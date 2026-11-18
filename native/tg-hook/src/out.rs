//! The one place this process answers the host and the one place it ends. Every ending a hook call can take goes through [`finish`], [`fail_open`] or the panic hook installed by [`install_panic_hook`], and every byte of the answer through [`emit`], so the host is always given exactly one valid answer for its harness and event, and never an exit code that blocks the tool call it was asked about.

use std::io::Write;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

/// The harness and event of the call in flight, set once the flags are parsed; what a panic or a failure far from the parser answers for.
static CONTEXT: Mutex<Option<(String, String)>> = Mutex::new(None);
/// Whether any byte of an answer has been written to stdout.
static ANSWERED: AtomicBool = AtomicBool::new(false);

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

/// What `harness` is answered when nothing could run for `event`: its no-op, or the event's own where the harness distinguishes one (Grok `pre_tool_use` must be told to allow). An unknown harness gets `{}`. The table is `safe_answers.json`, which tests/native_hook_conformance.test.ts compares with `noopFor` in src/hook_adapters.ts.
pub fn safe_answer(harness: &str, event: &str) -> String {
    let parsed: Option<serde_json::Value> = serde_json::from_str(TABLE).ok();
    let entry = parsed.as_ref().and_then(|table| table.get(harness));
    let own = entry.and_then(|e| e.get("events")).and_then(|events| events.get(event)).and_then(|v| v.as_str());
    let noop = entry.and_then(|e| e.get("noop")).and_then(|v| v.as_str());
    own.or(noop).unwrap_or("{}").to_string()
}

/// Writes `data` to stdout at once and marks the call answered. A host that has stopped reading is not this client's failure to report, so a write error is dropped.
pub fn emit(data: &str) {
    if data.is_empty() {
        return;
    }
    ANSWERED.store(true, Ordering::SeqCst);
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(data.as_bytes());
    let _ = out.flush();
}

/// Writes a leading part of an answer (the async marker) that the final answer follows; does not mark the call answered.
pub fn emit_partial(data: &str) {
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(data.as_bytes());
    let _ = out.flush();
}

/// Whether a final answer has been written to stdout.
pub fn answered() -> bool {
    ANSWERED.load(Ordering::SeqCst)
}

/// Flushes stdout and ends the process with `code`.
pub fn finish(code: i32) -> ! {
    let _ = std::io::stdout().flush();
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

/// Turns a panic anywhere, on any thread, into the safe answer and exit 0. Release builds abort on panic, which the host would see as a crash; this hook runs first and ends the process itself.
pub fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let _ = writeln!(std::io::stderr(), "tg-hook: internal error, answering the safe no-op: {info}");
        crate::notice::record_current("panic", "", &info.to_string());
        fail_open()
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
    fn an_unknown_harness_gets_the_empty_object() {
        assert_eq!(safe_answer("", ""), "{}");
        assert_eq!(safe_answer("nobody", "pre_tool_use"), "{}");
    }
}
