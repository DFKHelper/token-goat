//! tg-hook: the native hook client. The harness runs it in place of the Node hook command, with that whole command after `--`:
//!
//! `tg-hook --harness <name> --event <event> --entry <dist/token-goat.mjs> [--script-dir <dir>] -- <node> <shim> <event> <entry>`
//!
//! It relays the call to token-goat's resident hook server and prints the answer; whenever nothing could be dispatched it runs the command after `--`, unchanged, with the same stdin. The flags carry what the relay needs explicitly rather than having it parse the wrapped command, whose shape differs by harness (a PowerShell string for Codex on Windows, Copilot CLI's own event names): `--harness` selects the server's adapter, `--event` is the event argument the shim is run with (argv[2] of the wrapped command, in the harness's own spelling), `--entry` is the bundle entry the shim names (argv[3]), which locates the server, and `--script-dir` is the shim's directory, which the Copilot CLI adapter hands to VS Code's duplicate-hook guard.

mod client;
mod conn;
mod fallback;
mod jsstr;
mod nodepath;
mod paths;
mod protocol;
mod selftest;
mod sys;

use std::ffi::OsString;
use std::time::{Duration, Instant};

/// `process.platform` for this build.
const NODE_PLATFORM: &str = if cfg!(windows) {
    "win32"
} else if cfg!(target_os = "macos") {
    "darwin"
} else if cfg!(target_os = "linux") {
    "linux"
} else if cfg!(target_os = "freebsd") {
    "freebsd"
} else {
    "unknown"
};

/// `process.arch` for this build.
const NODE_ARCH: &str = if cfg!(target_arch = "x86_64") {
    "x64"
} else if cfg!(target_arch = "aarch64") {
    "arm64"
} else {
    "unknown"
};

const USAGE: &str =
    "usage: tg-hook --harness NAME --event EVENT --entry PATH [--script-dir DIR] -- COMMAND [ARG...]\n       tg-hook --selftest | --selftest-vectors | --selftest-real [NAME...] | --selftest-env";

/// The command line of a hook call: the flags, and the command after `--`.
struct HookArgs {
    call: Option<client::Call>,
    fallback: Vec<OsString>,
}

/// Splits the hook-call command line. `call` is `None` when the flags are incomplete or malformed, which leaves the wrapped command to run exactly as it would have without this client; `--response-timeout-ms` exists for tests of the lost-request path and is never written by an installer.
fn parse_hook_args(args: &[OsString]) -> Option<HookArgs> {
    let split = args.iter().position(|a| a == "--")?;
    let (flags, fallback) = (&args[..split], args[split + 1..].to_vec());
    let (mut harness, mut event, mut entry, mut script_dir) = (None, None, None, None);
    let mut response_timeout = client::RESPONSE_TIMEOUT;
    let mut ok = true;
    let mut it = flags.iter();
    while let Some(flag) = it.next() {
        let value = it.next().map(|v| jsstr::os_to_js(v));
        match (flag.to_str(), value) {
            (Some("--harness"), Some(v)) => harness = Some(v),
            (Some("--event"), Some(v)) => event = Some(v),
            (Some("--entry"), Some(v)) => entry = Some(v),
            (Some("--script-dir"), Some(v)) => script_dir = Some(v),
            (Some("--response-timeout-ms"), Some(v)) => match v.parse::<u64>() {
                Ok(ms) => response_timeout = Duration::from_millis(ms),
                Err(_) => ok = false,
            },
            _ => ok = false,
        }
    }
    let call = match (ok, harness, event, entry) {
        (true, Some(harness), Some(event), Some(entry)) => Some(client::Call { harness, event, entry, script_dir, response_timeout }),
        _ => None,
    };
    Some(HookArgs { call, fallback })
}

/// A hook call: relay it, or run the wrapped command.
fn run_hook(hook: HookArgs, main_start: Instant) -> i32 {
    if hook.fallback.is_empty() {
        eprintln!("tg-hook: no command after --\n{USAGE}");
        return 2;
    }
    let Some(call) = hook.call else { return fallback::run(&hook.fallback, fallback::Input::Untouched, "bad-flags") };
    let input = fallback::read_stdin(protocol::MAX_FRAME_BYTES);
    let fallback::Input::Read { bytes, more: false } = input else {
        let reason = if matches!(input, fallback::Input::Untouched) { "stdin-error" } else { "stdin-too-large" };
        return fallback::run(&hook.fallback, input, reason);
    };
    // Node would decode invalid UTF-8 with replacement characters; the command it wraps still gets the bytes exactly as they came.
    let text = match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(e) => return fallback::run(&hook.fallback, fallback::Input::Read { bytes: e.into_bytes(), more: false }, "stdin-not-utf8"),
    };
    match client::relay(&call, &text, main_start) {
        client::Ending::Served(code) => code,
        client::Ending::Fallback(reason) => fallback::run(&hook.fallback, fallback::Input::Read { bytes: text.into_bytes(), more: false }, reason),
    }
}

fn main() {
    let main_start = Instant::now();
    let raw: Vec<OsString> = std::env::args_os().skip(1).collect();
    let code = match raw.first().and_then(|a| a.to_str()) {
        Some("--selftest") => {
            println!(
                "{}",
                serde_json::json!({ "ok": true, "name": env!("CARGO_PKG_NAME"), "version": env!("CARGO_PKG_VERSION"), "platform": NODE_PLATFORM, "arch": NODE_ARCH, "protocol": protocol::PROTOCOL_VERSION, "harnessProtocol": protocol::HARNESS_PROTOCOL_VERSION, "slots": protocol::SERVER_SLOTS })
            );
            0
        }
        Some("--selftest-vectors") => selftest::run_vectors(),
        Some("--selftest-real") => selftest::run_real(&raw[1..].iter().map(|a| jsstr::os_to_js(a)).collect::<Vec<_>>()),
        Some("--selftest-env") => selftest::run_env(),
        _ => match parse_hook_args(&raw) {
            Some(hook) => run_hook(hook, main_start),
            None => {
                eprintln!("{USAGE}");
                2
            }
        },
    };
    std::process::exit(code);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    #[test]
    fn an_installed_command_line_waits_the_shipping_response_timeout() {
        let hook = parse_hook_args(&args(&["--harness", "codex", "--event", "PreToolUse", "--entry", "/d/token-goat.mjs", "--", "node", "shim.cjs"])).unwrap();
        let call = hook.call.unwrap();
        assert_eq!(call.response_timeout, Duration::from_millis(120_000));
        assert_eq!(call.response_timeout, client::RESPONSE_TIMEOUT);
        assert_eq!((call.harness.as_str(), call.event.as_str(), call.entry.as_str(), call.script_dir), ("codex", "PreToolUse", "/d/token-goat.mjs", None));
        assert_eq!(hook.fallback, args(&["node", "shim.cjs"]));
    }

    #[test]
    fn the_test_knob_sets_the_response_timeout() {
        let hook = parse_hook_args(&args(&["--harness", "kimi", "--event", "e", "--entry", "x", "--response-timeout-ms", "500", "--", "n"])).unwrap();
        assert_eq!(hook.call.unwrap().response_timeout, Duration::from_millis(500));
    }

    #[test]
    fn flags_that_do_not_describe_a_call_leave_only_the_wrapped_command() {
        for list in [
            &["--harness", "kimi", "--event", "e", "--", "n"][..],
            &["--harness", "kimi", "--event", "e", "--entry", "x", "--odd", "y", "--", "n"],
            &["--harness", "kimi", "--event", "e", "--entry", "--", "n"],
        ] {
            let hook = parse_hook_args(&args(list)).unwrap();
            assert!(hook.call.is_none(), "{list:?}");
            assert_eq!(hook.fallback, args(&["n"]));
        }
        assert!(parse_hook_args(&args(&["--harness", "kimi"])).is_none());
    }
}
