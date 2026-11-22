//! `auth/profile.ts`: the provider profile (ADR-005 "Auth kinds") and its closed validation. An unknown field is refused, so
//! a secret value cannot ride along under an invented name; a prohibited profile is never loadable. Validation runs over the
//! JSON value as TypeScript runs it over `unknown`, check for check and in the same order, so the first refusal and its text
//! are the same.
use super::errors::{AuthError, AuthErrorCode};
use serde_json::{Map, Value};

/// `AUTH_KINDS`.
pub const AUTH_KINDS: [&str; 6] = [
    "api_key",
    "oauth_pkce",
    "device_code",
    "adc",
    "external_cli",
    "federated_token",
];
/// `DEFAULT_REFRESH_SKEW_SECONDS` (ADR-005 "Token lifecycle").
pub const DEFAULT_REFRESH_SKEW_SECONDS: f64 = 120.0;

const KEYS: [&str; 26] = [
    "id",
    "display_name",
    "kind",
    "capabilities",
    "base_url",
    "auth_header_scheme",
    "extra_headers",
    "authorizeUrl",
    "tokenUrl",
    "deviceUrl",
    "audience",
    "authorization_endpoint",
    "token_endpoint",
    "device_authorization_endpoint",
    "revocation_endpoint",
    "scopes",
    "client_registration",
    "client_id",
    "redirect",
    "pkce",
    "refresh",
    "policy_status",
    "policy_source",
    "policy_checked",
    "person_bound",
    "secret_ref",
];

/// `AuthKind`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthKind {
    /// `api_key`
    ApiKey,
    /// `oauth_pkce`
    OauthPkce,
    /// `device_code`
    DeviceCode,
    /// `adc`
    Adc,
    /// `external_cli`
    ExternalCli,
    /// `federated_token`
    FederatedToken,
}

/// `client_registration`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClientRegistration {
    /// `none`
    None,
    /// `static`
    Static,
    /// `dynamic`
    Dynamic,
    /// `dynamic_on_authorize`
    DynamicOnAuthorize,
}

/// A validated profile. It keeps the JSON it was read from, so a caller can hand it on unchanged.
#[derive(Clone, Debug, PartialEq)]
pub struct AuthProfile {
    /// `id`
    pub id: String,
    /// `display_name`
    pub display_name: String,
    /// `kind`
    pub kind: AuthKind,
    /// `auth_header_scheme`
    pub auth_header_scheme: String,
    /// `extra_headers` as `Object.entries` reads them.
    pub extra_headers: Vec<(String, String)>,
    /// `scopes`
    pub scopes: Option<Vec<String>>,
    /// `client_registration`
    pub client_registration: Option<ClientRegistration>,
    /// `client_id`
    pub client_id: Option<String>,
    /// `audience`
    pub audience: Option<String>,
    /// `refresh.refresh_skew_seconds`
    pub refresh_skew_seconds: Option<f64>,
    /// `secret_ref`: a keychain handle, never a value.
    pub secret_ref: Option<String>,
    /// `base_url`
    pub base_url: Option<String>,
    /// The validated JSON.
    pub raw: Value,
}

fn bad(why: impl AsRef<str>) -> AuthError {
    AuthError::new(
        AuthErrorCode::InvalidProfile,
        format!("Auth profile is invalid: {}.", why.as_ref()),
    )
}

fn is_str(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::String(s)) if !s.is_empty())
}

fn has_crlf(s: &str) -> bool {
    s.contains(['\r', '\n'])
}

/// `/^[a-z0-9][a-z0-9._:-]{0,127}$/`.
fn id_ok(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 128
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"._:-".contains(c))
}

/// `policy_checked`: `/^\d{4}-\d{2}-\d{2}$/`, a date `Date.parse` accepts, and the same date back from `toISOString`.
fn date_ok(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    if !b
        .iter()
        .enumerate()
        .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
    {
        return false;
    }
    let (Ok(y), Ok(m), Ok(d)) = (s[0..4].parse(), s[5..7].parse(), s[8..10].parse()) else {
        return false;
    };
    chrono::NaiveDate::from_ymd_opt(y, m, d).is_some()
}

fn check_url(name: &str, v: Option<&Value>, https: bool) -> Result<(), AuthError> {
    let Some(v) = v else { return Ok(()) };
    let Value::String(s) = v else {
        return Err(bad(format!("{name} must be a URL string")));
    };
    if s.is_empty() {
        return Err(bad(format!("{name} must be a URL string")));
    }
    let Ok(u) = url::Url::parse(s) else {
        return Err(bad(format!("{name} is not a URL")));
    };
    if !u.username().is_empty() || u.password().is_some_and(|p| !p.is_empty()) {
        return Err(bad(format!("{name} must not carry credentials")));
    }
    let host = u.host_str().unwrap_or("");
    let lp = host == "localhost" || host == "127.0.0.1" || host == "[::1]";
    if https && u.scheme() != "https" && !(u.scheme() == "http" && lp) {
        return Err(bad(format!("{name} must be https")));
    }
    Ok(())
}

/// `Object.entries(v)` for the header map: an object's members, an array's or a string's indexed elements, nothing for any
/// other value.
fn entries(v: Option<&Value>) -> Vec<(String, Value)> {
    match v {
        Some(Value::Object(m)) => m.iter().map(|(k, x)| (k.clone(), x.clone())).collect(),
        Some(Value::Array(a)) => a
            .iter()
            .enumerate()
            .map(|(i, x)| (i.to_string(), x.clone()))
            .collect(),
        Some(Value::String(s)) => s
            .chars()
            .enumerate()
            .map(|(i, c)| (i.to_string(), Value::String(c.to_string())))
            .collect(),
        _ => Vec::new(),
    }
}

fn header_name_ok(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
}

/// `/^[\x21\x23-\x5b\x5d-\x7e]+$/`: an OAuth scope token.
fn scope_ok(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|c| c == 0x21 || (0x23..=0x5b).contains(&c) || (0x5d..=0x7e).contains(&c))
}

fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `parseHeaderScheme(id, scheme)`: `Name: value with {token}` into its parts. A CR or LF, or a value without `{token}`, is
/// refused (header injection).
pub fn parse_header_scheme(scheme: &str) -> Result<(String, String), AuthError> {
    let refuse = || bad("auth_header_scheme must be `Name: value` with {token}");
    // /^([A-Za-z0-9-]+):\s*(.*)$/ with `.` not matching a line terminator.
    let name_len = scheme
        .bytes()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == b'-')
        .count();
    if name_len == 0 || scheme.as_bytes().get(name_len) != Some(&b':') {
        return Err(refuse());
    }
    let rest = &scheme[name_len + 1..];
    let template = rest.trim_start_matches(crate::js::is_js_space);
    if template.chars().any(is_line_terminator) || has_crlf(scheme) || !template.contains("{token}")
    {
        return Err(refuse());
    }
    Ok((scheme[..name_len].to_owned(), template.to_owned()))
}

/// `validateProfile(input)`.
pub fn validate_profile(input: &Value) -> Result<AuthProfile, AuthError> {
    let Value::Object(p) = input else {
        return Err(bad("not an object"));
    };
    let get = |k: &str| p.get(k);
    let id = match get("id") {
        Some(Value::String(s)) if id_ok(s) => s.clone(),
        _ => return Err(bad("id must match ^[a-z0-9][a-z0-9._:-]{0,127}$")),
    };
    if id == "openai:chatgpt-oauth-restricted" {
        return Err(bad(
            "superseded by openai:chatgpt-plan; sign in with ChatGPT again",
        ));
    }
    if p.keys().any(|k| !KEYS.contains(&k.as_str())) {
        return Err(bad("unknown field"));
    }
    if !is_str(get("display_name")) {
        return Err(bad("display_name missing"));
    }
    let kind = match get("kind").and_then(Value::as_str) {
        Some("api_key") => AuthKind::ApiKey,
        Some("oauth_pkce") => AuthKind::OauthPkce,
        Some("device_code") => AuthKind::DeviceCode,
        Some("adc") => AuthKind::Adc,
        Some("external_cli") => AuthKind::ExternalCli,
        Some("federated_token") => AuthKind::FederatedToken,
        _ => return Err(bad(format!("kind must be one of {}", AUTH_KINDS.join("|")))),
    };
    let status = get("policy_status").and_then(Value::as_str);
    if !matches!(status, Some("allowed" | "restricted" | "prohibited")) {
        return Err(bad("policy_status missing"));
    }
    if status == Some("prohibited") {
        return Err(bad(
            "policy_status is prohibited; a prohibited profile is never loadable (ADR-005)",
        ));
    }
    if !is_str(get("policy_source")) {
        return Err(bad("policy_source missing"));
    }
    match get("policy_checked") {
        Some(Value::String(s)) if !s.is_empty() && date_ok(s) => {}
        _ => return Err(bad("policy_checked must be YYYY-MM-DD")),
    }
    match get("capabilities") {
        Some(Value::Array(a))
            if !a.is_empty()
                && a.iter()
                    .all(|c| matches!(c.as_str(), Some("chat" | "embedding" | "rerank"))) => {}
        _ => return Err(bad("capabilities must list chat|embedding|rerank")),
    }
    let scheme = match get("auth_header_scheme") {
        Some(Value::String(s)) if !s.is_empty() => s.clone(),
        _ => return Err(bad("auth_header_scheme missing")),
    };
    parse_header_scheme(&scheme)?;
    let mut extra_headers = Vec::new();
    for (name, v) in entries(get("extra_headers")) {
        let Value::String(v) = v else {
            return Err(bad("extra_headers entry is malformed"));
        };
        if has_crlf(&name) || has_crlf(&v) || !header_name_ok(&name) {
            return Err(bad("extra_headers entry is malformed"));
        }
        extra_headers.push((name, v));
    }
    for f in [
        "authorizeUrl",
        "tokenUrl",
        "deviceUrl",
        "base_url",
        "authorization_endpoint",
        "token_endpoint",
        "device_authorization_endpoint",
        "revocation_endpoint",
    ] {
        check_url(f, get(f), true)?;
    }
    // `a ?? b`: JSON null counts as absent.
    let either = |a: &str, b: &str| match get(a) {
        Some(Value::Null) | None => get(b),
        x => x,
    };
    if kind == AuthKind::OauthPkce
        && !(is_str(either("authorizeUrl", "authorization_endpoint"))
            && is_str(either("tokenUrl", "token_endpoint")))
    {
        return Err(bad(
            "oauth_pkce needs authorization_endpoint and token_endpoint",
        ));
    }
    if kind == AuthKind::DeviceCode
        && !(is_str(either("deviceUrl", "device_authorization_endpoint"))
            && is_str(either("tokenUrl", "token_endpoint")))
    {
        return Err(bad(
            "device_code needs device_authorization_endpoint and token_endpoint",
        ));
    }
    for (alias, legacy) in [
        ("authorizeUrl", "authorization_endpoint"),
        ("tokenUrl", "token_endpoint"),
        ("deviceUrl", "device_authorization_endpoint"),
    ] {
        if let (Some(a), Some(l)) = (get(alias), get(legacy)) {
            if a != l {
                return Err(bad("conflicting endpoint aliases"));
            }
        }
    }
    let scopes = match get("scopes") {
        None => None,
        Some(Value::Array(a)) if a.iter().all(|s| s.as_str().is_some_and(scope_ok)) => Some(
            a.iter()
                .filter_map(|s| s.as_str().map(str::to_owned))
                .collect(),
        ),
        Some(_) => return Err(bad("scopes must be OAuth scope tokens")),
    };
    for f in ["client_id", "audience", "secret_ref"] {
        match get(f) {
            None => {}
            Some(Value::String(s)) if !s.is_empty() && !has_crlf(s) => {}
            Some(_) => return Err(bad("invalid identifier")),
        }
    }
    let client_registration = match get("client_registration") {
        None => None,
        Some(v) => Some(match v.as_str() {
            Some("none") => ClientRegistration::None,
            Some("static") => ClientRegistration::Static,
            Some("dynamic") => ClientRegistration::Dynamic,
            Some("dynamic_on_authorize") => ClientRegistration::DynamicOnAuthorize,
            _ => return Err(bad("invalid client_registration")),
        }),
    };
    if get("person_bound").is_some_and(|v| !v.is_boolean()) {
        return Err(bad("person_bound must be boolean"));
    }
    if let Some(r) = get("redirect") {
        let Value::Object(r) = r else {
            return Err(bad("invalid loopback redirect"));
        };
        if r.get("type").and_then(Value::as_str) != Some("loopback")
            || r.keys().any(|k| k != "type" && k != "port")
        {
            return Err(bad("invalid loopback redirect"));
        }
        if let Some(port) = r.get("port") {
            let ok = port
                .as_f64()
                .is_some_and(|n| n.fract() == 0.0 && (0.0..=65535.0).contains(&n));
            if !ok {
                return Err(bad("invalid redirect port"));
            }
        }
    }
    if get("pkce").is_some_and(|v| v.as_str() != Some("S256")) {
        return Err(bad("pkce must be S256"));
    }
    let mut refresh_skew_seconds = None;
    if let Some(r) = get("refresh") {
        let shape = match r {
            Value::Object(r)
                if r.keys().all(|k| k == "mode" || k == "refresh_skew_seconds")
                    && matches!(
                        r.get("mode").and_then(Value::as_str),
                        Some("rotating" | "static")
                    ) =>
            {
                Some(r)
            }
            _ => None,
        };
        let Some(r) = shape else {
            return Err(bad("refresh.mode must be rotating|static"));
        };
        if let Some(s) = r.get("refresh_skew_seconds") {
            match s.as_f64() {
                Some(n) if n.fract() == 0.0 && n >= 0.0 => refresh_skew_seconds = Some(n),
                _ => return Err(bad("refresh_skew_seconds must be a non-negative integer")),
            }
        }
    }
    let text = |k: &str| get(k).and_then(Value::as_str).map(str::to_owned);
    Ok(AuthProfile {
        id,
        display_name: text("display_name").unwrap_or_default(),
        kind,
        auth_header_scheme: scheme,
        extra_headers,
        scopes,
        client_registration,
        client_id: text("client_id"),
        audience: text("audience"),
        refresh_skew_seconds,
        secret_ref: text("secret_ref"),
        base_url: text("base_url"),
        raw: input.clone(),
    })
}

/// `loadProfiles(input)`: every profile validated, a duplicate id refused, one bad profile fails the load. The ids in the
/// order of the input.
pub fn load_profiles(input: &[Value]) -> Result<Vec<AuthProfile>, AuthError> {
    let mut out: Vec<AuthProfile> = Vec::new();
    for raw in input {
        let p = validate_profile(raw)?;
        if out.iter().any(|q| q.id == p.id) {
            return Err(bad("duplicate id"));
        }
        out.push(p);
    }
    Ok(out)
}

impl AuthProfile {
    fn url(&self, a: &str, b: &str) -> Option<String> {
        let get = |k: &str| match self.raw.get(k) {
            Some(Value::Null) | None => None,
            x => x,
        };
        get(a)
            .or_else(|| get(b))
            .and_then(Value::as_str)
            .map(str::to_owned)
    }

    /// `authorizeUrl(p)`.
    pub fn authorize_url(&self) -> Option<String> {
        self.url("authorizeUrl", "authorization_endpoint")
    }

    /// `tokenUrl(p)`.
    pub fn token_url(&self) -> Option<String> {
        self.url("tokenUrl", "token_endpoint")
    }

    /// `deviceUrl(p)`.
    pub fn device_url(&self) -> Option<String> {
        self.url("deviceUrl", "device_authorization_endpoint")
    }

    /// `refreshSkewMs(p)`.
    pub fn refresh_skew_ms(&self) -> f64 {
        self.refresh_skew_seconds
            .unwrap_or(DEFAULT_REFRESH_SKEW_SECONDS)
            * 1000.0
    }

    /// `isRefreshable(p)`.
    pub fn is_refreshable(&self) -> bool {
        matches!(self.kind, AuthKind::OauthPkce | AuthKind::DeviceCode)
    }

    /// The header name and value for `token` (`parseHeaderScheme` and `template.split("{token}").join(token)`).
    pub fn header(&self, token: &str) -> (String, String) {
        let (name, template) = parse_header_scheme(&self.auth_header_scheme)
            .unwrap_or_else(|_| (String::new(), String::new()));
        (name, template.replace("{token}", token))
    }

    /// The profile's members as a JSON object (for a caller that hands it on).
    pub fn json(&self) -> &Map<String, Value> {
        static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();
        self.raw
            .as_object()
            .unwrap_or_else(|| EMPTY.get_or_init(Map::new))
    }
}
