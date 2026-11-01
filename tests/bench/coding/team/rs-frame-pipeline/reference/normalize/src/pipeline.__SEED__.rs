// SPDX-License-Identifier: MIT
pub fn decode(raw: &str) -> String {
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

pub fn normalize(raw: &str) -> String {
    if raw.contains('\0') {
        return "error".into();
    }
    raw.trim().to_lowercase()
}

pub fn encode(_raw: &str) -> String {
    "unimplemented".to_string()
}
