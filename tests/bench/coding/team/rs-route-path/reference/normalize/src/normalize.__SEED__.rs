// SPDX-License-Identifier: MIT
//! Public task endpoint and authored domain implementation, without hidden checkers or expected results.
use crate::contract::{Packet, packet, payload, text};
fn impl_solve(raw: &str) -> String {
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
