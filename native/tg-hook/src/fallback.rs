//! The path taken whenever the server cannot answer: run the command the harness would have run (everything after `--`), hand it the stdin this process already read, and exit as it exits. The Node shim then does everything it does today, including starting a server in the background, so the next call is served. Neither Windows nor POSIX `exec` fits: the payload has already been consumed from stdin and must be written back into the child.

use std::ffi::OsString;
use std::io::{Read, Write};
use std::process::{Command, ExitStatus, Stdio};

/// What of this process's stdin the child gets.
pub enum Input {
    /// Nothing was read: the child reads the same stdin itself.
    Untouched,
    /// These bytes were read; `more` says stdin was not exhausted, so the rest is copied after them.
    Read { bytes: Vec<u8>, more: bool },
}

/// Names, on the wrapped command's environment, why this call was not served. The Node hook path records it with the call's latency row (`stats.detail`, as `native-fallback:<reason>`), which is how `doctor` counts served and fallen-back calls per harness; the answer on stdout is untouched.
pub const REASON_ENV: &str = "TOKEN_GOAT_NATIVE_FALLBACK";

/// Runs `argv` with `reason` in its environment as [`REASON_ENV`] and returns the exit code to leave with.
pub fn run(argv: &[OsString], input: Input, reason: &str) -> i32 {
    let Some((program, args)) = argv.split_first() else {
        eprintln!("tg-hook: no command after --");
        return 2;
    };
    let mut cmd = Command::new(program);
    cmd.args(args).env(REASON_ENV, reason).stdout(Stdio::inherit()).stderr(Stdio::inherit());
    cmd.stdin(if matches!(input, Input::Untouched) { Stdio::inherit() } else { Stdio::piped() });
    crate::sys::guard_child(&mut cmd);
    crate::sys::stop_stdio_inheritance();
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) => {
            // What a POSIX shell reports for a command it cannot find (127) or cannot run (126).
            eprintln!("tg-hook: cannot run {}: {e}", program.to_string_lossy());
            return if e.kind() == std::io::ErrorKind::NotFound { 127 } else { 126 };
        }
    };
    crate::sys::adopt_child(&child);
    if let (Some(mut stdin), Input::Read { bytes, more }) = (child.stdin.take(), input) {
        // A child that exits without reading (an event its shim does not take) closes the pipe early; that is not an error here, and its exit code still stands.
        if stdin.write_all(&bytes).is_ok() && more {
            let _ = std::io::copy(&mut std::io::stdin().lock(), &mut stdin);
        }
        drop(stdin);
    }
    match child.wait() {
        Ok(status) => exit_code(status),
        Err(e) => {
            eprintln!("tg-hook: lost track of {}: {e}", program.to_string_lossy());
            1
        }
    }
}

/// The child's exit code. A child killed by a signal takes this process down with the same signal, so the harness sees exactly the ending it would have seen from the child itself; the shell convention of 128 + signal is the answer only if that does not end it.
fn exit_code(status: ExitStatus) -> i32 {
    if let Some(code) = status.code() {
        return code;
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(sig) = status.signal() {
            let _ = std::io::stdout().flush();
            // SAFETY: restores the default action for `sig` and raises it on this process; both calls are async-signal-safe and touch no memory of ours.
            unsafe {
                libc::signal(sig, libc::SIG_DFL);
                libc::raise(sig);
            }
            return 128 + sig;
        }
    }
    1
}

/// Reads stdin until EOF or until more than `limit` bytes have arrived.
pub fn read_stdin(limit: usize) -> Input {
    let mut bytes = Vec::new();
    let result = std::io::stdin().lock().take(limit as u64 + 1).read_to_end(&mut bytes);
    match result {
        Err(_) if bytes.is_empty() => Input::Untouched,
        // A read error mid-stream leaves the rest for the child to find, exactly as it would have.
        Err(_) => Input::Read { bytes, more: true },
        Ok(_) => {
            let more = bytes.len() > limit;
            Input::Read { bytes, more }
        }
    }
}
