//! The one place this process answers the host and the one place it ends. Every ending a hook call can take goes through [`finish`], [`fail_open`] or the panic hook installed by [`install_panic_hook`], and every byte of the answer through [`emit`], so the host is always given exactly one valid answer for its harness and event, and never an exit code that blocks the tool call it was asked about.

use std::io::Write;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// The harness and event of the call in flight, set once the flags are parsed; what a panic or a failure far from the parser answers for.
static CONTEXT: Mutex<Option<(String, String)>> = Mutex::new(None);
/// Whether any byte of an answer has been written to stdout.
static ANSWERED: AtomicBool = AtomicBool::new(false);
/// Whether the leading async marker has been written to stdout.
static MARKER_SENT: AtomicBool = AtomicBool::new(false);

const TABLE: &str = include_str!("../safe_answers.json");

/// Records the call this process is serving.
pub fn set_context(harness: &str, event: &str) {
    if let Ok(mut slot) = CONTEXT.lock() {
        *slot = Some((harness.to_string(), event.to_string()));
    }
}

fn context() -> (String, String) {
    CONTEXT.try_lock().ok().and_then(|slot| slot.clone()).unwrap_or_default()
}

/// The harness whose rows in the safe-answer and limit tables serve `harness`: VS Code runs the Copilot hooks that `copilot_cli` runs.
pub fn table_harness(harness: &str) -> &str {
    match harness {
        "vscode" => "copilot_cli",
        other => other,
    }
}

/// What `harness` is answered when nothing could run for `event`: its no-op, or the event's own where the harness distinguishes one (Grok `pre_tool_use` must be told to allow). An unknown harness gets `{}`. The table is `safe_answers.json`, which tests/native_hook_conformance.test.ts compares with `noopFor` in src/hook_adapters.ts.
pub fn safe_answer(harness: &str, event: &str) -> String {
    let parsed: Option<serde_json::Value> = serde_json::from_str(TABLE).ok();
    let harness = table_harness(harness);
    let entry = parsed.as_ref().and_then(|table| table.get(harness));
    let own = entry.and_then(|e| e.get("events")).and_then(|events| events.get(event)).and_then(|v| v.as_str());
    let noop = entry.and_then(|e| e.get("noop")).and_then(|v| v.as_str());
    own.or(noop).unwrap_or("{}").to_string()
}

/// The call's deadline, set once by the entry point; a stdout write still unfinished then ends the process.
static DEADLINE: Mutex<Option<Instant>> = Mutex::new(None);
/// Whether a stdout write is in flight on the writer thread, which holds the stdout lock until it ends.
static WRITING: AtomicBool = AtomicBool::new(false);

/// How long a write may take once the deadline has passed, so a ready pipe is not mistaken for a blocked one.
// limit: a pipe nobody reads ends the process this long after the deadline at the latest; revisit-when: never
const WRITE_GRACE: Duration = Duration::from_millis(20);

/// Records the deadline that bounds every write of an answer; `None` leaves writes unbounded (the self-tests).
pub fn set_deadline(deadline: Option<Instant>) {
    if let Ok(mut slot) = DEADLINE.lock() {
        *slot = deadline;
    }
}

fn write_now(data: &[u8]) {
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(data);
    let _ = out.flush();
}

/// The one place bytes reach stdout; a write unfinished at the deadline (a host not reading) exits 0.
fn write_bounded(data: &str) {
    let Some(end) = DEADLINE.lock().ok().and_then(|slot| *slot) else { return write_now(data.as_bytes()) };
    let bytes = data.as_bytes().to_vec();
    let (tx, rx) = std::sync::mpsc::channel();
    WRITING.store(true, Ordering::SeqCst);
    // owner: this call; dies when the process exits, which a write still blocked at the deadline ends
    std::thread::spawn(move || {
        write_now(&bytes);
        let _ = tx.send(());
    });
    let wait = end.saturating_duration_since(Instant::now()).max(WRITE_GRACE);
    if let Err(std::sync::mpsc::RecvTimeoutError::Timeout) = rx.recv_timeout(wait) {
        std::process::exit(0)
    }
    WRITING.store(false, Ordering::SeqCst);
}

/// Writes `data` to stdout at once and marks the call answered. A host that has stopped reading is not this client's failure to report, so a write error is dropped.
pub fn emit(data: &str) {
    if data.is_empty() {
        return;
    }
    ANSWERED.store(true, Ordering::SeqCst);
    write_bounded(data);
}

/// Writes a leading part of an answer (the async marker) that the final answer follows; does not mark the call answered. Only the first is written: a later route's marker would be a second one.
pub fn emit_partial(data: &str) {
    if claim_marker(&MARKER_SENT) {
        write_bounded(data);
    }
}

/// Whether this is the first claim on `sent`; every later one is not.
fn claim_marker(sent: &AtomicBool) -> bool {
    !sent.swap(true, Ordering::SeqCst)
}

/// Whether a final answer has been written to stdout.
pub fn answered() -> bool {
    ANSWERED.load(Ordering::SeqCst)
}

/// Flushes stdout and ends the process with `code`.
pub fn finish(code: i32) -> ! {
    // A writer thread blocked in a write holds the stdout lock, so a flush here would wait on it.
    if !WRITING.load(Ordering::SeqCst) {
        let _ = std::io::stdout().flush();
    }
    std::process::exit(code)
}

/// Ends the process with the safe answer and exit 0, unless an answer is already out, which a second one would corrupt.
pub fn fail_open() -> ! {
    answer_safely();
    finish(0)
}

/// Writes the safe answer for the call in flight unless an answer is already out.
pub fn answer_safely() {
    if !answered() {
        let (harness, event) = context();
        emit(&safe_answer(&harness, &event));
    }
}

/// Runs `record` on its own thread and waits for it only until `deadline`, so a stalled disk cannot hold the process past the call's limit. With no deadline (the self-tests) it waits for it.
pub fn record_bounded(record: impl FnOnce() + Send + 'static, deadline: Option<Instant>) {
    let (tx, rx) = std::sync::mpsc::channel();
    // owner: this call; dies when the process exits, which a record still blocked at the deadline does not outlast
    std::thread::spawn(move || {
        record();
        let _ = tx.send(());
    });
    match deadline {
        Some(end) => {
            let _ = rx.recv_timeout(end.saturating_duration_since(Instant::now()));
        }
        None => {
            let _ = rx.recv();
        }
    }
}

/// Ends the process with the safe answer and exit 0, then notes `route` failed with `error`: the answer is out before any disk is touched.
pub fn fail_open_noting(route: &'static str, error: String) -> ! {
    let deadline = DEADLINE.lock().ok().and_then(|slot| *slot);
    answer_then_record(answer_safely, move || crate::notice::record_current(route, "", &error), deadline);
    finish(0)
}

/// Gives the answer first and only then starts `record`, so nothing a disk does can delay the host's answer.
fn answer_then_record(answer: impl FnOnce(), record: impl FnOnce() + Send + 'static, deadline: Option<Instant>) {
    answer();
    record_bounded(record, deadline);
}

/// Turns a panic anywhere, on any thread, into the safe answer and exit 0. Release builds abort on panic, which the host would see as a crash; this hook runs first and ends the process itself.
pub fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let _ = writeln!(std::io::stderr(), "tg-hook: internal error, answering the safe no-op: {info}");
        fail_open_noting("panic", info.to_string())
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grok_pre_tool_use_is_told_to_allow_and_every_other_pair_gets_its_harness_no_op() {
        assert_eq!(safe_answer("grok", "pre_tool_use"), r#"{"decision":"allow"}"#);
        assert_eq!(safe_answer("grok", "stop"), "{}");
        assert_eq!(safe_answer("claudecode", "pre_tool_use"), "{}");
        assert_eq!(safe_answer("copilot_cli", "agentStop"), r#"{"decision":"allow"}"#);
        assert_eq!(safe_answer("copilot_cli", "preToolUse"), "{}");
        assert_eq!(safe_answer("kimi", "pre_tool_use"), "");
    }

    #[test]
    fn only_the_first_async_marker_is_claimed() {
        let sent = AtomicBool::new(false);
        assert!(claim_marker(&sent), "the first marker must be written");
        assert!(!claim_marker(&sent), "a second marker must not be written");
    }

    #[test]
    fn a_record_that_never_returns_cannot_hold_the_caller_past_the_deadline() {
        let (release, blocked) = std::sync::mpsc::channel::<()>();
        let started = Instant::now();
        record_bounded(
            move || {
                let _ = blocked.recv();
            },
            Some(started + Duration::from_millis(100)),
        );
        // The deadline passed with the record still blocked: the call returned on the deadline's account.
        assert!(started.elapsed() >= Duration::from_millis(100), "returned before the deadline with the record still running");
        assert!(release.send(()).is_ok(), "the record had already ended; it was not blocked");
    }

    #[test]
    fn the_answer_is_given_before_the_record_starts_even_when_the_record_would_block() {
        let order = std::sync::Arc::new(Mutex::new(Vec::<&'static str>::new()));
        let (release, blocked) = std::sync::mpsc::channel::<()>();
        let (started, began) = std::sync::mpsc::channel::<()>();
        let (answered_log, recorded_log) = (order.clone(), order.clone());
        let deadline = Some(Instant::now() + Duration::from_millis(100));
        answer_then_record(
            move || answered_log.lock().unwrap().push("answer"),
            move || {
                recorded_log.lock().unwrap().push("record");
                let _ = started.send(());
                let _ = blocked.recv();
            },
            deadline,
        );
        // The record thread may not have run before the deadline on a loaded host: wait on its own event, not the clock.
        began.recv_timeout(Duration::from_secs(60)).expect("the record never started");
        assert_eq!(*order.lock().unwrap(), ["answer", "record"], "the answer must precede the record");
        drop(release);
    }

    #[test]
    fn a_record_that_returns_is_waited_for_without_a_deadline() {
        let done = std::sync::Arc::new(AtomicBool::new(false));
        let seen = done.clone();
        record_bounded(move || seen.store(true, Ordering::SeqCst), None);
        assert!(done.load(Ordering::SeqCst));
    }

    #[test]
    fn vscode_is_answered_as_copilot_cli_for_every_event() {
        for event in ["agentStop", "subagentStop", "preToolUse", "sessionStart", "nothing"] {
            assert_eq!(safe_answer("vscode", event), safe_answer("copilot_cli", event), "{event}");
        }
        assert_eq!(safe_answer("vscode", "agentStop"), r#"{"decision":"allow"}"#);
    }

    #[test]
    fn an_unknown_harness_gets_the_empty_object() {
        assert_eq!(safe_answer("", ""), "{}");
        assert_eq!(safe_answer("nobody", "pre_tool_use"), "{}");
    }
}
