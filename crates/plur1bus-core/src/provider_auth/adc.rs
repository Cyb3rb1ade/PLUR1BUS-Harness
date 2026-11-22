//! `auth/adc.ts`: Google application-default credentials. Only the public `authorized_user` and `service_account` files are
//! supported, never another CLI's private token store. The file is found as gcloud places it (`GOOGLE_APPLICATION_CREDENTIALS`,
//! else `%APPDATA%\gcloud\…` on Windows and `~/.config/gcloud/…` elsewhere); the platform, the environment, the home
//! directory and the file read are ports, so no test touches a real file. A service account signs an RS256 assertion
//! (RFC 7523) with `ring`: the key must be RSA, PEM-armoured PKCS #8 (`PRIVATE KEY`) or PKCS #1 (`RSA PRIVATE KEY`); any other
//! key fails closed. Every failure is the one constant `adc_unavailable`; the token cache is private.
use super::credentials::{AdcLease, AdcTokenSource};
use super::errors::{AuthError, AuthErrorCode};
use super::http::{parse_token_response, Form, OAuthHttp};
use super::ports::{base64url, js_number, Clock, PortFailure};
use super::profile::{AuthKind, AuthProfile};
use super::secret::Secret;
use crate::js::json_stringify;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::sync::{Mutex, PoisonError};

/// The token endpoint when neither the profile nor the file names one.
pub const DEFAULT_TOKEN_URI: &str = "https://oauth2.googleapis.com/token";

/// The file read of ADC (`readFile(path, "utf8")`).
pub trait AdcFiles: Send + Sync {
    /// The file's text, `Err` when it cannot be read.
    fn read(&self, path: &str) -> Result<Secret, PortFailure>;
}

/// What the source is built from.
pub struct GoogleAdcOptions<'a> {
    /// The token POST.
    pub http: &'a OAuthHttp<'a>,
    /// The clock.
    pub clock: &'a dyn Clock,
    /// The environment variables.
    pub env: BTreeMap<String, String>,
    /// The home directory.
    pub home: String,
    /// `process.platform`.
    pub platform: String,
    /// The file read.
    pub files: &'a dyn AdcFiles,
}

#[derive(Clone)]
struct Cached {
    access_token: Secret,
    expires_at: f64,
    refresh_token: Option<Secret>,
}

/// `GoogleAdc`.
pub struct GoogleAdc<'a> {
    o: GoogleAdcOptions<'a>,
    cache: Mutex<HashMap<String, Cached>>,
    /// Concurrent callers wait for the one exchange and then find its result in the cache (`#flights`).
    exchange: Mutex<()>,
}

fn unavailable() -> AuthError {
    AuthError::new(
        AuthErrorCode::AdcUnavailable,
        "Google application-default credentials are unavailable; configure ADC and try again.",
    )
}

/// `path.posix.join` / `path.win32.join` for the segments used here: one separator between parts, repeated separators folded.
fn join(win: bool, parts: &[&str]) -> String {
    let sep = if win { '\\' } else { '/' };
    let mut out = String::new();
    for p in parts.iter().filter(|p| !p.is_empty()) {
        if !out.is_empty() && !out.ends_with(['/', '\\']) {
            out.push(sep);
        }
        out.push_str(p);
    }
    let mut folded = String::with_capacity(out.len());
    let mut last_sep = false;
    for (i, c) in out.chars().enumerate() {
        let is_sep = c == '/' || (win && c == '\\');
        // A Windows UNC prefix keeps its two leading separators.
        if is_sep && last_sep && !(win && i == 1) {
            continue;
        }
        folded.push(if is_sep { sep } else { c });
        last_sep = is_sep;
    }
    folded
}

/// The PEM body of `label`, base64-decoded, read in the line forms OpenSSL's PEM reader (behind `createPrivateKey`) takes
/// and never in one it refuses (review C, RC-8; measured with Node 24 and its OpenSSL, `adc.json` `pem`). Lines end at
/// `\n`; spaces, tabs, `\r`, `\v` and `\f` at the end of a line do not count. The BEGIN and END lines start the line and hold
/// nothing else; other lines before BEGIN and after END are ignored. One blank line may follow BEGIN (an empty header
/// block); any other blank line ends the read. A body line holds base64 characters, with spaces and tabs anywhere in it.
/// OpenSSL reads a few more forms (a leading `\r`, a NUL at the end of a line, a byte-order mark before BEGIN); Rust
/// refuses those (K4-D8).
fn pem(text: &str, label: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    let begin = format!("-----BEGIN {label}-----");
    let end = format!("-----END {label}-----");
    fn trim(l: &str) -> &str {
        l.trim_end_matches([' ', '\t', '\r', '\x0b', '\x0c'])
    }
    let mut lines = text.split('\n');
    lines.by_ref().find(|l| trim(l) == begin)?;
    let mut body = String::new();
    for (i, line) in lines.enumerate() {
        let l = trim(line);
        if l == end {
            return base64::engine::general_purpose::STANDARD.decode(body).ok();
        }
        let chars = l.trim_matches([' ', '\t']);
        if chars.is_empty() {
            if i == 0 {
                continue;
            }
            return None;
        }
        if !chars
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'=' | b' ' | b'\t'))
        {
            return None;
        }
        body.extend(chars.chars().filter(|c| !matches!(c, ' ' | '\t')));
    }
    None
}

/// The RSA key of a PEM text, as `createPrivateKey` reads it for the two armours a service account file uses.
pub(crate) fn rsa_key(text: &str) -> Option<ring::rsa::KeyPair> {
    if let Some(der) = pem(text, "PRIVATE KEY") {
        return ring::rsa::KeyPair::from_pkcs8(&der).ok();
    }
    if let Some(der) = pem(text, "RSA PRIVATE KEY") {
        return ring::rsa::KeyPair::from_der(&der).ok();
    }
    None
}

impl<'a> GoogleAdc<'a> {
    /// `new GoogleAdc(options)`.
    pub fn new(o: GoogleAdcOptions<'a>) -> GoogleAdc<'a> {
        GoogleAdc {
            o,
            cache: Mutex::new(HashMap::new()),
            exchange: Mutex::new(()),
        }
    }

    /// The credentials file this source reads.
    pub fn path(&self) -> String {
        if let Some(p) = self.o.env.get("GOOGLE_APPLICATION_CREDENTIALS") {
            return p.clone();
        }
        if self.o.platform == "win32" {
            let appdata = self
                .o
                .env
                .get("APPDATA")
                .cloned()
                .unwrap_or_else(|| join(true, &[&self.o.home, "AppData", "Roaming"]));
            join(
                true,
                &[&appdata, "gcloud", "application_default_credentials.json"],
            )
        } else {
            join(
                false,
                &[
                    &self.o.home,
                    ".config",
                    "gcloud",
                    "application_default_credentials.json",
                ],
            )
        }
    }

    /// `token(profile)`.
    pub fn token(&self, profile: &AuthProfile) -> Result<AdcLease, AuthError> {
        if profile.kind != AuthKind::Adc {
            return Err(unavailable());
        }
        let path = self.path();
        let key = serde_json::to_string(&(
            &path,
            profile.token_url(),
            profile.scopes.clone().unwrap_or_default(),
            &profile.audience,
        ))
        .map_err(|_| unavailable())?;
        let skew = profile.refresh_skew_ms();
        let hit = |cache: &HashMap<String, Cached>| {
            cache
                .get(&key)
                .filter(|c| c.expires_at - skew > self.o.clock.now())
                .map(|c| AdcLease {
                    access_token: c.access_token.clone(),
                    expires_at: Some(c.expires_at),
                })
        };
        if let Some(l) = hit(&self.cache.lock().unwrap_or_else(PoisonError::into_inner)) {
            return Ok(l);
        }
        let _one = self.exchange.lock().unwrap_or_else(PoisonError::into_inner);
        let cached = {
            let cache = self.cache.lock().unwrap_or_else(PoisonError::into_inner);
            if let Some(l) = hit(&cache) {
                return Ok(l);
            }
            cache.get(&key).cloned()
        };
        let result = self
            .exchange(&path, profile, cached.as_ref())
            .ok_or_else(unavailable)?;
        let lease = AdcLease {
            access_token: result.access_token.clone(),
            expires_at: Some(result.expires_at),
        };
        self.cache
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(key, result);
        Ok(lease)
    }

    fn exchange(
        &self,
        path: &str,
        profile: &AuthProfile,
        cached: Option<&Cached>,
    ) -> Option<Cached> {
        let raw = self.o.files.read(path).ok()?;
        if raw.expose().len() > 64 * 1024 {
            return None;
        }
        let Ok(Value::Object(c)) = serde_json::from_str::<Value>(raw.expose()) else {
            return None;
        };
        let endpoint = profile.token_url().unwrap_or_else(|| {
            c.get("token_uri")
                .and_then(Value::as_str)
                .unwrap_or(DEFAULT_TOKEN_URI)
                .to_owned()
        });
        let text = |k: &str| c.get(k).and_then(Value::as_str);
        let mut form = Form::new();
        match text("type") {
            Some("authorized_user") => {
                let (Some(id), Some(secret), Some(refresh)) = (
                    text("client_id").filter(|s| !s.is_empty()),
                    text("client_secret").filter(|s| !s.is_empty()),
                    text("refresh_token").filter(|s| !s.is_empty()),
                ) else {
                    return None;
                };
                form.push(("grant_type".into(), Secret::new("refresh_token")));
                form.push(("client_id".into(), Secret::new(id)));
                form.push(("client_secret".into(), Secret::new(secret)));
                let refresh = cached
                    .and_then(|c| c.refresh_token.clone())
                    .unwrap_or_else(|| Secret::new(refresh));
                form.push(("refresh_token".into(), refresh));
            }
            Some("service_account") => {
                let (Some(email), Some(private_key)) = (text("client_email"), text("private_key"))
                else {
                    return None;
                };
                let scopes = profile.scopes.as_ref().filter(|s| !s.is_empty())?;
                let key = rsa_key(private_key)?;
                let iat = (self.o.clock.now() / 1000.0).floor();
                let mut header = String::from("{\"alg\":\"RS256\",\"typ\":\"JWT\"");
                if let Some(kid) = text("private_key_id") {
                    header.push_str(",\"kid\":");
                    header.push_str(&json_stringify(kid));
                }
                header.push('}');
                let aud = profile.audience.clone().unwrap_or_else(|| endpoint.clone());
                let claims = format!(
                    "{{\"iss\":{},\"scope\":{},\"aud\":{},\"iat\":{},\"exp\":{}}}",
                    json_stringify(email),
                    json_stringify(&scopes.join(" ")),
                    json_stringify(&aud),
                    js_number(iat),
                    js_number(iat + 3600.0)
                );
                let body = format!(
                    "{}.{}",
                    base64url(header.as_bytes()),
                    base64url(claims.as_bytes())
                );
                let mut sig = vec![0u8; key.public().modulus_len()];
                key.sign(
                    &ring::signature::RSA_PKCS1_SHA256,
                    &ring::rand::SystemRandom::new(),
                    body.as_bytes(),
                    &mut sig,
                )
                .ok()?;
                form.push((
                    "grant_type".into(),
                    Secret::new("urn:ietf:params:oauth:grant-type:jwt-bearer"),
                ));
                form.push((
                    "assertion".into(),
                    Secret::new(format!("{body}.{}", base64url(&sig))),
                ));
            }
            _ => return None,
        }
        let result = parse_token_response(&self.o.http.post(&endpoint, &form).ok()?).ok()?;
        let expires_in = result.expires_in_seconds?;
        Some(Cached {
            access_token: result.access_token,
            expires_at: self.o.clock.now() + expires_in * 1000.0,
            refresh_token: result
                .refresh_token
                .or_else(|| cached.and_then(|c| c.refresh_token.clone())),
        })
    }
}

impl AdcTokenSource for GoogleAdc<'_> {
    fn token(&self, profile: &AuthProfile) -> Result<AdcLease, AuthError> {
        GoogleAdc::token(self, profile)
    }
}
