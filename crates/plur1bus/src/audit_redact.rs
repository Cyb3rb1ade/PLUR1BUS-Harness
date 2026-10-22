//! D111 §4 redaction of the audit `detail`, the Rust side of `packages/core/src/logs/redact.ts`.
//!
//! The rules are not listed here: the key-name patterns, the credential shapes, the URL steps and the deny-listed
//! paths are read from `packages/log-schema/schema/redaction.json` (embedded by `plur1bus-log-schema`), so a pattern
//! added there reaches this writer with the next build and the two implementations cannot drift apart. Only the
//! algorithm is ported: the order of the rules, the left-boundary check, the value groups, the `key=value` scan and
//! the path canonicalisation follow the TypeScript redactor. The shared canaries of `fixtures/vectors.json` are
//! checked in the tests below.
//!
//! Not applied here: rule 1 (the registry of secret values: an offline CLI process holds none) and rule 6 (PII, off
//! by default, `logs.redactPii` is a core setting). The audit writers call [`redact_detail`] once, before the record
//! reaches the chain or `audit.log`, so both hold the same redacted line. A redaction that cannot be set up returns
//! an error and nothing is written: an audit line never falls back to the raw detail.
use plur1bus_log_schema as ls;
use regex::{Captures, Regex};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::io;
use std::sync::OnceLock;

/// Nesting deeper than this is replaced, never passed on unredacted (same bound as the TypeScript redactor).
const MAX_DEPTH: usize = 64;

struct Pat {
    re: Regex,
    left_boundary: bool,
    value_group: Option<usize>,
    replacement: Option<String>,
    exempt: Option<Regex>,
}

struct Deny {
    id: String,
    /// Lower-cased segment sequences.
    segments: Vec<Vec<String>>,
    files: Vec<String>,
}

struct Compiled {
    template: String,
    key: Regex,
    camel: Regex,
    header: Regex,
    header_line: Regex,
    path_token: Regex,
    patterns: Vec<Pat>,
    url_steps: Vec<Pat>,
    deny: Vec<Deny>,
    /// Credential roots that contain a space, each matched with its own expression.
    spaced: Vec<Regex>,
    path_format: String,
    hash_chars: usize,
}

fn rule(id: &str) -> Result<&'static Value, String> {
    ls::redaction()["rules"]
        .as_array()
        .and_then(|rules| rules.iter().find(|r| r["id"] == id))
        .ok_or_else(|| format!("no redaction rule {id}"))
}

fn compile(p: &ls::Pattern) -> Result<Pat, String> {
    let exempt = match p.exempt_when_whole_match_is.as_deref() {
        Some(e) => Some(Regex::new(e).map_err(|err| format!("pattern {}: {err}", p.id))?),
        None => None,
    };
    Ok(Pat {
        re: p.regex(),
        left_boundary: p.left_boundary,
        value_group: p.value_group,
        replacement: p.replacement.clone(),
        exempt,
    })
}

fn compile_all(rule_id: &str) -> Result<Vec<Pat>, String> {
    let list = ls::rule_patterns(rule_id);
    if list.is_empty() {
        // `rule_patterns` answers an unreadable list with an empty one; an empty list would redact nothing.
        return Err(format!("redaction rule {rule_id} has no readable patterns"));
    }
    list.iter().map(compile).collect()
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

impl Compiled {
    fn build() -> Result<Compiled, String> {
        let template = ls::redaction()["replacementTemplate"]
            .as_str()
            .ok_or("no replacementTemplate")?
            .to_string();
        let k = rule("key")?;
        let key_src = k["pattern"].as_str().ok_or("key pattern")?;
        let key_src = if k["flags"] == "i" {
            format!("(?i){key_src}")
        } else {
            key_src.to_string()
        };
        let key = Regex::new(&key_src).map_err(|e| format!("key pattern: {e}"))?;
        let camel = Regex::new(k["camelPattern"].as_str().ok_or("key camelPattern")?)
            .map_err(|e| format!("key camelPattern: {e}"))?;

        let path = rule("path")?;
        let mut deny = Vec::new();
        let mut spaced = Vec::new();
        for c in path["classes"].as_array().ok_or("path classes")? {
            let id = c["id"].as_str().ok_or("path class id")?.to_string();
            let mut segments = Vec::new();
            for seq in c["segments"].as_array().into_iter().flatten() {
                let seq = strings(seq);
                if seq.iter().any(|s| s.contains(' ')) {
                    let body = seq
                        .iter()
                        .map(|s| regex::escape(s))
                        .collect::<Vec<String>>()
                        .join(r"[\\/]");
                    let src = format!(r#"(?i)[\\/]{body}(?:[\\/][^\s"'<>|:;,()\[\]{{}}]*)?"#);
                    let re = Regex::new(&src).map_err(|e| format!("path class {id}: {e}"))?;
                    spaced.push(re);
                }
                segments.push(seq.iter().map(|s| s.to_lowercase()).collect());
            }
            deny.push(Deny {
                id,
                segments,
                files: strings(&c["files"]),
            });
        }
        let hash_chars = path["hash"]["hexChars"].as_u64().unwrap_or(6) as usize;
        if hash_chars == 0 || hash_chars > 64 {
            return Err("path hash hexChars".into());
        }

        Ok(Compiled {
            template,
            key,
            camel,
            header: Regex::new(
                r"(?i)(^|[^A-Za-z0-9_])((?:proxy-)?authorization|(?:set-)?cookie)([ \t]*:[ \t]*)([^\r\n]*)",
            )
            .map_err(|e| format!("header: {e}"))?,
            header_line: Regex::new(r"(?m)^([A-Za-z0-9_-]+)([ \t]*:[ \t]*)([^\r\n]+)")
                .map_err(|e| format!("header line: {e}"))?,
            path_token: Regex::new(
                r#"(?:[A-Za-z]:)?(?:[\\/][^\s"'<>|:;,()\[\]{}]+)+|~[\\/][^\s"'<>|:;,()\[\]{}]+|\.env(?:\.[A-Za-z0-9_-]+)?(?-u:\b)"#,
            )
            .map_err(|e| format!("path token: {e}"))?,
            patterns: compile_all("pattern")?,
            url_steps: compile_all("url")?,
            deny,
            spaced,
            path_format: path["format"]
                .as_str()
                .ok_or("path format")?
                .to_string(),
            hash_chars,
        })
    }

    fn tag(&self, rule: &str) -> String {
        self.template.replace("{rule}", rule)
    }

    fn is_secret_key(&self, name: &str) -> bool {
        self.key.is_match(name) || self.camel.is_match(name)
    }

    fn deny_class_of(&self, segs: &[String]) -> Option<&str> {
        let low: Vec<String> = segs.iter().map(|s| s.to_lowercase()).collect();
        for c in &self.deny {
            for want in &c.segments {
                if want.is_empty() || want.len() > low.len() {
                    continue;
                }
                if low.windows(want.len()).any(|w| w == want.as_slice()) {
                    return Some(c.id.as_str());
                }
            }
            if let Some(base) = segs.last() {
                if c.files.iter().any(|f| file_matches(base, f)) {
                    return Some(c.id.as_str());
                }
            }
        }
        None
    }

    fn deny_label(&self, class: &str, segs: &[String]) -> String {
        let digest = format!("{:x}", Sha256::digest(segs.join("/").as_bytes()));
        self.path_format
            .replace("{class}", class)
            .replace("{hash}", &digest[..self.hash_chars])
    }

    /// A credential root with a literal space in it (`Application Support`): walk back to the start of the path.
    fn redact_spaced_path(&self, text: &str, re: &Regex) -> String {
        let mut out = String::with_capacity(text.len());
        let mut last = 0usize;
        for m in re.find_iter(text) {
            let mut start = m.start();
            while start > last {
                let Some(c) = text[..start].chars().next_back() else {
                    break;
                };
                if is_path_stop(c) {
                    break;
                }
                start -= c.len_utf8();
            }
            let bytes = text.as_bytes();
            if start >= last + 2
                && bytes[start - 2].is_ascii_alphabetic()
                && bytes[start - 1] == b':'
            {
                start -= 2;
            }
            let end = m.end();
            let segs = canonical(&text[start..end]);
            out.push_str(&text[last..start]);
            match self.deny_class_of(&segs) {
                Some(cls) => out.push_str(&self.deny_label(cls, &segs)),
                None => out.push_str(&text[start..end]),
            }
            last = end;
        }
        out.push_str(&text[last..]);
        out
    }

    /// `key=value` and `"key": "value"` inside free text, in one linear pass over the characters. Only a
    /// secret-looking name consumes its value; for any other name scanning resumes at the value.
    fn redact_pairs(&self, s: &str) -> String {
        let ch: Vec<char> = s.chars().collect();
        let n = ch.len();
        let sl = |a: usize, b: usize| -> String { ch[a..b].iter().collect() };
        let mut out = String::new();
        let mut last = 0usize;
        let mut i = 0usize;
        while i < n {
            if !is_name_char(ch[i]) {
                i += 1;
                continue;
            }
            let start = i;
            while i < n && is_name_char(ch[i]) {
                i += 1;
            }
            let name = sl(start, i);
            let mut q: Option<char> = None;
            let mut j = i;
            if start > last {
                let open = ch[start - 1];
                if (open == '"' || open == '\'') && i < n && ch[i] == open {
                    q = Some(open);
                    j = i + 1;
                }
            }
            loop {
                let mut k = j;
                while k < n && ch[k].is_whitespace() {
                    k += 1;
                }
                if k >= n || (ch[k] != ':' && ch[k] != '=') {
                    if q.is_some() {
                        q = None;
                        j = i;
                        continue;
                    }
                    break;
                }
                let mut v = k + 1;
                while v < n && ch[v].is_whitespace() {
                    v += 1;
                }
                if v >= n {
                    break;
                }
                if !self.is_secret_key(&name) {
                    i = v;
                    break;
                }
                let mut end: Option<usize> = None;
                let mut quote: Option<char> = None;
                let c0 = ch[v];
                if c0 == '"' || c0 == '\'' {
                    if let Some(rel) = ch[v + 1..].iter().position(|&x| x == c0) {
                        end = Some(v + 1 + rel + 1);
                        quote = Some(c0);
                    }
                } else {
                    let window: String = ch[v..(v + 12).min(n)].iter().collect();
                    let lower = window.to_ascii_lowercase();
                    let plen = if lower.starts_with("bearer") {
                        6
                    } else if lower.starts_with("basic") {
                        5
                    } else {
                        0
                    };
                    if plen > 0 {
                        let ws = window
                            .chars()
                            .skip(plen)
                            .take_while(|c| c.is_whitespace())
                            .count();
                        if ws > 0 {
                            let from = v + plen + ws;
                            let e = bare_end(&ch, from);
                            if e > from {
                                end = Some(e);
                            }
                        }
                    }
                    if end.is_none() {
                        let e = bare_end(&ch, v);
                        if e > v {
                            end = Some(e);
                        }
                    }
                }
                let Some(end) = end else {
                    break;
                };
                out.push_str(&sl(last, v));
                if let Some(qc) = quote {
                    out.push(qc);
                }
                out.push_str(&self.tag("key"));
                if let Some(qc) = quote {
                    out.push(qc);
                }
                last = end;
                i = end;
                break;
            }
        }
        out.push_str(&sl(last, n));
        out
    }

    /// The rules `key`, `pattern`, `url` and `path` over one string, in the order of `redaction.json`.
    fn text(&self, input: &str) -> String {
        let key_tag = self.tag("key");
        // Header values can contain spaces and semicolon-separated cookies: the whole line goes.
        let mut s = self
            .header
            .replace_all(input, |c: &Captures| {
                format!("{}{}{}{}", &c[1], &c[2], &c[3], key_tag)
            })
            .into_owned();
        s = self
            .header_line
            .replace_all(&s, |c: &Captures| {
                if self.is_secret_key(&c[1]) {
                    format!("{}{}{}", &c[1], &c[2], key_tag)
                } else {
                    c[0].to_string()
                }
            })
            .into_owned();
        s = self.redact_pairs(&s);
        let pattern_tag = self.tag("pattern");
        for p in &self.patterns {
            s = apply_pat(&s, p, &pattern_tag);
        }
        let url_tag = self.tag("url");
        s = map_urls(&s, |u| {
            let mut r = u.to_string();
            for st in &self.url_steps {
                r = apply_pat(&r, st, &url_tag);
            }
            r
        });
        for re in &self.spaced {
            s = self.redact_spaced_path(&s, re);
        }
        self.path_token
            .replace_all(&s, |c: &Captures| {
                let tok = &c[0];
                let segs = canonical(tok.strip_prefix('~').unwrap_or(tok));
                match self.deny_class_of(&segs) {
                    Some(cls) => self.deny_label(cls, &segs),
                    None => tok.to_string(),
                }
            })
            .into_owned()
    }

    /// Deep copy of `v` with every string redacted and every value under a secret-looking key replaced.
    fn walk(&self, v: &Value, depth: usize) -> Value {
        match v {
            Value::String(s) => Value::String(self.text(s)),
            Value::Array(a) => {
                if depth >= MAX_DEPTH {
                    return Value::String("[TRUNCATED:depth]".into());
                }
                Value::Array(a.iter().map(|x| self.walk(x, depth + 1)).collect())
            }
            Value::Object(o) => {
                if depth >= MAX_DEPTH {
                    return Value::String("[TRUNCATED:depth]".into());
                }
                let mut out = Map::new();
                for (k, x) in o {
                    let nv = if self.is_secret_key(k) && !x.is_null() {
                        Value::String(self.tag("key"))
                    } else {
                        self.walk(x, depth + 1)
                    };
                    out.insert(k.clone(), nv);
                }
                Value::Object(out)
            }
            other => other.clone(),
        }
    }
}

fn compiled() -> io::Result<&'static Compiled> {
    static C: OnceLock<Result<Compiled, String>> = OnceLock::new();
    C.get_or_init(Compiled::build)
        .as_ref()
        .map_err(|e| io::Error::other(format!("audit redaction is unavailable: {e}")))
}

/// `detail` with every secret redacted. An error (the redaction data cannot be read) means: write nothing.
pub(crate) fn redact_detail(detail: &Value) -> io::Result<Value> {
    Ok(compiled()?.walk(detail, 0))
}

/// One string through the rules (used by the tests; the audit writers only go through [`redact_detail`]).
pub(crate) fn redact_text(text: &str) -> io::Result<String> {
    Ok(compiled()?.text(text))
}

fn apply_pat(text: &str, p: &Pat, tag: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last = 0usize;
    for caps in p.re.captures_iter(text) {
        let Some(m) = caps.get(0) else {
            continue;
        };
        if m.as_str().is_empty() {
            continue;
        }
        let at = m.start();
        if p.left_boundary && at > 0 && text.as_bytes()[at - 1].is_ascii_alphanumeric() {
            continue;
        }
        if p.exempt.as_ref().is_some_and(|e| e.is_match(m.as_str())) {
            continue;
        }
        let rep: &str = p.replacement.as_deref().unwrap_or(tag);
        let (s, e) = match p.value_group.and_then(|g| caps.get(g)) {
            Some(g) => (g.start(), g.end()),
            None => (m.start(), m.end()),
        };
        if s < last {
            continue;
        }
        out.push_str(&text[last..s]);
        out.push_str(rep);
        last = e;
    }
    out.push_str(&text[last..]);
    out
}

/// Every `scheme://rest` (rest runs to whitespace, a quote or an angle bracket) goes through `f`. Found by walking
/// out from each `://` rather than by a regular expression that retries every start of a long scheme-like run.
fn map_urls(s: &str, f: impl Fn(&str) -> String) -> String {
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut last = 0usize;
    let mut from = 0usize;
    while let Some(rel) = s[from..].find("://") {
        let at = from + rel;
        from = at + 3;
        let mut b = at;
        while b > last && is_scheme_byte(bytes[b - 1]) {
            b -= 1;
        }
        while b < at && !bytes[b].is_ascii_alphabetic() {
            b += 1;
        }
        if b == at {
            continue; // no scheme
        }
        let e = s[at + 3..]
            .char_indices()
            .find(|(_, c)| c.is_whitespace() || matches!(c, '"' | '\'' | '<' | '>'))
            .map(|(i, _)| at + 3 + i)
            .unwrap_or(s.len());
        if e == at + 3 {
            continue; // nothing after `://`
        }
        out.push_str(&s[last..b]);
        out.push_str(&f(&s[b..e]));
        last = e;
        from = e;
    }
    out.push_str(&s[last..]);
    out
}

fn is_scheme_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'+' | b'.' | b'-')
}

fn is_name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-')
}

fn is_value_stop(c: char) -> bool {
    c.is_whitespace() || matches!(c, ',' | ';' | '&' | '"' | '\'')
}

/// End of a bare value starting at `i` (exclusive); `i` itself when it is empty.
fn bare_end(ch: &[char], i: usize) -> usize {
    let mut e = i;
    while e < ch.len() && !is_value_stop(ch[e]) {
        e += 1;
    }
    e
}

fn is_path_stop(c: char) -> bool {
    c.is_whitespace()
        || matches!(
            c,
            '"' | '\'' | '<' | '>' | '|' | ':' | ';' | ',' | '(' | ')' | '[' | ']' | '{' | '}'
        )
}

/// Separators unified, `.` and `..` resolved; case is folded only where the match is made.
fn canonical(p: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for seg in p.replace('\\', "/").split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            out.pop();
        } else {
            out.push(seg.to_string());
        }
    }
    out
}

fn file_matches(name: &str, pattern: &str) -> bool {
    let name = name.to_lowercase();
    let pattern = pattern.to_lowercase();
    match pattern.strip_suffix('*') {
        Some(prefix) if pattern.ends_with(".*") => name.starts_with(prefix),
        _ => name == pattern,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn vectors() -> Value {
        serde_json::from_str(include_str!(
            "../../../packages/log-schema/fixtures/vectors.json"
        ))
        .unwrap()
    }

    fn parts(v: &Value) -> String {
        strings(v).concat()
    }

    /// Output of the TypeScript redactor (`createRedactor().text`) for the same input.
    #[test]
    fn text_matches_the_typescript_redactor() {
        let cases = [
            (
                "see https://user:hunter2@example.com/a/b?token=abc123&x=1#frag now",
                "see https://example.com/a/b?token=[REDACTED:url]&x=[REDACTED:url]#[REDACTED:url] now",
            ),
            (
                "Authorization: Bearer abcdef123456 trailing",
                "Authorization: [REDACTED:key]",
            ),
            (
                "failed with password=hunter2 and retry",
                "failed with password=[REDACTED:key] and retry",
            ),
            (
                "{\"apiKey\":\"zzz\",\"model\":\"m\"}",
                "{\"apiKey\":\"[REDACTED:key]\",\"model\":\"m\"}",
            ),
            (
                "opened /home/alice/.ssh/id_rsa for read",
                "opened <deny:ssh>/…#fe53c4 for read",
            ),
            (
                "read C:\\Users\\bob\\.aws\\credentials today",
                "read <deny:cloud-cli>/…#c0c7f0 today",
            ),
            (
                "cfg at ~/.config/gh/hosts.yml ok",
                "cfg at <deny:cloud-cli>/…#ac3241 ok",
            ),
            (
                "file /srv/app/.env.local here",
                "file <deny:dotenv>/…#8a9285 here",
            ),
            (
                "PLUR1BUS_TOKEN=abcd1234 set",
                "PLUR1BUS_TOKEN=[REDACTED:pattern] set",
            ),
            (
                "x QkQkQkQkQkQkQkQkQkQkQkQkQkQkQkQkQkQkQkQkQkQk y",
                "x [REDACTED:pattern] y",
            ),
            (
                "Basic info and Basic dXNlcjpwYXNzd29yZA== end",
                "Basic info and [REDACTED:pattern] end",
            ),
            (
                "plain text stays: backend=file purpose=embedding",
                "plain text stays: backend=file purpose=embedding",
            ),
            (
                "/Users/me/Library/Application Support/Google/Chrome/Default/Cookies done",
                "<deny:browser-profile>/…#b712f8 done",
            ),
            (
                "line one\nCookie: a=1; b=2\nline three",
                "line one\nCookie: [REDACTED:key]\nline three",
            ),
        ];
        for (input, want) in cases {
            assert_eq!(redact_text(input).unwrap(), want, "{input}");
        }
    }

    #[test]
    fn values_follow_the_key_rule_and_keep_what_is_not_secret() {
        let got = redact_detail(&json!({
            "a": { "token": "x", "n": 1, "list": ["Bearer abc.def", "ok"] },
            "input_tokens": 5,
            "nul": null,
            "password": null,
        }))
        .unwrap();
        assert_eq!(
            got,
            json!({
                "a": { "token": "[REDACTED:key]", "n": 1, "list": ["[REDACTED:pattern]", "ok"] },
                "input_tokens": 5,
                "nul": null,
                "password": null,
            })
        );
    }

    /// The canaries of `vectors.json` (generated from the same `redaction.json` by the TypeScript package): the Rust
    /// redactor masks every one of them, in any detail field, and leaves the non-matches alone.
    #[test]
    fn the_shared_canaries_are_masked_and_the_non_matches_are_not() {
        let v = vectors();
        let canaries = v["redactionCanaries"].as_array().unwrap();
        assert!(!canaries.is_empty());
        for c in canaries {
            let text = parts(&c["parts"]);
            let secret = parts(&c["matches"]);
            let out = redact_text(&text).unwrap();
            assert!(!out.contains(&secret), "{} survives: {out}", c["pattern"]);
            assert!(
                out.contains("[REDACTED:"),
                "{} leaves no marker",
                c["pattern"]
            );
            let nested = redact_detail(&json!({ "reason": text, "list": [text] })).unwrap();
            assert!(
                !nested.to_string().contains(&secret),
                "{} survives in a detail",
                c["pattern"]
            );
        }
        for n in v["redactionNonMatches"].as_array().unwrap() {
            let text = n["text"].as_str().unwrap();
            assert_eq!(redact_text(text).unwrap(), text, "{}", n["note"]);
        }
    }

    #[test]
    fn key_names_follow_the_shared_list() {
        let v = vectors();
        for n in strings(&v["keyNames"]["redact"]) {
            let got = redact_detail(&json!({ n.clone(): "plain-value" })).unwrap();
            assert_eq!(got[n.as_str()], "[REDACTED:key]", "{n}");
        }
        for n in strings(&v["keyNames"]["keep"]) {
            let got = redact_detail(&json!({ n.clone(): "plain-value" })).unwrap();
            assert_eq!(got[n.as_str()], "plain-value", "{n}");
        }
    }

    #[test]
    fn ordinary_details_come_back_byte_identical() {
        let detail = json!({
            "target": "linux-x64", "channel": "stable", "core": "bundled", "profile": "standard",
            "id": "demo/demo-skill", "version": "1.0.0", "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
            "keyId": null, "acknowledged": ["unsigned"], "replaced": false, "via": "offline",
            "moved": ["data/ext/fixture", "modules.fixture"], "message": "ünï ✓ 😀 a\nb",
            "from": "0.1.0", "to": "0.2.0", "n": 3,
        });
        let got = redact_detail(&detail).unwrap();
        assert_eq!(got, detail);
        assert_eq!(got.to_string(), detail.to_string());
    }

    #[test]
    fn nesting_beyond_the_bound_is_replaced_not_passed_on() {
        let mut v = json!("Bearer abcdef123456");
        for _ in 0..(MAX_DEPTH + 5) {
            v = json!([v]);
        }
        let got = redact_detail(&v).unwrap().to_string();
        assert!(!got.contains("abcdef123456"));
        assert!(got.contains("[TRUNCATED:depth]"));
    }
}
