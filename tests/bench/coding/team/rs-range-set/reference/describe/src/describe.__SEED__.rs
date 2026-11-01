// SPDX-License-Identifier: MIT
pub fn solve(raw: &str) -> String {
    if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return "error".into();
    }
    match raw.parse::<u64>() {
        Ok(n) => format!("points={n}"),
        Err(_) => "error".into(),
    }
}
