//! Windows startup containment. The owner retains the only job handle.
use std::ffi::{OsStr, OsString};
use std::io;
use std::mem::size_of;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{FromRawHandle, OwnedHandle};
use std::ptr::{null, null_mut};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, HANDLE_FLAG_INHERIT, SetHandleInformation, WAIT_OBJECT_0};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::System::JobObjects::{
    CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectBasicAccountingInformation,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, CreateProcessW, DETACHED_PROCESS, DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess, InitializeProcThreadAttributeList,
    LPPROC_THREAD_ATTRIBUTE_LIST, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROC_THREAD_ATTRIBUTE_JOB_LIST, PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOEXW, STARTUPINFOW,
    UpdateProcThreadAttribute, WaitForSingleObject,
};

pub struct Handle(pub HANDLE);
// SAFETY: these kernel handles can be used and closed on any thread.
unsafe impl Send for Handle {}
impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY: each Handle exclusively owns a valid handle.
        unsafe { CloseHandle(self.0) };
    }
}

pub struct Job(Handle);
impl Job {
    pub fn new() -> io::Result<Self> {
        // SAFETY: null security attributes create a non-inheritable unnamed handle.
        let raw = unsafe { CreateJobObjectW(null(), null()) };
        if raw.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = Self(Handle(raw));
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: the buffer matches the information class and remains live for the call.
        if unsafe { SetInformationJobObject(raw, JobObjectExtendedLimitInformation, (&raw const limits).cast(), size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }

    pub fn terminate(&self) -> io::Result<()> {
        // SAFETY: the job handle is live.
        if unsafe { TerminateJobObject(self.0.0, 1) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub fn active(&self) -> io::Result<u32> {
        let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        // SAFETY: the output buffer matches the information class.
        if unsafe { QueryInformationJobObject(self.0.0, JobObjectBasicAccountingInformation, (&raw mut accounting).cast(), size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32, null_mut()) }
            == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(accounting.ActiveProcesses)
    }
}

struct Attributes {
    // usize gives the allocation the pointer alignment required by Windows.
    _storage: Vec<usize>,
    list: LPPROC_THREAD_ATTRIBUTE_LIST,
}
impl Attributes {
    fn new() -> io::Result<Self> {
        let mut bytes = 0;
        // SAFETY: a null first call obtains the allocation size.
        unsafe { InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut bytes) };
        let mut storage = vec![0usize; bytes.div_ceil(size_of::<usize>())];
        let list = storage.as_mut_ptr().cast();
        // SAFETY: storage is aligned and holds at least the reported size.
        if unsafe { InitializeProcThreadAttributeList(list, 2, 0, &mut bytes) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { _storage: storage, list })
    }
    fn set(&self, key: u32, handles: &mut [HANDLE]) -> io::Result<()> {
        // SAFETY: the handle array stays live until CreateProcessW returns.
        if unsafe { UpdateProcThreadAttribute(self.list, 0, key as usize, handles.as_mut_ptr().cast(), std::mem::size_of_val(handles), null_mut(), null()) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}
impl Drop for Attributes {
    fn drop(&mut self) {
        // SAFETY: this list was initialized successfully.
        unsafe { DeleteProcThreadAttributeList(self.list) };
    }
}

fn pipe(parent_reads: bool) -> io::Result<(Handle, Handle)> {
    let security = SECURITY_ATTRIBUTES { nLength: size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: null_mut(), bInheritHandle: 1 };
    let (mut read, mut write) = (null_mut(), null_mut());
    // SAFETY: valid output pointers and default security.
    if unsafe { CreatePipe(&mut read, &mut write, &security, 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let (read, write) = (Handle(read), Handle(write));
    let parent = if parent_reads { &read } else { &write };
    // SAFETY: parent owns this handle; do not let children inherit it.
    if unsafe { SetHandleInformation(parent.0, HANDLE_FLAG_INHERIT, 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(if parent_reads { (read, write) } else { (write, read) })
}

fn quoted(arg: &OsStr) -> Vec<u16> {
    let mut result = vec![b'"' as u16];
    let mut slashes = 0;
    for ch in arg.encode_wide() {
        if ch == b'\\' as u16 {
            slashes += 1;
        } else {
            result.extend(std::iter::repeat_n(b'\\' as u16, if ch == b'"' as u16 { slashes * 2 + 1 } else { slashes }));
            result.push(ch);
            slashes = 0;
        }
    }
    result.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2));
    result.push(b'"' as u16);
    result
}

pub struct Child {
    process: Handle,
    pub input: Option<std::fs::File>,
    pub output: std::fs::File,
    pub errors: std::fs::File,
}
impl Child {
    pub fn spawn(job: &Job, command: &[OsString]) -> io::Result<Self> {
        let (input, child_input) = pipe(false)?;
        let (output, child_output) = pipe(true)?;
        let (errors, child_errors) = pipe(true)?;
        let attributes = Attributes::new()?;
        let mut jobs = [job.0.0];
        let mut inherited = [child_input.0, child_output.0, child_errors.0];
        attributes.set(PROC_THREAD_ATTRIBUTE_JOB_LIST, &mut jobs)?;
        attributes.set(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, &mut inherited)?;
        let mut startup = STARTUPINFOEXW::default();
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = child_input.0;
        startup.StartupInfo.hStdOutput = child_output.0;
        startup.StartupInfo.hStdError = child_errors.0;
        startup.lpAttributeList = attributes.list;
        let mut line = Vec::new();
        for (index, arg) in command.iter().enumerate() {
            if index != 0 {
                line.push(b' ' as u16);
            }
            line.extend(quoted(arg));
        }
        line.push(0);
        let application: Vec<u16> = command[0].encode_wide().chain(Some(0)).collect();
        let mut process = PROCESS_INFORMATION::default();
        // SAFETY: all buffers and attribute values remain live. JOB_LIST associates
        // the child atomically at creation, including when an outer job is present.
        if unsafe { CreateProcessW(application.as_ptr(), line.as_mut_ptr(), null(), null(), 1, EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW, null(), null(), &startup.StartupInfo, &mut process) }
            == 0
        {
            return Err(io::Error::last_os_error());
        }
        let process_handle = Handle(process.hProcess);
        drop(Handle(process.hThread));
        fn into_file(handle: Handle) -> std::fs::File {
            let raw = handle.0;
            std::mem::forget(handle);
            // SAFETY: ownership transfers from Handle to File.
            std::fs::File::from(unsafe { OwnedHandle::from_raw_handle(raw) })
        }
        Ok(Self { process: process_handle, input: Some(into_file(input)), output: into_file(output), errors: into_file(errors) })
    }

    pub fn exit_code(&self) -> io::Result<Option<u32>> {
        // SAFETY: process remains live until Child drops.
        if unsafe { WaitForSingleObject(self.process.0, 0) } != WAIT_OBJECT_0 {
            return Ok(None);
        }
        let mut code = 0;
        // SAFETY: output points to a u32 and process is valid.
        if unsafe { GetExitCodeProcess(self.process.0, &mut code) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Some(code))
    }
}

/// Launch only the existing managed index daemon, from the outermost owner.
/// No inherited handles: even an unused inherited pipe writer pins client EOF.
pub fn wake_worker(node: &OsStr, entry: &OsStr) -> io::Result<()> {
    let args = [node, entry, OsStr::new("--worker-daemon"), OsStr::new("--claim-worker")];
    let mut line = Vec::new();
    for (index, arg) in args.iter().enumerate() {
        if index != 0 {
            line.push(b' ' as u16);
        }
        line.extend(quoted(arg));
    }
    line.push(0);
    let application: Vec<u16> = node.encode_wide().chain(Some(0)).collect();
    // Pure trusted environment path resolution, never a filesystem probe. Even
    // a duplicate daemon retiring before JS initialization must not pin cwd.
    let cwd: Vec<u16> = std::env::temp_dir().as_os_str().encode_wide().chain(Some(0)).collect();
    let startup = STARTUPINFOW { cb: size_of::<STARTUPINFOW>() as u32, ..Default::default() };
    let mut process = PROCESS_INFORMATION::default();
    // SAFETY: buffers remain live through CreateProcessW; handle inheritance is
    // disabled and argv contains no data taken from the canonical response.
    if unsafe { CreateProcessW(application.as_ptr(), line.as_mut_ptr(), null(), null(), 0, DETACHED_PROCESS, null(), cwd.as_ptr(), &startup, &mut process) } == 0 {
        return Err(io::Error::last_os_error());
    }
    drop(Handle(process.hThread));
    drop(Handle(process.hProcess));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quoting_preserves_unicode_quotes_and_trailing_slashes() {
        assert_eq!(String::from_utf16(&quoted(OsStr::new("a b日本\\\"c\\"))).unwrap(), "\"a b日本\\\\\\\"c\\\\\"");
    }
    #[test]
    fn job_handle_is_not_inheritable_and_disallows_breakaway() {
        use windows_sys::Win32::Foundation::GetHandleInformation;
        let job = Job::new().unwrap();
        let mut flags = 0;
        assert_ne!(unsafe { GetHandleInformation(job.0.0, &mut flags) }, 0);
        assert_eq!(flags & HANDLE_FLAG_INHERIT, 0);
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        assert_ne!(unsafe { QueryInformationJobObject(job.0.0, JobObjectExtendedLimitInformation, (&raw mut limits).cast(), size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32, null_mut()) }, 0);
        assert_eq!(limits.BasicLimitInformation.LimitFlags, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE);
        assert_eq!(job.active().unwrap(), 0);
    }

    #[test]
    fn real_child_and_descendants_are_accounted_until_kernel_cleanup() {
        let job = Job::new().unwrap();
        let command: Vec<OsString> = ["C:\\Windows\\System32\\cmd.exe", "/d", "/c", "ping -n 30 127.0.0.1 >nul"].into_iter().map(OsString::from).collect();
        let child = Child::spawn(&job, &command).unwrap();
        assert!(job.active().unwrap() >= 1, "root was not associated at creation");
        job.terminate().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while job.active().unwrap() != 0 || child.exit_code().unwrap().is_none() {
            assert!(std::time::Instant::now() < deadline, "kernel cleanup did not complete");
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
    }

    #[test]
    fn failed_job_association_never_runs_canonical_work() {
        let path = std::env::temp_dir().join(format!("tg-startup-never-{}.txt", std::process::id()));
        assert!(!path.exists());
        let command = vec![OsString::from("C:\\Windows\\System32\\cmd.exe"), OsString::from("/d"), OsString::from("/c"), OsString::from(format!("echo unexpected > \"{}\"", path.display()))];
        // A real kernel failure, rather than an injected spawn implementation.
        let invalid = Job(Handle(null_mut()));
        assert!(Child::spawn(&invalid, &command).is_err());
        assert!(!path.exists(), "unowned process executed after association failure");
    }
}
