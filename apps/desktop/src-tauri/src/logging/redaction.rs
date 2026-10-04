//! The only redaction boundary. No sink accepts an unformatted application string.
use base64::{
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD},
    Engine,
};
use regex::{Captures, Regex};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use zeroize::Zeroizing;

pub const REDACTION_RULES_JSON: &str = include_str!("redaction.json");
const MAX_INPUT: usize = 3 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RedactionError {
    Busy,
    InputLimit,
    RegistryLimit,
    Resolver,
}

/// Exact secret values and encodings, in Rust memory only. Values shorter than eight chars are ignored.
/// Dropped entries are zeroized. Bounded to 8192 stored encoding variants; each input is at most 4096 bytes.
#[derive(Default)]
pub struct SecretRegistry {
    values: RwLock<Vec<Zeroizing<String>>>,
}
impl SecretRegistry {
    pub fn register(&self, value: &str) -> Result<(), RedactionError> {
        if value.chars().count() < 8 {
            return Ok(());
        }
        if value.len() > 4096 {
            return Err(RedactionError::RegistryLimit);
        }
        let mut values = self.values.write().map_err(|_| RedactionError::Busy)?;
        if values.iter().any(|v| v.as_str() == value) {
            return Ok(());
        }
        if values.len() + 8 > 8192 {
            return Err(RedactionError::RegistryLimit);
        }
        let percent: String = value
            .as_bytes()
            .iter()
            .map(|b| {
                if b.is_ascii_alphanumeric() || b"-._~".contains(b) {
                    (*b as char).to_string()
                } else {
                    format!("%{b:02X}")
                }
            })
            .collect();
        let percent_lower: String = value
            .as_bytes()
            .iter()
            .map(|b| {
                if b.is_ascii_alphanumeric() || b"-._~".contains(b) {
                    (*b as char).to_string()
                } else {
                    format!("%{b:02x}")
                }
            })
            .collect();
        let form: String = url::form_urlencoded::byte_serialize(value.as_bytes()).collect();
        for item in [
            value.to_owned(),
            STANDARD.encode(value),
            STANDARD_NO_PAD.encode(value),
            URL_SAFE.encode(value),
            URL_SAFE_NO_PAD.encode(value),
            percent,
            percent_lower,
            form,
        ] {
            if !values.iter().any(|v| v.as_str() == item) {
                values.push(Zeroizing::new(item));
            }
        }
        values.sort_by_key(|v| std::cmp::Reverse(v.len()));
        Ok(())
    }
}

#[derive(Clone, Copy, Debug)]
pub enum CredentialClass {
    Ssh,
    GnuPg,
    Keychain,
    Browser,
    PasswordManager,
    Cloud,
    Environment,
    Token,
}
impl CredentialClass {
    fn label(self) -> &'static str {
        match self {
            Self::Ssh => "ssh",
            Self::GnuPg => "gnupg",
            Self::Keychain => "keychain",
            Self::Browser => "browser",
            Self::PasswordManager => "password-manager",
            Self::Cloud => "cloud",
            Self::Environment => "environment",
            Self::Token => "token",
        }
    }
}
/// Resolver output cannot inject text: the class is closed; only a short hash of the canonical path is emitted.
pub struct DeniedPath {
    pub class: CredentialClass,
    pub canonical: String,
}
/// Controlled canonicalisation seam. Implementations must be local, bounded and non-panicking; no real-home scan.
/// The default implementation is lexical only; integration may supply a precomputed alias map for symlinks.
pub trait CredentialPathResolver: Send + Sync {
    fn classify(&self, path: &str) -> Result<Option<DeniedPath>, RedactionError>;
}
pub struct CredentialPaths {
    home: String,
}
impl CredentialPaths {
    pub fn new(home: &str) -> Self {
        Self {
            home: normalize(home),
        }
    }
}
fn normalize(path: &str) -> String {
    let path = path.replace('\\', "/");
    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    format!(
        "{}{}",
        if path.starts_with('/') { "/" } else { "" },
        parts.join("/")
    )
}
impl CredentialPathResolver for CredentialPaths {
    fn classify(&self, path: &str) -> Result<Option<DeniedPath>, RedactionError> {
        if !(path.starts_with('/')
            || path.starts_with("~/")
            || path.as_bytes().get(1) == Some(&b':'))
        {
            return Ok(None);
        }
        let canonical = normalize(
            &path
                .strip_prefix("~/")
                .map(|s| format!("{}/{s}", self.home))
                .unwrap_or_else(|| path.into()),
        );
        let lower = canonical.to_ascii_lowercase();
        let parts: Vec<_> = lower.split('/').collect();
        let class = if parts.contains(&".ssh") {
            Some(CredentialClass::Ssh)
        } else if parts.contains(&".gnupg") {
            Some(CredentialClass::GnuPg)
        } else if parts
            .iter()
            .any(|p| matches!(*p, "keychains" | "keyrings" | "kwalletd" | "kwallet"))
            || lower.ends_with(".keychain-db")
            || lower.contains("/microsoft/credentials/")
            || lower.contains("/microsoft/vault/")
            || lower.contains("/microsoft/protect/")
        {
            Some(CredentialClass::Keychain)
        } else if parts.iter().any(|p| {
            matches!(
                *p,
                ".mozilla" | "google-chrome" | "chromium" | "brave-browser" | "firefox"
            )
        }) || lower.contains("/google/chrome/")
            || lower.contains("/microsoft/edge/")
            || lower.contains("/library/safari/")
        {
            Some(CredentialClass::Browser)
        } else if parts.iter().any(|p| {
            matches!(
                *p,
                ".password-store" | ".1password" | "1password" | "bitwarden" | "keepass"
            )
        }) || lower.ends_with(".kdbx")
        {
            Some(CredentialClass::PasswordManager)
        } else if parts
            .iter()
            .any(|p| matches!(*p, ".aws" | ".azure" | "gcloud"))
        {
            Some(CredentialClass::Cloud)
        } else if parts
            .last()
            .is_some_and(|p| *p == ".env" || p.starts_with(".env.") || p.ends_with(".env"))
        {
            Some(CredentialClass::Environment)
        } else if parts.last().is_some_and(|p| {
            matches!(
                *p,
                "auth.json"
                    | "auth-profiles.json"
                    | "credentials.json"
                    | ".credentials.json"
                    | "credentials"
                    | ".npmrc"
                    | ".netrc"
            ) || p.starts_with("token")
                || p.ends_with(".token")
        }) || parts.contains(&"credentials")
            || (parts.contains(&"agents") && parts.contains(&"agent") && lower.ends_with(".sqlite"))
        {
            Some(CredentialClass::Token)
        } else {
            None
        };
        Ok(class.map(|class| DeniedPath { class, canonical }))
    }
}

struct Rules {
    key: Regex,
    key_value: Regex,
    patterns: Vec<Regex>,
    base64url: Regex,
    url: Regex,
    path: Regex,
    email: Regex,
    phone: Regex,
}
fn rules() -> &'static Rules {
    static RULES: OnceLock<Rules> = OnceLock::new();
    RULES.get_or_init(|| {
        #[derive(Deserialize)]
        struct Data {
            sensitive_key: String,
            key_value: String,
            patterns: Vec<String>,
            base64url: String,
            url: String,
            path: String,
            email: String,
            phone: String,
        }
        let d: Data = serde_json::from_str(REDACTION_RULES_JSON).expect("embedded redaction rules");
        let compile = |s: &str| Regex::new(s).expect("embedded redaction pattern");
        Rules {
            key: compile(&d.sensitive_key),
            key_value: compile(&d.key_value),
            patterns: d.patterns.iter().map(|p| compile(p)).collect(),
            base64url: compile(&d.base64url),
            url: compile(&d.url),
            path: compile(&d.path),
            email: compile(&d.email),
            phone: compile(&d.phone),
        }
    })
}
struct Inner {
    secrets: Arc<SecretRegistry>,
    resolver: Arc<dyn CredentialPathResolver>,
    pii: bool,
    gate: Mutex<()>,
}
/// Single shared formatter for records, local crash reports and next-start crash details.
/// All lock acquisition is nonblocking; a busy/poisoned redactor fails closed.
#[derive(Clone)]
pub struct Formatter(Arc<Inner>);
impl Formatter {
    pub fn new(
        secrets: Arc<SecretRegistry>,
        resolver: Arc<dyn CredentialPathResolver>,
        redact_pii: bool,
    ) -> Self {
        let _ = rules();
        Self(Arc::new(Inner {
            secrets,
            resolver,
            pii: redact_pii,
            gate: Mutex::new(()),
        }))
    }
    pub fn redact_text(&self, input: &str) -> Result<String, RedactionError> {
        let _gate = self.0.gate.try_lock().map_err(|_| RedactionError::Busy)?;
        let secrets = self
            .0
            .secrets
            .values
            .try_read()
            .map_err(|_| RedactionError::Busy)?;
        self.text(input, &secrets)
    }
    pub fn redact_json(&self, input: &Value) -> Result<Value, RedactionError> {
        let _gate = self.0.gate.try_lock().map_err(|_| RedactionError::Busy)?;
        let secrets = self
            .0
            .secrets
            .values
            .try_read()
            .map_err(|_| RedactionError::Busy)?;
        self.value(input, &secrets, 0)
    }
    fn value(
        &self,
        input: &Value,
        secrets: &[Zeroizing<String>],
        depth: usize,
    ) -> Result<Value, RedactionError> {
        if depth > 32 {
            return Err(RedactionError::InputLimit);
        }
        Ok(match input {
            Value::String(text) => Value::String(self.text(text, secrets)?),
            Value::Array(items) => {
                if items.len() > 1024 {
                    return Err(RedactionError::InputLimit);
                }
                Value::Array(
                    items
                        .iter()
                        .map(|v| self.value(v, secrets, depth + 1))
                        .collect::<Result<_, _>>()?,
                )
            }
            Value::Object(items) => {
                if items.len() > 1024 {
                    return Err(RedactionError::InputLimit);
                }
                Value::Object(
                    items
                        .iter()
                        .map(|(k, v)| {
                            Ok((
                                self.text(k, secrets)?,
                                if rules().key.is_match(k)
                                    || k.to_ascii_uppercase().starts_with("PLUR1BUS_")
                                {
                                    Value::String("[REDACTED:key]".into())
                                } else {
                                    self.value(v, secrets, depth + 1)?
                                },
                            ))
                        })
                        .collect::<Result<_, _>>()?,
                )
            }
            _ => input.clone(),
        })
    }
    fn text(&self, input: &str, secrets: &[Zeroizing<String>]) -> Result<String, RedactionError> {
        if input.len() > MAX_INPUT {
            return Err(RedactionError::InputLimit);
        }
        let mut out = input.to_owned();
        for value in secrets {
            out = out.replace(value.as_str(), "[REDACTED:secret]");
        }
        // Exact structured input catches nested credential values as well as scalars.
        if let Ok(value) = serde_json::from_str::<Value>(&out) {
            if value.is_object() || value.is_array() {
                return serde_json::to_string(&self.value(&value, secrets, 1)?)
                    .map_err(|_| RedactionError::InputLimit);
            }
        }
        out = redact_key_values(&out);
        for pattern in &rules().patterns {
            out = pattern.replace_all(&out, "[REDACTED:pattern]").into_owned();
        }
        out = rules()
            .base64url
            .replace_all(&out, |c: &Captures<'_>| {
                if c[0].bytes().all(|b| b.is_ascii_hexdigit()) {
                    c[0].to_string()
                } else {
                    "[REDACTED:pattern]".into()
                }
            })
            .into_owned();
        out = rules()
            .url
            .replace_all(&out, |c: &Captures<'_>| redact_url(&c[0]))
            .into_owned();
        // Whole-path resolution also permits deterministic precomputed alias maps.
        if let Some(path) = self.0.resolver.classify(&out)? {
            out = path_marker(path);
        } else {
            let mut next = String::new();
            let mut cursor = 0;
            for found in rules().path.find_iter(&out) {
                next.push_str(&out[cursor..found.start()]);
                if let Some(path) = self
                    .0
                    .resolver
                    .classify(found.as_str().trim_matches(['"', '\'']))?
                {
                    next.push_str(&path_marker(path));
                } else {
                    next.push_str(found.as_str());
                }
                cursor = found.end();
            }
            next.push_str(&out[cursor..]);
            out = next;
        }
        if self.0.pii {
            out = rules()
                .email
                .replace_all(&out, "[REDACTED:pii]")
                .into_owned();
            out = rules()
                .phone
                .replace_all(&out, |c: &Captures<'_>| {
                    if (7..=15).contains(&c[0].bytes().filter(u8::is_ascii_digit).count()) {
                        "[REDACTED:pii]".into()
                    } else {
                        c[0].to_owned()
                    }
                })
                .into_owned();
        }
        // C0/C1 controls never reach a terminal; newlines/tabs are useful in local crash text.
        out.retain(|c| !c.is_control() || c == '\n' || c == '\t');
        Ok(out)
    }
}
fn path_marker(path: DeniedPath) -> String {
    let hash = format!("{:x}", Sha256::digest(path.canonical.as_bytes()));
    format!(
        "[REDACTED:path]<deny:{}>/…#{}",
        path.class.label(),
        &hash[..6]
    )
}
fn redact_key_values(input: &str) -> String {
    let mut out = String::new();
    let mut cursor = 0;
    for caps in rules().key_value.captures_iter(input) {
        let found = caps.get(0).expect("match");
        if found.start() < cursor {
            continue;
        }
        out.push_str(&input[cursor..found.end()]);
        let rest = &input[found.end()..];
        let key = caps[1].to_ascii_lowercase();
        let header = matches!(
            key.as_str(),
            "authorization" | "proxy-authorization" | "cookie" | "set-cookie"
        );
        let length = value_length(rest, header);
        out.push_str("[REDACTED:key]");
        cursor = found.end() + length;
    }
    out.push_str(&input[cursor..]);
    out
}
fn value_length(input: &str, header: bool) -> usize {
    let bytes = input.as_bytes();
    let Some(&first) = bytes.first() else {
        return 0;
    };
    if first == b'"' || first == b'\'' {
        let mut escaped = false;
        for (i, &b) in bytes.iter().enumerate().skip(1) {
            if !escaped && b == first {
                return i + 1;
            }
            escaped = b == b'\\' && !escaped;
        }
        return bytes.len();
    }
    if first == b'{' || first == b'[' {
        let mut depth = 0;
        let mut quote = false;
        let mut escape = false;
        for (i, &b) in bytes.iter().enumerate() {
            if quote {
                if b == b'"' && !escape {
                    quote = false;
                }
                escape = b == b'\\' && !escape;
            } else {
                match b {
                    b'"' => quote = true,
                    b'{' | b'[' => depth += 1,
                    b'}' | b']' => {
                        depth -= 1;
                        if depth == 0 {
                            return i + 1;
                        }
                    }
                    _ => {}
                }
            }
        }
        return bytes.len();
    }
    if header {
        return input.find(['\n', '\r']).unwrap_or(input.len());
    }
    input
        .find(|c: char| c.is_whitespace() || matches!(c, ',' | ';' | '&' | '#' | '}' | '"' | '\''))
        .unwrap_or(input.len())
}
fn redact_url(input: &str) -> String {
    let (base, fragment) = input
        .split_once('#')
        .map(|(b, _)| (b, true))
        .unwrap_or((input, false));
    let (base, query) = base
        .split_once('?')
        .map(|(b, q)| (b, Some(q)))
        .unwrap_or((base, None));
    let mut base = base.to_owned();
    if let Some(scheme) = base.find("://") {
        let start = scheme + 3;
        let end = base[start..]
            .find('/')
            .map(|p| p + start)
            .unwrap_or(base.len());
        if let Some(at) = base[start..end].rfind('@') {
            base.replace_range(start..start + at + 1, "");
        }
    }
    if let Some(query) = query {
        base.push('?');
        base.push_str(
            &query
                .split('&')
                .map(|part| {
                    format!(
                        "{}=[REDACTED:url]",
                        part.split('=').next().unwrap_or_default()
                    )
                })
                .collect::<Vec<_>>()
                .join("&"),
        );
    }
    if fragment {
        base.push_str("#[REDACTED:url]");
    }
    base
}
