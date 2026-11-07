//! Exact intersection for the closed whole-segment `*` / `**` language.
use std::collections::{BTreeSet, VecDeque};

/// Reject traversal, absolute paths and wildcard syntax outside the team contract.
pub fn valid(pattern: &str) -> bool {
    !pattern.is_empty()
        && pattern.split('/').all(|p| {
            p == "*"
                || p == "**"
                || (!p.is_empty()
                    && p != "."
                    && p != ".."
                    && p.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"_.@+-".contains(&b)))
        })
}
/// Decide whether two bounded glob languages share at least one nonempty path.
pub fn intersects(left: &str, right: &str) -> bool {
    if !valid(left) || !valid(right) {
        return false;
    }
    let a: Vec<_> = left.split('/').collect();
    let b: Vec<_> = right.split('/').collect();
    let mut queue = VecDeque::from([(0, 0, false)]);
    let mut seen = BTreeSet::new();
    while let Some((i, j, consumed)) = queue.pop_front() {
        if !seen.insert((i, j, consumed)) {
            continue;
        }
        if i == a.len() && j == b.len() && consumed {
            return true;
        }
        if a.get(i) == Some(&"**") {
            queue.push_back((i + 1, j, consumed));
        }
        if b.get(j) == Some(&"**") {
            queue.push_back((i, j + 1, consumed));
        }
        if let (Some(x), Some(y)) = (a.get(i), b.get(j)) {
            if x == y || x.starts_with('*') || y.starts_with('*') {
                queue.push_back((
                    i + usize::from(*x != "**"),
                    j + usize::from(*y != "**"),
                    true,
                ));
            }
        }
    }
    false
}
/// Concrete paths use the same automaton; wildcards are not accepted in paths.
pub fn matches(pattern: &str, path: &str) -> bool {
    !path.contains('*') && intersects(pattern, path)
}
