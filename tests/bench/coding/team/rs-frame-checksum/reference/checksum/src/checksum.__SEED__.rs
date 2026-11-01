// SPDX-License-Identifier: MIT
pub fn solve(raw: &str) -> String {
    if !raw.is_ascii() || raw.len() % 2 != 0 {
        return "error".into();
    }
    let mut sum = 0_u8;
    for index in (0..raw.len()).step_by(2) {
        let Ok(byte) = u8::from_str_radix(&raw[index..index + 2], 16) else {
            return "error".into();
        };
        sum = sum.wrapping_add(byte);
    }
    format!("{sum:02x}")
}
