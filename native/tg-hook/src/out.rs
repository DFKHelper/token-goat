//! The one place this process answers the host and the one place it ends. Every ending a hook call can take goes through [`finish`], [`fail_open`] or the panic hook installed by [`install_panic_hook`], and every byte of the answer through [`emit`], so the host is always given exactly one valid answer for its harness and event, and never an exit code that blocks the tool call it was asked about.

use std::io::Write;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

/// The harness and event of the call in flight, set once the flags are parsed; what a panic or a failure far from the parser answers for.
static CONTEXT: Mutex<Option<(String, String)>> = Mutex::new(None);
/// Who has claimed the answer: no one yet, the route that served the call (which may stream it in several parts), or the safe answer.
static ANSWERED: AtomicU8 = AtomicU8::new(UNANSWERED);
const UNANSWERED: u8 = 0;
const BY_ROUTE: u8 = 1;
const BY_SAFE_ANSWER: u8 = 2;
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
/// How many stdout writes are in flight on writer threads, which hold the stdout lock until each ends.
static WRITING: AtomicUsize = AtomicUsize::new(0);

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

type Job = Box<dyn FnOnce() + Send>;

/// Counts a write in flight, then starts `job` with `spawn`; a failed start gives the count back.
fn start_counted(writing: &AtomicUsize, job: impl FnOnce() + Send + 'static, spawn: impl FnOnce(Job) -> std::io::Result<()>) -> bool {
    writing.fetch_add(1, Ordering::SeqCst);
    if spawn(Box::new(job)).is_err() {
        writing.fetch_sub(1, Ordering::SeqCst);
        return false;
    }
    true
}

/// Counts one answer write in flight on `writing` until dropped, so an exit waits for it.
struct InFlight<'a>(&'a AtomicUsize);

impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// The one place bytes reach stdout; a write unfinished at the deadline (a host not reading) exits 0.
fn write_bounded(data: &str) {
    let Some(end) = DEADLINE.lock().ok().and_then(|slot| *slot) else { return write_now(data.as_bytes()) };
    let bytes = data.as_bytes().to_vec();
    let (tx, rx) = std::sync::mpsc::channel();
    // owner: this call; dies when the process exits, which a write still blocked at the deadline ends
    let job = move || {
        write_now(&bytes);
        let _ = tx.send(());
    };
    // limit: a write whose thread cannot start is dropped; revisit-when: a thread spawn fails on a live host
    if !start_counted(&WRITING, job, |job| std::thread::Builder::new().spawn(job).map(|_| ())) {
        return;
    }
    let wait = end.saturating_duration_since(Instant::now()).max(WRITE_GRACE);
    if let Err(std::sync::mpsc::RecvTimeoutError::Timeout) = rx.recv_timeout(wait) {
        std::process::exit(0)
    }
    WRITING.fetch_sub(1, Ordering::SeqCst);
}

/// Writes `data` to stdout at once and marks the call answered; a second answer is dropped. A host that has stopped reading is not this client's failure to report, so a write error is dropped.
pub fn emit(data: &str) {
    emit_claimed(&ANSWERED, BY_ROUTE, data, write_bounded);
}

/// Claims the answer for `by` in one step, then writes `data` with `write`; false when `data` is empty or the claim is held by the other answerer, or by an earlier safe answer.
fn emit_claimed(answered: &AtomicU8, by: u8, data: &str, write: impl FnOnce(&str)) -> bool {
    emit_claimed_after(answered, by, data, write, &MARKER_WRITE, || {})
}

/// [`emit_claimed`] with the marker lock and the wait's observer given, so a test can hold a marker write open.
fn emit_claimed_after(answered: &AtomicU8, by: u8, data: &str, write: impl FnOnce(&str), marker: &Mutex<()>, waiting: impl FnMut()) -> bool {
    emit_claimed_counting(&WRITING, answered, by, data, write, marker, waiting)
}

/// [`emit_claimed_after`] counting the answer on `writing` from before its claim to its write's end.
fn emit_claimed_counting(writing: &AtomicUsize, answered: &AtomicU8, by: u8, data: &str, write: impl FnOnce(&str), marker: &Mutex<()>, waiting: impl FnMut()) -> bool {
    if data.is_empty() {
        return false;
    }
    writing.fetch_add(1, Ordering::SeqCst);
    let _in_flight = InFlight(writing);
    // A route streams its answer in parts, so it may write again once it holds the claim; the safe answer is a single write.
    let mine = match answered.compare_exchange(UNANSWERED, by, Ordering::SeqCst, Ordering::SeqCst) {
        Ok(_) => true,
        Err(held) => held == by && by == BY_ROUTE,
    };
    if !mine {
        return false;
    }
    // A marker already past its check is written before this answer, never after it.
    settle_marker(marker, waiting);
    write(data);
    true
}

/// Held from the marker's check to the end of its write, so an answer claimed in between waits for it instead of being written first.
static MARKER_WRITE: Mutex<()> = Mutex::new(());

thread_local! {
    /// Whether this thread is inside [`emit_partial_with`], holding the marker lock.
    static HOLDS_MARKER: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Clears [`HOLDS_MARKER`] when the marker write ends or unwinds.
struct MarkerHeld;

impl Drop for MarkerHeld {
    fn drop(&mut self) {
        HOLDS_MARKER.with(|holds| holds.set(false));
    }
}

/// Waits until no marker write is in flight on `marker`, for at most the call's deadline; `waiting` is told of each wait.
fn settle_marker(marker: &Mutex<()>, mut waiting: impl FnMut()) {
    // The panic hook runs on the thread that panicked inside the marker write, which still holds the lock.
    if HOLDS_MARKER.with(std::cell::Cell::get) {
        return;
    }
    let end = bounded_deadline(DEADLINE.lock().ok().and_then(|slot| *slot), Instant::now());
    while matches!(marker.try_lock(), Err(std::sync::TryLockError::WouldBlock)) {
        waiting();
        if Instant::now() >= end {
            return;
        }
        std::thread::sleep(Duration::from_millis(1));
    }
}

/// Writes a leading part of an answer (the async marker) that the final answer follows; does not mark the call answered. Only the first is written: a later route's marker would be a second one.
pub fn emit_partial(data: &str) {
    emit_partial_with(&ANSWERED, &MARKER_SENT, &MARKER_WRITE, || write_bounded(data));
}

/// Checks and writes the marker under `lock`, so [`settle_marker`] on the answer's side sees the write in flight.
fn emit_partial_with(answered: &AtomicU8, sent: &AtomicBool, lock: &Mutex<()>, write: impl FnOnce()) {
    let _held = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    HOLDS_MARKER.with(|holds| holds.set(true));
    let _mark = MarkerHeld;
    if marker_allowed(answered, sent) {
        write();
    }
}

/// Whether the marker may be written now: no final answer is out yet and this is the first claim on `sent`.
fn marker_allowed(answered: &AtomicU8, sent: &AtomicBool) -> bool {
    answered.load(Ordering::SeqCst) == UNANSWERED && claim_marker(sent)
}

/// Whether this is the first claim on `sent`; every later one is not.
fn claim_marker(sent: &AtomicBool) -> bool {
    !sent.swap(true, Ordering::SeqCst)
}

/// Whether a final answer has been written to stdout.
pub fn answered() -> bool {
    ANSWERED.load(Ordering::SeqCst) != UNANSWERED
}

/// Flushes stdout and ends the process with `code`, once an answer write in flight (a panic on another thread can end the call during one) has ended or the deadline has passed.
pub fn finish(code: i32) -> ! {
    let now = Instant::now();
    let end = bounded_deadline(DEADLINE.lock().ok().and_then(|slot| *slot), now).max(now + WRITE_GRACE);
    settle_then_flush(&WRITING, end, || std::thread::sleep(Duration::from_millis(1)), || _ = std::io::stdout().flush());
    std::process::exit(code)
}

/// Runs `flush` once no write is in flight on `writing`; a write still in flight at `end` is blocked in the stdout lock, which a flush would wait on, so none is made then.
fn settle_then_flush(writing: &AtomicUsize, end: Instant, mut waiting: impl FnMut(), flush: impl FnOnce()) {
    while writing.load(Ordering::SeqCst) != 0 {
        if Instant::now() >= end {
            return;
        }
        waiting();
    }
    flush();
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
        emit_claimed(&ANSWERED, BY_SAFE_ANSWER, &safe_answer(&harness, &event), write_bounded);
    }
}

/// Runs `record` on its own thread and waits for it until `deadline` or [`RECORD_GRACE`], whichever is first, so a stalled disk cannot hold the process once the answer is out; true when the record finished. With no deadline set yet the smallest hook limit stands in for it.
pub fn record_bounded(record: impl FnOnce() + Send + 'static, deadline: Option<Instant>) -> bool {
    let (tx, rx) = std::sync::mpsc::channel();
    // owner: this call; dies when the process exits, which a record still blocked at the deadline does not outlast
    std::thread::spawn(move || {
        record();
        let _ = tx.send(());
    });
    let end = record_end(deadline, Instant::now());
    rx.recv_timeout(end.saturating_duration_since(Instant::now())).is_ok()
}

/// How long the process waits for a record once the answer is out; a stalled disk loses the record, not the exit.
// limit: a record slower than this is dropped when the process exits; revisit-when: notes go missing on healthy disks
// lost: the hook-broken notice, or a hook-broken.json.<pid>.tmp left behind; accepted, an exit is never delayed
const RECORD_GRACE: Duration = Duration::from_millis(250);

/// Where a record's wait ends: the deadline [`bounded_deadline`] gives, or `now` plus [`RECORD_GRACE`] if that is sooner.
fn record_end(deadline: Option<Instant>, now: Instant) -> Instant {
    bounded_deadline(deadline, now).min(now + RECORD_GRACE)
}

/// The deadline a record waits for: the call's own, or, before it is set, the smallest hook limit in the table from `now`.
fn bounded_deadline(deadline: Option<Instant>, now: Instant) -> Instant {
    deadline.unwrap_or_else(|| now + crate::fallback::harness_limit(""))
}

/// Ends the process with the safe answer and exit 0, then notes `route` failed with `error`: the answer is out before any disk is touched.
pub fn fail_open_noting(route: &'static str, error: String) -> ! {
    let deadline = DEADLINE.lock().ok().and_then(|slot| *slot);
    note_once(&NOTING, answer_safely, move || crate::notice::record_current(route, "", &error), deadline);
    finish(0)
}

/// Whether a note is being recorded; a panic on the record thread re-enters [`fail_open_noting`] and must not start another.
static NOTING: AtomicBool = AtomicBool::new(false);

/// [`answer_then_record`] for the first entry on `entered`; a later entry only makes sure the answer is out, so a failing record cannot start itself again. True when this entry recorded.
fn note_once(entered: &AtomicBool, answer: impl FnOnce(), record: impl FnOnce() + Send + 'static, deadline: Option<Instant>) -> bool {
    if entered.swap(true, Ordering::SeqCst) {
        answer();
        return false;
    }
    answer_then_record(answer, record, deadline);
    true
}

/// Gives the answer first and only then starts `record`, so nothing a disk does can delay the host's answer.
pub fn answer_then_record(answer: impl FnOnce(), record: impl FnOnce() + Send + 'static, deadline: Option<Instant>) -> bool {
    answer();
    record_bounded(record, deadline)
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
    fn a_route_and_the_safe_answer_racing_write_exactly_one_answer() {
        let answered = AtomicU8::new(UNANSWERED);
        let writes = std::sync::atomic::AtomicUsize::new(0);
        let start = std::sync::Barrier::new(2);
        let wrote = std::thread::scope(|scope| {
            let racers: Vec<_> = [BY_ROUTE, BY_SAFE_ANSWER]
                .into_iter()
                .map(|by| {
                    let (answered, writes, start) = (&answered, &writes, &start);
                    scope.spawn(move || {
                        start.wait();
                        emit_claimed(answered, by, "{}", |_| {
                            writes.fetch_add(1, Ordering::SeqCst);
                        })
                    })
                })
                .collect();
            racers.into_iter().filter_map(|racer| racer.join().ok()).filter(|won| *won).count()
        });
        assert_eq!(wrote, 1, "exactly one of the route and the safe answer may claim the write");
        assert_eq!(writes.load(Ordering::SeqCst), 1, "exactly one answer may reach stdout");
    }

    #[test]
    fn a_route_streams_its_parts_but_the_safe_answer_is_written_once_and_never_after_a_route() {
        let by_route = AtomicU8::new(UNANSWERED);
        assert!(emit_claimed(&by_route, BY_ROUTE, "a", |_| {}), "a route's first part is written");
        assert!(emit_claimed(&by_route, BY_ROUTE, "b", |_| {}), "a route's later parts are written");
        assert!(!emit_claimed(&by_route, BY_SAFE_ANSWER, "{}", |_| {}), "no safe answer follows a route's answer");
        let by_safe = AtomicU8::new(UNANSWERED);
        assert!(emit_claimed(&by_safe, BY_SAFE_ANSWER, "{}", |_| {}), "the safe answer is written when no one answered");
        assert!(!emit_claimed(&by_safe, BY_SAFE_ANSWER, "{}", |_| {}), "a second safe answer is not written");
        assert!(!emit_claimed(&by_safe, BY_ROUTE, "a", |_| {}), "no route answer follows the safe answer");
    }

    #[test]
    fn an_empty_answer_does_not_claim_the_call() {
        let answered = AtomicU8::new(UNANSWERED);
        assert!(!emit_claimed(&answered, BY_ROUTE, "", |_| {}));
        assert_eq!(answered.load(Ordering::SeqCst), UNANSWERED, "an empty answer wrote nothing and must leave the call unanswered");
    }

    #[test]
    fn no_async_marker_follows_the_final_answer() {
        let (answered, sent) = (AtomicU8::new(BY_ROUTE), AtomicBool::new(false));
        assert!(!marker_allowed(&answered, &sent), "a marker after the final answer must not be written");
        assert!(!sent.load(Ordering::SeqCst), "a refused marker must not use up the claim");
        answered.store(UNANSWERED, Ordering::SeqCst);
        assert!(marker_allowed(&answered, &sent), "before the answer the first marker is written");
        assert!(!marker_allowed(&answered, &sent), "a second marker is still refused");
    }

    #[test]
    fn the_wait_for_a_record_ends_at_the_grace_unless_the_deadline_comes_first() {
        let now = Instant::now();
        let far = now + Duration::from_secs(3600);
        assert_eq!(record_end(Some(far), now), now + RECORD_GRACE, "a far deadline must not hold the exit after the answer");
        let near = now + Duration::from_millis(7);
        assert_eq!(record_end(Some(near), now), near, "a deadline sooner than the grace still wins");
        assert_eq!(record_end(None, now), now + RECORD_GRACE, "no deadline set must also end at the grace");
    }

    #[test]
    fn a_blocked_record_is_given_up_on_after_the_answer_which_was_written_once() {
        let (release, blocked) = std::sync::mpsc::channel::<()>();
        let answers = std::sync::atomic::AtomicUsize::new(0);
        let completed = answer_then_record(
            || _ = answers.fetch_add(1, Ordering::SeqCst),
            move || {
                let _ = blocked.recv();
            },
            None,
        );
        assert!(!completed, "the record was blocked, so the wait must end by its bound and report it unfinished");
        assert_eq!(answers.load(Ordering::SeqCst), 1, "the answer is written once, before the record");
        assert!(release.send(()).is_ok(), "the record had already ended; it was not blocked");
    }

    #[test]
    fn an_answer_claimed_while_the_marker_is_being_written_waits_for_it() {
        let (answered, sent, lock) = (AtomicU8::new(UNANSWERED), AtomicBool::new(false), Mutex::new(()));
        let in_flight = AtomicBool::new(false);
        let order = Mutex::new(Vec::<&'static str>::new());
        let (inside_tx, inside_rx) = std::sync::mpsc::channel::<()>();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let (events_tx, events_rx) = std::sync::mpsc::channel::<&'static str>();
        std::thread::scope(|scope| {
            let (order, in_flight, answered, lock) = (&order, &in_flight, &answered, &lock);
            scope.spawn(move || {
                emit_partial_with(answered, &sent, lock, || {
                    in_flight.store(true, Ordering::SeqCst);
                    let _ = inside_tx.send(());
                    let _ = release_rx.recv();
                    order.lock().unwrap().push("marker");
                    in_flight.store(false, Ordering::SeqCst);
                });
            });
            inside_rx.recv().expect("the marker write never began");
            let (waits, writes) = (events_tx.clone(), events_tx);
            scope.spawn(move || {
                let write = |_: &str| {
                    order.lock().unwrap().push(if in_flight.load(Ordering::SeqCst) { "answer-during-marker" } else { "answer" });
                    let _ = writes.send("written");
                };
                emit_claimed_after(answered, BY_ROUTE, "{}", write, lock, || _ = waits.send("waiting"));
            });
            // The first thing the answer's side does: wait for the marker (fixed) or write over it (the defect).
            assert!(events_rx.recv().is_ok(), "the answer side did neither");
            let _ = release_tx.send(());
        });
        assert_eq!(*order.lock().unwrap(), ["marker", "answer"], "the answer was written while the marker write was in flight");
    }

    #[test]
    fn an_answer_is_counted_in_flight_from_before_its_claim_to_the_end_of_its_write() {
        let (answered, writing, lock) = (AtomicU8::new(UNANSWERED), AtomicUsize::new(0), Mutex::new(()));
        let (inside_tx, inside_rx) = std::sync::mpsc::channel::<()>();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let seen = std::cell::RefCell::new(Vec::<(u8, usize)>::new());
        std::thread::scope(|scope| {
            let lock = &lock;
            scope.spawn(move || {
                let _held = lock.lock().unwrap();
                let _ = inside_tx.send(());
                let _ = release_rx.recv();
            });
            inside_rx.recv().expect("the marker holder never started");
            let mut released = false;
            let waiting = || {
                // Claimed, marker not settled, nothing written: an exit here must find the write counted.
                seen.borrow_mut().push((answered.load(Ordering::SeqCst), writing.load(Ordering::SeqCst)));
                if !released {
                    released = true;
                    let _ = release_tx.send(());
                }
            };
            let wrote = emit_claimed_counting(&writing, &answered, BY_ROUTE, "{}", |_| seen.borrow_mut().push((BY_ROUTE, writing.load(Ordering::SeqCst))), lock, waiting);
            assert!(wrote);
        });
        let seen = seen.into_inner();
        assert!(seen.len() >= 2, "the answer never waited for the marker and wrote: {seen:?}");
        assert!(seen.iter().all(|&(_, count)| count == 1), "the answer was not counted in flight between its claim and its write: {seen:?}");
        assert_eq!(seen[0].0, BY_ROUTE, "the observer ran before the claim, so it did not see the window");
        assert_eq!(writing.load(Ordering::SeqCst), 0, "the count was not given back after the write");
    }

    #[test]
    fn a_lost_claim_and_an_empty_answer_leave_no_write_counted() {
        let (writing, held) = (AtomicUsize::new(0), AtomicU8::new(BY_SAFE_ANSWER));
        let marker = Mutex::new(());
        assert!(!emit_claimed_counting(&writing, &held, BY_ROUTE, "a", |_| {}, &marker, || {}));
        assert_eq!(writing.load(Ordering::SeqCst), 0, "a lost claim kept its count");
        let free = AtomicU8::new(UNANSWERED);
        assert!(!emit_claimed_counting(&writing, &free, BY_ROUTE, "", |_| {}, &marker, || {}));
        assert_eq!(writing.load(Ordering::SeqCst), 0, "an empty answer kept its count");
    }

    #[test]
    fn a_write_whose_thread_cannot_start_gives_its_count_back() {
        let writing = AtomicUsize::new(0);
        let started = start_counted(&writing, || {}, |_| Err(std::io::Error::other("no thread")));
        assert!(!started);
        assert_eq!(writing.load(Ordering::SeqCst), 0, "a failed start left its count behind, so an exit would wait for it");
        assert!(start_counted(
            &writing,
            || {},
            |job| {
                job();
                Ok(())
            }
        ));
        assert_eq!(writing.load(Ordering::SeqCst), 1, "a started write is counted until its owner gives it back");
    }

    #[test]
    fn the_thread_inside_the_marker_write_does_not_wait_for_its_own_lock() {
        let (sent, answered, lock) = (AtomicBool::new(false), AtomicU8::new(UNANSWERED), Mutex::new(()));
        let settled = std::cell::Cell::new(false);
        emit_partial_with(&answered, &sent, &lock, || {
            // What the panic hook does on this thread, with the lock still held.
            settle_marker(&lock, || panic!("settle_marker waited for a marker lock this thread itself holds"));
            settled.set(true);
        });
        assert!(settled.get());
        let after = std::cell::Cell::new(false);
        settle_marker(&lock, || after.set(true));
        assert!(!after.get(), "the thread kept claiming the marker lock after its write ended");
    }

    #[test]
    fn a_marker_lock_a_panicked_thread_poisoned_counts_as_settled() {
        let lock = Mutex::new(());
        let panicked = std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    let _held = lock.lock().unwrap();
                    std::panic::resume_unwind(Box::new("marker thread gone"));
                })
                .join()
        });
        assert!(panicked.is_err() && lock.is_poisoned());
        settle_marker(&lock, || panic!("settle_marker waited on a poisoned marker lock"));
    }

    #[test]
    fn an_exit_flushes_only_once_the_answer_write_in_flight_has_ended() {
        let writing = AtomicUsize::new(1);
        let flushed_with = std::cell::Cell::new(usize::MAX);
        settle_then_flush(&writing, Instant::now() + Duration::from_secs(3600), || _ = writing.fetch_sub(1, Ordering::SeqCst), || flushed_with.set(writing.load(Ordering::SeqCst)));
        assert_eq!(flushed_with.get(), 0, "the exit went on while an answer write was still in flight");
    }

    #[test]
    fn an_exit_does_not_flush_into_a_write_still_blocked_at_its_end() {
        let writing = AtomicUsize::new(1);
        let (flushed, waited) = (AtomicBool::new(false), AtomicBool::new(false));
        settle_then_flush(&writing, Instant::now(), || waited.store(true, Ordering::SeqCst), || flushed.store(true, Ordering::SeqCst));
        assert!(!flushed.load(Ordering::SeqCst), "a flush would wait on the blocked writer's lock");
        assert!(!waited.load(Ordering::SeqCst), "no wait is left once the end has passed");
    }

    #[test]
    fn a_record_with_no_deadline_set_is_bounded_by_the_smallest_hook_limit() {
        let now = Instant::now();
        let table: serde_json::Value = serde_json::from_str(include_str!("../hook_limits.json")).unwrap();
        let smallest = table.as_object().unwrap().values().filter_map(|v| v.as_u64()).min().unwrap();
        assert_eq!(bounded_deadline(None, now), now + Duration::from_millis(smallest), "no deadline must fall back to the smallest limit");
        let own = now + Duration::from_millis(7);
        assert_eq!(bounded_deadline(Some(own), now), own, "a set deadline is the bound");
    }

    #[test]
    fn a_second_entry_makes_sure_of_the_answer_and_starts_no_record() {
        use std::sync::Arc;
        use std::sync::atomic::AtomicUsize;
        let entered = AtomicBool::new(false);
        let (answers, records) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
        let enter = || {
            let (a, r) = (answers.clone(), records.clone());
            note_once(&entered, move || _ = a.fetch_add(1, Ordering::SeqCst), move || _ = r.fetch_add(1, Ordering::SeqCst), None)
        };
        assert!(enter(), "the first entry records");
        assert!(!enter(), "a re-entry from a panic on the record thread must not record again");
        assert_eq!(records.load(Ordering::SeqCst), 1, "one record in all");
        assert_eq!(answers.load(Ordering::SeqCst), 2, "each entry makes sure the answer is out");
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
