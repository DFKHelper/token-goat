//! Runs one Node route with its stdout captured, and judges it: a route is served only if it ended on its own, with exit 0 (or 2 and an answer, a deliberate block), and printed answers the host can parse. The Claude shim's first line, `{"async":true}`, is forwarded at once so the host is released early exactly as it is today; everything else is held until the route is judged, so a crash or garbage never reaches the host.

use std::ffi::OsString;
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use crate::out;
use crate::sys::Group;

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

/// Whether `bytes` is one or more JSON objects and nothing else (the shim's marker line precedes its answer).
fn is_json_stream(bytes: &[u8]) -> bool {
    let mut seen = false;
    for item in serde_json::Deserializer::from_slice(bytes).into_iter::<serde_json::Value>() {
        // No host accepts a bare null, number, string or array as a hook answer.
        if !matches!(item, Ok(serde_json::Value::Object(_))) {
            return false;
        }
        seen = true;
    }
    seen
}

/// Judges a finished route. `held` is stdout past what was already forwarded.
fn judge(code: Option<i32>, held: &[u8], held_err: &[u8], empty_ok: bool) -> Result<i32, Failure> {
    let Some(code) = code else { return Err(Failure::Signal) };
    if code != 0 && code != 2 {
        return Err(Failure::Exit(code));
    }
    if held.iter().all(u8::is_ascii_whitespace) {
        return match (empty_ok, code) {
            (true, 0) => Ok(0),
            // Node never exits 2 by itself: a block that speaks on stderr alone is a deliberate answer.
            (_, 2) if !held_err.iter().all(u8::is_ascii_whitespace) => Ok(2),
            _ => Err(Failure::Output("empty")),
        };
    }
    if !is_json_stream(held) {
        return Err(Failure::Output("not JSON"));
    }
    Ok(code)
}

/// The most stderr a route's block message may carry through.
const STDERR_CAP: u64 = 64 * 1024;

/// Keeps the first `cap` bytes of `pipe` and drains the rest, so a chatty route never stalls on a full pipe.
fn read_capped(mut pipe: impl Read, cap: u64) -> Vec<u8> {
    let mut all = Vec::new();
    let _ = pipe.by_ref().take(cap).read_to_end(&mut all);
    let _ = std::io::copy(&mut pipe, &mut std::io::sink());
    all
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

/// What a route's stdout read ends with: the bytes past the forwarded marker, or that more than `cap` arrived.
type Captured = Result<Vec<u8>, &'static str>;

/// Reads `pipe` to its end so the route never stalls; a stream past `cap` bytes is a failed route.
fn read_pipe(mut pipe: impl Read, cap: usize, done: mpsc::Sender<Captured>) {
    let mut all = Vec::new();
    let mut over = false;
    let mut forwarded = 0;
    let mut chunk = [0u8; 8192];
    while let Ok(n) = pipe.read(&mut chunk) {
        if n == 0 {
            break;
        }
        if all.len() + n <= cap {
            all.extend_from_slice(&chunk[..n]);
        } else {
            over = true;
        }
        if forwarded == 0 && all.starts_with(ASYNC_MARKER) {
            out::emit_partial(std::str::from_utf8(ASYNC_MARKER).unwrap_or(""));
            forwarded = ASYNC_MARKER.len();
        }
    }
    all.drain(..forwarded);
    let _ = done.send(if over { Err("larger than the capture limit") } else { Ok(all) });
}

/// Runs `argv` with `reason` in its environment as [`crate::fallback::REASON_ENV`] and judges the result within `timeout`. On `Ok` the answer is already on stdout.
/// The one reap a route gets: [`kill_and_reap`] bounded by [`REAP_BOUND`].
fn reap(child: &mut std::process::Child) {
    reap_by(child, kill_and_reap);
}

/// What a timed-out or failed route gets: its whole group ended, then the one reap of its direct child.
fn reap_route(child: &mut std::process::Child, group: &Group) {
    reap_route_by(child, group, crate::sys::end_group);
}

/// [`reap_route`] with the group's end passed in, so a row can see what the route's end is handed.
fn reap_route_by(child: &mut std::process::Child, group: &Group, end: impl FnOnce(&Group)) {
    end(group);
    reap(child);
}

/// Hands `how` the child and the bound a reap is allowed, which is [`REAP_BOUND`] and nothing else.
fn reap_by(child: &mut std::process::Child, how: impl FnOnce(&mut std::process::Child, Duration)) {
    how(child, REAP_BOUND);
}

/// Held from clearing inheritance flags until the child exists, so two runs never interleave those steps.
static SPAWN: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// What a run saw, kept so a test failure can name its evidence: the wait that ended the stdout read, the status, the bytes.
#[derive(Debug, Default)]
pub struct Trace {
    pub stdout_ended_by: &'static str,
    pub status: Option<Option<i32>>,
    pub stdout_bytes: Option<usize>,
    pub stderr_bytes: Option<usize>,
}

pub fn exec(argv: &[OsString], stdin: Stdin, reason: &str, timeout: Duration, harness: &str, event: &str) -> Result<Outcome, Failure> {
    exec_traced(argv, stdin, reason, timeout, harness, event, &mut Trace::default())
}

#[rustfmt::skip]
fn exec_traced(
    argv: &[OsString], stdin: Stdin, reason: &str, timeout: Duration, harness: &str, event: &str,
    trace: &mut Trace,
) -> Result<Outcome, Failure> {
    let Some((program, args)) = argv.split_first() else { return Err(Failure::NoCommand) };
    let end = Instant::now() + timeout;
    let mut cmd = Command::new(program);
    cmd.args(args).env(crate::fallback::REASON_ENV, reason).stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.stdin(match stdin {
        Stdin::Inherit => Stdio::inherit(),
        Stdin::Bytes(_) => Stdio::piped(),
        Stdin::Null => Stdio::null(),
    });
    crate::sys::guard_child(&mut cmd);
    // One thread clearing inherit flags while another spawns hands that child dead stdio (exit 0, no output).
    let spawning = SPAWN.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    crate::sys::stop_handle_inheritance();
    let spawned = cmd.spawn().map_err(|e| Failure::Spawn(e.to_string()));
    drop(spawning);
    let mut child = spawned?;
    let group = crate::sys::adopt_child(&child);
    if let (Some(mut pipe), Stdin::Bytes(bytes)) = (child.stdin.take(), &stdin) {
        let payload = bytes.to_vec();
        // A child that exits without reading closes the pipe early; its exit code and answer still stand.
        std::thread::spawn(move || {
            let _ = pipe.write_all(&payload);
        });
    }
    // stderr is held, never inherited: a broken route's loader noise must not reach the host.
    let (err_tx, err_rx) = mpsc::channel();
    match child.stderr.take() {
        Some(pipe) => {
            std::thread::spawn(move || {
                let _ = err_tx.send(read_capped(pipe, STDERR_CAP));
            });
        }
        None => drop(err_tx),
    }
    let (tx, rx) = mpsc::channel();
    match child.stdout.take() {
        Some(pipe) => {
            std::thread::spawn(move || read_pipe(pipe, MAX_CAPTURE, tx));
        }
        None => drop(tx),
    }
    // The route's whole group is ended, then its direct child reaped; a descendant that left the group or job on purpose (the detached hook server) is not chased.
    let kill = |child: &mut std::process::Child| reap_route(child, &group);
    let left = |end: Instant| end.saturating_duration_since(Instant::now());
    let held = match rx.recv_timeout(left(end)) {
        Ok(Ok(bytes)) => {
            trace.stdout_ended_by = "the stdout reader finished";
            trace.stdout_bytes = Some(bytes.len());
            bytes
        }
        Ok(Err(what)) => {
            kill(&mut child);
            return Err(Failure::Output(what));
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            kill(&mut child);
            return Err(Failure::Timeout(timeout));
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            trace.stdout_ended_by = "the stdout reader was gone without an answer";
            Vec::new()
        }
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
    // The route ended by itself, so what it started (the hook server) is left running; a failed release changes no answer.
    let _ = crate::sys::release_group(&group);
    crate::sys::close_group(group);
    let empty_ok = out::safe_answer(harness, event).is_empty();
    // Only a served route (exit 0 or a deliberate 2) passes stderr on; the wait ends with the pipe or the deadline.
    let held_err = if matches!(status.code(), Some(0 | 2)) {
        err_rx.recv_timeout(left(end)).unwrap_or_default()
    } else {
        Vec::new()
    };
    trace.status = Some(status.code());
    trace.stderr_bytes = Some(held_err.len());
    let code = judge(status.code(), &held, &held_err, empty_ok)?;
    out::emit(&String::from_utf8_lossy(&held));
    let _ = std::io::stderr().write_all(&held_err);
    Ok(Outcome { code })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// How long a test waits on an event (a pidfile, a process ending); a cap that only a broken run reaches.
    const BACKSTOP: Duration = Duration::from_secs(60);

    #[test]
    fn only_a_parseable_answer_from_an_ordinary_ending_is_served() {
        assert_eq!(judge(Some(0), b"{}", b"", false).unwrap(), 0);
        assert_eq!(judge(Some(0), b"{\"a\":1}\n{\"b\":2}", b"", false).unwrap(), 0);
        assert_eq!(judge(Some(2), b"{\"decision\":\"deny\"}", b"", false).unwrap(), 2);
        assert!(matches!(judge(None, b"{}", b"", false), Err(Failure::Signal)));
        assert!(matches!(judge(Some(7), b"{}", b"", false), Err(Failure::Exit(7))));
        assert!(matches!(judge(Some(1), b"{}", b"", false), Err(Failure::Exit(1))));
        assert!(matches!(judge(Some(0), b"hello", b"", false), Err(Failure::Output(_))));
        assert!(matches!(judge(Some(0), b"{} junk", b"", false), Err(Failure::Output(_))));
        assert!(matches!(judge(Some(0), b"", b"", false), Err(Failure::Output("empty"))));
        assert_eq!(judge(Some(0), b"{\"decision\":\"deny\"}", b"", false).unwrap(), 0);
        assert_eq!(judge(Some(0), b"", b"", true).unwrap(), 0);
    }

    #[test]
    fn an_answer_that_is_not_a_json_object_is_a_failed_route() {
        for bad in [&b"null"[..], b"3", b"\"text\"", b"[]", b"true", b"{}\nnull", b"[{}]"] {
            let verdict = judge(Some(0), bad, b"", false);
            assert!(matches!(verdict, Err(Failure::Output("not JSON"))), "{bad:?}: {verdict:?}");
            assert!(matches!(judge(Some(2), bad, b"", false), Err(Failure::Output("not JSON"))));
        }
        assert!(matches!(judge(Some(2), b"", b"", true), Err(Failure::Output("empty"))));
    }

    #[test]
    fn exit_two_blocks_only_when_it_carries_a_message_or_a_decision() {
        // The guard forms (sh, PowerShell, cmd) apply the same rule: a silent exit 2 is a crash, not a block.
        assert!(matches!(judge(Some(2), b"", b"", false), Err(Failure::Output("empty"))));
        assert!(matches!(judge(Some(2), b"\n", b" \r\n", true), Err(Failure::Output("empty"))));
        assert_eq!(judge(Some(2), b"", b"blocked: use the other command\n", false).unwrap(), 2);
        assert_eq!(judge(Some(2), b"{\"decision\":\"deny\"}", b"", false).unwrap(), 2);
    }

    #[test]
    fn a_capped_stream_keeps_its_head_and_is_read_to_the_end() {
        let data = vec![b'x'; 1000];
        let mut reader = std::io::Cursor::new(data);
        let kept = read_capped(&mut reader, 100);
        assert_eq!(kept.len(), 100);
        assert_eq!(reader.position(), 1000, "the rest of the stream was left unread");
    }

    /// Child for the next test: `--ignored --exact <this>` writes past the stderr cap, answers `{}`, exit 0.
    #[test]
    #[ignore = "only runs as the chatty child of the test below"]
    fn chatty_child() {
        if !std::env::args().any(|a| a == "capture::tests::chatty_child") {
            return;
        }
        let block = [b'e'; 8192];
        let mut err = std::io::stderr();
        for _ in 0..(STDERR_CAP as usize / block.len() * 4) {
            // A reader that closed its end early makes this fail, and the child then exits 101, not 0.
            err.write_all(&block).expect("stderr was closed by the reader");
        }
        println!("{{}}");
    }

    fn run_traced(argv: &[OsString]) -> (Result<Outcome, Failure>, Trace) {
        let mut trace = Trace::default();
        let got = exec_traced(argv, Stdin::Null, "test", BACKSTOP, "claudecode", "pre_tool_use", &mut trace);
        (got, trace)
    }

    #[test]
    fn a_route_writing_past_the_stderr_cap_is_served_when_it_exits() {
        let me = std::env::current_exe().unwrap().into_os_string();
        let test = "capture::tests::chatty_child".into();
        let argv = vec![me, "--ignored".into(), "--exact".into(), test, "--nocapture".into()];
        // Without a drain the reader closes at the cap: the child's write fails and it exits 101, not 0.
        // The harness prints its own header on stdout, so a child that ended on exit 0 is judged "not JSON":
        // that verdict is only reachable after the child exited and its stderr was drained.
        let (got, trace) = run_traced(&argv);
        match got {
            Err(Failure::Timeout(_)) => panic!("the route stalled on its full stderr pipe: {trace:?}"),
            Err(Failure::Output(what)) => assert_eq!(what, "not JSON", "not ended on exit 0: {trace:?}"),
            Err(other) => panic!("expected a judged exit 0, got: {other}: {trace:?}"),
            Ok(_) => panic!("the harness header cannot be a JSON answer"),
        }
    }

    #[test]
    fn routes_started_together_each_get_their_own_stdio() {
        let me = std::env::current_exe().unwrap().into_os_string();
        let argv = vec![me, "--list".into()];
        let runs: Vec<_> = (0..8)
            .map(|_| {
                let argv = argv.clone();
                std::thread::spawn(move || {
                    let (got, trace) = run_traced(&argv);
                    (matches!(got, Err(Failure::Output("not JSON"))), format!("{:?} {trace:?}", got.err()))
                })
            })
            .collect();
        for run in runs {
            let (listed, seen) = run.join().unwrap();
            assert!(listed, "a started route lost its stdout: {seen}");
        }
    }

    fn captured(bytes: &[u8], cap: usize) -> Captured {
        let (tx, rx) = mpsc::channel();
        read_pipe(std::io::Cursor::new(bytes.to_vec()), cap, tx);
        rx.recv().unwrap()
    }

    #[test]
    fn a_stdout_stream_up_to_the_cap_is_kept_whole() {
        let json = b"{\"a\":1}\n{\"b\":2}\n";
        assert_eq!(captured(json, json.len()), Ok(json.to_vec()));
    }

    #[test]
    fn a_stdout_stream_one_byte_past_the_cap_is_a_failed_route_not_a_cut_answer() {
        // A cut that lands on a complete JSON value would otherwise judge as a valid answer.
        let json = b"{\"a\":1}\n{\"b\":2}\n";
        assert_eq!(captured(json, json.len() - 1), Err("larger than the capture limit"));
        let cut = judge(Some(0), &json[..8], b"", false);
        assert!(matches!(cut, Ok(0)), "the cut prefix alone is a valid answer");
    }

    #[test]
    fn an_over_cap_stream_is_still_read_to_its_end() {
        let big = vec![b'x'; 3 * 8192 + 5];
        assert_eq!(captured(&big, 8192), Err("larger than the capture limit"));
    }

    #[test]
    fn an_empty_answer_serves_only_where_the_safe_answer_is_empty() {
        assert_eq!(judge(Some(0), b"", b"", true).unwrap(), 0);
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

    /// The pidfile of the calling test, named after its own function path, so no two tests share one.
    macro_rules! own_pidfile {
        () => {{
            fn marker() {}
            pidfile_for(std::any::type_name_of_val(&marker))
        }};
    }

    /// Maps a function path to a pidfile name; tests share one process id, so the path is the key.
    fn pidfile_for(path: &str) -> std::path::PathBuf {
        let name: String = path.chars().map(|c| if c.is_alphanumeric() { c } else { '-' }).collect();
        std::env::temp_dir().join(format!("tg-cap-{name}-{}.pid", std::process::id()))
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

    /// Ends the process whose pid `hang_child` wrote to the file, if it is still running, and removes the file.
    struct ReapRecordedChild(std::path::PathBuf);

    impl Drop for ReapRecordedChild {
        fn drop(&mut self) {
            let recorded = std::fs::read_to_string(&self.0).ok().and_then(|t| t.trim().parse::<u32>().ok());
            let _ = std::fs::remove_file(&self.0);
            if let Some(pid) = recorded.filter(|&pid| !process_is_gone(pid)) {
                kill_pid(pid);
            }
        }
    }

    /// Kills `pid` with the platform's own tool, since this crate adds no `unsafe`.
    fn kill_pid(pid: u32) {
        #[cfg(unix)]
        let mut kill = Command::new("kill");
        #[cfg(unix)]
        kill.args(["-9", &pid.to_string()]);
        #[cfg(windows)]
        let mut kill = Command::new("taskkill");
        #[cfg(windows)]
        kill.args(["/PID", &pid.to_string(), "/T", "/F"]);
        let _ = kill.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
    }

    #[test]
    fn a_red_hung_route_row_leaves_its_child_killed() {
        let pidfile = own_pidfile!();
        let _ = std::fs::remove_file(&pidfile);
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "capture::tests::hang_child"])
            .arg(format!("pidfile={}", pidfile.display()))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let recorded = poll_within(BACKSTOP, || std::fs::read_to_string(&pidfile).ok().and_then(|t| t.trim().parse::<u32>().ok()));
        let reap = ReapRecordedChild(pidfile);
        let Some(pid) = recorded else {
            let _ = child.kill();
            let _ = child.wait();
            panic!("the child never recorded its pid");
        };
        assert_eq!(pid, child.id(), "the recorded pid is the child's");
        drop(reap);
        let gone = poll_within(BACKSTOP, || {
            let _ = child.try_wait();
            process_is_gone(pid).then_some(())
        })
        .is_some();
        // Whatever the guard did, this test ends its own child.
        let _ = child.kill();
        let _ = child.wait();
        assert!(gone, "the guard left pid {pid} of the hung child running");
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
        let pidfile = own_pidfile!();
        // Ends the hung child by its recorded pid however this test ends, so a red row leaves nothing running.
        let _reap = ReapRecordedChild(pidfile.clone());
        let me = std::env::current_exe().unwrap().into_os_string();
        let argv = vec![me, "--ignored".into(), "--exact".into(), "capture::tests::hang_child".into(), format!("pidfile={}", pidfile.display()).into()];
        // A run that overran its limit before the child wrote its pid recorded none: it says nothing about the kill, so another run follows.
        let pid = poll_within(BACKSTOP, || {
            let _ = std::fs::remove_file(&pidfile);
            let (done, ended) = mpsc::channel();
            let route = argv.clone();
            // owner: this test; exec ends the child at its limit, and the thread ends with exec
            std::thread::spawn(move || {
                let _ = done.send(exec(&route, Stdin::Null, "t", Duration::from_millis(2500), "grok", "pre_tool_use"));
            });
            let ended = ended.recv_timeout(BACKSTOP).expect("exec did not return");
            assert!(matches!(ended, Err(Failure::Timeout(_))), "the hung route must time out");
            std::fs::read_to_string(&pidfile).ok().and_then(|t| t.trim().parse::<u32>().ok())
        });
        let pid = pid.expect("no run of the hung route recorded its pid before it was killed");
        // The kill was issued before exec returned; the wait here is on the process ending, not on the production reap bound.
        assert!(poll_within(BACKSTOP, || process_is_gone(pid).then_some(())).is_some(), "pid {pid} of the hung route was still alive after exec returned");
    }

    /// Hanging route that starts a hanging child of its own: `parentfile=<path>` gets its pid, `childfile=<path>` the child's.
    #[test]
    #[ignore = "only runs as the route of the grandchild kill test below"]
    fn hang_parent() {
        let arg = |key: &str| std::env::args().find_map(|a| a.strip_prefix(key).map(String::from));
        let (Some(parentfile), Some(childfile)) = (arg("parentfile="), arg("childfile=")) else { return };
        std::fs::write(parentfile, std::process::id().to_string()).unwrap();
        let grandchild = Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "capture::tests::hang_child"])
            .arg(format!("pidfile={childfile}"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        drop(grandchild);
        std::thread::sleep(Duration::from_secs(120));
    }

    /// Route that starts a detached hanging child (`childfile=<path>` gets its pid), waits for the pid, answers `{}`, exits.
    #[test]
    #[ignore = "only runs as the route of the in-time test below"]
    fn exit_parent() {
        let arg = |key: &str| std::env::args().find_map(|a| a.strip_prefix(key).map(String::from));
        let Some(childfile) = arg("childfile=") else { return };
        // As Node does at startup, so the child does not hold this route's stdout pipe open past the route's exit.
        crate::sys::stop_handle_inheritance();
        let mut cmd = Command::new(std::env::current_exe().unwrap());
        cmd.args(["--ignored", "--exact", "capture::tests::hang_child"]).arg(format!("pidfile={childfile}"));
        cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP, as Node's detached spawn.
            cmd.creation_flags(0x8 | 0x200);
        }
        drop(cmd.spawn());
        // Bounded by BACKSTOP; the row asserts on the pid, so a child that never wrote it fails there.
        let _ = poll_within(BACKSTOP, || std::fs::metadata(&childfile).is_ok().then_some(()));
        println!("{{}}");
    }

    #[test]
    fn a_route_that_ends_in_time_leaves_what_it_started_running() {
        let pidfile = own_pidfile!();
        let _ = std::fs::remove_file(&pidfile);
        // Ends the recorded grandchild however this test ends, so a red row leaves nothing running.
        let _reap = ReapRecordedChild(pidfile.clone());
        let me = std::env::current_exe().unwrap().into_os_string();
        let test = "capture::tests::exit_parent".into();
        let file = format!("childfile={}", pidfile.display()).into();
        let argv = vec![me, "--ignored".into(), "--exact".into(), test, file];
        let ended = exec(&argv, Stdin::Null, "t", BACKSTOP, "claudecode", "pre_tool_use");
        // The harness header makes the route's stdout "not JSON", a verdict reached only once the route exited by itself.
        match ended {
            Err(Failure::Output(what)) => assert_eq!(what, "not JSON", "the route did not end on its own exit"),
            Err(other) => panic!("the route did not end on its own exit: {other}"),
            Ok(_) => panic!("the harness header cannot be a JSON answer"),
        }
        let read = || std::fs::read_to_string(&pidfile).ok().and_then(|t| t.trim().parse::<u32>().ok());
        let pid = poll_within(BACKSTOP, read).expect("the route's child never recorded its pid");
        assert!(!process_is_gone(pid), "grandchild pid {pid} was ended with a route that finished in time");
    }

    #[test]
    fn the_end_of_a_route_is_handed_its_group_and_not_only_its_child() {
        let me = std::env::current_exe().unwrap();
        let mut child = Command::new(me).args(["--list"]).stdout(Stdio::null()).spawn().unwrap();
        let group = crate::sys::adopt_child(&child);
        let mut handed = None;
        reap_route_by(&mut child, &group, |g| handed = Some(g.clone()));
        let _ = child.kill();
        let _ = child.wait();
        assert_eq!(handed, Some(group.clone()), "the route's end must be handed its group");
        assert_eq!(group.leader, child.id(), "the group must be the one the route heads");
    }

    #[test]
    fn a_timed_out_route_takes_the_child_it_started_with_it() {
        let pidfile = own_pidfile!();
        let parentfile = pidfile.with_extension("parent");
        // Each recorded pid is ended however this test ends, so a red row leaves nothing running.
        let _reap_child = ReapRecordedChild(pidfile.clone());
        let _reap_parent = ReapRecordedChild(parentfile.clone());
        let me = std::env::current_exe().unwrap().into_os_string();
        let argv = vec![
            me,
            "--ignored".into(),
            "--exact".into(),
            "capture::tests::hang_parent".into(),
            format!("parentfile={}", parentfile.display()).into(),
            format!("childfile={}", pidfile.display()).into(),
        ];
        // A run that overran its limit before the grandchild wrote its pid says nothing about the kill, so another run follows.
        let pid = poll_within(BACKSTOP, || {
            let _ = std::fs::remove_file(&pidfile);
            let (done, ended) = mpsc::channel();
            let route = argv.clone();
            // owner: this test; exec ends the route at its limit, and the thread ends with exec
            std::thread::spawn(move || {
                let limit = Duration::from_millis(2500);
                let _ = done.send(exec(&route, Stdin::Null, "t", limit, "grok", "pre_tool_use"));
            });
            let ended = ended.recv_timeout(BACKSTOP).expect("exec did not return");
            assert!(matches!(ended, Err(Failure::Timeout(_))), "the hung route must time out");
            std::fs::read_to_string(&pidfile).ok().and_then(|t| t.trim().parse::<u32>().ok())
        });
        let pid = pid.expect("no run of the route recorded its grandchild's pid before it was killed");
        let gone = poll_within(BACKSTOP, || process_is_gone(pid).then_some(())).is_some();
        assert!(gone, "grandchild pid {pid} outlived its route");
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
        let pidfile = own_pidfile!();
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

    #[test]
    fn a_block_that_speaks_on_stderr_alone_is_an_answer_but_only_from_exit_2() {
        assert_eq!(judge(Some(2), b"", b"blocked: use the other command", true).unwrap(), 2);
        assert!(matches!(judge(Some(2), b"", b"  \n", true), Err(Failure::Output("empty"))));
        assert!(matches!(judge(Some(1), b"", b"loader noise", true), Err(Failure::Exit(1))));
        assert!(matches!(judge(Some(13), b"{}", b"loader noise", true), Err(Failure::Exit(13))));
    }
}
