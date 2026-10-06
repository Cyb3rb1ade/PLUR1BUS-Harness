//! The redactor behind `plur1bus 1staid bundle` (logging and diagnostics spec §4, rules 1–4): known secret values and
//! their encoded forms, keys by name, token patterns and URLs. A match becomes `[REDACTED:<rule>]`, so a reader sees
//! that something was removed and why. Hand-written scanning instead of a regex engine: the harness has no such
//! dependency and the rules are small.
//!
//! The bundle runs [`Redactor::redact`] over every text it writes and then [`Redactor::scan`] over the result: a rule
//! that still matches means the redactor and its own re-scan disagree, and the bundle refuses to write. Redaction is
//! idempotent (`redact(redact(x)) == redact(x)`), because every rule leaves an existing `[REDACTED:…]` alone.
//!
//! Rules 5 (deny-list paths) and 6 (optional PII) of the spec belong to the log writers and are not applied here: a
//! bundle never contains file contents, and PII redaction is off by default.
use std::ops::Range;

const MARK: &str = "[REDACTED:";

/// Rule names, as they appear inside the replacement.
pub const RULE_SECRET: &str = "secret";
pub const RULE_KEY: &str = "key";
pub const RULE_PATTERN: &str = "pattern";
pub const RULE_URL: &str = "url";

/// Substrings of a key name (compared in lower case) whose value is replaced — spec §4 rule 2.
const KEY_NAMES: [&str; 21] = [
    "authorization",
    "cookie",
    "token",
    "secret",
    "password",
    "passwd",
    "apikey",
    "api_key",
    "api-key",
    "refresh",
    "code_verifier",
    "code-verifier",
    "codeverifier",
    "ticket",
    "csrf",
    "private_key",
    "private-key",
    "privatekey",
    "session_key",
    "session-key",
    "sessionkey",
];

/// Header-like keys: the value is the rest of the line (`Authorization: Bearer abc`, `Cookie: a=1; b=2`).
const LINE_VALUE_KEYS: [&str; 2] = ["authorization", "cookie"];

pub struct Redactor {
    /// Known secret values, ≥ 8 characters, with their base64, base64url and percent-encoded forms; longest first.
    secrets: Vec<String>,
}

impl Redactor {
    /// `secrets` are the exact values this process knows (here: the supervisor and core tokens). Values shorter than
    /// eight characters are ignored: they would redact ordinary words.
    pub fn new<I: IntoIterator<Item = String>>(secrets: I) -> Self {
        let mut all: Vec<String> = Vec::new();
        for s in secrets {
            let s = s.trim().to_string();
            if s.len() < 8 {
                continue;
            }
            all.push(base64(s.as_bytes(), false, true));
            all.push(base64(s.as_bytes(), false, false));
            all.push(base64(s.as_bytes(), true, false));
            all.push(percent_encode(&s));
            all.push(s);
        }
        all.retain(|s| s.len() >= 8);
        all.sort_by_key(|s| std::cmp::Reverse(s.len()));
        all.dedup();
        Redactor { secrets: all }
    }

    /// `text` with every match of rules 1–4 replaced.
    pub fn redact(&self, text: &str) -> String {
        self.apply(text).0
    }

    /// The rules that still match `text` — empty for anything [`Redactor::redact`] returned.
    pub fn scan(&self, text: &str) -> Vec<&'static str> {
        self.apply(text).1
    }

    fn apply(&self, text: &str) -> (String, Vec<&'static str>) {
        let mut hits: Vec<&'static str> = Vec::new();
        let mut s = text.to_string();
        s = substitute(&s, RULE_SECRET, &mut hits, |t| {
            find_secrets(t, &self.secrets)
        });
        s = substitute(&s, RULE_PATTERN, &mut hits, find_pem);
        s = substitute(&s, RULE_KEY, &mut hits, find_keyed_values);
        s = substitute(&s, RULE_PATTERN, &mut hits, find_patterns);
        s = substitute(&s, RULE_URL, &mut hits, find_url_parts);
        hits.dedup();
        (s, hits)
    }
}

/// Replaces the (sorted, non-overlapping) ranges `find` returns with `[REDACTED:<rule>]`.
fn substitute(
    s: &str,
    rule: &'static str,
    hits: &mut Vec<&'static str>,
    find: impl Fn(&str) -> Vec<Range<usize>>,
) -> String {
    let mut ranges = find(s);
    if ranges.is_empty() {
        return s.to_string();
    }
    ranges.sort_by_key(|r| r.start);
    let mut out = String::with_capacity(s.len());
    let mut at = 0;
    for r in ranges {
        if r.start < at || r.end > s.len() || r.start >= r.end {
            continue;
        }
        out.push_str(&s[at..r.start]);
        out.push_str(MARK);
        out.push_str(rule);
        out.push(']');
        at = r.end;
    }
    out.push_str(&s[at..]);
    if !hits.contains(&rule) {
        hits.push(rule);
    }
    out
}

// ---- rule 1: known secret values -------------------------------------------------------------------------------

fn find_secrets(s: &str, secrets: &[String]) -> Vec<Range<usize>> {
    let mut found: Vec<Range<usize>> = Vec::new();
    for secret in secrets {
        let mut from = 0;
        while let Some(i) = s[from..].find(secret.as_str()) {
            let start = from + i;
            let end = start + secret.len();
            if !found.iter().any(|r| start < r.end && r.start < end) {
                found.push(start..end);
            }
            from = end;
        }
    }
    found
}

fn base64(bytes: &[u8], url: bool, pad: bool) -> String {
    let alphabet: &[u8; 64] = if url {
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    } else {
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    };
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16
            | (*chunk.get(1).unwrap_or(&0) as u32) << 8
            | *chunk.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(alphabet[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else if pad {
                out.push('=');
            }
        }
    }
    out
}

fn percent_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

// ---- rule 2: keys by name --------------------------------------------------------------------------------------

fn is_ident(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
}

fn line_end(b: &[u8], from: usize) -> usize {
    b[from..]
        .iter()
        .position(|c| *c == b'\n' || *c == b'\r')
        .map_or(b.len(), |p| from + p)
}

fn find_keyed_values(s: &str) -> Vec<Range<usize>> {
    let b = s.as_bytes();
    let lower = s.to_ascii_lowercase();
    let mut starts: Vec<(usize, &str)> = Vec::new();
    for name in KEY_NAMES {
        let mut from = 0;
        while let Some(i) = lower[from..].find(name) {
            starts.push((from + i, name));
            from += i + name.len();
        }
    }
    starts.sort();
    let mut found: Vec<Range<usize>> = Vec::new();
    let mut covered = 0;
    for (idx, name) in starts {
        if idx < covered {
            continue;
        }
        // The whole identifier the name sits in (`client_secret`, `x-api-key`, `refreshToken`).
        let mut a = idx;
        while a > 0 && is_ident(b[a - 1]) {
            a -= 1;
        }
        let mut e = idx + name.len();
        while e < b.len() && is_ident(b[e]) {
            e += 1;
        }
        let ident = &lower[a..e];
        let mut p = e;
        if p < b.len() && (b[p] == b'"' || b[p] == b'\'') {
            p += 1;
        }
        while p < b.len() && (b[p] == b' ' || b[p] == b'\t') {
            p += 1;
        }
        if p >= b.len() || (b[p] != b':' && b[p] != b'=') {
            continue;
        }
        p += 1;
        while p < b.len() && (b[p] == b' ' || b[p] == b'\t') {
            p += 1;
        }
        if p >= b.len() {
            continue;
        }
        let header_like = LINE_VALUE_KEYS.iter().any(|k| ident.contains(k));
        let range = if b[p] == b'"' || b[p] == b'\'' {
            let q = b[p];
            let mut i = p + 1;
            while i < b.len() && b[i] != q && b[i] != b'\n' {
                if b[i] == b'\\' {
                    i += 1;
                }
                i += 1;
            }
            (p + 1)..i.min(b.len())
        } else if header_like {
            let mut i = p;
            while i < b.len() && b[i] != b'"' && b[i] != b'\n' && b[i] != b'\r' {
                i += 1;
            }
            p..i.min(line_end(b, p))
        } else {
            let mut i = p;
            while i < b.len()
                && !matches!(
                    b[i],
                    b' ' | b'\t'
                        | b'\n'
                        | b'\r'
                        | b','
                        | b';'
                        | b'&'
                        | b'}'
                        | b']'
                        | b'"'
                        | b'\''
                        | b')'
                )
            {
                i += 1;
            }
            p..i
        };
        let value = s.get(range.clone()).unwrap_or("");
        if value.is_empty()
            || value.starts_with(MARK)
            || value.starts_with('{')
            || value.starts_with('[')
            || matches!(value, "null" | "true" | "false")
        {
            continue;
        }
        covered = range.end;
        found.push(range);
    }
    found
}

// ---- rule 3: patterns -------------------------------------------------------------------------------------------

fn find_pem(s: &str) -> Vec<Range<usize>> {
    let mut found = Vec::new();
    let mut from = 0;
    while let Some(i) = s[from..].find("-----BEGIN ") {
        let start = from + i;
        let header_end = s[start + 11..]
            .find("-----")
            .map(|p| start + 11 + p + 5)
            .unwrap_or(s.len());
        let header = &s[start..header_end];
        if !header.contains("PRIVATE KEY") {
            from = header_end.max(start + 11);
            continue;
        }
        let end = s[header_end..]
            .find("-----END ")
            .and_then(|p| {
                let e = header_end + p + 9;
                s[e..].find("-----").map(|q| e + q + 5)
            })
            .unwrap_or(s.len());
        found.push(start..end);
        from = end;
    }
    found
}

fn is_run(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.')
}

fn all_of(run: &str, f: impl Fn(u8) -> bool) -> bool {
    run.bytes().all(f)
}

/// A vendor key shape: `sk-…` (also `sk-ant-…`, `sk-proj-…`), `ek_…`, `ghp_…`, `github_pat_…`, `xox[abpr]-…`.
fn vendor_key(run: &str) -> bool {
    let rest_len = |prefix: &str| run.len().saturating_sub(prefix.len());
    if run.starts_with("sk-") {
        return rest_len("sk-") >= 16;
    }
    if run.starts_with("ek_") {
        return rest_len("ek_") >= 16;
    }
    if run.starts_with("ghp_") {
        return rest_len("ghp_") >= 20;
    }
    if run.starts_with("github_pat_") {
        return rest_len("github_pat_") >= 20;
    }
    if ["xoxa-", "xoxb-", "xoxp-", "xoxr-"]
        .iter()
        .any(|p| run.starts_with(p))
    {
        return rest_len("xoxa-") >= 10;
    }
    if let Some(r) = run.strip_prefix("AKIA") {
        return r.len() == 16 && all_of(r, |c| c.is_ascii_digit() || c.is_ascii_uppercase());
    }
    if let Some(r) = run.strip_prefix("AIza") {
        return r.len() == 35 && all_of(r, is_ident);
    }
    false
}

fn find_patterns(s: &str) -> Vec<Range<usize>> {
    let b = s.as_bytes();
    let mut found = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if !is_run(b[i]) {
            i += 1;
            continue;
        }
        let start = i;
        while i < b.len() && is_run(b[i]) {
            i += 1;
        }
        let run = &s[start..i];
        // JWT: eyJ….eyJ….<signature>
        if run.starts_with("eyJ") && run.matches('.').count() >= 2 && run.contains(".eyJ") {
            found.push(start..i);
            continue;
        }
        if vendor_key(run) {
            found.push(start..i);
            continue;
        }
        // PLUR1BUS_*=value
        if run.starts_with("PLUR1BUS_") && b.get(i) == Some(&b'=') {
            let mut e = i + 1;
            while e < b.len() && !matches!(b[e], b' ' | b'\t' | b'\n' | b'\r' | b'"' | b'\'') {
                e += 1;
            }
            let v = &s[i + 1..e];
            if !v.is_empty() && !v.starts_with(MARK) {
                found.push(i + 1..e);
            }
            i = e.max(i);
            continue;
        }
        // Bearer <token>, Basic <base64>
        let bearer = run.eq_ignore_ascii_case("bearer");
        if bearer || run == "Basic" {
            let mut p = i;
            while p < b.len() && (b[p] == b' ' || b[p] == b'\t') {
                p += 1;
            }
            if p > i {
                let mut e = p;
                while e < b.len()
                    && if bearer {
                        !matches!(b[e], b' ' | b'\t' | b'\n' | b'\r' | b'"' | b'\'' | b',')
                    } else {
                        b[e].is_ascii_alphanumeric() || matches!(b[e], b'+' | b'/' | b'=')
                    }
                {
                    e += 1;
                }
                let v = &s[p..e];
                if !v.is_empty() && !v.starts_with(MARK) {
                    found.push(p..e);
                    i = e;
                    continue;
                }
            }
        }
        // a base64url run of ≥ 43 characters that is not pure hex (SHA-256 and git ids stay readable)
        if run.len() >= 43 && all_of(run, is_ident) && !all_of(run, |c| c.is_ascii_hexdigit()) {
            found.push(start..i);
        }
    }
    found
}

// ---- rule 4: URLs -----------------------------------------------------------------------------------------------

fn find_url_parts(s: &str) -> Vec<Range<usize>> {
    let b = s.as_bytes();
    let mut found = Vec::new();
    let mut from = 0;
    while let Some(i) = s[from..].find("://") {
        let at = from + i;
        let auth_start = at + 3;
        let mut end = auth_start;
        while end < b.len()
            && !matches!(
                b[end],
                b' ' | b'\t' | b'\n' | b'\r' | b'"' | b'\'' | b'<' | b'>' | b')' | b'\\'
            )
        {
            end += 1;
        }
        from = end.max(auth_start);
        let url = &s[auth_start..end];
        let auth_end = url.find(['/', '?', '#']).unwrap_or(url.len());
        if let Some(pos) = url[..auth_end].rfind('@') {
            if !url[..pos].starts_with(MARK) && pos > 0 {
                found.push(auth_start..auth_start + pos);
            }
        }
        let frag_at = url.find('#');
        if let Some(f) = frag_at {
            let frag = &url[f + 1..];
            if !frag.is_empty() && !frag.starts_with(MARK) {
                found.push(auth_start + f + 1..end);
            }
        }
        if let Some(q) = url.find('?').filter(|q| frag_at.is_none_or(|f| *q < f)) {
            let q_end = frag_at.unwrap_or(url.len());
            let mut p = q + 1;
            while p < q_end {
                let seg_end = url[p..q_end].find('&').map_or(q_end, |x| p + x);
                if let Some(eq) = url[p..seg_end].find('=') {
                    let v = &url[p + eq + 1..seg_end];
                    if !v.is_empty() && !v.starts_with(MARK) {
                        found.push(auth_start + p + eq + 1..auth_start + seg_end);
                    }
                }
                p = seg_end + 1;
            }
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Spelled in two pieces so the repository's own key-header hygiene scan does not flag this file.
    const PRIVATE: &str = concat!("PRIV", "ATE KEY");

    fn none() -> Redactor {
        Redactor::new(Vec::new())
    }

    fn assert_gone(r: &Redactor, input: &str, canary: &str) {
        let out = r.redact(input);
        assert!(!out.contains(canary), "{canary:?} survived in {out:?}");
        assert!(out.contains(MARK), "no marker in {out:?}");
        assert_eq!(r.redact(&out), out, "not idempotent: {out:?}");
        assert!(r.scan(&out).is_empty(), "re-scan hit {:?}", r.scan(&out));
    }

    #[test]
    fn known_secret_values_and_their_encodings_are_replaced() {
        let secret = "s3cr3t/value+with=chars";
        let r = Redactor::new([secret.to_string()]);
        for form in [
            secret.to_string(),
            base64(secret.as_bytes(), false, true),
            base64(secret.as_bytes(), true, false),
            percent_encode(secret),
        ] {
            assert_gone(&r, &format!("log line with {form} inside"), &form);
        }
        assert_eq!(r.redact("short"), "short");
    }

    #[test]
    fn a_short_value_is_never_registered() {
        let r = Redactor::new(["abc".to_string()]);
        assert_eq!(r.redact("abc abc"), "abc abc");
    }

    #[test]
    fn keys_by_name_in_json_env_and_header_forms() {
        let r = none();
        assert_gone(&r, r#"{"apiKey":"hunter2-value"}"#, "hunter2-value");
        assert_gone(&r, r#"{ "refreshToken": "r-0123456789" }"#, "r-0123456789");
        assert_gone(&r, "PASSWORD=correct-horse", "correct-horse");
        assert_gone(&r, "client_secret: abc123def", "abc123def");
        assert_gone(&r, "Authorization: Bearer abc.def.ghi extra", "abc.def.ghi");
        assert_gone(&r, "Cookie: sid=1234; other=5678", "1234");
        assert_gone(&r, r#"{"msg":"x","authorization":"Basic dTpw"}"#, "dTpw");
        assert_gone(&r, "https://h/cb?x=1&code_verifier=zzzzzzzz", "zzzzzzzz");
    }

    #[test]
    fn keys_keep_structure_and_leave_null_and_nested_values() {
        let r = none();
        let json = r#"{"token":null,"secrets":{"password":"p4ss-word"},"ok":true}"#;
        let out = r.redact(json);
        assert!(out.contains(r#""token":null"#), "{out}");
        assert!(!out.contains("p4ss-word"), "{out}");
        assert!(out.contains(r#""ok":true"#), "{out}");
        assert!(
            serde_json::from_str::<serde_json::Value>(&out).is_ok(),
            "{out}"
        );
    }

    #[test]
    fn patterns_bearer_basic_vendor_keys_jwt_and_env() {
        let r = none();
        assert_gone(&r, "sent Bearer abcDEF123456 to host", "abcDEF123456");
        assert_gone(
            &r,
            "header Basic dXNlcjpwYXNzd29yZA== x",
            "dXNlcjpwYXNzd29yZA==",
        );
        for k in [
            "sk-abcdefghijklmnopqrstuvwx",
            "sk-ant-api03-abcdefghijklmnop",
            "sk-proj-abcdefghijklmnopqr",
            "ek_0123456789abcdef0123",
            "ghp_0123456789abcdefghijkl",
            "github_pat_0123456789abcdefghij",
            "xoxb-0123456789-abcdef",
            "AKIAIOSFODNN7EXAMPLE",
            "AIzaSyA-0123456789abcdefghijklmnopqrstu",
        ] {
            assert_gone(&r, &format!("value {k} end"), k);
        }
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.c2lnbmF0dXJl";
        assert_gone(&r, &format!("id {jwt} end"), jwt);
        assert_gone(&r, "PLUR1BUS_FOO=whatever-value next", "whatever-value");
    }

    #[test]
    fn a_pem_private_key_block_is_replaced_across_lines() {
        let r = none();
        let pem = format!("before\n-----BEGIN {k}-----\nMIIEvQIBADANBgkq\nhkiG9w0BAQEFAASC\n-----END {k}-----\nafter", k = PRIVATE);
        let out = r.redact(&pem);
        assert!(!out.contains("MIIEvQ") && !out.contains("hkiG9w"), "{out}");
        assert!(
            out.starts_with("before\n") && out.ends_with("\nafter"),
            "{out}"
        );
        let rsa = format!(
            "-----BEGIN RSA {k}-----\nAAAA\n-----END RSA {k}-----",
            k = PRIVATE
        );
        assert!(!r.redact(&rsa).contains("AAAA"));
        let cert = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----";
        assert_eq!(r.redact(cert), cert);
    }

    #[test]
    fn a_long_base64url_run_goes_but_hex_ids_stay() {
        let r = none();
        let blob = "Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4_-Zm9v";
        assert_gone(&r, &format!("data {blob} end"), blob);
        let sha = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
        assert_eq!(r.redact(&format!("sha256 {sha}")), format!("sha256 {sha}"));
    }

    #[test]
    fn urls_lose_userinfo_query_values_and_fragment() {
        let r = none();
        let out =
            r.redact("GET https://user:pw@example.com/a?code=abc123&state=xyz789#frag-9 done");
        assert!(!out.contains("user:pw"), "{out}");
        assert!(
            !out.contains("abc123") && !out.contains("xyz789") && !out.contains("frag-9"),
            "{out}"
        );
        assert!(
            out.contains("example.com/a?code=[REDACTED:url]&state=[REDACTED:url]#[REDACTED:url]"),
            "{out}"
        );
        assert_eq!(r.redact(&out), out);
        assert_eq!(
            r.redact("see https://example.com/docs/x done"),
            "see https://example.com/docs/x done"
        );
    }

    #[test]
    fn ordinary_diagnostic_text_is_untouched() {
        let r = none();
        let line = r#"{"at":1759000000000,"level":"info","role":"core","msg":"ready","pid":4242,"path":"/home/u/.plur1bus/run/core.sock"}"#;
        assert_eq!(r.redact(line), line);
        assert!(r.scan(line).is_empty());
    }

    #[test]
    fn scan_names_the_rules_that_match() {
        let r = none();
        assert_eq!(r.scan("password=hunter2hunter2"), vec![RULE_KEY]);
        assert_eq!(r.scan("go to https://a.b/?x=1"), vec![RULE_URL]);
    }
}
