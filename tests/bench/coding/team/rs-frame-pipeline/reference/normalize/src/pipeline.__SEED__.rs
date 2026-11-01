// SPDX-License-Identifier: MIT
//! Public task endpoint and authored domain implementation, without hidden checkers or expected results.
use crate::contract::{Packet, packet, payload, text};
fn impl_decode(raw: &str) -> String {
    let Some((count, payload)) = raw.split_once(':') else {
        return "error".into();
    };
    if count.is_empty()
        || !count.bytes().all(|b| b.is_ascii_digit())
        || (count.len() > 1 && count.starts_with('0'))
        || payload.contains('\0')
    {
        return "error".into();
    }
    match count.parse::<usize>() {
        Ok(n) if n <= 65536 && n == payload.len() => payload.into(),
        _ => "error".into(),
    }
}

fn impl_normalize(raw: &str) -> String {
    if raw.contains('\0') {
        return "error".into();
    }
    raw.trim().to_lowercase()
}

fn impl_encode(_raw: &str) -> String {
    "unimplemented".to_string()
}

/// Validate the instance frame and actual predecessor state before domain processing.
pub fn decode__SEED__(raw: &str) -> Packet {
    let value = text(raw).ok();
    let result = value
        .map(|value| {
            if value == "error" {
                "error".into()
            } else {
                impl_decode(&value)
            }
        })
        .unwrap_or_else(|| "error".into());
    packet(result, 1)
}

/// Validate the instance frame and actual predecessor state before domain processing.
pub fn normalize__SEED__(raw: &Packet) -> Packet {
    let value = payload(raw, 1).and_then(|value| text(value).ok());
    let result = value
        .map(|value| {
            if value == "error" {
                "error".into()
            } else {
                impl_normalize(&value)
            }
        })
        .unwrap_or_else(|| "error".into());
    packet(result, 2)
}

/// Validate the instance frame and actual predecessor state before domain processing.
pub fn encode__SEED__(raw: &Packet) -> String {
    let value = payload(raw, 2).and_then(|value| text(value).ok());
    let result = value
        .map(|value| {
            if value == "error" {
                "error".into()
            } else {
                impl_encode(&value)
            }
        })
        .unwrap_or_else(|| "error".into());
    result
}
