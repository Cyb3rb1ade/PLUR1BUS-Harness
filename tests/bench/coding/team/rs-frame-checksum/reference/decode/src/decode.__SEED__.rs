// SPDX-License-Identifier: MIT
//! Public task endpoint and authored domain implementation, without hidden checkers or expected results.
use crate::contract::{Packet, packet, payload, text};
fn impl_solve(raw: &str) -> String {
    let Some((length, payload)) = raw.split_once(':') else {
        return "error".into();
    };
    if length.is_empty()
        || !length.bytes().all(|b| b.is_ascii_digit())
        || (length.len() > 1 && length.starts_with('0'))
        || payload.contains('\0')
    {
        return "error".into();
    }
    match length.parse::<usize>() {
        Ok(n) if n <= 65536 && n == payload.len() => payload.into(),
        _ => "error".into(),
    }
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
