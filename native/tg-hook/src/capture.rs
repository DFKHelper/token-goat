//! Runs one Node route with its stdout captured, and judges it: a route is served only if it ended on its own, with exit 0 (or 2 and an answer, a deliberate block), and printed answers the host can parse. The Claude shim's first line, `{"async":true}`, is forwarded at once so the host is released early exactly as it is today; everything else is held until the route is judged, so a crash or garbage never reaches the host.

use std::ffi::OsString;
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use crate::out;

/// The marker line the Claude shim prints to detach the host before the hook's real work.
const ASYNC_MARKER: &[u8] = b"{\"async\":true}\n";
/// The most stdout held for judgment; a route printing more than a hook answer ever holds is garbage.
const MAX_CAPTURE: usize = 8 << 20;

/// What of this process's stdin a route is given.
pub enum Stdin<'a> {
    Inherit,
    Bytes(&'a [u8]),
    Null,
}

/// A route that was served: its exit code (0, or 2 for a deliberate block).
pub struct Outcome {
    pub code: i32,
}

/// Why a route did not serve.
#[derive(Debug)]
pub enum Failure {
    NoCommand,
    Spawn(String),
    Timeout(Duration),
    Signal,
    Exit(i32),
    Output(&'static str),
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Failure::NoCommand => write!(f, "no command to run"),
            Failure::Spawn(e) => write!(f, "cannot start: {e}"),
            Failure::Timeout(d) => write!(f, "no answer within {} ms", d.as_millis()),
            Failure::Signal => write!(f, "ended by a signal"),
            Failure::Exit(code) => write!(f, "exited {code}"),
            Failure::Output(what) => write!(f, "stdout was {what}"),
        }
    }
}

/// Whether `bytes` is one or more JSON values and nothing else (the shim's marker line precedes its answer).
fn is_json_stream(bytes: &[u8]) -> bool {
    let mut seen = false;
    for item in serde_json::Deserializer::from_slice(bytes).into_iter::<serde_json::Value>() {
        if item.is_err() {
            return false;
        }
        seen = true;
    }
    seen
}

/// Judges a finished route. `held` is stdout past what was already forwarded.
fn judge(code: Option<i32>, held: &[u8], empty_ok: bool) -> Result<i32, Failure> {
    let Some(code) = code else { return Err(Failure::Signal) };
    if code != 0 && code != 2 {
        return Err(Failure::Exit(code));
    }
    if held.iter().all(u8::is_ascii_whitespace) {
        return match (empty_ok, code) {
            (true, 0) => Ok(0),
            _ => Err(Failure::Output("empty")),
        };
    }
    if !is_json_stream(held) {
        return Err(Failure::Output("not JSON"));
    }
    Ok(code)
}

/// The longest a killed route is waited for; one that outlasts it is left to the job object or PDEATHSIG.
pub const REAP_BOUND: Duration = Duration::from_millis(100);

/// Calls `probe` until it answers or `bound` has passed; `None` when it never did.
fn poll_within<T>(bound: Duration, mut probe: impl FnMut() -> Option<T>) -> Option<T> {
    let end = Instant::now() + bound;
    loop {
        if let Some(found) = probe() {
            return Some(found);
        }
        if Instant::now() >= end {
            return None;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}

/// Kills `child` and waits up to `bound` for it to be reaped; the kill is issued before any wait.
fn kill_and_reap(child: &mut std::process::Child, bound: Duration) {
    let _ = child.kill();
    let _ = poll_within(bound, || matches!(child.try_wait(), Ok(Some(_)) | Err(_)).then_some(()));
}

fn read_pipe(mut pipe: impl Read, done: mpsc::Sender<Vec<u8>>) {
    let mut all = Vec::new();
    let mut forwarded = 0;
    let mut chunk = [0u8; 8192];
    while let Ok(n) = pipe.read(&mut chunk) {
        if n == 0 {
            break;
        }
        if all.len() < MAX_CAPTURE {
            all.extend_from_slice(&chunk[..n]);
        }
        if forwarded == 0 && all.starts_with(ASYNC_MARKER) {
            out::emit_partial(std::str::from_utf8(ASYNC_MARKER).unwrap_or(""));
            forwarded = ASYNC_MARKER.len();
        }
    }
    all.drain(..forwarded);
    let _ = done.send(all);
}

/// Runs `argv` with `reason` in its environment as [`crate::fallback::REASON_ENV`] and judges the result within `timeout`. On `Ok` the answer is already on stdout.
/// The one reap a route gets: [`kill_and_reap`] bounded by [`REAP_BOUND`].
fn reap(child: &mut std::process::Child) {
    reap_by(child, kill_and_reap);
}

/// Hands `how` the child and the bound a reap is allowed, which is [`REAP_BOUND`] and nothing else.
fn reap_by(child: &mut std::process::Child, how: impl FnOnce(&mut std::process::Child, Duration)) {
    how(child, REAP_BOUND);
}

pub fn exec(argv: &[OsString], stdin: Stdin, reason: &str, timeout: Duration, harness: &str, event: &str) -> Result<Outcome, Failure> {
    let Some((program, args)) = argv.split_first() else { return Err(Failure::NoCommand) };
    let end = Instant::now() + timeout;
    let mut cmd = Command::new(program);
    cmd.args(args).env(crate::fallback::REASON_ENV, reason).stdout(Stdio::piped()).stderr(Stdio::inherit());
    cmd.stdin(match stdin {
        Stdin::Inherit => Stdio::inherit(),
        Stdin::Bytes(_) => Stdio::piped(),
        Stdin::Null => Stdio::null(),
    });
    crate::sys::guard_child(&mut cmd);
    crate::sys::stop_handle_inheritance();
    let mut child = cmd.spawn().map_err(|e| Failure::Spawn(e.to_string()))?;
    crate::sys::adopt_child(&child);
    if let (Some(mut pipe), Stdin::Bytes(bytes)) = (child.stdin.take(), &stdin) {
        let payload = bytes.to_vec();
        // A child that exits without reading closes the pipe early; its exit code and answer still stand.
        std::thread::spawn(move || {
            let _ = pipe.write_all(&payload);
        });
    }
    let (tx, rx) = mpsc::channel();
    match child.stdout.take() {
        Some(pipe) => {
            std::thread::spawn(move || read_pipe(pipe, tx));
        }
        None => drop(tx),
    }
    // Only the direct child is killed and reaped: the hook server it started detached must outlive the call.
    let kill = reap;
    let left = |end: Instant| end.saturating_duration_since(Instant::now());
    let held = match rx.recv_timeout(left(end)) {
        Ok(bytes) => bytes,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            kill(&mut child);
            return Err(Failure::Timeout(timeout));
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => Vec::new(),
    };
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if left(end).is_zero() => {
                kill(&mut child);
                return Err(Failure::Timeout(timeout));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(2)),
            Err(e) => return Err(Failure::Spawn(format!("lost track of the child: {e}"))),
        }
    };
    let empty_ok = out::safe_answer(harness, event).is_empty();
    let code = judge(status.code(), &held, empty_ok)?;
    out::emit(&String::from_utf8_lossy(&held));
    Ok(Outcome { code })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// How long a test waits on an event (a pidfile, a process ending); a cap that only a broken run reaches.
    const BACKSTOP: Duration = Duration::from_secs(60);

    #[test]
    fn only_a_parseable_answer_from_an_ordinary_ending_is_served() {
        assert_eq!(judge(Some(0), b"{}", false).unwrap(), 0);
        assert_eq!(judge(Some(0), b"{\"a\":1}\n{\"b\":2}", false).unwrap(), 0);
        assert_eq!(judge(Some(2), b"{\"decision\":\"deny\"}", false).unwrap(), 2);
        assert!(matches!(judge(None, b"{}", false), Err(Failure::Signal)));
        assert!(matches!(judge(Some(7), b"{}", false), Err(Failure::Exit(7))));
        assert!(matches!(judge(Some(1), b"{}", false), Err(Failure::Exit(1))));
        assert!(matches!(judge(Some(0), b"hello", false), Err(Failure::Output(_))));
        assert!(matches!(judge(Some(0), b"{} junk", false), Err(Failure::Output(_))));
        assert!(matches!(judge(Some(0), b"", false), Err(Failure::Output("empty"))));
        assert!(matches!(judge(Some(2), b"", true), Err(Failure::Output("empty"))));
    }

    #[test]
    fn an_empty_answer_serves_only_where_the_safe_answer_is_empty() {
        assert_eq!(judge(Some(0), b"", true).unwrap(), 0);
    }

    #[test]
    fn a_probe_that_never_answers_is_given_up_on_within_its_bound() {
        let (tx, rx) = mpsc::channel();
        // owner: this test; the thread ends with the test process if the bound were ignored
        std::thread::spawn(move || {
            let _ = tx.send(poll_within(Duration::from_millis(50), || None::<()>));
        });
        let got = rx.recv_timeout(Duration::from_secs(10)).expect("poll_within outlived its bound");
        assert!(got.is_none());
        let mut calls = 0;
        let third = poll_within(Duration::from_secs(10), || {
            calls += 1;
            (calls == 3).then_some(calls)
        });
        assert_eq!(third, Some(3));
    }

    /// Hanging child for the next test: `--ignored --exact <this> pidfile=<path>` writes its pid, then hangs.
    #[test]
    #[ignore = "only runs as the hanging child of the kill tests below"]
    fn hang_child() {
        let Some(path) = std::env::args().find_map(|a| a.strip_prefix("pidfile=").map(String::from)) else { return };
        std::fs::write(path, std::process::id().to_string()).unwrap();
        // Outlives BACKSTOP, so an unkilled child fails the tests waiting on it.
        std::thread::sleep(Duration::from_secs(120));
    }

    /// Whether no process, not even an unreaped zombie, answers to `pid`.
    fn process_is_gone(pid: u32) -> bool {
        #[cfg(unix)]
        {
            // SAFETY: signal 0 only checks that the pid exists.
            let sent = unsafe { libc::kill(pid as libc::pid_t, 0) };
            sent == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
        }
        #[cfg(windows)]
        {
            use windows_sys::Win32::Foundation::{CloseHandle, ERROR_INVALID_PARAMETER};
            use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
            const STILL_ACTIVE: u32 = 259;
            // SAFETY: a query-only handle to a pid, closed below; the exit code is one u32 of ours.
            unsafe {
                let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
                if handle.is_null() {
                    return std::io::Error::last_os_error().raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32);
                }
                let mut code = 0u32;
                let known = GetExitCodeProcess(handle, &mut code) != 0;
                CloseHandle(handle);
                known && code != STILL_ACTIVE
            }
        }
    }

    #[test]
    fn a_hung_route_is_killed_when_exec_times_out() {
        let pidfile = std::env::temp_dir().join(format!("tg-cap-{}.pid", std::process::id()));
        let _ = std::fs::remove_file(&pidfile);
        let me = std::env::current_exe().unwrap().into_os_string();
        let argv = [me, "--ignored".into(), "--exact".into(), "capture::tests::hang_child".into(), format!("pidfile={}", pidfile.display()).into()];
        let limit = Duration::from_millis(2500);
        let ended = exec(&argv, Stdin::Null, "t", limit, "grok", "pre_tool_use");
        assert!(matches!(ended, Err(Failure::Timeout(_))), "the hung route must time out");
        let text = poll_within(BACKSTOP, || std::fs::read_to_string(&pidfile).ok().filter(|t| t.trim().parse::<u32>().is_ok())).unwrap_or_default();
        let _ = std::fs::remove_file(&pidfile);
        let pid: u32 = text.trim().parse().expect("the hung route never wrote its pid");
        // The kill was issued before exec returned; the wait here is on the process ending, not on the production reap bound.
        assert!(poll_within(BACKSTOP, || process_is_gone(pid).then_some(())).is_some(), "pid {pid} of the hung route was still alive after exec returned");
    }

    #[test]
    fn a_poll_whose_bound_has_passed_gives_up_instead_of_probing_on() {
        let mut calls = 0;
        let found = poll_within(Duration::ZERO, || {
            calls += 1;
            (calls > 1).then_some(())
        });
        assert!(found.is_none(), "a zero bound allows the first probe only");
    }

    #[test]
    fn a_poll_that_never_answers_returns_none_at_its_bound() {
        assert!(poll_within(Duration::from_millis(1), || None::<()>).is_none(), "a poll that never answers returns None");
    }

    #[test]
    fn the_reap_a_route_gets_is_bounded_by_the_reap_bound() {
        let mut child = Command::new(std::env::current_exe().unwrap()).args(["--list"]).stdout(Stdio::null()).spawn().unwrap();
        let mut bound = None;
        reap_by(&mut child, |_, given| bound = Some(given));
        let _ = child.kill();
        let _ = child.wait();
        assert_eq!(bound, Some(REAP_BOUND), "the reap must be handed REAP_BOUND");
    }

    #[test]
    fn the_production_reap_leaves_the_child_gone_once_its_pidfile_shows_it_started() {
        let pidfile = std::env::temp_dir().join(format!("tg-cap-reap-{}.pid", std::process::id()));
        let _ = std::fs::remove_file(&pidfile);
        let me = std::env::current_exe().unwrap();
        let mut child = Command::new(me).args(["--ignored", "--exact", "capture::tests::hang_child"]).arg(format!("pidfile={}", pidfile.display())).stdout(Stdio::null()).spawn().unwrap();
        let started = poll_within(BACKSTOP, || pidfile.exists().then_some(()));
        let pid = child.id();
        if started.is_none() {
            let _ = child.kill();
            let _ = child.wait();
        }
        let _ = std::fs::remove_file(&pidfile);
        assert!(started.is_some(), "the hang child never wrote its pidfile");
        reap(&mut child);
        let gone = poll_within(BACKSTOP, || process_is_gone(pid).then_some(())).is_some();
        let _ = child.kill();
        let _ = child.wait();
        assert!(gone, "kill_and_reap returned with pid {pid} still alive");
    }
}
