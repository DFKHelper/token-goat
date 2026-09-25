//! The relay: `callServer` and `relayViaServer` from src/hook_client.ts, speaking the harness-aware protocol (`HARNESS_PROTOCOL_VERSION`, src/hook_server.ts `serveConnection`) so this client carries no harness logic. Every outcome maps to one of two endings: the server answered (its bytes are printed and its exit code returned), or nothing was dispatched and the caller runs the wrapped Node command. A request lost after it was handed over prints the harness's no-op instead, because running a hook twice is worse than failing it open.

use std::io::Write;
use std::time::{Duration, Instant};

use serde_json::{Map, Value, json};

use crate::conn::{Conn, ConnectError, FrameConn, FrameError};
use crate::jsstr::{js_trim, os_to_js};
use crate::paths;
use crate::protocol::{self, HARNESS_PROTOCOL_VERSION, SERVER_SLOTS};

/// `HANDSHAKE_TIMEOUT_MS`: how long one server gets to answer the hello. One that cannot is busy in synchronous work for another caller.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_millis(150);
/// `FIND_BUDGET_MS`: no slot is tried once this much time has gone on finding one. An attempt already under way is not cut short by it, as in `callServer`.
pub const FIND_BUDGET: Duration = Duration::from_millis(300);
/// `RESPONSE_TIMEOUT_MS`: a dispatched request not answered by now is failed open.
pub const RESPONSE_TIMEOUT: Duration = Duration::from_millis(120_000);
/// `DISABLED_MARKER_TTL_MS`.
const DISABLED_MARKER_TTL: Duration = Duration::from_millis(10 * 60_000);

/// One hook call, as the command line describes it.
pub struct Call {
    pub harness: String,
    pub event: String,
    pub entry: String,
    pub script_dir: Option<String>,
    pub response_timeout: Duration,
}

/// How a call ended.
#[derive(Debug, PartialEq, Eq)]
pub enum Ending {
    /// The server answered: whatever it streamed is on stdout already, and this is the code to exit with.
    Served(i32),
    /// Nothing was dispatched: run the wrapped command.
    Fallback,
}

/// How one attempt on one slot ended, as `attempt` in src/hook_client.ts classifies it.
enum Outcome {
    Served {
        stdout: String,
        exit: i32,
    },
    /// Dispatched, then no verified answer: `noop` is what the harness prints for a request never answered.
    Lost {
        noop: String,
    },
    Absent,
    Busy,
    Stale,
    /// A connection-level failure: `callServer` tries the next slot.
    Refused,
    /// The server named this harness unknown, or failed to prove it holds the key, or the frame is too long for it: every slot would answer alike.
    NoSlotWill,
}

/// `envBool('TOKEN_GOAT_HOOK_SERVER', true)`: the switch that turns the resident server off for this process.
fn server_enabled() -> bool {
    let Some(raw) = std::env::var_os("TOKEN_GOAT_HOOK_SERVER") else { return true };
    let raw = os_to_js(&raw);
    !matches!(js_trim(&raw).to_lowercase().as_str(), "0" | "false" | "no" | "off")
}

/// Whether a server recently found itself turned off. src/hook_client.ts reads the same marker only to stop starting servers, and only while its content matches the config's modification time; a marker is never removed, so honouring it forever would leave this client falling back long after the server was turned on again. Within its ten minutes the check is looser here (content not compared), which can only mean an unneeded fallback, never a missed one: the Node shim that runs next keeps the exact rule.
fn recently_disabled(data_dir: &str) -> bool {
    let marker = crate::nodepath::join(paths::Platform::HOST.flavor(), &[data_dir, "hook-server.disabled"]);
    let Ok(modified) = std::fs::metadata(marker).and_then(|m| m.modified()) else { return false };
    // A modification time in the future is an age below the limit, as `Date.now() - mtimeMs` makes it.
    std::time::SystemTime::now().duration_since(modified).map_or(true, |age| age < DISABLED_MARKER_TTL)
}

/// `process.cwd()`: libuv drops a trailing backslash unless the directory is a drive root.
pub fn node_cwd() -> Option<String> {
    let dir = os_to_js(std::env::current_dir().ok()?.as_os_str());
    #[cfg(windows)]
    {
        let units: Vec<u16> = dir.encode_utf16().collect();
        if units.len() > 1 && units.last() == Some(&u16::from(b'\\')) && !(units.len() == 3 && units[1] == u16::from(b':')) {
            return Some(dir[..dir.len() - 1].to_string());
        }
    }
    Some(dir)
}

/// `envSnapshot()`: every variable `process.env` enumerates, each with the value `process.env[name]` returns. Node lists the names from the environment block, skipping those that start with `=` (Windows' per-drive directories), and looks each value up again by its decoded name, so a name that does not survive decoding reads as undefined and is left out.
pub fn env_snapshot() -> Map<String, Value> {
    let mut env = Map::new();
    for (name, _) in std::env::vars_os() {
        let name = os_to_js(&name);
        if name.is_empty() || name.starts_with('=') {
            continue;
        }
        if let Some(value) = std::env::var_os(&name) {
            env.insert(name, Value::String(os_to_js(&value)));
        }
    }
    env
}

fn nonce() -> Option<String> {
    let mut bytes = [0u8; 16];
    crate::sys::random_bytes(&mut bytes).then(|| bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// The no-op outputs a verified challenge carries, or `None` for a challenge that is not one.
fn challenge_noops(msg: &Map<String, Value>) -> Option<(String, Vec<(String, String)>)> {
    let noop = msg.get("noop")?.as_str()?.to_string();
    let noops = msg
        .get("noops")?
        .as_array()?
        .iter()
        .map(|pair| match pair.as_array().map(Vec::as_slice) {
            Some([Value::String(event), Value::String(out)]) => Some((event.clone(), out.clone())),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()?;
    Some((noop, noops))
}

/// Writes `data` to stdout at once. A harness that has stopped reading is not this client's failure to report.
fn emit(data: &str) {
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(data.as_bytes());
    let _ = out.flush();
}

/// One attempt against `slot`: connect, hello, verified challenge, request, then the `out` frames (each printed as it arrives) and the `done` frame.
fn attempt(endpoint: &str, key: &[u8], call: &Call, body: &str) -> Outcome {
    let started = Instant::now();
    let handshake_deadline = started + HANDSHAKE_TIMEOUT;
    let conn = match Conn::connect(endpoint, handshake_deadline) {
        Ok(conn) => conn,
        Err(ConnectError::Absent) => return Outcome::Absent,
        #[cfg(windows)]
        Err(ConnectError::Busy) => return Outcome::Busy,
        Err(ConnectError::Other) => return Outcome::Refused,
    };
    let mut conn = FrameConn::new(conn);
    let Some(nc) = nonce() else { return Outcome::NoSlotWill };
    let hello = protocol::encode_message(&json!({ "t": "hello", "v": HARNESS_PROTOCOL_VERSION, "nc": nc, "h": call.harness }));
    if conn.send(&hello, handshake_deadline).is_err() {
        return Outcome::Refused;
    }
    let challenge = match conn.next(handshake_deadline) {
        Ok(msg) => msg,
        Err(FrameError::Timeout) => return Outcome::Busy,
        Err(_) => return Outcome::Refused,
    };
    match challenge.get("t").and_then(Value::as_str) {
        Some("busy") => return Outcome::Busy,
        Some("stale") => return Outcome::Stale,
        Some("refused") => return Outcome::NoSlotWill,
        Some("challenge") => {}
        _ => return Outcome::Refused,
    }
    // The server proves it holds the key, and vouches for the harness and the no-op outputs, before anything about the request leaves this process.
    let ns = challenge.get("ns").and_then(Value::as_str).unwrap_or("");
    let Some((noop, noops)) = challenge_noops(&challenge) else { return Outcome::NoSlotWill };
    let v2 = challenge.get("v").and_then(Value::as_u64) == Some(u64::from(HARNESS_PROTOCOL_VERSION));
    let their_mac = challenge.get("mac").and_then(Value::as_str).unwrap_or("");
    if ns.is_empty() || !v2 || !protocol::mac_matches(&protocol::challenge_mac_v2(key, &nc, ns, &call.harness, &noop, &noops), their_mac) {
        return Outcome::NoSlotWill;
    }
    let lost = Outcome::Lost { noop: noops.iter().find(|(event, _)| *event == call.event).map_or(noop.clone(), |(_, out)| out.clone()) };
    let request = protocol::encode_message(&json!({ "t": "req", "mac": protocol::request_mac_v2(key, &nc, ns, &call.harness, body), "body": body }));
    // The server hangs up on a frame this long before reading any of it.
    if !protocol::frame_fits(&request) {
        return Outcome::NoSlotWill;
    }
    let response_deadline = Instant::now() + call.response_timeout;
    // A request not written whole never reached the server's handler, which reads the complete frame before it acts, so running it here instead cannot run it twice.
    if conn.send(&request, response_deadline).is_err() {
        return Outcome::Refused;
    }
    let mut seq: u64 = 0;
    loop {
        let Ok(msg) = conn.next(response_deadline) else { return lost };
        match msg.get("t").and_then(Value::as_str) {
            // Another caller was dispatched between this one's challenge and its request, or the server began retiring: this request was not run.
            Some("busy") if seq == 0 => return Outcome::Busy,
            Some("stale") if seq == 0 => return Outcome::Stale,
            Some("out") => {
                let data = msg.get("data").and_then(Value::as_str);
                let mac = msg.get("mac").and_then(Value::as_str).unwrap_or("");
                let in_order = msg.get("seq").and_then(Value::as_u64) == Some(seq);
                match data {
                    Some(data) if in_order && protocol::mac_matches(&protocol::out_frame_mac(key, &nc, ns, seq, data), mac) => emit(data),
                    _ => return lost,
                }
                seq += 1;
            }
            Some("done") => {
                let stdout = msg.get("stdout").and_then(Value::as_str);
                let exit = msg.get("exit").and_then(Value::as_i64).and_then(|e| i32::try_from(e).ok());
                let counted = msg.get("n").and_then(Value::as_u64) == Some(seq);
                let mac = msg.get("mac").and_then(Value::as_str).unwrap_or("");
                return match (stdout, exit) {
                    (Some(stdout), Some(exit)) if counted && protocol::mac_matches(&protocol::done_frame_mac(key, &nc, ns, stdout, exit, seq), mac) => {
                        Outcome::Served { stdout: stdout.to_string(), exit }
                    }
                    _ => lost,
                };
            }
            _ => return lost,
        }
    }
}

/// `relayViaServer` for `call` with `input`, the whole of stdin. Prints what the server answers; `Fallback` means nothing was printed and nothing dispatched.
pub fn relay(call: &Call, input: &str, main_start: Instant) -> Ending {
    if !server_enabled() {
        return Ending::Fallback;
    }
    let Some(data_dir) = paths::data_dir() else { return Ending::Fallback };
    if recently_disabled(&data_dir) {
        return Ending::Fallback;
    }
    let Some(key) = paths::read_server_key(&data_dir) else { return Ending::Fallback };
    let Some(cwd) = node_cwd() else { return Ending::Fallback };
    let bundle_dir = paths::bundle_dir_for_entry(&call.entry);
    let mut request = json!({
        "kind": "hook",
        "harness": call.harness,
        "event": call.event,
        "input": input,
        "env": env_snapshot(),
        "cwd": cwd,
        "elapsedMs": crate::sys::process_elapsed_ms(main_start),
    });
    if let Some(dir) = &call.script_dir {
        request["scriptDir"] = Value::String(dir.clone());
    }
    let body = request.to_string();
    let deadline = Instant::now() + FIND_BUDGET;
    for slot in 0..SERVER_SLOTS {
        if Instant::now() >= deadline {
            break;
        }
        match attempt(&paths::endpoint_for(slot, &data_dir, &bundle_dir), &key, call, &body) {
            Outcome::Served { stdout, exit } => {
                emit(&stdout);
                return Ending::Served(exit);
            }
            // What relayViaServer answers for a request a server took and never answered, in this harness's form.
            Outcome::Lost { noop } => {
                emit(&noop);
                return Ending::Served(0);
            }
            // No server on this slot: the Node command starts one in the background, so the next call is served.
            Outcome::Absent | Outcome::Stale | Outcome::NoSlotWill => return Ending::Fallback,
            Outcome::Busy | Outcome::Refused => {}
        }
    }
    Ending::Fallback
}
