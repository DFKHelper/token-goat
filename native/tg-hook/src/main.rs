//! tg-hook: the native hook client. The harness runs it in place of `node <shim> <event> <bundle>`, with that whole command after `--`; it relays the call to token-goat's resident hook server and, whenever it cannot, runs the command it wraps. This build carries the path, key and protocol rules and the self-tests that pin them to the TypeScript; the relay itself comes next.

mod jsstr;
mod nodepath;
mod paths;
mod protocol;
mod selftest;

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

fn main() {
    let args: Vec<String> = std::env::args_os().skip(1).map(|a| jsstr::os_to_js(&a)).collect();
    let code = match args.first().map(String::as_str) {
        Some("--selftest") => {
            println!(
                "{}",
                serde_json::json!({ "ok": true, "name": env!("CARGO_PKG_NAME"), "version": env!("CARGO_PKG_VERSION"), "platform": NODE_PLATFORM, "arch": NODE_ARCH, "protocol": protocol::PROTOCOL_VERSION, "slots": protocol::SERVER_SLOTS })
            );
            0
        }
        Some("--selftest-vectors") => selftest::run_vectors(),
        Some("--selftest-real") => selftest::run_real(&args[1..]),
        _ => {
            eprintln!("usage: tg-hook --selftest | --selftest-vectors | --selftest-real [NAME...]");
            2
        }
    };
    std::process::exit(code);
}
