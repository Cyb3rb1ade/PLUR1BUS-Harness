// SPDX-License-Identifier: MIT
pub fn solve(raw: &str) -> String {
    raw.bytes().map(|b| format!("{b:02x}")).collect::<String>()
}
