//! `<dataDir>/hook-entry.json`, the pointer an install writes to where the current bundle lives, read back here when the entry path a hook command carries has gone missing. It is validated exactly as strictly as a baked `--entry` and never trusted past that: a pointer that fails any structural check is ignored whole, and a well-formed path whose file is absent simply leaves that piece out. The TypeScript twin is src/hook_pointer.ts; tests/fixtures/hook_pointer/cases.json is read by both suites so the two cannot drift.

use std::io::Read;
use std::path::{Path, PathBuf};

pub const FILE_NAME: &str = "hook-entry.json";
/// The largest pointer file read; the writer's output is a few hundred bytes.
const MAX_BYTES: u64 = 4096;
const SHIM_NAME: &str = "token-goat-shim.cjs";
const ENTRY_NAME: &str = "token-goat.mjs";

/// A validated pointer: `entry` exists; `node` and `shim` are set only when their files exist.
#[derive(Debug, PartialEq, Eq)]
pub struct Pointer {
    pub entry: PathBuf,
    pub node: Option<PathBuf>,
    pub shim: Option<PathBuf>,
    /// Each harness's own shim that exists, when the pointer carries the additive `shims` map.
    pub shims: Option<Vec<(String, PathBuf)>>,
}

impl Pointer {
    /// The shim for `harness`: its own entry in `shims` when the map is there (a harness without one has none), else the single `shim`.
    pub fn shim_for(&self, harness: &str) -> Option<&PathBuf> {
        match &self.shims {
            Some(map) => map.iter().find(|(h, _)| h == harness).map(|(_, p)| p),
            None => self.shim.as_ref(),
        }
    }
}

fn is_sep(c: char) -> bool {
    c == '/' || c == '\\'
}

fn base_matches(path: &str, names: &[&str]) -> bool {
    let base = path.rsplit(is_sep).next().unwrap_or("");
    names.iter().any(|n| if cfg!(windows) { base.eq_ignore_ascii_case(n) } else { base == *n })
}

/// A path the pointer may name: absolute, no `..`, no UNC or device namespace, no NUL.
fn structurally_sound(path: &str) -> Result<(), String> {
    if path.is_empty() || path.contains('\0') {
        return Err("empty path or NUL".into());
    }
    if path.starts_with("\\\\") || path.starts_with("//") {
        return Err(format!("UNC or device path {path}"));
    }
    if !Path::new(path).is_absolute() {
        return Err(format!("not an absolute path: {path}"));
    }
    if path.split(is_sep).any(|part| part == "..") {
        return Err(format!("parent reference in {path}"));
    }
    Ok(())
}

fn existing_file(path: &str) -> bool {
    std::fs::canonicalize(path).and_then(std::fs::metadata).is_ok_and(|m| m.is_file())
}

fn trimmed(dir: &str) -> String {
    let mut text = dir.replace('\\', "/");
    while text.len() > 1 && text.ends_with('/') {
        text.pop();
    }
    if cfg!(windows) { text.to_ascii_lowercase() } else { text }
}

/// Validates the text of a pointer file. `Err` names the first structural failure, or the missing entry.
pub fn parse(text: &str) -> Result<Pointer, String> {
    let value: serde_json::Value = serde_json::from_str(text).map_err(|e| format!("not JSON: {e}"))?;
    let object = value.as_object().ok_or("not an object")?;
    if object.get("schema").and_then(|v| v.as_u64()) != Some(1) {
        return Err("schema is not 1".into());
    }
    let string = |key: &str| object.get(key).and_then(|v| v.as_str());
    if string("version").is_none() || string("writtenAt").is_none() {
        return Err("version or writtenAt missing".into());
    }
    let entry = string("entry").ok_or("entry missing")?;
    structurally_sound(entry)?;
    if !base_matches(entry, &[ENTRY_NAME]) {
        return Err(format!("entry is not {ENTRY_NAME}: {entry}"));
    }
    let bundle = string("bundleDir").ok_or("bundleDir missing")?;
    structurally_sound(bundle)?;
    let entry_dir = entry.rsplit_once(is_sep).map_or("", |(dir, _)| dir);
    if trimmed(bundle) != trimmed(entry_dir) {
        return Err(format!("bundleDir {bundle} is not the directory of {entry}"));
    }
    let native = string("nativeBin").ok_or("nativeBin missing")?;
    structurally_sound(native)?;
    if !base_matches(native, &["tg-hook", "tg-hook.exe"]) {
        return Err(format!("nativeBin is not tg-hook: {native}"));
    }
    let optional = |key: &str, names: &[&str]| -> Result<Option<PathBuf>, String> {
        match object.get(key) {
            None | Some(serde_json::Value::Null) => Ok(None),
            Some(serde_json::Value::String(path)) => {
                structurally_sound(path)?;
                if !base_matches(path, names) {
                    return Err(format!("{key} has an unexpected name: {path}"));
                }
                Ok(existing_file(path).then(|| PathBuf::from(path)))
            }
            Some(_) => Err(format!("{key} is not a string or null")),
        }
    };
    let node = optional("node", &["node", "node.exe"])?;
    let shim = optional("shim", &[SHIM_NAME])?;
    let shims = object.get("shims").and_then(|v| v.as_object()).map(|map| {
        map.iter()
            .filter_map(|(harness, v)| v.as_str().map(|p| (harness.clone(), p)))
            .filter(|(_, p)| structurally_sound(p).is_ok() && base_matches(p, &[SHIM_NAME]) && existing_file(p))
            .map(|(harness, p)| (harness, PathBuf::from(p)))
            .collect::<Vec<_>>()
    });
    if !existing_file(entry) {
        return Err(format!("entry file is missing: {entry}"));
    }
    Ok(Pointer { entry: PathBuf::from(entry), node, shim, shims })
}

#[cfg(unix)]
fn trusted_owner(file: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    // SAFETY: geteuid has no preconditions and reads no memory of ours.
    let me = unsafe { libc::geteuid() };
    let ok = |p: &Path| std::fs::metadata(p).is_ok_and(|m| m.uid() == me && m.mode() & 0o022 == 0);
    ok(file) && file.parent().is_some_and(ok)
}

#[cfg(not(unix))]
fn trusted_owner(_file: &Path) -> bool {
    // No ACL check on Windows: write access to the data directory already grants everything the pointer could.
    true
}

/// Reads and validates `<data_dir>/hook-entry.json`.
pub fn load(data_dir: &str) -> Result<Pointer, String> {
    let file = Path::new(data_dir).join(FILE_NAME);
    let mut text = String::new();
    let opened = std::fs::File::open(&file).map_err(|e| format!("cannot open {}: {e}", file.display()))?;
    opened.take(MAX_BYTES + 1).read_to_string(&mut text).map_err(|e| format!("cannot read {}: {e}", file.display()))?;
    if text.len() as u64 > MAX_BYTES {
        return Err(format!("{} is larger than {MAX_BYTES} bytes", file.display()));
    }
    if !trusted_owner(&file) {
        return Err(format!("{} is not owned by this user or is writable by others", file.display()));
    }
    parse(&text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const CASES: &str = include_str!("../../../tests/fixtures/hook_pointer/cases.json");

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tg-ptr-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn substitute(value: &Value, root: &str) -> Value {
        match value {
            Value::String(s) => Value::String(s.replace("{ROOT}", root).replace("{EXE}", if cfg!(windows) { ".exe" } else { "" })),
            Value::Array(a) => Value::Array(a.iter().map(|v| substitute(v, root)).collect()),
            Value::Object(o) => Value::Object(o.iter().map(|(k, v)| (k.clone(), substitute(v, root))).collect()),
            other => other.clone(),
        }
    }

    #[test]
    fn every_shared_fixture_case_is_judged_as_the_fixture_says() {
        let cases: Value = serde_json::from_str(CASES).unwrap();
        let cases = cases["cases"].as_array().unwrap();
        assert!(cases.len() >= 20, "the fixture lost cases: {}", cases.len());
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let root_dir = scratch(&name.replace(|c: char| !c.is_ascii_alphanumeric(), "_"));
            let root = root_dir.to_string_lossy().to_string();
            for file in case["files"].as_array().unwrap() {
                let rel = substitute(file, &root);
                let path = root_dir.join(rel.as_str().unwrap());
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(&path, "x").unwrap();
            }
            let text = match (case.get("raw"), case.get("rawBytes")) {
                (Some(raw), _) => substitute(raw, &root).as_str().unwrap().to_string(),
                (None, Some(n)) => " ".repeat(n.as_u64().unwrap() as usize),
                (None, None) => substitute(&case["pointer"], &root).to_string(),
            };
            let parsed = if text.len() as u64 > MAX_BYTES { Err("oversize".to_string()) } else { parse(&text) };
            let expect = &case["expect"];
            assert_eq!(parsed.is_ok(), expect["usable"].as_bool().unwrap(), "{name}: {parsed:?}");
            if let Ok(p) = parsed {
                assert_eq!(p.node.is_some(), expect["node"].as_bool().unwrap(), "{name}: node");
                assert_eq!(p.shim.is_some(), expect["shim"].as_bool().unwrap(), "{name}: shim");
            }
            let _ = std::fs::remove_dir_all(&root_dir);
        }
    }

    #[test]
    fn load_refuses_an_absent_or_oversize_pointer() {
        let dir = scratch("load");
        assert!(load(dir.to_str().unwrap()).is_err());
        std::fs::write(dir.join(FILE_NAME), " ".repeat(5000)).unwrap();
        assert!(load(dir.to_str().unwrap()).unwrap_err().contains("larger than"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
