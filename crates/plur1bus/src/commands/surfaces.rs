use crate::commands::memory_ops::{connect_core, require_supports};
use crate::output::Out;
use crate::paths::Layout;
use serde_json::Value;
use std::time::Duration;

pub fn call(out: &Out, layout: &Layout, method: &str, params: Value) -> Value {
    let mut client = connect_core(out, layout, method, Duration::from_secs(30));
    require_supports(out, &client, method);
    match client.call(method, params) {
        Ok(value) => value,
        Err(error) => out.from_rpc_error(&error),
    }
}
pub fn emit(out: &Out, method: &str, value: &Value) {
    out.ok(&format!("{method}/1"), value, || {
        serde_json::to_string_pretty(value).unwrap_or_default()
    });
}
/// Strict bounded base64 decoding for the core's image transfer; no path or URL from an output is executed.
pub fn decode(s: &str) -> Result<Vec<u8>, &'static str> {
    if s.len() > 24 * 1024 * 1024 || !s.len().is_multiple_of(4) {
        return Err("invalid image data");
    }
    let mut bytes = Vec::new();
    for (index, chunk) in s.as_bytes().chunks(4).enumerate() {
        let mut value = 0u32;
        let mut pad = 0;
        for c in chunk {
            let digit = match c {
                b'A'..=b'Z' => c - b'A',
                b'a'..=b'z' => c - b'a' + 26,
                b'0'..=b'9' => c - b'0' + 52,
                b'+' => 62,
                b'/' => 63,
                b'=' => {
                    pad += 1;
                    0
                }
                _ => return Err("invalid image data"),
            };
            if pad > 0 && *c != b'=' {
                return Err("invalid image data");
            }
            value = (value << 6) | u32::from(digit);
        }
        if pad > 2 || (pad > 0 && index + 1 != s.len() / 4) {
            return Err("invalid image data");
        }
        bytes.push((value >> 16) as u8);
        if pad < 2 {
            bytes.push((value >> 8) as u8);
        }
        if pad == 0 {
            bytes.push(value as u8);
        }
    }
    Ok(bytes)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn image_data_is_strict_and_bounded() {
        assert_eq!(decode("UE5H").unwrap(), b"PNG");
        assert_eq!(decode("YQ==").unwrap(), b"a");
        for bad in ["a", "a===", "YQ=x", "YQ==YQ==", "%%%%"] {
            assert!(decode(bad).is_err());
        }
    }
}
