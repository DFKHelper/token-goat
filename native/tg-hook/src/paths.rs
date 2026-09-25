//! Where the hook server lives: the data directory (src/constants.ts `defaultDataDir`, `safeEnvDir`, `dataDirForHome`), the bundle directory (src/hook_ipc.ts `bundleDir`), the endpoint (`endpointId`, `endpointFor`) and the shared key (`serverKeyPath`, `readServerKey`). Each must produce the very string Node produces: a different string is not an error anyone sees, it is a client that finds no server and quietly takes the slow path on every call. tests/native_hook_conformance.test.ts pins every function here against the TypeScript it mirrors.

use std::collections::HashMap;
use std::ffi::OsStr;

use sha2::{Digest, Sha256};

use crate::jsstr::{js_trim, os_to_js};
use crate::nodepath::{self, Flavor};

/// The `process.platform` whose rules apply. Only win32 changes path syntax; darwin and every other POSIX system differ only in the home-relative default.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[allow(dead_code, reason = "each build constructs only its own platform through HOST")]
pub enum Platform {
    Win32,
    Darwin,
    Other,
}

impl Platform {
    #[cfg(windows)]
    pub const HOST: Platform = Platform::Win32;
    #[cfg(target_os = "macos")]
    pub const HOST: Platform = Platform::Darwin;
    #[cfg(all(not(windows), not(target_os = "macos")))]
    pub const HOST: Platform = Platform::Other;

    pub fn flavor(self) -> Flavor {
        if self == Platform::Win32 { Flavor::Win32 } else { Flavor::Posix }
    }
}

/// A source of environment variables, so the resolution rules can run over the real environment or over a test case's.
pub trait Env {
    fn var(&self, key: &str) -> Option<String>;
}

/// The process environment, decoded the way Node decodes it. Lookups are case-insensitive on Windows, as `process.env` is.
pub struct RealEnv;

impl Env for RealEnv {
    fn var(&self, key: &str) -> Option<String> {
        std::env::var_os(key).map(|v| os_to_js(&v))
    }
}

impl Env for HashMap<String, String> {
    fn var(&self, key: &str) -> Option<String> {
        self.get(key).cloned()
    }
}

/// `safeEnvDir`: the trimmed value when it is an anchored absolute path, otherwise `None` (use the home-based default). On win32 a drive-less root (`\tmp`) is rejected because it resolves against whichever drive is current.
pub fn safe_env_dir(value: &str, platform: Platform) -> Option<String> {
    let stripped = js_trim(value);
    if stripped.is_empty() {
        return None;
    }
    let flavor = platform.flavor();
    if !nodepath::is_absolute(flavor, stripped) {
        return None;
    }
    if platform == Platform::Win32 {
        let root = nodepath::parse_root(flavor, stripped);
        if root.is_empty() || root == "\\" || root == "/" {
            return None;
        }
    }
    Some(stripped.to_string())
}

/// `dataDirForHome`.
pub fn data_dir_for_home(home: &str, platform: Platform) -> String {
    let flavor = platform.flavor();
    match platform {
        Platform::Win32 => nodepath::join(flavor, &[home, "AppData", "Local", "dfk-helper", "token-goat"]),
        Platform::Darwin => nodepath::join(flavor, &[home, "Library", "Application Support", "token-goat"]),
        Platform::Other => nodepath::join(flavor, &[home, ".local", "share", "token-goat"]),
    }
}

/// `os.homedir()`: libuv's `uv_os_homedir` takes USERPROFILE (Windows) or HOME (elsewhere) whenever it is set, and only then asks the OS. HOME is taken even when empty; a USERPROFILE under 3 bytes is refused outright (libuv src/win/util.c, "USERPROFILE is empty or invalid"), so Node throws ENOENT and so does `dataDir()`. `None` wherever Node would throw.
pub fn node_homedir(env: &dyn Env, platform: Platform) -> Option<String> {
    let key = if platform == Platform::Win32 { "USERPROFILE" } else { "HOME" };
    if let Some(v) = env.var(key) {
        return if platform == Platform::Win32 && v.len() < 3 { None } else { Some(v) };
    }
    // std consults the same variable first and then the same OS source libuv falls back to (GetUserProfileDirectoryW, getpwuid_r); the variable is unset here, so only the OS source answers.
    std::env::home_dir().map(|p| os_to_js(p.as_os_str()))
}

/// `defaultDataDir` for `platform` under `env`, with `home` consulted only when no override applies. The Vitest-only guard in `homeFallbackOrGuard` has no counterpart: it exists to stop a test from touching a developer's real data, and this binary is never a Vitest worker.
pub fn resolve_data_dir(env: &dyn Env, platform: Platform, home: impl FnOnce() -> Option<String>) -> Option<String> {
    let flavor = platform.flavor();
    let (var, suffix): (&str, &[&str]) = if platform == Platform::Win32 { ("LOCALAPPDATA", &["dfk-helper", "token-goat"]) } else { ("XDG_DATA_HOME", &["token-goat"]) };
    let raw = env.var(var).unwrap_or_default();
    let base = if raw.is_empty() { None } else { safe_env_dir(&raw, platform) };
    if let Some(base) = base {
        let mut parts: Vec<&str> = vec![&base];
        parts.extend_from_slice(suffix);
        return Some(nodepath::join(flavor, &parts));
    }
    home().map(|h| data_dir_for_home(&h, platform))
}

/// The data directory this process would use, resolved from its own environment.
pub fn data_dir() -> Option<String> {
    resolve_data_dir(&RealEnv, Platform::HOST, || node_homedir(&RealEnv, Platform::HOST))
}

/// `fs.realpathSync.native(dir)`. On Windows that is libuv's `GetFinalPathNameByHandleW` with the `\\?\` prefix removed (`\\?\UNC\` becomes `\\`); a result with neither prefix is an error there, so it is one here. `std::fs::canonicalize` makes the same call but keeps the prefix, which would hash differently.
fn realpath_native(dir: &str) -> Option<String> {
    let real = std::fs::canonicalize(dir).ok()?;
    #[cfg(windows)]
    {
        use std::ffi::OsString;
        use std::os::windows::ffi::{OsStrExt, OsStringExt};
        let wide: Vec<u16> = real.as_os_str().encode_wide().collect();
        let unc: Vec<u16> = r"\\?\UNC\".encode_utf16().collect();
        let long: Vec<u16> = r"\\?\".encode_utf16().collect();
        let stripped: Vec<u16> = if wide.starts_with(&unc) {
            let mut v: Vec<u16> = r"\\".encode_utf16().collect();
            v.extend_from_slice(&wide[unc.len()..]);
            v
        } else if wide.starts_with(&long) {
            wide[long.len()..].to_vec()
        } else {
            return None;
        };
        Some(os_to_js(&OsString::from_wide(&stripped)))
    }
    #[cfg(not(windows))]
    {
        Some(os_to_js(real.as_os_str()))
    }
}

/// `bundleDir` for the bundle entry named on the command line: the real path of its directory, or the directory as written when that cannot be resolved.
pub fn bundle_dir_for_entry(entry: &str) -> String {
    let dir = nodepath::dirname(Platform::HOST.flavor(), entry);
    realpath_native(&dir).unwrap_or(dir)
}

/// `endpointId`: the first 16 hex characters of SHA-256 over the two directories, lowercased first on win32 only (`String.prototype.toLowerCase`, which `str::to_lowercase` matches, final sigma included).
pub fn endpoint_id(data_dir: &str, bundle_dir: &str, platform: Platform) -> String {
    let fold = |p: &str| if platform == Platform::Win32 { p.to_lowercase() } else { p.to_string() };
    let digest = Sha256::new().chain_update(fold(data_dir)).chain_update([0u8]).chain_update(fold(bundle_dir)).finalize();
    let mut hex = String::with_capacity(64);
    for b in digest.iter() {
        hex.push_str(&format!("{b:02x}"));
    }
    hex.truncate(16);
    hex
}

/// `endpointFor`: the pipe name on Windows; elsewhere the socket in the data directory, or under `token-goat-<uid>` in the temp directory when that path would reach the ~104-byte Unix socket limit.
pub fn endpoint_for(slot: u32, data_dir: &str, bundle_dir: &str) -> String {
    let id = format!("{}-{slot}", endpoint_id(data_dir, bundle_dir, Platform::HOST));
    if Platform::HOST == Platform::Win32 {
        return format!(r"\\.\pipe\token-goat-hooks-{id}");
    }
    let in_data = nodepath::join(Flavor::Posix, &[data_dir, &format!("hooks-{id}.sock")]);
    if in_data.len() < 100 {
        return in_data;
    }
    match private_temp_dir() {
        Some(own) => nodepath::join(Flavor::Posix, &[&own, &format!("{id}.sock")]),
        None => in_data,
    }
}

#[cfg(unix)]
fn ids() -> (u32, u32, u32, u32) {
    // SAFETY: these four calls take no arguments, cannot fail, and touch no memory of ours.
    unsafe { (libc::getuid(), libc::geteuid(), libc::getgid(), libc::getegid()) }
}

/// Node's `SafeGetenv` refuses every variable in a process running with elevated identity (set-id bits, or AT_SECURE on Linux). Its exception for a process holding only CAP_NET_BIND_SERVICE is not reproduced.
#[cfg(unix)]
fn env_is_unsafe() -> bool {
    let (uid, euid, gid, egid) = ids();
    #[cfg(target_os = "linux")]
    // SAFETY: getauxval reads the process auxiliary vector and returns 0 for an absent entry.
    let at_secure = unsafe { libc::getauxval(libc::AT_SECURE) } != 0;
    #[cfg(not(target_os = "linux"))]
    let at_secure = false;
    at_secure || uid != euid || gid != egid
}

/// POSIX `os.tmpdir()`: the first non-empty of TMPDIR, TMP and TEMP, else `/tmp`, with one trailing slash removed.
#[cfg(unix)]
pub fn node_tmpdir(env: &dyn Env) -> String {
    let mut dir = String::new();
    if !env_is_unsafe() {
        for key in ["TMPDIR", "TMP", "TEMP"] {
            if let Some(v) = env.var(key).filter(|v| !v.is_empty()) {
                dir = v;
                break;
            }
        }
    }
    if dir.is_empty() {
        return "/tmp".to_string();
    }
    if dir.len() > 1 && dir.ends_with('/') {
        dir.pop();
    }
    dir
}

/// `privateTempDir`: `token-goat-<uid>` under the temp directory, created owner-only if absent, and used only when it is a real directory this user owns that nobody else can enter.
#[cfg(unix)]
fn private_temp_dir() -> Option<String> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt};
    let (uid, ..) = ids();
    let own = nodepath::join(Flavor::Posix, &[&node_tmpdir(&RealEnv), &format!("token-goat-{uid}")]);
    let _ = std::fs::DirBuilder::new().mode(0o700).create(&own);
    let st = std::fs::symlink_metadata(&own).ok()?;
    (st.is_dir() && st.uid() == uid && st.mode() & 0o077 == 0).then_some(own)
}

#[cfg(not(unix))]
fn private_temp_dir() -> Option<String> {
    None
}

/// `serverKeyPath`.
pub fn server_key_path(data_dir: &str) -> String {
    nodepath::join(Platform::HOST.flavor(), &[data_dir, "hook-server.key"])
}

pub const KEY_BYTES: usize = 32;

/// `readServerKey`: the 32-byte key, or `None` when it is absent, the wrong size, or (POSIX) open to anyone but its owner or owned by someone else.
pub fn read_server_key(data_dir: &str) -> Option<[u8; KEY_BYTES]> {
    let p = server_key_path(data_dir);
    let st = std::fs::metadata(OsStr::new(&p)).ok()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if st.mode() & 0o077 != 0 || st.uid() != ids().0 {
            return None;
        }
    }
    #[cfg(not(unix))]
    let _ = st;
    std::fs::read(&p).ok()?.try_into().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn win32_override_is_trimmed_and_joined() {
        let e = env(&[("LOCALAPPDATA", "  C:/Users/u/AppData/Local/ ")]);
        assert_eq!(resolve_data_dir(&e, Platform::Win32, || None).as_deref(), Some(r"C:\Users\u\AppData\Local\dfk-helper\token-goat"));
    }

    #[test]
    fn drive_less_root_falls_back_to_home() {
        let e = env(&[("LOCALAPPDATA", r"\tmp\tg")]);
        assert_eq!(resolve_data_dir(&e, Platform::Win32, || Some(r"C:\Users\u".into())).as_deref(), Some(r"C:\Users\u\AppData\Local\dfk-helper\token-goat"));
    }

    #[test]
    fn short_userprofile_is_refused_but_empty_home_is_kept() {
        assert_eq!(node_homedir(&env(&[("USERPROFILE", "é")]), Platform::Win32), None);
        assert_eq!(node_homedir(&env(&[("USERPROFILE", "éa")]), Platform::Win32).as_deref(), Some("éa"));
        assert_eq!(node_homedir(&env(&[("HOME", "")]), Platform::Other).as_deref(), Some(""));
    }

    #[test]
    fn endpoint_id_folds_case_on_win32_only() {
        assert_eq!(endpoint_id(r"C:\A", r"C:\B", Platform::Win32), endpoint_id(r"c:\a", r"c:\b", Platform::Win32));
        assert_ne!(endpoint_id("/A", "/B", Platform::Other), endpoint_id("/a", "/b", Platform::Other));
    }
}
