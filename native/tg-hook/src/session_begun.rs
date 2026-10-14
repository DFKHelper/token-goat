//! The begun stamp for a Copilot session start whose payload was received but whose deadline passed before the Node shim could stamp it, so the first tool call still delivers the reminder. A plain mirror of `resetSessionStartOwedFiles` in src/bridges/copilot_session_start.ts; tests/native_hook_conformance.test.ts pins both to the same file for the same payloads.
#![cfg_attr(not(windows), allow(dead_code, reason = "only the Windows installed startup path stamps; the pin test runs the rule everywhere"))]

use serde_json::Value;

use crate::nodepath;
use crate::paths::{self, Env, Platform};

const STEM_UNITS: usize = 64;

/// JavaScript truthiness of a parsed JSON value.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    }
}

/// The sidecar stem of a main-thread session id: every UTF-16 unit outside `[A-Za-z0-9_-]` becomes `_`, cut to 64 units. `None` for a payload that names no main-thread session (no string id, a `:agent:` id, or an agent id).
pub fn stem(payload: &Value) -> Option<String> {
    let raw = match payload.get("session_id") {
        Some(id) => id,
        None => payload.get("sessionId")?,
    };
    let id = raw.as_str().filter(|id| !id.is_empty() && !id.contains(":agent:"))?;
    if truthy(payload.get("agent_id")) || truthy(payload.get("agentId")) {
        return None;
    }
    let stem: String = id
        .encode_utf16()
        .take(STEM_UNITS)
        .map(|unit| match u8::try_from(unit) {
            Ok(byte) if byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-' => char::from(byte),
            _ => '_',
        })
        .collect();
    Some(stem)
}

/// Where token-goat keeps its per-session files: an absolute `TOKEN_GOAT_HOME` (a drive-less root is refused on win32), otherwise `.token-goat` under the Node home directory.
fn sessions_dir(env: &dyn Env, platform: Platform) -> Option<String> {
    let flavor = platform.flavor();
    let home = match env.var("TOKEN_GOAT_HOME").and_then(|value| paths::safe_env_dir(&value, platform)) {
        Some(home) => home,
        None => nodepath::join(flavor, &[&paths::node_homedir(env, platform)?, ".token-goat"]),
    };
    Some(nodepath::join(flavor, &[&home, "sessions"]))
}

/// The begun-stamp file of this payload's session, if it names one.
pub fn begun_path(payload: &Value, env: &dyn Env, platform: Platform) -> Option<String> {
    let stem = stem(payload)?;
    Some(nodepath::join(platform.flavor(), &[&sessions_dir(env, platform)?, &format!("{stem}.session-start")]))
}

/// Drops the delivery claim an earlier start left and writes the begun stamp. Best effort: a start that cannot be stamped fails open exactly as before.
pub fn stamp(payload_bytes: &[u8]) {
    let Ok(payload) = crate::protocol::parse_json_lossy(payload_bytes) else { return };
    let Some(begun) = begun_path(&payload, &paths::RealEnv, Platform::HOST) else { return };
    let begun = std::path::PathBuf::from(begun);
    let Some(dir) = begun.parent() else { return };
    let claim = begun.with_file_name(format!("{}-owed", begun.file_name().map(|n| n.to_string_lossy()).unwrap_or_default()));
    let _ = std::fs::remove_file(claim);
    let _ = std::fs::create_dir_all(dir);
    let at_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_millis());
    let _ = std::fs::write(begun, format!("{{\"begunAtMs\":{at_ms}}}"));
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    #[test]
    fn stem_follows_the_shim_rule() {
        assert_eq!(stem(&json!({"session_id": "plain-id_1"})).as_deref(), Some("plain-id_1"));
        assert_eq!(stem(&json!({"sessionId": "a b/c:d.e"})).as_deref(), Some("a_b_c_d_e"));
        assert_eq!(stem(&json!({"session_id": "x".repeat(90)})).as_deref(), Some("x".repeat(64).as_str()));
        // One underscore per UTF-16 unit: a character outside the BMP is two.
        assert_eq!(stem(&json!({"session_id": "a\u{1F642}b"})).as_deref(), Some("a__b"));
        assert_eq!(stem(&json!({"session_id": null, "sessionId": "ignored"})), None);
        assert_eq!(stem(&json!({"session_id": "s", "sessionId": "other"})).as_deref(), Some("s"));
    }

    #[test]
    fn subagent_and_nameless_payloads_get_no_stem() {
        for payload in
            [json!({}), json!({"session_id": ""}), json!({"session_id": 7}), json!({"session_id": "p:agent:q"}), json!({"session_id": "p", "agent_id": "a"}), json!({"session_id": "p", "agentId": 1})]
        {
            assert_eq!(stem(&payload), None, "{payload}");
        }
        assert_eq!(stem(&json!({"session_id": "p", "agent_id": ""})).as_deref(), Some("p"));
    }

    #[test]
    fn home_override_must_be_absolute() {
        let env: HashMap<String, String> = [("HOME".to_string(), "/home/u".to_string()), ("TOKEN_GOAT_HOME".to_string(), "relative/dir".to_string())].into();
        let payload = json!({"session_id": "s"});
        assert_eq!(begun_path(&payload, &env, Platform::Other).as_deref(), Some("/home/u/.token-goat/sessions/s.session-start"));
        let env: HashMap<String, String> = [("TOKEN_GOAT_HOME".to_string(), " /abs/home ".to_string())].into();
        assert_eq!(begun_path(&payload, &env, Platform::Other).as_deref(), Some("/abs/home/sessions/s.session-start"));
    }
}
