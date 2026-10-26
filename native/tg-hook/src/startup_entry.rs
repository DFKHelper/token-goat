//! Installed SessionStart commands bypass ordinary EOF buffering and resident dispatch.
use crate::client::Call;
use std::ffi::OsString;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// The SessionStart budget; src/bridges/shim_common.ts::SHIM_SESSION_START_TIMEOUT_MS must stay equal (tests/bridges/copilot_session_start_budget_seam.test.ts reads this line).
pub(crate) const DEFAULT_BUDGET_MS: u64 = 10_000;
const TEST_BUDGET_ENV: &str = "TG_TEST_SESSION_START_BUDGET_MS";
const TEST_BUDGET_MIN_MS: u64 = 1000;
const TEST_BUDGET_MAX_MS: u64 = 600_000;

// Test-only seam, read by the Node shim as well: a plain decimal value in range replaces the budget so a test need not race the clock; anything else is ignored and the default applies.
pub(crate) fn budget_ms() -> u64 {
    budget_from(std::env::var(TEST_BUDGET_ENV).ok().as_deref())
}

fn budget_from(value: Option<&str>) -> u64 {
    match value {
        Some(text) if !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()) => match text.parse::<u64>() {
            Ok(ms) if (TEST_BUDGET_MIN_MS..=TEST_BUDGET_MAX_MS).contains(&ms) => ms,
            _ => DEFAULT_BUDGET_MS,
        },
        _ => DEFAULT_BUDGET_MS,
    }
}

pub fn is_startup(call: &Call) -> bool {
    matches!(call.harness.as_str(), "copilot_cli" | "vscode") && matches!(call.event.as_str(), "sessionStart" | "SessionStart" | "session_start")
}

pub fn run(mut command: Vec<OsString>, started: Instant) -> i32 {
    if command.len() < 4 {
        return fail_open("installed startup command unavailable");
    }
    let deadline = started + Duration::from_millis(budget_ms());
    let epoch = match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(now) => now.as_millis() as u64 + deadline.saturating_duration_since(Instant::now()).as_millis() as u64,
        Err(error) => return fail_open(&error.to_string()),
    };
    command.push(format!("--session-start-deadline={epoch}").into());
    // An already-installed shim may still have its ordinary resident branch.
    // SAFETY: this route runs on main before any client/reader/worker threads.
    unsafe { std::env::set_var("TOKEN_GOAT_HOOK_SERVER", "0") };
    #[cfg(not(windows))]
    {
        // The existing POSIX shim owns a detached group. Inherit stdin directly,
        // and pass the original native deadline rather than waiting for EOF.
        crate::fallback::run(&command, crate::fallback::Input::Untouched, "bounded-startup")
    }
    #[cfg(windows)]
    {
        let (tx, rx) = std::sync::mpsc::channel();
        // The external parent never blocks on input, launch, SQLite or cleanup.
        // Process exit closes every private job even if this worker is blocked.
        std::thread::spawn(move || {
            let result = execute(&command, epoch, deadline).map(|(candidate, diagnostics, wake)| {
                if wake && Instant::now() < deadline {
                    // This is the existing index daemon, not an unbounded
                    // bootstrap. It claims its own ordinary lifecycle slot.
                    if std::env::var_os("TOKEN_GOAT_NO_WORKER_SPAWN").is_none_or(|value| value != "1") {
                        let _ = crate::startup_process::wake_worker(&command[0], &command[3]);
                    }
                }
                (candidate, diagnostics)
            });
            let _ = tx.send(result);
        });
        loop {
            if Instant::now() >= deadline {
                return fail_open("installed startup overall deadline exceeded");
            }
            match rx.try_recv() {
                Ok(Ok((candidate, diagnostics))) => {
                    eprint!("{}", String::from_utf8_lossy(&diagnostics));
                    print!("{candidate}");
                    return 0;
                }
                Ok(Err(error)) => return fail_open(&error),
                Err(std::sync::mpsc::TryRecvError::Disconnected) => return fail_open("installed startup worker stopped"),
                Err(std::sync::mpsc::TryRecvError::Empty) => {}
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    }
}

fn fail_open(reason: &str) -> i32 {
    eprintln!("tg-hook: SessionStart failed open: {reason}");
    print!("{{}}");
    0
}

#[cfg(windows)]
fn frame(mut input: impl std::io::Read) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        let count = input.read(&mut buffer).map_err(|e| format!("startup input failed: {e}"))?;
        if count == 0 {
            return Err("stdin closed before a complete JSON object".into());
        }
        if bytes.len() + count > crate::startup_owner::MAX_BYTES {
            return Err("startup input exceeded 1 MiB".into());
        }
        bytes.extend_from_slice(&buffer[..count]);
        match serde_json::from_slice::<serde_json::Value>(&bytes) {
            Ok(value) if value.is_object() => return Ok(bytes),
            Ok(_) => return Err("startup input was not a JSON object".into()),
            Err(error) if error.is_eof() => {}
            Err(error) => return Err(format!("invalid startup JSON: {error}")),
        }
    }
}

#[cfg(windows)]
fn execute(command: &[OsString], epoch: u64, deadline: Instant) -> Result<(serde_json::Value, Vec<u8>, bool), String> {
    use crate::startup_owner::{MAX_BYTES, RESERVE_MS, reader};
    use crate::startup_process::{Child, Job};
    use std::io::Write;
    use std::sync::mpsc;
    let work_deadline = deadline - Duration::from_millis(RESERVE_MS);
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(frame(std::io::stdin()));
    });
    let payload = loop {
        if Instant::now() >= work_deadline {
            // A payload framed before the deadline must not be lost to the order of these checks: look once more before giving up.
            match rx.try_recv() {
                Ok(result) => break result?,
                Err(_) => return Err("startup input deadline exceeded".into()),
            }
        }
        match rx.try_recv() {
            Ok(result) => break result?,
            Err(mpsc::TryRecvError::Disconnected) => return Err("startup input reader stopped".into()),
            Err(mpsc::TryRecvError::Empty) => std::thread::sleep(Duration::from_millis(2)),
        }
    };
    // The payload arrived, so this start has an identity: stamp it begun before any relay work, so a start the budget cuts off anywhere after this point is delivered by the first tool call (a start that settles replaces the stamp with its own marker).
    crate::session_begun::stamp(&payload);
    let stamped = payload.clone();
    // The relay itself is atomically owned too: killing the installed entry
    // closes this strict job, including during nested owner/shim creation.
    let job = Job::new().map_err(|e| format!("startup relay job creation failed: {e}"))?;
    let outcome = (|| -> Result<(serde_json::Value, Vec<u8>, bool), String> {
        if command.len() < 5 || Instant::now() >= work_deadline {
            return Err("startup command unavailable or insufficient time for process-tree cleanup".into());
        }
        let mut args = vec![std::env::current_exe().map_err(|e| e.to_string())?.into_os_string(), "--session-start-owner-v1".into(), epoch.to_string().into()];
        args.extend_from_slice(command);
        let mut child = Child::spawn(&job, &args).map_err(|e| format!("startup relay creation failed: {e}"))?;
        // The canonical response is capped at 1 MiB; the owner adds bounded
        // capability/accounting metadata, as the Node parent also allows.
        let output = reader(child.output.try_clone().map_err(|e| e.to_string())?, MAX_BYTES + 4096);
        let errors = reader(child.errors.try_clone().map_err(|e| e.to_string())?, MAX_BYTES);
        let mut pipe = child.input.take().ok_or("missing startup relay input")?;
        let (tx, input) = mpsc::channel();
        std::thread::spawn(move || {
            let result = pipe.write_all(&payload).map_err(|e| format!("startup relay input failed: {e}"));
            drop(pipe);
            let _ = tx.send(result);
        });
        let mut stdout = None;
        let mut stderr = None;
        let mut input_result = None;
        let mut code = None;
        while Instant::now() < deadline {
            if stdout.is_none() {
                stdout = output.try_recv().ok();
            }
            if stderr.is_none() {
                stderr = errors.try_recv().ok();
            }
            if input_result.is_none() {
                input_result = input.try_recv().ok();
            }
            if code.is_none() {
                code = child.exit_code().map_err(|e| e.to_string())?;
                if code.is_some() {
                    job.terminate().map_err(|e| format!("startup relay cleanup failed: {e}"))?;
                }
            }
            if code.is_some() && stdout.is_some() && stderr.is_some() && input_result.is_some() && job.active().map_err(|e| e.to_string())? == 0 {
                let diagnostics = stderr.ok_or("missing relay stderr")??;
                input_result.ok_or("missing relay input completion")??;
                if code != Some(0) {
                    return Err(format!("startup relay failed: {}", String::from_utf8_lossy(&diagnostics)));
                }
                let mut ack: serde_json::Value = serde_json::from_slice(&stdout.ok_or("missing relay stdout")??).map_err(|e| format!("invalid startup relay acknowledgement: {e}"))?;
                if ack["protocol"] != "tg-session-start-owner-v1"
                    || ack["capability"] != "atomic-job-list"
                    || ack["activeProcesses"] != 0
                    || ack["rootExited"] != true
                    || ack["pipesDrained"] != true
                    || !ack["candidate"].is_object()
                {
                    return Err("startup relay incompatible protocol or unverified cleanup".into());
                }
                return Ok((ack["candidate"].take(), diagnostics, ack["workerWake"] == true));
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        Err("startup relay overall deadline exceeded".into())
    })();
    // A start that fails open prints `{}`, so it is owed whatever settle marker the helper wrote before the relay failed (a helper that finished inside its budget but whose answer never arrived): end the helper tree, then re-stamp the start begun, as the Node shim does (src/bridges/copilot_session_start.ts::stampSessionStartOwedFiles).
    if outcome.is_err() {
        let _ = job.terminate();
        crate::session_begun::stamp(&stamped);
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_aliases_are_routed_without_changing_other_hooks() {
        for harness in ["copilot_cli", "vscode", "claudecode"] {
            for event in ["sessionStart", "SessionStart", "session_start", "preToolUse"] {
                let call = Call { harness: harness.into(), event: event.into(), entry: String::new(), script_dir: None, response_timeout: Duration::ZERO };
                assert_eq!(is_startup(&call), harness != "claudecode" && event != "preToolUse");
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn complete_frames_do_not_require_eof_and_invalid_input_is_rejected() {
        assert!(frame(&b"{\"braces\":\"}{\", \"nested\":[{}]}"[..]).is_ok());
        for input in [b"[".as_slice(), b"{}{}", b"{\"x\":}", b""] {
            assert!(frame(input).is_err());
        }
    }
}

#[cfg(test)]
mod budget_tests {
    use super::*;
    #[test]
    fn only_a_plain_in_range_decimal_replaces_the_budget() {
        assert_eq!(budget_from(None), DEFAULT_BUDGET_MS);
        assert_eq!(budget_from(Some("120000")), 120000);
        assert_eq!(budget_from(Some("1000")), 1000);
        assert_eq!(budget_from(Some("600000")), 600000);
        for ignored in ["", "999", "600001", "+5000", "-5000", "5000ms", " 5000", "0x1388", "99999999999999999999999"] {
            assert_eq!(budget_from(Some(ignored)), DEFAULT_BUDGET_MS, "{ignored:?}");
        }
    }
}
