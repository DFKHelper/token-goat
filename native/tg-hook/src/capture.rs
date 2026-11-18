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
    let kill = |child: &mut std::process::Child| {
        let _ = child.kill();
        let _ = child.wait();
    };
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
}
