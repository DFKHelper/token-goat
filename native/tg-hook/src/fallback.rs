//! The path taken whenever the server cannot answer. Routes, in order: the wrapped command the harness would have run (everything after `--`), then the same Node command rebuilt from `hook-entry.json` when the one the harness named is broken, then the harness's safe answer. A route counts only if it produced an answer the host can read: a command that cannot be started, dies of a signal, overruns its deadline, or prints nothing parseable hands over to the next route, and the stdin this process already read is given to each. Neither Windows nor POSIX `exec` fits: the payload has already been consumed from stdin and must be written back into the child. The Node shim does everything it does today, including starting a server in the background, so the next call is served. Whatever is found missing or broken on the way is recorded in `hook-broken.json` (see notice.rs), never printed to the host.

use std::ffi::OsString;
use std::io::Read;
use std::path::Path;
use std::time::{Duration, Instant};

use crate::capture::{self, Outcome, Stdin};
use crate::{notice, out, paths, pointer};

/// What of this process's stdin the child gets.
pub enum Input {
    /// Nothing was read: the child reads the same stdin itself, and only the first route can have it.
    Untouched,
    /// These bytes were read; `more` says stdin was not exhausted, so the rest is read in before the first route starts.
    Read { bytes: Vec<u8>, more: bool },
}

/// Names, on the wrapped command's environment, why this call was not served. The Node hook path records it with the call's latency row (`stats.detail`, as `native-fallback:<reason>`), which is how `doctor` counts served and fallen-back calls per harness; the answer on stdout is untouched.
pub const REASON_ENV: &str = "TOKEN_GOAT_NATIVE_FALLBACK";

const LIMITS: &str = include_str!("../hook_limits.json");

/// The time one call may take: its host's hook limit from `hook_limits.json`, the smallest when unknown.
// tests/native_hook_limits.test.ts pins the table to SHIM_FALLBACK_TIMEOUT_MS in src/bridges/shim_common.ts.
pub fn harness_limit(harness: &str) -> Duration {
    let table: Option<serde_json::Value> = serde_json::from_str(LIMITS).ok();
    let ms = |v: &serde_json::Value| v.as_u64().filter(|n| *n > 0);
    let named = table.as_ref().and_then(|t| t.get(harness)).and_then(ms);
    let smallest = table.as_ref().and_then(|t| t.as_object()).and_then(|o| o.values().filter_map(ms).min());
    // limit: used only if the embedded table cannot be read, which a unit test rules out; revisit-when: never
    Duration::from_millis(named.or(smallest).unwrap_or(3_000))
}

/// The most stdin read in whole for a payload past the frame limit.
const MAX_STDIN_BYTES: u64 = 1 << 30;

/// What the chain needs to know about the call, beyond the command itself.
pub struct Opts {
    pub harness: String,
    /// The event argument the shim is run with, in the harness's own spelling; `None` when the flags were incomplete.
    pub event: Option<String>,
    /// One deadline for every route, taken at the start of the call; none starts or runs past it.
    pub deadline: Option<Instant>,
    /// Whether the first route takes two thirds of what is left at most, so the second can still answer.
    pub reserve_second: bool,
    /// Arguments after the entry that the rebuilt command carries too (the startup deadline).
    pub extra: Vec<OsString>,
}

impl Opts {
    pub fn bare() -> Opts {
        Opts { harness: String::new(), event: None, deadline: None, reserve_second: false, extra: Vec::new() }
    }

    /// A hook call that began at `start`; `limit`, a test seam, replaces the harness's own limit.
    pub fn for_call(harness: &str, event: &str, start: Instant, limit: Option<Duration>) -> Opts {
        let deadline = Some(start + limit.unwrap_or_else(|| harness_limit(harness)));
        let (harness, event) = (harness.to_string(), Some(event.to_string()));
        Opts { harness, event, deadline, reserve_second: true, ..Opts::bare() }
    }
}

fn budget(opts: &Opts) -> Option<Duration> {
    let end = opts.deadline.unwrap_or_else(|| Instant::now() + harness_limit(""));
    let left = end.saturating_duration_since(Instant::now());
    (!left.is_zero()).then_some(left)
}

/// What the first route may take: all that is left, or two thirds of it when a second route is to follow.
fn first_budget(opts: &Opts) -> Option<Duration> {
    budget(opts).map(|left| if opts.reserve_second { left * 2 / 3 } else { left })
}

/// The first part of `argv` that names a file which is not there: what to blame in the notice.
fn missing_piece(argv: &[OsString]) -> String {
    let looks_like_path = |s: &&OsString| s.to_string_lossy().contains(['/', '\\']);
    let named = argv.iter().filter(looks_like_path).find(|s| !Path::new(s).exists());
    named.or(argv.first()).map(|s| s.to_string_lossy().to_string()).unwrap_or_default()
}

fn rebuilt(opts: &Opts, data_dir: &str) -> Result<Vec<OsString>, String> {
    let event = opts.event.as_deref().ok_or("no event flag to rebuild the command from")?;
    let found = pointer::load(data_dir)?;
    let shim = found.shim_for(&opts.harness).cloned();
    let node: OsString = found.node.map_or_else(|| "node".into(), Into::into);
    let mut argv = match shim {
        Some(shim) => vec![node, shim.into(), event.into(), found.entry.into()],
        None if opts.harness == "claudecode" => vec![node, found.entry.into(), "hook".into(), event.into()],
        None => return Err("the pointer names no shim and this harness takes no direct entry".into()),
    };
    argv.extend(opts.extra.iter().cloned());
    Ok(argv)
}

fn read_rest(first: Vec<u8>) -> Vec<u8> {
    let mut bytes = first;
    let _ = std::io::stdin().lock().take(MAX_STDIN_BYTES).read_to_end(&mut bytes);
    bytes
}

/// Runs the routes and returns the code to leave with. Never returns a code that would block the call on this process's own account: 0, or 2 only when a command ran and deliberately said so.
pub fn run(argv: &[OsString], input: Input, reason: &str, opts: &Opts) -> i32 {
    let bytes = match input {
        Input::Untouched => None,
        Input::Read { bytes, more: false } => Some(bytes),
        Input::Read { bytes, more: true } => Some(read_rest(bytes)),
    };
    let first_in = || bytes.as_deref().map_or(Stdin::Inherit, Stdin::Bytes);
    let later_in = || bytes.as_deref().map_or(Stdin::Null, Stdin::Bytes);
    let data_dir = paths::data_dir();
    let record = |route: &str, path: &str, error: &str| {
        if let Some(dir) = &data_dir {
            notice::record(dir, route, path, error);
        }
    };
    let mut failed_argv: Option<Vec<OsString>> = None;
    if let Some(timeout) = first_budget(opts) {
        match capture::exec(argv, first_in(), reason, timeout, &opts.harness, opts.event.as_deref().unwrap_or("")) {
            Ok(done) => {
                if let Some(dir) = &data_dir {
                    notice::clear(dir);
                }
                return finish(done);
            }
            Err(failure) => {
                record("node-argv", &missing_piece(argv), &failure.to_string());
                failed_argv = Some(argv.to_vec());
            }
        }
    }
    if let Some(dir) = &data_dir {
        match rebuilt(opts, dir) {
            Ok(second) if failed_argv.as_deref() != Some(second.as_slice()) => {
                if let Some(timeout) = budget(opts) {
                    match capture::exec(&second, later_in(), "pointer-route", timeout, &opts.harness, opts.event.as_deref().unwrap_or("")) {
                        Ok(done) => return finish(done),
                        Err(failure) => record("node-pointer", &missing_piece(&second), &failure.to_string()),
                    }
                }
            }
            Ok(_) => {}
            Err(why) => record("pointer", &Path::new(dir).join(pointer::FILE_NAME).to_string_lossy(), &why),
        }
    }
    record("safe-answer", "", "every route failed; the host was given its safe answer");
    out::fail_open()
}

/// A route's answer is already on stdout; the exit code that goes with it.
fn finish(done: Outcome) -> i32 {
    match done.code {
        2 => 2,
        _ => 0,
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn slashed(path: &std::path::Path) -> String {
        path.to_string_lossy().replace(std::path::MAIN_SEPARATOR, "/")
    }

    fn pointer_dir(name: &str, with_shim: bool) -> (std::path::PathBuf, String) {
        let root = std::env::temp_dir().join(format!("tg-fb-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let exe = if cfg!(windows) { ".exe" } else { "" };
        for file in ["bundle/token-goat.mjs", "hooks/token-goat-shim.cjs"].into_iter().map(String::from).chain([format!("bin/node{exe}")]) {
            let path = root.join(&file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "x").unwrap();
        }
        let base = slashed(&root);
        let shim = if with_shim { format!("\"{base}/hooks/token-goat-shim.cjs\"") } else { "null".into() };
        let text = format!(
            "{{\"schema\":1,\"version\":\"1\",\"bundleDir\":\"{base}/bundle\",\"entry\":\"{base}/bundle/token-goat.mjs\",\"node\":\"{base}/bin/node{exe}\",\"shim\":{shim},\"nativeBin\":\"{base}/n/tg-hook{exe}\",\"writtenAt\":\"t\"}}"
        );
        std::fs::write(root.join(pointer::FILE_NAME), text).unwrap();
        let dir = root.to_string_lossy().to_string();
        (root, dir)
    }

    #[test]
    fn the_pointer_route_is_node_shim_event_entry_then_the_startup_extras() {
        let (root, dir) = pointer_dir("shim", true);
        let opts = Opts { harness: "codex".into(), event: Some("PreToolUse".into()), extra: vec!["--x=1".into()], ..Opts::bare() };
        let argv = rebuilt(&opts, &dir).unwrap();
        let shown: Vec<String> = argv.iter().map(|a| a.to_string_lossy().replace(std::path::MAIN_SEPARATOR, "/")).collect();
        assert!(shown[0].contains("/bin/node"), "{shown:?}");
        assert!(shown[1].ends_with("/hooks/token-goat-shim.cjs") && shown[2] == "PreToolUse" && shown[3].ends_with("/bundle/token-goat.mjs"), "{shown:?}");
        assert_eq!(shown[4], "--x=1");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn without_a_shim_only_claude_takes_the_entry_directly_and_without_an_event_nothing_is_rebuilt() {
        let (root, dir) = pointer_dir("noshim", false);
        let claude = Opts { harness: "claudecode".into(), event: Some("pre_tool_use".into()), ..Opts::bare() };
        let argv = rebuilt(&claude, &dir).unwrap();
        assert_eq!((argv[2].to_string_lossy().as_ref(), argv[3].to_string_lossy().as_ref()), ("hook", "pre_tool_use"));
        let other = Opts { harness: "grok".into(), event: Some("stop".into()), ..Opts::bare() };
        assert!(rebuilt(&other, &dir).is_err());
        assert!(rebuilt(&Opts::bare(), &dir).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_expired_deadline_leaves_no_budget_and_a_deadline_caps_the_route_timeout() {
        let past = Opts { deadline: Some(Instant::now()), ..Opts::bare() };
        assert!(budget(&past).is_none());
        let near = Opts { deadline: Some(Instant::now() + Duration::from_secs(5)), ..Opts::bare() };
        assert!(budget(&near).unwrap() <= Duration::from_secs(5));
        assert!(budget(&Opts::bare()).unwrap() <= harness_limit(""));
    }

    #[test]
    fn the_limits_are_the_table_and_an_unknown_or_missing_harness_gets_the_smallest() {
        assert_eq!(harness_limit("grok"), Duration::from_millis(3_000));
        assert_eq!(harness_limit("codex"), Duration::from_millis(45_000));
        assert_eq!(harness_limit(""), Duration::from_millis(3_000));
        assert_eq!(harness_limit("some-new-host"), Duration::from_millis(3_000));
    }

    #[test]
    fn one_deadline_from_the_start_of_the_call_serves_every_route() {
        let start = Instant::now() - Duration::from_secs(60);
        let spent = Opts::for_call("codex", "pre_tool_use", start, None);
        assert!(budget(&spent).is_none(), "a call that began 60 s ago has nothing left for any route");
        let fresh = Opts::for_call("codex", "pre_tool_use", Instant::now(), None);
        assert!(budget(&fresh).unwrap() <= Duration::from_millis(45_000));
        let seam = Opts::for_call("codex", "pre_tool_use", Instant::now(), Some(Duration::from_millis(500)));
        assert!(budget(&seam).unwrap() <= Duration::from_millis(500));
        assert!(first_budget(&seam).unwrap() < budget(&seam).unwrap(), "no share kept for the second route");
        let whole = first_budget(&Opts::bare()).unwrap();
        assert!(whole > Duration::from_millis(2_000), "a startup call keeps its whole deadline");
    }
}
