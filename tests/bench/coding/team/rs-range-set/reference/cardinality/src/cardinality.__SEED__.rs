// SPDX-License-Identifier: MIT
pub fn solve(raw: &str) -> String {
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
