//! A port of the parts of Node's `path` module the data directory, key path and endpoint are built from: `normalize`, `join`, `isAbsolute`, `dirname` and the `root` of `parse`, for both `path.win32` and `path.posix`. Ported line for line from lib/path.js at v24.12.0, which matches v22.23.3 in every function here (older 22.x lines lack the reserved-device-name handling). The code works in UTF-16 code units because Node does: every length test, index and slice below counts them, and a byte-based port would disagree on a path whose non-ASCII characters sit next to a length check.

use crate::jsstr::{from_utf16, utf16};

const SLASH: u16 = b'/' as u16;
const BACKSLASH: u16 = b'\\' as u16;
const DOT: u16 = b'.' as u16;
const COLON: u16 = b':' as u16;

/// Which of Node's two path implementations to follow.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Flavor {
    Win32,
    Posix,
}

fn is_sep(c: u16) -> bool {
    c == SLASH || c == BACKSLASH
}

fn is_posix_sep(c: u16) -> bool {
    c == SLASH
}

fn is_device_root(c: u16) -> bool {
    (u16::from(b'A')..=u16::from(b'Z')).contains(&c) || (u16::from(b'a')..=u16::from(b'z')).contains(&c)
}

fn index_of(s: &[u16], c: u16, from: usize) -> Option<usize> {
    s.iter().skip(from).position(|&x| x == c).map(|p| p + from)
}

/// `path.slice(0, end)` where `end` may be -1 (a missing colon), which JavaScript counts from the end.
fn js_slice_to(s: &[u16], end: i64) -> &[u16] {
    let len = s.len() as i64;
    let end = if end < 0 { (len + end).max(0) } else { end.min(len) };
    &s[..end as usize]
}

const WINDOWS_RESERVED_NAMES: [&str; 28] = [
    "CON",
    "PRN",
    "AUX",
    "NUL",
    "COM1",
    "COM2",
    "COM3",
    "COM4",
    "COM5",
    "COM6",
    "COM7",
    "COM8",
    "COM9",
    "LPT1",
    "LPT2",
    "LPT3",
    "LPT4",
    "LPT5",
    "LPT6",
    "LPT7",
    "LPT8",
    "LPT9",
    "COM\u{b9}",
    "COM\u{b2}",
    "COM\u{b3}",
    "LPT\u{b9}",
    "LPT\u{b2}",
    "LPT\u{b3}",
];

/// `isWindowsReservedName(path, colonIndex)`, including its reading of a missing colon (-1) as "all but the last character".
fn is_windows_reserved_name(path: &[u16], colon_index: i64) -> bool {
    let device = from_utf16(js_slice_to(path, colon_index)).to_uppercase();
    WINDOWS_RESERVED_NAMES.contains(&device.as_str())
}

fn colon_index(path: &[u16]) -> i64 {
    index_of(path, COLON, 0).map_or(-1, |i| i as i64)
}

/// `normalizeString`: resolves `.` and `..` segments.
fn normalize_string(path: &[u16], allow_above_root: bool, separator: u16, is_separator: fn(u16) -> bool) -> Vec<u16> {
    let mut res: Vec<u16> = Vec::new();
    let mut last_segment_length: i64 = 0;
    let mut last_slash: i64 = -1;
    let mut dots: i64 = 0;
    let mut code: u16 = 0;
    let len = path.len();
    for i in 0..=len {
        if i < len {
            code = path[i];
        } else if is_separator(code) {
            break;
        } else {
            code = SLASH;
        }
        let ii = i as i64;
        if is_separator(code) {
            if last_slash == ii - 1 || dots == 1 {
                // NOOP
            } else if dots == 2 {
                let n = res.len();
                if n < 2 || last_segment_length != 2 || res[n - 1] != DOT || res[n - 2] != DOT {
                    if n > 2 {
                        let last_slash_index = n as i64 - last_segment_length - 1;
                        if last_slash_index == -1 {
                            res.clear();
                            last_segment_length = 0;
                        } else {
                            res.truncate(last_slash_index as usize);
                            let last_sep = res.iter().rposition(|&x| x == separator).map_or(-1, |p| p as i64);
                            last_segment_length = res.len() as i64 - 1 - last_sep;
                        }
                        last_slash = ii;
                        dots = 0;
                        continue;
                    } else if n != 0 {
                        res.clear();
                        last_segment_length = 0;
                        last_slash = ii;
                        dots = 0;
                        continue;
                    }
                }
                if allow_above_root {
                    if !res.is_empty() {
                        res.push(separator);
                    }
                    res.extend_from_slice(&[DOT, DOT]);
                    last_segment_length = 2;
                }
            } else {
                let segment = &path[(last_slash + 1) as usize..i];
                if !res.is_empty() {
                    res.push(separator);
                }
                res.extend_from_slice(segment);
                last_segment_length = ii - last_slash - 1;
            }
            last_slash = ii;
            dots = 0;
        } else if code == DOT && dots != -1 {
            dots += 1;
        } else {
            dots = -1;
        }
    }
    res
}

fn cat(parts: &[&[u16]]) -> Vec<u16> {
    parts.concat()
}

/// `path.win32.normalize`.
fn win32_normalize(path: &[u16]) -> Vec<u16> {
    let len = path.len();
    if len == 0 {
        return vec![DOT];
    }
    let mut root_end = 0usize;
    let mut device: Option<Vec<u16>> = None;
    let mut is_absolute = false;
    let code = path[0];
    if len == 1 {
        return if is_posix_sep(code) { vec![BACKSLASH] } else { path.to_vec() };
    }
    if is_sep(code) {
        is_absolute = true;
        if is_sep(path[1]) {
            let mut j = 2;
            let mut last = j;
            while j < len && !is_sep(path[j]) {
                j += 1;
            }
            if j < len && j != last {
                let first_part = &path[last..j];
                last = j;
                while j < len && is_sep(path[j]) {
                    j += 1;
                }
                if j < len && j != last {
                    last = j;
                    while j < len && !is_sep(path[j]) {
                        j += 1;
                    }
                    if j == len || j != last {
                        if first_part == [DOT] || first_part == [u16::from(b'?')] {
                            device = Some(cat(&[&[BACKSLASH, BACKSLASH], first_part]));
                            root_end = 4;
                            let ci = colon_index(path);
                            let possible_device = if 4 <= (ci + 1).max(0) as usize { &path[4..(ci + 1) as usize] } else { &path[0..0] };
                            if is_windows_reserved_name(possible_device, possible_device.len() as i64 - 1) {
                                device = Some(cat(&[&utf16("\\\\?\\"), possible_device]));
                                root_end = 4 + possible_device.len();
                            }
                        } else if j == len {
                            return cat(&[&[BACKSLASH, BACKSLASH], first_part, &[BACKSLASH], &path[last..], &[BACKSLASH]]);
                        } else {
                            device = Some(cat(&[&[BACKSLASH, BACKSLASH], first_part, &[BACKSLASH], &path[last..j]]));
                            root_end = j;
                        }
                    }
                }
            }
        } else {
            root_end = 1;
        }
    } else {
        let ci = colon_index(path);
        if ci > 0 {
            if is_device_root(code) && ci == 1 {
                device = Some(path[0..2].to_vec());
                root_end = 2;
                if len > 2 && is_sep(path[2]) {
                    is_absolute = true;
                    root_end = 3;
                }
            } else if is_windows_reserved_name(path, ci) {
                device = Some(path[0..(ci + 1) as usize].to_vec());
                root_end = (ci + 1) as usize;
            }
        }
    }

    let mut tail = if root_end < len { normalize_string(&path[root_end..], !is_absolute, BACKSLASH, is_sep) } else { Vec::new() };
    if tail.is_empty() && !is_absolute {
        tail = vec![DOT];
    }
    if !tail.is_empty() && is_sep(path[len - 1]) {
        tail.push(BACKSLASH);
    }
    if !is_absolute && device.is_none() && path.contains(&COLON) {
        if tail.len() >= 2 && is_device_root(tail[0]) && tail[1] == COLON {
            return cat(&[&[DOT, BACKSLASH], &tail]);
        }
        let mut index = index_of(path, COLON, 0);
        while let Some(ix) = index {
            if ix == len - 1 || is_sep(path[ix + 1]) {
                return cat(&[&[DOT, BACKSLASH], &tail]);
            }
            index = index_of(path, COLON, ix + 1);
        }
    }
    if is_windows_reserved_name(path, colon_index(path)) {
        return cat(&[&[DOT, BACKSLASH], device.as_deref().unwrap_or(&[]), &tail]);
    }
    match device {
        None => {
            if is_absolute {
                cat(&[&[BACKSLASH], &tail])
            } else {
                tail
            }
        }
        Some(d) => {
            if is_absolute {
                cat(&[&d, &[BACKSLASH], &tail])
            } else {
                cat(&[&d, &tail])
            }
        }
    }
}

/// `path.win32.join`.
fn win32_join(args: &[Vec<u16>]) -> Vec<u16> {
    let parts: Vec<&Vec<u16>> = args.iter().filter(|a| !a.is_empty()).collect();
    if parts.is_empty() {
        return vec![DOT];
    }
    let first_part = parts[0];
    let mut joined: Vec<u16> = Vec::new();
    for (i, p) in parts.iter().enumerate() {
        if i > 0 {
            joined.push(BACKSLASH);
        }
        joined.extend_from_slice(p);
    }
    let mut needs_replace = true;
    let mut slash_count = 0usize;
    if is_sep(first_part[0]) {
        slash_count += 1;
        let first_len = first_part.len();
        if first_len > 1 && is_sep(first_part[1]) {
            slash_count += 1;
            if first_len > 2 {
                if is_sep(first_part[2]) {
                    slash_count += 1;
                } else {
                    needs_replace = false;
                }
            }
        }
    }
    if needs_replace {
        while slash_count < joined.len() && is_sep(joined[slash_count]) {
            slash_count += 1;
        }
        if slash_count >= 2 {
            joined = cat(&[&[BACKSLASH], &joined[slash_count..]]);
        }
    }

    // Skip normalization when reserved device names are present.
    let mut segs: Vec<Vec<u16>> = Vec::new();
    let mut part: Vec<u16> = Vec::new();
    let mut i = 0;
    while i < joined.len() {
        if joined[i] == BACKSLASH {
            if !part.is_empty() {
                segs.push(std::mem::take(&mut part));
            }
            part.clear();
            while i + 1 < joined.len() && joined[i + 1] == BACKSLASH {
                i += 1;
            }
        } else {
            part.push(joined[i]);
        }
        i += 1;
    }
    if !part.is_empty() {
        segs.push(part);
    }
    if segs.iter().any(|p| {
        let ci = colon_index(p);
        ci != -1 && is_windows_reserved_name(p, ci)
    }) {
        return joined.iter().map(|&c| if c == SLASH { BACKSLASH } else { c }).collect();
    }
    win32_normalize(&joined)
}

fn win32_is_absolute(path: &[u16]) -> bool {
    let len = path.len();
    if len == 0 {
        return false;
    }
    let code = path[0];
    is_sep(code) || (len > 2 && is_device_root(code) && path[1] == COLON && is_sep(path[2]))
}

/// `path.win32.dirname`.
fn win32_dirname(path: &[u16]) -> Vec<u16> {
    let len = path.len();
    if len == 0 {
        return vec![DOT];
    }
    let mut root_end: i64 = -1;
    let mut offset = 0usize;
    let code = path[0];
    if len == 1 {
        return if is_sep(code) { path.to_vec() } else { vec![DOT] };
    }
    if is_sep(code) {
        root_end = 1;
        offset = 1;
        if is_sep(path[1]) {
            let mut j = 2;
            let mut last = j;
            while j < len && !is_sep(path[j]) {
                j += 1;
            }
            if j < len && j != last {
                last = j;
                while j < len && is_sep(path[j]) {
                    j += 1;
                }
                if j < len && j != last {
                    last = j;
                    while j < len && !is_sep(path[j]) {
                        j += 1;
                    }
                    if j == len {
                        return path.to_vec();
                    }
                    if j != last {
                        root_end = (j + 1) as i64;
                        offset = j + 1;
                    }
                }
            }
        }
    } else if is_device_root(code) && path[1] == COLON {
        root_end = if len > 2 && is_sep(path[2]) { 3 } else { 2 };
        offset = root_end as usize;
    }
    let mut end: i64 = -1;
    let mut matched_slash = true;
    let mut i = len as i64 - 1;
    while i >= offset as i64 {
        if is_sep(path[i as usize]) {
            if !matched_slash {
                end = i;
                break;
            }
        } else {
            matched_slash = false;
        }
        i -= 1;
    }
    if end == -1 {
        if root_end == -1 {
            return vec![DOT];
        }
        end = root_end;
    }
    path[..end as usize].to_vec()
}

/// The `root` field of `path.win32.parse`.
fn win32_parse_root(path: &[u16]) -> Vec<u16> {
    let len = path.len();
    if len == 0 {
        return Vec::new();
    }
    let mut root_end = 0usize;
    let code = path[0];
    if len == 1 {
        return if is_sep(code) { path.to_vec() } else { Vec::new() };
    }
    if is_sep(code) {
        root_end = 1;
        if is_sep(path[1]) {
            let mut j = 2;
            let mut last = j;
            while j < len && !is_sep(path[j]) {
                j += 1;
            }
            if j < len && j != last {
                last = j;
                while j < len && is_sep(path[j]) {
                    j += 1;
                }
                if j < len && j != last {
                    last = j;
                    while j < len && !is_sep(path[j]) {
                        j += 1;
                    }
                    if j == len {
                        root_end = j;
                    } else if j != last {
                        root_end = j + 1;
                    }
                }
            }
        }
    } else if is_device_root(code) && path[1] == COLON {
        if len <= 2 {
            return path.to_vec();
        }
        root_end = 2;
        if is_sep(path[2]) {
            if len == 3 {
                return path.to_vec();
            }
            root_end = 3;
        }
    }
    if root_end > 0 { path[..root_end].to_vec() } else { Vec::new() }
}

/// `path.posix.normalize`.
fn posix_normalize(path: &[u16]) -> Vec<u16> {
    if path.is_empty() {
        return vec![DOT];
    }
    let is_absolute = path[0] == SLASH;
    let trailing_separator = path[path.len() - 1] == SLASH;
    let mut out = normalize_string(path, !is_absolute, SLASH, is_posix_sep);
    if out.is_empty() {
        if is_absolute {
            return vec![SLASH];
        }
        return if trailing_separator { vec![DOT, SLASH] } else { vec![DOT] };
    }
    if trailing_separator {
        out.push(SLASH);
    }
    if is_absolute { cat(&[&[SLASH], &out]) } else { out }
}

fn posix_join(args: &[Vec<u16>]) -> Vec<u16> {
    let parts: Vec<&Vec<u16>> = args.iter().filter(|a| !a.is_empty()).collect();
    if parts.is_empty() {
        return vec![DOT];
    }
    let mut joined: Vec<u16> = Vec::new();
    for (i, p) in parts.iter().enumerate() {
        if i > 0 {
            joined.push(SLASH);
        }
        joined.extend_from_slice(p);
    }
    posix_normalize(&joined)
}

fn posix_dirname(path: &[u16]) -> Vec<u16> {
    if path.is_empty() {
        return vec![DOT];
    }
    let has_root = path[0] == SLASH;
    let mut end: i64 = -1;
    let mut matched_slash = true;
    let mut i = path.len() as i64 - 1;
    while i >= 1 {
        if path[i as usize] == SLASH {
            if !matched_slash {
                end = i;
                break;
            }
        } else {
            matched_slash = false;
        }
        i -= 1;
    }
    if end == -1 {
        return if has_root { vec![SLASH] } else { vec![DOT] };
    }
    if has_root && end == 1 {
        return vec![SLASH, SLASH];
    }
    path[..end as usize].to_vec()
}

/// `path[flavor].join(...parts)`.
pub fn join(flavor: Flavor, parts: &[&str]) -> String {
    let units: Vec<Vec<u16>> = parts.iter().map(|p| utf16(p)).collect();
    from_utf16(&match flavor {
        Flavor::Win32 => win32_join(&units),
        Flavor::Posix => posix_join(&units),
    })
}

/// `path[flavor].normalize(p)`.
pub fn normalize(flavor: Flavor, p: &str) -> String {
    let units = utf16(p);
    from_utf16(&match flavor {
        Flavor::Win32 => win32_normalize(&units),
        Flavor::Posix => posix_normalize(&units),
    })
}

/// `path[flavor].isAbsolute(p)`.
pub fn is_absolute(flavor: Flavor, p: &str) -> bool {
    match flavor {
        Flavor::Win32 => win32_is_absolute(&utf16(p)),
        Flavor::Posix => p.starts_with('/'),
    }
}

/// `path[flavor].dirname(p)`.
pub fn dirname(flavor: Flavor, p: &str) -> String {
    let units = utf16(p);
    from_utf16(&match flavor {
        Flavor::Win32 => win32_dirname(&units),
        Flavor::Posix => posix_dirname(&units),
    })
}

/// `path[flavor].parse(p).root`.
pub fn parse_root(flavor: Flavor, p: &str) -> String {
    match flavor {
        Flavor::Win32 => from_utf16(&win32_parse_root(&utf16(p))),
        Flavor::Posix => {
            if p.starts_with('/') {
                "/".to_string()
            } else {
                String::new()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn win32_join_normalizes_separators_and_dots() {
        assert_eq!(join(Flavor::Win32, &["C:/x/lad", "dfk-helper", "token-goat"]), r"C:\x\lad\dfk-helper\token-goat");
        assert_eq!(join(Flavor::Win32, &[r"C:\a\.\b\..\c\", "d"]), r"C:\a\c\d");
        assert_eq!(join(Flavor::Win32, &["//server", "share"]), r"\\server\share\");
    }

    #[test]
    fn posix_join_normalizes_dots_and_repeated_slashes() {
        assert_eq!(join(Flavor::Posix, &["/a//b/./c/..", "d/"]), "/a/b/d/");
        assert_eq!(join(Flavor::Posix, &["", ""]), ".");
    }

    #[test]
    fn dirname_and_root() {
        assert_eq!(dirname(Flavor::Win32, r"C:\a\b\token-goat.mjs"), r"C:\a\b");
        assert_eq!(dirname(Flavor::Posix, "/a/b/"), "/a");
        assert_eq!(parse_root(Flavor::Win32, r"\tmp\tg"), r"\");
        assert_eq!(parse_root(Flavor::Win32, r"\\server\share\x"), r"\\server\share\");
    }
}
