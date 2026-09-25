//! The few operating-system facts the relay needs and std does not expose: random bytes for the handshake nonce, how long this process has been alive, which of its handles a fallback child inherits, and tying that child's life to this process.

use std::process::{Child, Command};
use std::time::Instant;

/// Clears the inherit flag on this process's own standard handles, as Node does for itself at startup (`uv_disable_stdio_inheritance`). std gives a Windows child its standard handles as fresh inheritable duplicates, but creates it inheriting every inheritable handle of this process too, so without this the child would also hold the originals under handle values it does not know are its stdio. Node cannot clear those, and hands them on to the hook server the shim starts in the background, which then holds the harness's stdout open until it exits: a harness waiting for end of output would wait for the server, not the hook. POSIX needs nothing: a child gets descriptors 0 to 2 and std opens everything else close-on-exec.
pub fn stop_stdio_inheritance() {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::{HANDLE_FLAG_INHERIT, SetHandleInformation};
        for handle in [std::io::stdin().as_raw_handle(), std::io::stdout().as_raw_handle(), std::io::stderr().as_raw_handle()] {
            // SAFETY: changes only the inherit flag of a handle this process owns; a null or invalid one makes the call fail, which changes nothing.
            unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) };
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
    #[cfg(not(target_os = "linux"))]
    let _ = cmd;
}

/// Windows half of [`guard_child`]: puts `child` in a job that is killed when this process's handle to it closes, which the exit of this process does. Processes the child starts itself break away from the job silently, so the hook server the Node shim starts in the background outlives this call as it does today. Best effort: a child left outside the job behaves exactly as it would have without one.
pub fn adopt_child(child: &Child) {
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
            return;
        }
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
        // SAFETY: `info` is the structure this information class names, passed with its own size.
        let set = unsafe { SetInformationJobObject(job, JobObjectExtendedLimitInformation, (&raw const info).cast(), size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32) } != 0;
        if set {
            // SAFETY: both handles are live: the job was just created and `child` has not been waited on.
            unsafe { AssignProcessToJobObject(job, child.as_raw_handle()) };
        }
    }
    #[cfg(not(windows))]
    let _ = child;
}
