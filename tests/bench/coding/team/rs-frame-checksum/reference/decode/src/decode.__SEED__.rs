// SPDX-License-Identifier: MIT
pub fn solve(raw: &str) -> String {
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
