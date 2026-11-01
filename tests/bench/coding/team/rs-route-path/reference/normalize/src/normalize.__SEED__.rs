// SPDX-License-Identifier: MIT
pub fn solve(raw: &str) -> String {
    if !raw.starts_with('/') || raw.contains('\0') {
        return "error".into();
    }
    let mut parts = Vec::new();
    for part in raw.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return "error".into();
                }
            }
            _ => parts.push(part),
        }
    }
    format!("/{}", parts.join("/"))
}
