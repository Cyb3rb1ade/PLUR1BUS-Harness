//! D111 §4 redaction, the one implementation the CLI and the core share (the Rust side of
//! `packages/core/src/logs/redact.ts`).
//!
//! The rules are not listed here: the key-name patterns, the credential shapes, the URL steps, the deny-listed
//! paths and the PII patterns are read from `packages/log-schema/schema/redaction.json` (embedded by this crate), so a
//! pattern added there reaches every writer with the next build and the implementations cannot drift apart. Only the
//! algorithm is ported: the order of the rules, the left-boundary check, the value groups, the `key=value` scan and
//! the path canonicalisation follow the TypeScript redactor. The shared canaries of `fixtures/vectors.json` and the
//! parity vectors `fixtures/parity/logs/{redact,secret-matcher}.json` are checked in the tests.
//!
//! A [`Redactor`] applies the rules in the order of `redaction.json`: rule 1 (`secret`, the registry of exact values the
//! process holds, with their encodings: [`SecretMatcher`], [`SecretFormsCache`]), then `key`, `pattern`, `url`, `path`
//! and, only when [`RedactOptions::pii`] is set, rule 6 (`pii`, `logs.redactPii`). The offline CLI holds no secret value
//! and keeps PII off, so it creates its redactor without options (`plur1bus::audit_redact`); the core sets them.
//! [`RedactOptions::secrets_only`] applies rule 1 alone, for output that is not a log line (a tool result).
//!
//! A redaction that cannot be set up returns an error and nothing is written: a line never falls back to the raw text.
//!
//! JavaScript and Rust differ in three places the vectors pin down (`fixtures/parity/logs/`): a Rust `str` cannot hold
//! a lone surrogate (the `*_units` methods take UTF-16 code units for input that came from JavaScript), offsets and
//! lengths count UTF-16 code units as JavaScript does, and a `serde_json::Map` iterates in key order, not in insertion
//! order (it matters only where repeated keys are numbered, [`RedactOptions::secrets_only`]).
use crate::{redaction, rule_patterns, Pattern};
use regex::{Captures, Regex};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, OnceLock};

pub mod forms;
pub mod json_escapes;
pub mod matcher;
pub mod utf16;

pub use forms::{
    encode_uri_component, min_length, secret_forms_in, secret_forms_of, SecretFormsCache,
    SecretFormsSnapshot,
};
pub use json_escapes::{json_escape_view, json_secret_views, JsonEscapeView};
pub use matcher::{
    mask, JsonSecretScan, RangeError, SecretMatcher, SecretSpan, SecretTextProjection,
};
pub use utf16::{well_formed_prefix, well_formed_prefix_units};

/// The characters of JavaScript's `\s`, as the inside of a regex class. Rust's `\s` and `char::is_whitespace` differ in two:
/// U+FEFF is a space in JavaScript only, U+0085 in Rust only.
const JS_SPACE: &str =
    r"\t\n\x0B\f\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

/// `/\s/.test(c)` of JavaScript.
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{B}' | '\u{C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// Nesting deeper than this is replaced, never passed on unredacted (same bound as the TypeScript redactor).
pub const MAX_DEPTH: usize = 64;

/// The redaction data cannot be set up, or a result must be withheld.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RedactError(pub String);

impl fmt::Display for RedactError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for RedactError {}

/// What a [`Redactor`] applies (`RedactOptions` of `redact.ts`). The default is the CLI's: no registry, no PII.
#[derive(Debug, Clone, Default)]
pub struct RedactOptions {
    /// Rule `pii` (`logs.redactPii`); default false.
    pub pii: bool,
    /// Rule `secret`: exact secret values this process holds (at least [`min_length`] UTF-16 units), with their base64,
    /// base64url, hex and URL-encoded forms.
    pub secrets: Vec<String>,
    /// Only rule `secret` applies: exact registered values and their encodings, in strings and in object keys. The key,
    /// pattern, url, path and pii rules do not, so text that merely looks like a credential survives. For output that is
    /// not a log line (a tool result), where only a value this process holds may change. Default false.
    pub secrets_only: bool,
    /// Forms to mask as they are, in addition to `secrets` (see [`secret_forms_in`]): for a caller that scanned the text
    /// first and keeps only the forms that occur in it. UTF-16 code units, so a form may hold a lone surrogate.
    pub secret_forms: Vec<Vec<u16>>,
    /// Immutable compiled exact-value policy from the live secret-set generation.
    pub secret_matcher: Option<Arc<SecretMatcher>>,
}

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
    /// Rule 6, applied only when the redactor asks for it.
    pii: Vec<Pat>,
    url_steps: Vec<Pat>,
    deny: Vec<Deny>,
    /// Credential roots that contain a space, each matched with its own expression.
    spaced: Vec<Regex>,
    path_format: String,
    hash_chars: usize,
}

fn rule(id: &str) -> Result<&'static Value, String> {
    redaction()["rules"]
        .as_array()
        .and_then(|rules| rules.iter().find(|r| r["id"] == id))
        .ok_or_else(|| format!("no redaction rule {id}"))
}

fn compile(p: &Pattern) -> Result<Pat, String> {
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
    let list = rule_patterns(rule_id);
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
        let template = redaction()["replacementTemplate"]
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
                    let src =
                        format!(r#"(?i)[\\/]{body}(?:[\\/][^{JS_SPACE}"'<>|:;,()\[\]{{}}]*)?"#);
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
            path_token: Regex::new(&format!(
                r#"(?:[A-Za-z]:)?(?:[\\/][^{JS_SPACE}"'<>|:;,()\[\]{{}}]+)+|~[\\/][^{JS_SPACE}"'<>|:;,()\[\]{{}}]+|\.env(?:\.[A-Za-z0-9_-]+)?(?-u:\b)"#
            ))
            .map_err(|e| format!("path token: {e}"))?,
            patterns: compile_all("pattern")?,
            pii: compile_all("pii")?,
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
                while k < n && is_js_space(ch[k]) {
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
                while v < n && is_js_space(ch[v]) {
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
                            .take_while(|c| is_js_space(*c))
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

    /// The rule `pii` patterns over one string (rule 6, `logs.redactPii`).
    fn pii_text(&self, input: String) -> String {
        let tag = self.tag("pii");
        self.pii.iter().fold(input, |s, p| apply_pat(&s, p, &tag))
    }
}

/// One redactor over a secret-set generation and the rule switches. Cheap to clone the handle of: the compiled rules are
/// shared by the whole process and the matcher by reference count.
#[derive(Debug, Clone)]
pub struct Redactor {
    rules: &'static Compiled,
    pii: bool,
    secrets_only: bool,
    matcher: Arc<SecretMatcher>,
}

impl fmt::Debug for Compiled {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Compiled")
    }
}

fn compiled() -> Result<&'static Compiled, RedactError> {
    static C: OnceLock<Result<Compiled, String>> = OnceLock::new();
    C.get_or_init(Compiled::build)
        .as_ref()
        .map_err(|e| RedactError(format!("redaction is unavailable: {e}")))
}

/// True when a JSON key, header name or env name denotes a credential (rule `key`).
pub fn is_secret_key(name: &str) -> Result<bool, RedactError> {
    Ok(compiled()?.is_secret_key(name))
}

/// `Number.prototype.toString` for a finite double (ECMA-262 Number::toString), the text the registry is matched against
/// when a number is found where a secret was registered.
pub fn js_number_string(x: f64) -> String {
    if x == 0.0 {
        return "0".to_string();
    }
    let sign = if x < 0.0 { "-" } else { "" };
    let scientific = format!("{:e}", x.abs());
    let (mantissa, exponent) = scientific.split_once('e').unwrap_or((&scientific, "0"));
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let exponent: i32 = exponent.parse().unwrap_or(0);
    let k = digits.len() as i32;
    let n = exponent + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let sign_e = if e < 0 { '-' } else { '+' };
        if k == 1 {
            format!("{digits}e{sign_e}{}", e.abs())
        } else {
            format!("{}.{}e{sign_e}{}", &digits[..1], &digits[1..], e.abs())
        }
    };
    format!("{sign}{body}")
}

impl Redactor {
    /// A redactor for `options`. Errors when the redaction data cannot be read: nothing may be written then.
    pub fn new(options: RedactOptions) -> Result<Redactor, RedactError> {
        let rules = compiled()?;
        let mut additional: Vec<Vec<u16>> =
            secret_forms_in(options.secrets.iter().map(String::as_str))
                .iter()
                .map(|f| utf16::utf16(f))
                .collect();
        additional.extend(options.secret_forms);
        let matcher = match options.secret_matcher {
            Some(m) if additional.is_empty() => m,
            other => {
                let mut forms: Vec<Vec<u16>> =
                    other.map(|m| m.forms().to_vec()).unwrap_or_default();
                forms.extend(additional);
                Arc::new(SecretMatcher::new(forms))
            }
        };
        Ok(Redactor {
            rules,
            pii: options.pii,
            secrets_only: options.secrets_only,
            matcher,
        })
    }

    /// The shared redactor without options (what the CLI uses): every rule but 1 and 6.
    pub fn shared() -> Result<&'static Redactor, RedactError> {
        static R: OnceLock<Result<Redactor, RedactError>> = OnceLock::new();
        R.get_or_init(|| Redactor::new(RedactOptions::default()))
            .as_ref()
            .map_err(Clone::clone)
    }

    /// The exact-value policy this redactor masks with.
    pub fn secret_matcher(&self) -> &Arc<SecretMatcher> {
        &self.matcher
    }

    /// Whether rule 6 (PII) applies.
    pub fn pii(&self) -> bool {
        self.pii
    }

    /// Whether only rule 1 applies.
    pub fn secrets_only(&self) -> bool {
        self.secrets_only
    }

    fn finish_text(&self, input: String) -> String {
        if self.secrets_only {
            return input;
        }
        let s = self.rules.text(&input);
        if self.pii {
            self.rules.pii_text(s)
        } else {
            s
        }
    }

    /// One string through the rules.
    pub fn text(&self, input: &str) -> String {
        self.finish_text(self.matcher.mask_text(input))
    }

    /// One string given as UTF-16 code units (it may hold a lone surrogate, which becomes U+FFFD).
    pub fn text_units(&self, input: &[u16]) -> String {
        self.finish_text(self.matcher.mask_text_units(input))
    }

    /// The window `[begin, end)` (UTF-16 offsets) of `input`: coordinates precede masking, and only exact-value
    /// matching reads outside the window.
    pub fn text_window(&self, input: &str, begin: usize, end: usize) -> Result<String, RangeError> {
        Ok(self.finish_text(self.matcher.mask_text_window(input, begin, end)?))
    }

    /// Deep copy of a JSON value with every string redacted and every value under a secret-looking key replaced.
    pub fn value(&self, v: &Value) -> Value {
        self.value_preserving_references(v, &[])
    }

    /// Like [`value`](Self::value), but the exact schema-validated reference subtrees (JSON pointers) stay as written;
    /// all other values keep the central backstops.
    pub fn value_preserving_references(&self, v: &Value, references: &[String]) -> Value {
        self.walk(v, 0, "", references, false)
    }

    /// Deep copy of `v` with every string redacted and every value under a secret-looking key replaced.
    fn walk(
        &self,
        v: &Value,
        depth: usize,
        pointer: &str,
        references: &[String],
        inherited_secret: bool,
    ) -> Value {
        if depth < MAX_DEPTH && references.iter().any(|reference| reference == pointer) {
            return v.clone();
        }
        if inherited_secret && !v.is_null() {
            let prefix = format!("{pointer}/");
            let contains_reference = (v.is_object() || v.is_array())
                && references
                    .iter()
                    .any(|reference| reference.starts_with(&prefix));
            if !contains_reference {
                return Value::String(self.rules.tag("key"));
            }
        }
        match v {
            Value::String(s) => Value::String(self.text(s)),
            // Opaque config slots can hold malformed numeric credentials. Preserve the number type in diagnostic attrs;
            // `secrets_only` keeps the fail-closed contract for a result holding a non-string secret.
            Value::Number(n)
                if !self.secrets_only
                    && !self.matcher.is_empty()
                    && n.as_f64().is_some_and(|x| {
                        !self
                            .matcher
                            .find_text_spans(&js_number_string(x))
                            .is_empty()
                    }) =>
            {
                Value::from(0)
            }
            Value::Array(a) => {
                if depth >= MAX_DEPTH {
                    return Value::String("[TRUNCATED:depth]".into());
                }
                Value::Array(
                    a.iter()
                        .enumerate()
                        .map(|(index, x)| {
                            self.walk(
                                x,
                                depth + 1,
                                &format!("{pointer}/{index}"),
                                references,
                                inherited_secret,
                            )
                        })
                        .collect(),
                )
            }
            Value::Object(o) => {
                if depth >= MAX_DEPTH {
                    return Value::String("[TRUNCATED:depth]".into());
                }
                let mut out = Map::new();
                // Two keys that mask to the same text keep both: the repeats are numbered in order
                // (`[REDACTED:secret]`, `[REDACTED:secret]#2`, ...).
                let mut repeats: HashMap<String, usize> = HashMap::new();
                for (k, x) in o {
                    let mut name = if self.secrets_only {
                        self.text(k)
                    } else {
                        k.clone()
                    };
                    if self.secrets_only && out.contains_key(&name) {
                        let base = name.clone();
                        let mut n = repeats.get(&base).copied().unwrap_or(1);
                        loop {
                            n += 1;
                            name = format!("{base}#{n}");
                            if !out.contains_key(&name) {
                                break;
                            }
                        }
                        repeats.insert(base, n);
                    }
                    let child = format!("{pointer}/{}", k.replace('~', "~0").replace('/', "~1"));
                    let nv = self.walk(
                        x,
                        depth + 1,
                        &child,
                        references,
                        inherited_secret || (!self.secrets_only && self.rules.is_secret_key(k)),
                    );
                    out.insert(name, nv);
                }
                Value::Object(out)
            }
            other => other.clone(),
        }
    }
}

/// A JSON value with the registered secrets masked, and its serialised text.
#[derive(Debug, Clone, PartialEq)]
pub struct MaskedJson {
    /// The masked value.
    pub value: Value,
    /// `JSON.stringify` of [`value`](Self::value) (`serde_json::to_string`).
    pub json: String,
}

/// Masks the registered secret values in a JSON-serialised value (`json` is the serialisation of `value`'s source,
/// `value` its parse). The serialised text is scanned with the generation's automaton: with no form in it nothing is
/// masked and `None` comes back (no walk, so nothing is copied or cut). Strings and keys are masked with the same
/// immutable matcher (`secrets_only`).
///
/// Errors when a form that occurred is still there after masking: it was not in a string (a numeric secret serialised as
/// a JSON number is the case), the redactor cannot mask it, and the caller must not pass the result on.
pub fn mask_secrets_in_json(
    json: &str,
    value: &Value,
    matcher: &Arc<SecretMatcher>,
) -> Result<Option<MaskedJson>, RedactError> {
    let before = matcher.scan_json(json);
    if !before.found {
        return Ok(None);
    }
    let masked = Redactor::new(RedactOptions {
        secret_matcher: Some(matcher.clone()),
        secrets_only: true,
        ..RedactOptions::default()
    })?
    .value(value);
    let out = serde_json::to_string(&masked)
        .map_err(|e| RedactError(format!("masked result cannot be serialised: {e}")))?;
    if matcher.has_residual(&before, &matcher.scan_json(&out)) {
        return Err(RedactError(
            "a registered secret value is in the result outside any string".to_string(),
        ));
    }
    Ok(Some(MaskedJson {
        value: masked,
        json: out,
    }))
}

/// [`mask_secrets_in_json`] with the matcher derived from the registered values.
pub fn mask_secrets_in_json_for<'a>(
    json: &str,
    value: &Value,
    secrets: impl IntoIterator<Item = &'a str>,
) -> Result<Option<MaskedJson>, RedactError> {
    let forms = secret_forms_in(secrets);
    mask_secrets_in_json(
        json,
        value,
        &Arc::new(SecretMatcher::from_strs(forms.iter().map(String::as_str))),
    )
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
            .find(|(_, c)| is_js_space(*c) || matches!(c, '"' | '\'' | '<' | '>'))
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
    is_js_space(c) || matches!(c, ',' | ';' | '&' | '"' | '\'')
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
    is_js_space(c)
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
