// SPDX-License-Identifier: MIT
//! Public task endpoint and authored domain implementation, without hidden checkers or expected results.
use crate::contract::{Packet, packet, payload, text};
fn impl_solve(raw: &str) -> String {
    let Some(record) = crate::contract::route_record(raw) else {
        return "error".into();
    };
    let sum = record
        .path
        .bytes()
        .fold(0u8, |sum, byte| sum.wrapping_add(byte));
    format!(
        "path={};segments={};etag={sum:02x}",
        record.path, record.segments
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
