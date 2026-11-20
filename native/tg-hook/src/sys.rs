//! The few operating-system facts the relay needs and std does not expose: random bytes for the handshake nonce, how long this process has been alive, which of its handles a fallback child inherits, and tying that child's life to this process.

use std::process::{Child, Command};
use std::time::Instant;

/// The highest handle value [`stop_handle_inheritance`] probes, should the process's handle count never be reached: values are multiples of 4, so this bounds the scan at 262,144 calls that each fail fast on an unused value.
#[cfg(windows)]
const MAX_PROBED_HANDLE: usize = 1 << 20;

/// Clears the inherit flag on every handle this process holds, its standard handles first, as Node does for those three at startup (`uv_disable_stdio_inheritance`). std gives a Windows child its standard handles as fresh inheritable duplicates, but creates it inheriting every inheritable handle of this process too, so without this the child would also hold the originals under handle values it does not know are its stdio, and any other inheritable handle this process was itself given: PowerShell, which is how Copilot CLI runs a hook command, hands its child its own stdout that way beside the three standard handles. Node cannot clear those, and hands them on to the hook server the shim starts in the background, which then holds the harness's stdout open until it exits: a harness waiting for end of output would wait for the server, not the hook. Windows has no documented call that lists a process's handles, so the values are probed in order until as many as the process holds have been found. POSIX needs nothing: a child gets descriptors 0 to 2 and std opens everything else close-on-exec.
pub fn stop_handle_inheritance() {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::{GetHandleInformation, HANDLE_FLAG_INHERIT, SetHandleInformation};
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetProcessHandleCount};
        for handle in [std::io::stdin().as_raw_handle(), std::io::stdout().as_raw_handle(), std::io::stderr().as_raw_handle()] {
            // SAFETY: changes only the inherit flag of a handle this process owns; a null or invalid one makes the call fail, which changes nothing.
            unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) };
        }
        let mut count = 0u32;
        // SAFETY: the pseudo-handle for this process needs no closing; writes one u32.
        if unsafe { GetProcessHandleCount(GetCurrentProcess(), &mut count) } == 0 {
            count = u32::MAX;
        }
        let (mut found, mut value) = (0u32, 4usize);
        while found < count && value <= MAX_PROBED_HANDLE {
            let handle = std::ptr::without_provenance_mut(value);
            let mut flags = 0u32;
            // SAFETY: reads the flags of a handle value this process may hold; an unused value makes the call fail and writes nothing.
            if unsafe { GetHandleInformation(handle, &mut flags) } != 0 {
                found += 1;
                if flags & HANDLE_FLAG_INHERIT != 0 {
                    // SAFETY: changes only the inherit flag of a handle this process holds.
                    unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) };
                }
            }
            value += 4;
        }
    }
}

/// Fills `buf` from the operating system's random source. False when it cannot, and the caller falls back rather than send a guessable nonce.
pub fn random_bytes(buf: &mut [u8]) -> bool {
    #[cfg(windows)]
    {
        // ProcessPrng is the source std itself draws on, so its DLL is loaded already.
        // SAFETY: writes exactly `buf.len()` bytes into `buf`.
        unsafe { windows_sys::Win32::Security::Cryptography::ProcessPrng(buf.as_mut_ptr(), buf.len()) != 0 }
    }
    #[cfg(target_os = "linux")]
    {
        let mut filled = 0;
        while filled < buf.len() {
            // SAFETY: writes at most the remaining length into the remaining part of `buf`.
            let n = unsafe { libc::getrandom(buf[filled..].as_mut_ptr().cast(), buf.len() - filled, 0) };
            if n < 0 {
                if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                return false;
            }
            filled += n as usize;
        }
        true
    }
    #[cfg(all(unix, not(target_os = "linux")))]
    {
        // getentropy serves at most 256 bytes per call.
        buf.chunks_mut(256).all(|chunk| {
            // SAFETY: writes exactly `chunk.len()` (at most 256) bytes into `chunk`.
            unsafe { libc::getentropy(chunk.as_mut_ptr().cast(), chunk.len()) == 0 }
        })
    }
}

/// Milliseconds since this process was created, the clock `performance.now()` gives the Node client, so the ledger's hook timings stay comparable across the two. Windows reads the creation time itself. Linux's only source (`/proc/self/stat` starttime) counts in 10 ms clock ticks, truncated, so it would overstate by 5 ms on average; the time since `main` started understates by the exec, well under 1 ms for this binary, and is used instead there and on macOS, which does not ship this client.
pub fn process_elapsed_ms(main_start: Instant) -> f64 {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::FILETIME;
        use windows_sys::Win32::System::SystemInformation::GetSystemTimePreciseAsFileTime;
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};
        let ticks = |t: FILETIME| (u64::from(t.dwHighDateTime) << 32) | u64::from(t.dwLowDateTime);
        let (mut created, mut exited, mut kernel, mut user, mut now) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
        // SAFETY: the pseudo-handle for this process needs no closing, and each out-parameter is a FILETIME of ours.
        let ok = unsafe { GetProcessTimes(GetCurrentProcess(), &mut created, &mut exited, &mut kernel, &mut user) } != 0;
        // SAFETY: writes one FILETIME.
        unsafe { GetSystemTimePreciseAsFileTime(&mut now) };
        if ok && ticks(now) >= ticks(created) {
            // FILETIME counts 100 ns intervals.
            return (ticks(now) - ticks(created)) as f64 / 10_000.0;
        }
    }
    main_start.elapsed().as_secs_f64() * 1000.0
}

/// Arranges, before `cmd` is spawned, for the child to die with this process: if the harness kills this client on its hook timeout, the Node command it was running on the harness's behalf goes too, as it would have when the harness ran that command itself. Linux asks the kernel for SIGKILL on parent death; Windows does it through [`adopt_child`].
pub fn guard_child(cmd: &mut Command) {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        let parent = std::process::id() as libc::pid_t;
        // SAFETY: the closure runs in the forked child before exec and calls only async-signal-safe functions.
        unsafe {
            cmd.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                // The parent may have died before the request took effect.
                if libc::getppid() != parent {
                    libc::_exit(1);
                }
                Ok(())
            });
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // The route heads its own process group, so ending that group ends what the route started.
        cmd.process_group(0);
    }
    #[cfg(not(unix))]
    let _ = cmd;
}

/// Windows half of [`guard_child`]: puts `child` in a job that is killed when this process's handle to it closes, which the exit of this process does. Processes the child starts itself break away from the job silently, so the hook server the Node shim starts in the background outlives this call as it does today. Best effort: a child left outside the job behaves exactly as it would have without one.
pub fn adopt_child(child: &Child) -> Group {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut held = 0usize;
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JobObjectExtendedLimitInformation, SetInformationJobObject,
        };
        // SAFETY: an unnamed job with default security; the handle is deliberately never closed, so the job lives exactly as long as this process.
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return Group { leader: child.id(), job: 0 };
        }
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
        // SAFETY: `info` is the structure this information class names, passed with its own size.
        let set = unsafe { SetInformationJobObject(job, JobObjectExtendedLimitInformation, (&raw const info).cast(), size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32) } != 0;
        if set {
            // SAFETY: both handles are live: the job was just created and `child` has not been waited on.
            if unsafe { AssignProcessToJobObject(job, child.as_raw_handle()) } != 0 {
                held = job as usize;
            }
        }
    }
    Group { leader: child.id(), job: held }
}

/// What a route started as the head of: its own process group (POSIX, led by the route's pid) or the job it was put in (Windows, 0 when the job could not be made or joined).
#[derive(Clone, Debug, PartialEq)]
pub struct Group {
    pub leader: u32,
    #[cfg_attr(not(windows), allow(dead_code))]
    job: usize,
}

/// Ends every process of `group` at once. Call it only while the route's direct child is still unreaped, so the leader's pid cannot have been handed to another process. A descendant that left the group (POSIX setsid) or broke away from the job (silently, as the hook server the shim starts does) is not chased.
pub fn end_group(group: &Group) {
    #[cfg(unix)]
    {
        // A leader pid of 1 or less would signal every process or the caller's own group.
        if group.leader > 1 {
            // SAFETY: SIGKILL to the group this client created for its route; the leader is unreaped, so the id is still the route's.
            unsafe { libc::kill(-(group.leader as libc::pid_t), libc::SIGKILL) };
        }
    }
    #[cfg(windows)]
    {
        if group.job != 0 {
            // SAFETY: the job handle is the one adopt_child made and never closed, so it is live for the life of this process.
            unsafe { windows_sys::Win32::System::JobObjects::TerminateJobObject(group.job as _, 1) };
        }
    }
}

/// Whether process `pid` is running: `Some(false)` only when the system says no such process exists, `None` when it cannot tell, which a caller treats as running.
pub fn process_alive(pid: u32) -> Option<bool> {
    #[cfg(unix)]
    {
        // SAFETY: signal 0 only checks that the process exists and may be signalled; nothing is sent.
        if unsafe { libc::kill(pid as libc::pid_t, 0) } == 0 {
            return Some(true);
        }
        match std::io::Error::last_os_error().raw_os_error() {
            Some(libc::ESRCH) => Some(false),
            Some(libc::EPERM) => Some(true),
            _ => None,
        }
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, ERROR_INVALID_PARAMETER};
        use windows_sys::Win32::System::Threading::{self as threading, GetExitCodeProcess, OpenProcess};
        // SAFETY: opens a query-only handle that is closed below; a pid that does not exist makes the call fail.
        let handle = unsafe { OpenProcess(threading::PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle.is_null() {
            let code = std::io::Error::last_os_error().raw_os_error();
            return if code == Some(ERROR_INVALID_PARAMETER as i32) { Some(false) } else { None };
        }
        let mut exit = 0u32;
        // SAFETY: `handle` is the live handle just opened; writes one u32.
        let read = unsafe { GetExitCodeProcess(handle, &mut exit) } != 0;
        // SAFETY: closes the handle opened above, once.
        unsafe { CloseHandle(handle) };
        // 259 is STILL_ACTIVE, the exit code of a process that has not exited.
        if read { Some(exit == 259) } else { None }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
        None
    }
}
