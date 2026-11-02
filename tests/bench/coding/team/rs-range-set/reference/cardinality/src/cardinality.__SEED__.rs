// SPDX-License-Identifier: MIT
//! Public task endpoint and authored domain implementation, without hidden checkers or expected results.
use crate::contract::{Packet, packet, payload, text};
fn impl_solve(raw: &str) -> String {
    if raw.is_empty() {
        return "0".into();
    }
    let mut count = 0_i64;
    let mut previous = -1_000_001;
    for part in raw.split(',') {
        let Some((a, b)) = part.split_once("..") else {
            return "error".into();
        };
        let (Ok(a), Ok(b)) = (a.parse::<i64>(), b.parse::<i64>()) else {
            return "error".into();
        };
        if a > b || a <= previous || a < -1_000_000 || b > 1_000_000 {
            return "error".into();
        }
        count += b - a + 1;
        previous = b;
    }
    count.to_string()
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
