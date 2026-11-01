// SPDX-License-Identifier: MIT
pub fn solve(raw: &str) -> String {
    if !raw.starts_with('/') || raw.contains('\0') {
        return "error".into();
    }
    raw.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~/".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect::<String>()
}
