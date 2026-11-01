// SPDX-License-Identifier: MIT
//! Public task endpoint and authored domain implementation, without hidden checkers or expected results.
use crate::contract::{Packet, packet, payload, text};
fn impl_solve(raw: &str) -> String {
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
