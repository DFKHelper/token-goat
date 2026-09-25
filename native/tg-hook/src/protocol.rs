//! The wire format of src/hook_ipc.ts: frames of a 4-byte big-endian length plus UTF-8 JSON, capped at `MAX_FRAME_BYTES`, and the length-prefixed HMAC-SHA256 every handshake step carries. The connection logic that uses these belongs to the relay and is not here yet.

use hmac::{KeyInit, Mac};
use serde_json::{Map, Value};
use sha2::Sha256;

use crate::jsstr::replace_lone_surrogate_escapes;

/// `PROTOCOL_VERSION`: a peer speaking another version is treated as absent.
pub const PROTOCOL_VERSION: u32 = 1;
/// `SERVER_SLOTS`.
pub const SERVER_SLOTS: u32 = 3;
/// `MAX_FRAME_BYTES`: the largest frame body either end sends or accepts.
pub const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;

/// `mac(key, ...parts)`: HMAC-SHA256 over each part as `${utf8ByteLength}:${part}`, as lowercase hex.
pub fn mac(key: &[u8], parts: &[&str]) -> String {
    let mut h = <hmac::Hmac<Sha256> as KeyInit>::new_from_slice(key).expect("HMAC accepts a key of any length");
    for part in parts {
        h.update(format!("{}:", part.len()).as_bytes());
        h.update(part.as_bytes());
    }
    let tag = h.finalize().into_bytes();
    let mut hex = String::with_capacity(tag.len() * 2);
    for b in tag.iter() {
        hex.push_str(&format!("{b:02x}"));
    }
    hex
}

/// `macMatches(expected, actual)`: equal UTF-16 length first, then a constant-time comparison of the bytes. Where Node's `timingSafeEqual` would throw (same UTF-16 length, different UTF-8 length) this answers false, which is what a thrown check amounts to for a peer.
pub fn mac_matches(expected: &str, actual: &str) -> bool {
    if expected.encode_utf16().count() != actual.encode_utf16().count() {
        return false;
    }
    let (a, b) = (expected.as_bytes(), actual.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let diff = a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y));
    std::hint::black_box(diff) == 0
}

/// `encodeFrame`: the 4-byte big-endian length of `body`, then `body`.
pub fn encode_frame(body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + body.len());
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(body);
    out
}

/// A message as it goes on the wire.
pub fn encode_message(message: &Value) -> Vec<u8> {
    encode_frame(&serde_json::to_vec(message).unwrap_or_default())
}

/// `frameFits`: whether the peer will read `frame` rather than hang up on it.
pub fn frame_fits(frame: &[u8]) -> bool {
    frame.len().saturating_sub(4) <= MAX_FRAME_BYTES
}

/// Parses JSON text the way `JSON.parse(buffer.toString('utf8'))` does for every input a peer sends: invalid UTF-8 becomes U+FFFD first, and a lone-surrogate escape decodes to U+FFFD, the bytes Node would write or MAC for it.
pub fn parse_json_lossy(bytes: &[u8]) -> Result<Value, String> {
    let text = String::from_utf8_lossy(bytes);
    serde_json::from_str(&replace_lone_surrogate_escapes(&text)).map_err(|e| e.to_string())
}

/// What one chunk of input produced: every complete frame, in order, and the error that ended the stream if one did.
#[derive(Debug, Default)]
pub struct Decoded {
    pub frames: Vec<Map<String, Value>>,
    pub error: Option<String>,
}

/// `readFrames` as a push decoder: bytes go in as they arrive, complete frames come out. After an oversized, malformed or non-object frame it reports the error and accepts nothing more, as `readFrames` destroys the socket.
#[derive(Default)]
pub struct FrameReader {
    buffered: Vec<u8>,
    failed: bool,
}

impl FrameReader {
    pub fn push(&mut self, chunk: &[u8]) -> Decoded {
        let mut out = Decoded::default();
        if self.failed {
            return out;
        }
        self.buffered.extend_from_slice(chunk);
        while self.buffered.len() >= 4 {
            let len = u32::from_be_bytes([self.buffered[0], self.buffered[1], self.buffered[2], self.buffered[3]]) as usize;
            if len > MAX_FRAME_BYTES {
                out.error = Some(format!("frame of {len} bytes exceeds {MAX_FRAME_BYTES}"));
                break;
            }
            if self.buffered.len() < 4 + len {
                return out;
            }
            let body: Vec<u8> = self.buffered.drain(..4 + len).skip(4).collect();
            match parse_json_lossy(&body) {
                Ok(Value::Object(map)) => out.frames.push(map),
                Ok(_) => {
                    out.error = Some("frame is not a JSON object".to_string());
                    break;
                }
                Err(e) => {
                    out.error = Some(e);
                    break;
                }
            }
        }
        if out.error.is_some() {
            self.failed = true;
            self.buffered.clear();
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mac_prefixes_each_part_with_its_utf8_length() {
        let key = [7u8; 32];
        assert_ne!(mac(&key, &["ab", "c"]), mac(&key, &["a", "bc"]));
        assert_eq!(mac(&key, &["é"]).len(), 64);
    }

    #[test]
    fn reader_splits_frames_across_chunks_and_refuses_oversize() {
        let frame = encode_message(&serde_json::json!({"t": "hello"}));
        let mut r = FrameReader::default();
        assert!(r.push(&frame[..3]).frames.is_empty());
        let d = r.push(&frame[3..]);
        assert_eq!(d.frames.len(), 1);
        let mut r = FrameReader::default();
        let d = r.push(&((MAX_FRAME_BYTES as u32) + 1).to_be_bytes());
        assert!(d.error.is_some());
        assert!(!mac_matches("ab", "ac"));
        assert!(mac_matches("ab", "ab"));
    }
}
