// SPDX-License-Identifier: MIT
//! Public task endpoint and authored domain implementation, without hidden checkers or expected results.
//! Public text-frame and typed stage interface; no oracle or private seed is exposed.
const PROFILE: usize = __PROFILE__;
const SALT: usize = __SALT__;
/// State whose payload and integrity depend on the preceding stage's actual output.
pub struct Packet {
    pub payload: String,
    pub stage: usize,
    pub stamp: usize,
}
/// Construct the next stage's state from the preceding semantic result.
pub fn packet(value: String, stage: usize) -> Packet {
    let stamp = (value.bytes().map(usize::from).sum::<usize>() + SALT * stage) % 65536;
    Packet {
        payload: value,
        stage,
        stamp,
    }
}
/// Refuse stale or corrupted state before consuming the preceding result.
pub fn payload(value: &Packet, stage: usize) -> Option<&str> {
    let stamp = (value.payload.bytes().map(usize::from).sum::<usize>() + SALT * stage) % 65536;
    if value.stage == stage && value.stamp == stamp {
        Some(&value.payload)
    } else {
        None
    }
}
/// Decode raw text or the instance's optional byte-length/checksum frame.
pub fn text(raw: &str) -> Result<String, ()> {
    if !raw.starts_with("@TEXT") {
        return Ok(raw.into());
    }
    let Some((header, body)) = raw.split_once('\n') else {
        return Err(());
    };
    let sum = (body.bytes().map(usize::from).sum::<usize>() + SALT) % 256;
    let suffix = match PROFILE {
        0 => String::new(),
        1 => format!(":{}", body.len()),
        _ => format!(":{}:{sum}", body.len()),
    };
    if header == format!("@TEXT{suffix}") {
        Ok(body.into())
    } else {
        Err(())
    }
}
