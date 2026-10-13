//! Internal v1 startup protocol: publish a candidate only after kernel-confirmed cleanup.
use crate::startup_process::{Child, Job};
use std::ffi::OsString;
use std::io::{Read, Write};
use std::sync::mpsc::{self, Receiver};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub(crate) const MAX_BYTES: usize = 1024 * 1024;
pub(crate) const RESERVE_MS: u64 = 1000;

fn remaining(epoch: u64, now: u64) -> Result<u64, String> {
    let remaining = epoch.saturating_sub(now);
    if remaining <= RESERVE_MS {
        return Err("insufficient time for process-tree cleanup".into());
    }
    if remaining > 3000 {
        return Err("invalid absolute startup deadline".into());
    }
    Ok(remaining)
}

pub(crate) fn reader(mut input: impl Read + Send + 'static, limit: usize) -> Receiver<Result<Vec<u8>, String>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut buffer = [0u8; 8192];
        let result = loop {
            match input.read(&mut buffer) {
                Ok(0) => break Ok(bytes),
                Ok(n) if bytes.len() + n <= limit => bytes.extend_from_slice(&buffer[..n]),
                Ok(_) => break Err("hook helper stream exceeded 1 MiB".into()),
                Err(error) => break Err(format!("hook pipe read failed: {error}")),
            }
        };
        let _ = tx.send(result);
    });
    rx
}

fn pause() {
    std::thread::sleep(Duration::from_millis(2));
}

fn execute(args: &[OsString]) -> Result<String, String> {
    // No "--" separator: older tg-hook versions cannot mistake this mode for
    // an ordinary hook and execute the canonical command as their fallback.
    if args.len() < 5 {
        return Err("invalid internal startup owner arguments".into());
    }
    let epoch: u64 = args[0].to_str().and_then(|s| s.parse().ok()).ok_or("invalid absolute startup deadline")?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis() as u64;
    let budget = remaining(epoch, now)?;
    let deadline = Instant::now() + Duration::from_millis(budget);
    let work_deadline = deadline - Duration::from_millis(RESERVE_MS);
    // A blocked CreateProcessW must not outlive the inherited deadline. Process
    // exit closes the sole job handle even if this thread never resumes.
    std::thread::spawn(move || {
        std::thread::sleep(deadline.saturating_duration_since(Instant::now()));
        // No pipe writes, Rust stdio flushing or DLL-detach callbacks on the
        // emergency path. Kernel termination closes the sole job handle.
        // SAFETY: the pseudo-handle denotes this owner, never a peer process.
        let terminated = unsafe { windows_sys::Win32::System::Threading::TerminateProcess(windows_sys::Win32::System::Threading::GetCurrentProcess(), 124) };
        if terminated == 0 {
            // SAFETY: a failed emergency termination must still end this owner.
            unsafe { windows_sys::Win32::System::Threading::ExitProcess(124) };
        }
    });
    let input = reader(std::io::stdin(), MAX_BYTES);
    let payload = loop {
        if Instant::now() >= work_deadline {
            return Err("hook helper timed out reading input".into());
        }
        match input.try_recv() {
            Ok(result) => break result?,
            Err(mpsc::TryRecvError::Empty) => pause(),
            Err(_) => return Err("startup input reader stopped".into()),
        }
    };
    let value: serde_json::Value = serde_json::from_slice(&payload).map_err(|e| format!("invalid startup JSON: {e}"))?;
    if !value.is_object() {
        return Err("startup input must be an object".into());
    }
    let job = Job::new().map_err(|e| format!("startup job creation failed: {e}"))?;
    if deadline.saturating_duration_since(Instant::now()) <= Duration::from_millis(RESERVE_MS) {
        return Err("insufficient time for process-tree cleanup".into());
    }
    let mut child = Child::spawn(&job, &args[1..]).map_err(|e| format!("startup job association/process creation failed: {e}"))?;
    let output = reader(child.output.try_clone().map_err(|e| e.to_string())?, MAX_BYTES);
    let errors = reader(child.errors.try_clone().map_err(|e| e.to_string())?, MAX_BYTES);
    // The originals must close too, or they keep the reads artificially alive.
    // File clones share the pipe endpoint, not an additional writer.
    let input_pipe = child.input.take().ok_or("missing input pipe")?;
    let (input_tx, input_rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut pipe = input_pipe;
        let result = pipe.write_all(&payload).map_err(|error| format!("hook helper input failed: {error}"));
        drop(pipe);
        let _ = input_tx.send(result);
    });
    let mut stdout = None;
    let mut stderr = None;
    let mut failure = None;
    let mut input_result = None;
    let code = loop {
        if stdout.is_none()
            && let Ok(result) = output.try_recv()
        {
            stdout = Some(result);
        }
        if stderr.is_none()
            && let Ok(result) = errors.try_recv()
        {
            stderr = Some(result);
        }
        if input_result.is_none()
            && let Ok(result) = input_rx.try_recv()
        {
            input_result = Some(result);
        }
        if stdout.as_ref().is_some_and(Result::is_err) || stderr.as_ref().is_some_and(Result::is_err) || input_result.as_ref().is_some_and(Result::is_err) {
            failure = Some("hook helper stream exceeded 1 MiB or pipe failed".to_string());
            break None;
        }
        if let Some(code) = child.exit_code().map_err(|e| e.to_string())? {
            break Some(code);
        }
        if Instant::now() >= work_deadline {
            failure = Some("hook helper timed out".to_string());
            break None;
        }
        pause();
    };
    job.terminate().map_err(|e| format!("process-tree cleanup failed: {e}"))?;
    loop {
        if stdout.is_none()
            && let Ok(result) = output.try_recv()
        {
            stdout = Some(result);
        }
        if stderr.is_none()
            && let Ok(result) = errors.try_recv()
        {
            stderr = Some(result);
        }
        if input_result.is_none()
            && let Ok(result) = input_rx.try_recv()
        {
            input_result = Some(result);
        }
        if job.active().map_err(|e| format!("job accounting failed: {e}"))? == 0
            && child.exit_code().map_err(|e| e.to_string())?.is_some()
            && stdout.is_some()
            && stderr.is_some()
            && input_result.is_some()
        {
            break;
        }
        if Instant::now() >= deadline {
            return Err("process-tree cleanup failed: deadline exceeded".into());
        }
        pause();
    }
    if let Some(error) = failure {
        return Err(error);
    }
    if code != Some(0) {
        return Err("hook helper exited without a response".into());
    }
    input_result.ok_or("missing input completion")??;
    let output = stdout.ok_or("missing stdout")??;
    let (worker_wake, diagnostics) = take_worker_wake(stderr.ok_or("missing stderr")??);
    // Only the installed-entry relay owns a shim, whose fail-open diagnostics
    // must reach the harness. Canonical owner invocations retain their behavior.
    if args.last().is_some_and(|arg| arg.to_str().is_some_and(|text| text.starts_with("--session-start-deadline="))) {
        std::io::stderr().write_all(&diagnostics).map_err(|e| e.to_string())?;
    }
    let candidate: serde_json::Value = serde_json::from_slice(&output).map_err(|e| format!("hook helper returned invalid JSON: {e}"))?;
    if !candidate.is_object() {
        return Err("hook helper returned a non-object response".into());
    }
    Ok(serde_json::json!({
        "protocol": "tg-session-start-owner-v1", "capability": "atomic-job-list",
        "activeProcesses": 0, "rootExited": true, "pipesDrained": true,
        "workerWake": worker_wake,
        "candidate": candidate,
    })
    .to_string())
}

pub fn take_worker_wake(diagnostics: Vec<u8>) -> (bool, Vec<u8>) {
    const REQUEST: &[u8] = b"\x1eTG_WORKER_WAKE_V1\x1e\n";
    let mut requested = false;
    let mut clean = Vec::with_capacity(diagnostics.len());
    for line in diagnostics.split_inclusive(|byte| *byte == b'\n') {
        if line == REQUEST {
            requested = true;
        } else {
            clean.extend_from_slice(line);
        }
    }
    (requested, clean)
}

pub fn run(args: &[OsString]) -> i32 {
    match execute(args) {
        Ok(ack) => {
            println!("{ack}");
            0
        }
        Err(error) => {
            eprintln!("tg-hook startup owner: {error}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn worker_request_is_only_an_exact_bounded_marker() {
        let (wake, diagnostics) = take_worker_wake(b"before\n\x1eTG_WORKER_WAKE_V1\x1e\nafter\n".to_vec());
        assert!(wake);
        assert_eq!(diagnostics, b"before\nafter\n");
        let input = b"prefix\x1eTG_WORKER_WAKE_V1\x1e\n\x1eTG_WORKER_WAKE_V1\x1e arbitrary.exe\n";
        let (wake, diagnostics) = take_worker_wake(input.to_vec());
        assert!(!wake);
        assert_eq!(diagnostics, input);
    }
    #[test]
    fn reserve_and_absolute_budget_are_not_reset() {
        assert!(remaining(4000, 3000).is_err());
        assert_eq!(remaining(4001, 3000).unwrap(), 1001);
        assert!(remaining(4000, 4001).is_err());
        assert!(remaining(7001, 3000).is_err());
    }
}
