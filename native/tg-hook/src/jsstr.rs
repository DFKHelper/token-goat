//! JavaScript string semantics the hook client has to reproduce byte for byte: `String.prototype.trim`, how Node turns OS strings into JS strings, and how a JS string with a lone surrogate reaches the wire. Rust's own `str::trim` and `to_string_lossy` differ from both in small ways, and a small difference here changes an endpoint hash, so nothing in the crate uses them for these jobs.

use std::borrow::Cow;
use std::ffi::OsStr;

/// The characters ECMAScript `String.prototype.trim` strips: WhiteSpace (TAB, VT, FF, SP, NBSP, ZWNBSP and every `Zs` character) plus LineTerminator. Unlike `char::is_whitespace` it strips U+FEFF and keeps U+0085.
fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}' | '\u{000A}' | '\u{000B}' | '\u{000C}' | '\u{000D}' | '\u{0020}' | '\u{00A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}

/// `s.trim()` as JavaScript computes it.
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_whitespace)
}

/// The JS string Node builds from an OS string (an environment value or a path libuv returned). libuv hands Node WTF-8 on Windows and raw bytes on POSIX, and V8 decodes both as UTF-8 with U+FFFD per maximal invalid subpart, so a Windows lone surrogate becomes three U+FFFD, not the one `OsStr::to_string_lossy` gives. `as_encoded_bytes` is that same WTF-8 on Windows and the raw bytes on POSIX, and `from_utf8_lossy` substitutes by maximal subpart too.
pub fn os_to_js(s: &OsStr) -> String {
    String::from_utf8_lossy(s.as_encoded_bytes()).into_owned()
}

/// UTF-16 code units, the unit every `length`, index and slice in Node's path module counts in.
pub fn utf16(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

/// Back from code units. Node writes a lone surrogate out as U+FFFD, so that is what one becomes here.
pub fn from_utf16(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

fn hex4(b: &[u8], at: usize) -> Option<u16> {
    let digits = b.get(at..at + 4)?;
    let text = std::str::from_utf8(digits).ok()?;
    if !text.bytes().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    u16::from_str_radix(text, 16).ok()
}

/// JSON text with every lone-surrogate `\uXXXX` escape inside a string replaced by `FFFD`. `JSON.parse` accepts a lone surrogate escape and yields a JS string that Node then writes, hashes and MACs as the UTF-8 of U+FFFD; serde_json refuses the escape outright. A server reply whose stdout held a lone surrogate (text sliced mid-pair) must decode, not fail, and must MAC the same bytes Node does, so it is rewritten to exactly what Node would have encoded. Escaped backslashes (`\\u`) and paired surrogates are left alone.
pub fn replace_lone_surrogate_escapes(json: &str) -> Cow<'_, str> {
    if !json.contains("\\u") {
        return Cow::Borrowed(json);
    }
    let b = json.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut in_string = false;
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if !in_string {
            if c == b'"' {
                in_string = true;
            }
            out.push(c);
            i += 1;
            continue;
        }
        match c {
            b'"' => {
                in_string = false;
                out.push(c);
                i += 1;
            }
            b'\\' if b.get(i + 1) == Some(&b'u') => match hex4(b, i + 2) {
                Some(u) if (0xD800..0xDC00).contains(&u) => {
                    let low = if b.get(i + 6) == Some(&b'\\') && b.get(i + 7) == Some(&b'u') { hex4(b, i + 8) } else { None };
                    if low.is_some_and(|l| (0xDC00..0xE000).contains(&l)) {
                        out.extend_from_slice(&b[i..i + 12]);
                        i += 12;
                    } else {
                        out.extend_from_slice(b"\\uFFFD");
                        i += 6;
                    }
                }
                Some(u) if (0xDC00..0xE000).contains(&u) => {
                    out.extend_from_slice(b"\\uFFFD");
                    i += 6;
                }
                Some(_) => {
                    out.extend_from_slice(&b[i..i + 6]);
                    i += 6;
                }
                // A malformed escape is left for the parser to reject.
                None => {
                    out.extend_from_slice(&b[i..i + 2]);
                    i += 2;
                }
            },
            b'\\' => {
                let end = (i + 2).min(b.len());
                out.extend_from_slice(&b[i..end]);
                i = end;
            }
            _ => {
                out.push(c);
                i += 1;
            }
        }
    }
    // Only ASCII was inserted or removed, and only at ASCII boundaries, so this cannot fail; the fallback keeps a bug from becoming a panic.
    match String::from_utf8(out) {
        Ok(s) => Cow::Owned(s),
        Err(_) => Cow::Borrowed(json),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_matches_ecmascript_not_unicode_white_space() {
        assert_eq!(js_trim("\u{FEFF} a \u{3000}"), "a");
        assert_eq!(js_trim("\u{0085}a\u{0085}"), "\u{0085}a\u{0085}");
    }

    /// JSON text with each `%XXXX` written as a `\uXXXX` escape, so the escapes in these cases are unambiguous in the source.
    fn esc(template: &str) -> String {
        template.replace('%', "\\u")
    }

    #[test]
    fn lone_surrogates_become_replacement_escapes() {
        assert_eq!(replace_lone_surrogate_escapes(&esc(r#"{"a":"x%d800y"}"#)), esc(r#"{"a":"x%FFFDy"}"#));
        assert_eq!(replace_lone_surrogate_escapes(&esc(r#"{"a":"%dc00"}"#)), esc(r#"{"a":"%FFFD"}"#));
        assert_eq!(replace_lone_surrogate_escapes(&esc(r#"{"a":"%d83d%de00"}"#)), esc(r#"{"a":"%d83d%de00"}"#));
        assert_eq!(replace_lone_surrogate_escapes(&esc(r#"{"a":"\%d800"}"#)), esc(r#"{"a":"\%d800"}"#));
        assert_eq!(replace_lone_surrogate_escapes(&esc(r#"{"%d800":1}"#)), esc(r#"{"%FFFD":1}"#));
    }
}
