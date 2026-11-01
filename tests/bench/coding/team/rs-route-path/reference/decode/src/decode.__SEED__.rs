// SPDX-License-Identifier: MIT
pub fn solve(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut result = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return "error".into();
            }
            let (Some(a), Some(b)) = (
                (bytes[i + 1] as char).to_digit(16),
                (bytes[i + 2] as char).to_digit(16),
            ) else {
                return "error".into();
            };
            result.push((a * 16 + b) as u8);
            i += 3;
        } else {
            result.push(bytes[i]);
            i += 1;
        }
    }
    if result.contains(&0) {
        return "error".into();
    }
    String::from_utf8(result).unwrap_or_else(|_| "error".into())
}
