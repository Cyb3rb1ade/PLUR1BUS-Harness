// SPDX-License-Identifier: MIT
//! Public task endpoint and authored domain implementation, without hidden checkers or expected results.
use crate::contract::{Packet, packet, payload, text};
fn impl_solve(raw: &str) -> String {
    if !raw.starts_with('/') || !raw.is_ascii() || raw.contains(';') || raw.contains("//") {
        return "error".into();
    }
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len()
                || !bytes[i + 1..i + 3]
                    .iter()
                    .all(|v| v.is_ascii_digit() || (b'A'..=b'F').contains(v))
            {
                return "error".into();
            }
            i += 2;
        }
        i += 1;
    }
    format!(
        "path={raw};segments={}",
        raw.split('/').filter(|part| !part.is_empty()).count()
    )
}
/// Validate the instance frame and actual predecessor state before domain processing.
pub fn solve__SEED__(raw: &str) -> String {
    let value = text(raw).ok();
    let result = value
        .map(|value| {
            if value == "error" {
                "error".into()
            } else {
                impl_solve(&value)
            }
        })
        .unwrap_or_else(|| "error".into());
    result
}
