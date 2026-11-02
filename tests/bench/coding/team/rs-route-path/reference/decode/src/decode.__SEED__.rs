// SPDX-License-Identifier: MIT
//! Public task endpoint and authored domain implementation, without hidden checkers or expected results.
use crate::contract::{Packet, packet, payload, text};
fn impl_solve(raw: &str) -> String {
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
