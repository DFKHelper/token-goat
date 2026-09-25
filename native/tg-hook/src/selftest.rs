//! `--selftest-vectors`: runs every rule the client depends on over test cases read from stdin and prints the results, so tests/native_hook_conformance.test.ts can hold each one to the TypeScript it mirrors. The cases arrive as a JSON array of objects naming an `op`; the answer is a JSON array of `{"out": ...}` or `{"error": "..."}` in the same order.

use std::collections::HashMap;
use std::io::Read;

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::nodepath::{self, Flavor};
use crate::paths::{self, Platform};
use crate::protocol;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(s: &str) -> Result<Vec<u8>, String> {
    if !s.len().is_multiple_of(2) {
        return Err("odd-length hex".into());
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|e| e.to_string())).collect()
}

fn str_field<'a>(case: &'a Map<String, Value>, key: &str) -> Result<&'a str, String> {
    case.get(key).and_then(Value::as_str).ok_or_else(|| format!("missing string field {key}"))
}

fn strings(case: &Map<String, Value>, key: &str) -> Result<Vec<String>, String> {
    case.get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("missing array field {key}"))?
        .iter()
        .map(|v| v.as_str().map(str::to_string).ok_or_else(|| format!("{key} holds a non-string")))
        .collect()
}

fn run_case(case: &Map<String, Value>) -> Result<Value, String> {
    let op = str_field(case, "op")?;
    Ok(match op {
        "dataDir" => {
            let env: HashMap<String, String> = case.get("env").and_then(Value::as_object).ok_or("missing env")?.iter().filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string()))).collect();
            json!(paths::resolve_data_dir(&env, Platform::HOST, || paths::node_homedir(&env, Platform::HOST)))
        }
        "path" => {
            let flavor = match str_field(case, "flavor")? {
                "win32" => Flavor::Win32,
                "posix" => Flavor::Posix,
                other => return Err(format!("unknown flavor {other}")),
            };
            let args = strings(case, "args")?;
            let first = args.first().map(String::as_str).unwrap_or("");
            match str_field(case, "fn")? {
                "join" => json!(nodepath::join(flavor, &args.iter().map(String::as_str).collect::<Vec<_>>())),
                "normalize" => json!(nodepath::normalize(flavor, first)),
                "isAbsolute" => json!(nodepath::is_absolute(flavor, first)),
                "dirname" => json!(nodepath::dirname(flavor, first)),
                "parseRoot" => json!(nodepath::parse_root(flavor, first)),
                other => return Err(format!("unknown path fn {other}")),
            }
        }
        "trim" => json!(crate::jsstr::js_trim(str_field(case, "s")?)),
        "bundleDir" => json!(paths::bundle_dir_for_entry(str_field(case, "entry")?)),
        "endpoint" => {
            let slot = case.get("slot").and_then(Value::as_u64).ok_or("missing slot")? as u32;
            json!(paths::endpoint_for(slot, str_field(case, "dataDir")?, str_field(case, "bundleDir")?))
        }
        "keyPath" => json!(paths::server_key_path(str_field(case, "dataDir")?)),
        "readKey" => json!(paths::read_server_key(str_field(case, "dataDir")?).map(|k| hex(&k))),
        "mac" => {
            let key = unhex(str_field(case, "keyHex")?)?;
            let parts = strings(case, "parts")?;
            json!(protocol::mac(&key, &parts.iter().map(String::as_str).collect::<Vec<_>>()))
        }
        "macMatches" => json!(protocol::mac_matches(str_field(case, "expected")?, str_field(case, "actual")?)),
        "encodeFrame" => {
            let message = case.get("message").ok_or("missing message")?;
            let frame = protocol::encode_message(message);
            json!({ "hex": hex(&frame), "fits": protocol::frame_fits(&frame) })
        }
        "encodeSized" => {
            // A JSON string of `bodyBytes` bytes in all: two quotes around bodyBytes - 2 letters.
            let n = case.get("bodyBytes").and_then(Value::as_u64).ok_or("missing bodyBytes")? as usize;
            let message = Value::String("a".repeat(n.saturating_sub(2)));
            let frame = protocol::encode_message(&message);
            json!({ "header": hex(&frame[..4]), "bodySha256": hex(&Sha256::digest(&frame[4..])), "fits": protocol::frame_fits(&frame) })
        }
        "decode" => {
            let mut reader = protocol::FrameReader::default();
            let mut frames: Vec<Value> = Vec::new();
            let mut error = false;
            for chunk in strings(case, "chunksHex")? {
                let d = reader.push(&unhex(&chunk)?);
                frames.extend(d.frames.into_iter().map(Value::Object));
                error |= d.error.is_some();
            }
            json!({ "frames": frames, "error": error })
        }
        other => return Err(format!("unknown op {other}")),
    })
}

/// Prints `value` as JSON with every non-ASCII character written as a UTF-16 escape, so the output survives a pass through any console code page (the Windows surrogate test relays it through PowerShell) and still parses to the same value.
fn print_ascii(value: &Value) {
    let mut out = String::new();
    for c in value.to_string().chars() {
        if c.is_ascii() {
            out.push(c);
        } else {
            let mut units = [0u16; 2];
            for unit in c.encode_utf16(&mut units) {
                out.push(char::from(0x5c));
                out.push('u');
                out.push_str(&format!("{unit:04x}"));
            }
        }
    }
    println!("{out}");
}

/// Reads the cases from stdin and prints the answers. Input is parsed with the same lossy decoder as a server frame, so a case string holding a lone surrogate arrives as the U+FFFD Node would write for it.
pub fn run_vectors() -> i32 {
    let mut input = Vec::new();
    if let Err(e) = std::io::stdin().read_to_end(&mut input) {
        eprintln!("tg-hook: cannot read stdin: {e}");
        return 2;
    }
    let cases = match protocol::parse_json_lossy(&input) {
        Ok(Value::Array(cases)) => cases,
        Ok(_) => {
            eprintln!("tg-hook: --selftest-vectors expects a JSON array");
            return 2;
        }
        Err(e) => {
            eprintln!("tg-hook: --selftest-vectors input is not JSON: {e}");
            return 2;
        }
    };
    let results: Vec<Value> = cases
        .iter()
        .map(|c| match c.as_object().ok_or_else(|| "case is not an object".to_string()).and_then(run_case) {
            Ok(out) => json!({ "out": out }),
            Err(e) => json!({ "error": e }),
        })
        .collect();
    print_ascii(&Value::Array(results));
    0
}

/// `--selftest-real [NAME...]`: what this process resolves from its own environment, plus the decoded value of each variable named, so a test can compare the real-environment path (lookup, decoding, home directory) with Node's under the same environment.
pub fn run_real(names: &[String]) -> i32 {
    let env: Map<String, Value> = names.iter().map(|n| (n.clone(), json!(std::env::var_os(n).map(|v| crate::jsstr::os_to_js(&v))))).collect();
    let out = json!({
        "dataDir": paths::data_dir(),
        "homedir": paths::node_homedir(&paths::RealEnv, Platform::HOST),
        "env": env,
    });
    print_ascii(&out);
    0
}

/// `--selftest-env`: the environment and working directory a request from this process carries, so a test can hold them to `envSnapshot()` and `process.cwd()` in a Node process started the same way.
pub fn run_env() -> i32 {
    print_ascii(&json!({ "env": crate::client::env_snapshot(), "cwd": crate::client::node_cwd() }));
    0
}
