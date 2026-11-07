#![allow(clippy::unwrap_used, clippy::expect_used)]
use plur1bus_tools::team::glob::{intersects, matches, valid};
fn expand(parts: &[&str], depth: usize, prefix: &str, out: &mut Vec<String>) {
    if depth == 0 {
        return;
    }
    for part in parts {
        let p = if prefix.is_empty() {
            part.to_string()
        } else {
            format!("{prefix}/{part}")
        };
        out.push(p.clone());
        expand(parts, depth - 1, &p, out);
    }
}
#[test]
fn intersection_matches_brute_force_on_generated_trees() {
    let mut patterns = Vec::new();
    expand(&["a", "b", "*", "**"], 3, "", &mut patterns);
    let mut paths = Vec::new();
    expand(&["a", "b"], 6, "", &mut paths);
    // Independent recursive matcher; do not use the production intersection to build the oracle.
    fn oracle(p: &[&str], f: &[&str]) -> bool {
        if p.is_empty() {
            return f.is_empty();
        }
        if p[0] == "**" {
            return oracle(&p[1..], f) || (!f.is_empty() && oracle(p, &f[1..]));
        }
        !f.is_empty() && (p[0] == "*" || p[0] == f[0]) && oracle(&p[1..], &f[1..])
    }
    for a in &patterns {
        for b in &patterns {
            let brute = paths.iter().any(|f| {
                oracle(
                    &a.split('/').collect::<Vec<_>>(),
                    &f.split('/').collect::<Vec<_>>(),
                ) && oracle(
                    &b.split('/').collect::<Vec<_>>(),
                    &f.split('/').collect::<Vec<_>>(),
                )
            });
            assert_eq!(intersects(a, b), brute, "{a} / {b}");
            assert_eq!(intersects(a, b), intersects(b, a));
        }
    }
    for f in paths {
        assert_eq!(
            matches("a/**/b", &f),
            oracle(&["a", "**", "b"], &f.split('/').collect::<Vec<_>>())
        );
    }
}
#[test]
fn invalid_paths_never_match() {
    for p in ["/a", "../a", "a/./b", "a//b", "[a]", "{a,b}", "a?", "*.rs"] {
        assert!(!valid(p));
        assert!(!intersects(p, "**"));
    }
    assert!(!matches("**", "a/*"));
}
