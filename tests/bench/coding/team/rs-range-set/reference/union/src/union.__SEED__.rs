// SPDX-License-Identifier: MIT
pub fn solve(raw: &str) -> String {
    if raw.is_empty() {
        return String::new();
    }
    let mut ranges = Vec::new();
    for part in raw.split(',') {
        let Some((a, b)) = part.split_once("..") else {
            return "error".into();
        };
        let (Ok(a), Ok(b)) = (a.parse::<i64>(), b.parse::<i64>()) else {
            return "error".into();
        };
        if a > b || a < -1_000_000 || b > 1_000_000 {
            return "error".into();
        }
        ranges.push((a, b));
    }
    ranges.sort_unstable();
    let mut result: Vec<(i64, i64)> = Vec::new();
    for (a, b) in ranges {
        if let Some(last) = result.last_mut() {
            if a <= last.1 + 1 {
                last.1 = last.1.max(b);
                continue;
            }
        }
        result.push((a, b));
    }
    result
        .iter()
        .map(|(a, b)| format!("{a}..{b}"))
        .collect::<Vec<_>>()
        .join(",")
}
