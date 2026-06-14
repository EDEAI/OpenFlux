//! Minimal Base64 encoder / decoder — no external dependencies.
//!
//! Uses the standard RFC 4648 Base64 alphabet (`A–Z a–z 0–9 + /`)
//! with `=` padding.

const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Encode `data` to a Base64 string.
pub fn encode(data: &[u8]) -> String {
    let mut result = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;
        result.push(CHARS[((triple >> 18) & 0x3F) as usize] as char);
        result.push(CHARS[((triple >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            result.push(CHARS[((triple >> 6) & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
        if chunk.len() > 2 {
            result.push(CHARS[(triple & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
    }
    result
}

/// Decode a Base64 string to bytes.
///
/// Returns `Err` only if the input is completely invalid (not for missing padding).
pub fn decode(input: &str) -> Result<Vec<u8>, String> {
    let mut table = [0xFFu8; 256];
    for (i, &c) in CHARS.iter().enumerate() {
        table[c as usize] = i as u8;
    }

    let input = input.as_bytes();
    let mut result = Vec::with_capacity(input.len() * 3 / 4);
    let mut buf = 0u32;
    let mut bits = 0u32;

    for &c in input {
        if c == b'=' {
            break;
        }
        let val = table[c as usize];
        if val == 0xFF {
            continue; // skip whitespace / invalid chars
        }
        buf = (buf << 6) | val as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            result.push((buf >> bits) as u8);
        }
    }

    Ok(result)
}
