//! Credentials of the front door (P4-10): `run/core.token`, `run/api-delegation.token` and `run/core-legacy.token` (32
//! random bytes each, hex, written `0600` before the socket accepts, compared in constant time, never logged), and the
//! checks `core.auth` runs on a client's credentials before anything reaches the legacy core.
//!
//! The front door authenticates every connection itself and forwards only the credentials the client presented, plus
//! the link token and the [`Caller`] kind it proved (`core.auth.frontDoor`). The legacy core verifies the same
//! credentials again and refuses a link whose kind differs, so the front door never grants more than the client's own
//! credential grants (no confused deputy). The checks below are ports of module-api's `verifyApiDelegation`,
//! `validApiPrincipal`, `verifyEngineDelegation` and `checkAdoptionNonce`, with the same refusal codes and reasons.
use serde_json::{Map, Value};
use std::fmt;
use std::io;
use zeroize::Zeroizing;

/// A credential held in memory that is never printed (`Debug` shows `Secret(..)`) and whose own buffer is zeroed on drop.
/// Only that buffer (P4-10 security review I1): the copies made to use it, in `serde_json` values (the legacy core's
/// credentials file, a forwarded `frontDoor`, the control link's handshake) and in frame buffers, are not zeroed. The
/// threat model is a process of the same user, which can read `run/` anyway; nothing here claims more.
pub struct Secret(Zeroizing<String>);

impl Secret {
    /// 32 fresh random bytes as 64 lower-case hex characters (`crypto.randomBytes(32).toString("hex")`).
    pub fn fresh() -> io::Result<Secret> {
        let mut bytes = Zeroizing::new([0u8; 32]);
        getrandom::fill(bytes.as_mut()).map_err(|_| io::Error::other("no entropy for a token"))?;
        let mut hex = Zeroizing::new(String::with_capacity(64));
        for b in bytes.iter() {
            hex.push(char::from(HEX[usize::from(b >> 4)]));
            hex.push(char::from(HEX[usize::from(b & 0x0f)]));
        }
        Ok(Secret(hex))
    }

    /// Wraps a credential read from a file or a message.
    pub fn new(value: String) -> Secret {
        Secret(Zeroizing::new(value))
    }

    /// The credential itself, for writing it to its file or presenting it on a link. Never log it.
    pub fn expose(&self) -> &str {
        &self.0
    }

    /// Whether `given` is this credential, compared in constant time (after an equal-length check, as
    /// `crypto.timingSafeEqual` requires).
    pub fn matches(&self, given: &str) -> bool {
        constant_time_eq(self.0.as_bytes(), given.as_bytes())
    }
}

/// Equality of two credentials, in constant time.
impl PartialEq for Secret {
    fn eq(&self, other: &Secret) -> bool {
        self.matches(other.expose())
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(..)")
    }
}

const HEX: &[u8; 16] = b"0123456789abcdef";

/// Constant-time equality of two byte strings of equal length; different lengths are unequal at once (the length of a
/// token is not secret: every token is 64 hex characters).
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b) {
        diff |= x ^ y;
    }
    // Keep the comparison from being turned into an early exit.
    std::hint::black_box(diff) == 0
}

/// 64 hex characters.
pub fn is_hex64(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The kind of principal a connection authenticated as, as `core.auth.frontDoor.caller` names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Caller {
    /// `run/core.token`: the installation owner (ruling R8).
    Owner,
    /// `run/core.token` plus a verified `harness-api` delegation.
    Api,
    /// The memory engine with its own `run/engine.token` (`host.*` and egress events only).
    Engine,
    /// A scoped IPC client token; only the legacy core's identity store can verify it (until P4-12), and it re-checks it
    /// on every call.
    Client,
    /// The legacy core itself, on its bridge connection (`run/core-legacy.token`): `bridge.*` only.
    LegacyCore,
}

impl Caller {
    /// The `frontDoor.caller` value.
    pub fn as_str(self) -> &'static str {
        match self {
            Caller::Owner => "owner",
            Caller::Api => "api",
            Caller::Engine => "engine",
            Caller::Client => "client",
            Caller::LegacyCore => "legacy-core",
        }
    }
}

/// A refusal with the harness error code, reason and message of the TypeScript check it ports.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Refusal {
    /// `$defs/ErrorCode`.
    pub code: &'static str,
    /// The `reason`, when the TypeScript check sets one.
    pub reason: Option<&'static str>,
    /// The message (not contract, ADR-016).
    pub message: &'static str,
}

impl Refusal {
    const fn new(code: &'static str, reason: &'static str, message: &'static str) -> Self {
        Refusal {
            code,
            reason: Some(reason),
            message,
        }
    }
}

/// `API delegation refused` (module-api `verifyApiDelegation`).
pub const API_DELEGATION: Refusal =
    Refusal::new("E_UNAUTHORIZED", "api-delegation", "API delegation refused");
/// `engine delegation refused` (module-api `verifyEngineDelegation`).
pub const ENGINE_DELEGATION: Refusal = Refusal::new(
    "E_UNAUTHORIZED",
    "engine-delegation",
    "engine delegation refused",
);

/// A delegation the API presented (`core.auth.params.api` or a request's top-level `api`), checked like
/// `verifyApiDelegation`: the exact shape, `clientId: "harness-api"`, the delegation token in constant time, and a valid
/// principal when one is given. Returns the delegation's `transport`, if any.
pub fn verify_api_delegation(value: &Value, api_token: &Secret) -> Result<Option<String>, Refusal> {
    let d = value.as_object().ok_or(API_DELEGATION)?;
    let known = ["clientId", "token", "principal", "transport"];
    if d.keys().any(|k| !known.contains(&k.as_str()))
        || d.get("clientId") != Some(&Value::from("harness-api"))
    {
        return Err(API_DELEGATION);
    }
    let token = d
        .get("token")
        .and_then(Value::as_str)
        .ok_or(API_DELEGATION)?;
    let transport = match d.get("transport") {
        None => None,
        Some(Value::String(t)) if t == "loopback" || t == "remote" => Some(t.clone()),
        Some(_) => return Err(API_DELEGATION),
    };
    if api_token.expose().is_empty() || !api_token.matches(token) {
        return Err(API_DELEGATION);
    }
    match d.get("principal") {
        None => Ok(transport),
        Some(p) if valid_api_principal(p) => Ok(transport),
        Some(_) => Err(API_DELEGATION),
    }
}

/// module-api's `validApiPrincipal`, check for check.
pub fn valid_api_principal(value: &Value) -> bool {
    let Some(p) = value.as_object() else {
        return false;
    };
    let known = [
        "userId",
        "kind",
        "role",
        "agentRights",
        "projectRights",
        "tokenScopes",
        "tokenId",
        "binding",
    ];
    if p.keys().any(|k| !known.contains(&k.as_str())) {
        return false;
    }
    let user_ok = p
        .get("userId")
        .and_then(Value::as_str)
        .is_some_and(|u| id_like(u, 256));
    let role_ok = p
        .get("role")
        .and_then(Value::as_str)
        .is_some_and(|r| ["owner", "admin", "operator", "member", "viewer"].contains(&r));
    let kind_ok = p
        .get("kind")
        .and_then(Value::as_str)
        .is_some_and(|k| k == "person" || k == "agent");
    if !(user_ok && role_ok && kind_ok) {
        return false;
    }
    for (key, values) in [
        ("agentRights", ["use", "manage"]),
        ("projectRights", ["member", "lead"]),
    ] {
        if let Some(rights) = p.get(key) {
            let Some(map) = rights.as_object() else {
                return false;
            };
            if map
                .iter()
                .any(|(k, v)| !id_like(k, 256) || !v.as_str().is_some_and(|v| values.contains(&v)))
            {
                return false;
            }
        }
    }
    if let Some(id) = p.get("tokenId") {
        if !id.as_str().is_some_and(|t| id_like(t, 128)) {
            return false;
        }
    }
    if let Some(binding) = p.get("binding") {
        if !valid_binding(binding) {
            return false;
        }
    }
    match p.get("tokenScopes") {
        None => true,
        Some(Value::Array(scopes)) => scopes
            .iter()
            .all(|s| s.as_str().is_some_and(|s| s.encode_utf16().count() <= 256)),
        Some(_) => false,
    }
}

/// `/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,max-1}$/`.
fn id_like(value: &str, max: usize) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= max
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-')
}

/// module-api's `isIdentifier`: a string whose trimmed length is 1 to `max` UTF-16 units, without control characters.
fn identifier(value: &Value, max: usize) -> bool {
    value.as_str().is_some_and(|s| {
        let trimmed = s.trim_matches(js_whitespace).encode_utf16().count();
        (1..=max).contains(&trimmed)
            && !s
                .chars()
                .any(|c| ('\u{0}'..='\u{1f}').contains(&c) || c == '\u{7f}')
    })
}

/// `String.prototype.trim`'s whitespace (WhiteSpace and LineTerminator of ECMA-262).
fn js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// module-api's `validBinding`.
fn valid_binding(value: &Value) -> bool {
    let Some(b) = value.as_object() else {
        return false;
    };
    let known = [
        "audience",
        "agentId",
        "projectId",
        "system",
        "groups",
        "memory",
    ];
    if b.keys().any(|k| !known.contains(&k.as_str())) {
        return false;
    }
    let audience = b.get("audience").and_then(Value::as_str);
    if !matches!(audience, Some("mcp" | "a2a"))
        || !b.get("agentId").is_some_and(|v| identifier(v, 128))
    {
        return false;
    }
    for key in ["projectId", "system"] {
        if b.get(key).is_some_and(|v| !identifier(v, 128)) {
            return false;
        }
    }
    if let Some(groups) = b.get("groups") {
        if !groups
            .as_array()
            .is_some_and(|g| g.iter().all(|g| identifier(g, 64)))
        {
            return false;
        }
    }
    match b.get("memory") {
        None => true,
        Some(memory) => valid_memory_policy(memory),
    }
}

fn valid_memory_policy(value: &Value) -> bool {
    let Some(m) = value.as_object() else {
        return false;
    };
    if m.keys()
        .any(|k| !["recall", "filter", "disclose", "capture"].contains(&k.as_str()))
    {
        return false;
    }
    if let Some(recall) = m.get("recall") {
        let Some(r) = recall.as_object() else {
            return false;
        };
        if r.iter().any(|(k, v)| {
            !["workspace", "user", "agentPrivate", "project"].contains(&k.as_str())
                || !v.is_boolean()
        }) {
            return false;
        }
    }
    let categories = ["health", "financial", "credential", "identity", "personal"];
    if let Some(filter) = m.get("filter") {
        if !filter.as_array().is_some_and(|f| {
            f.iter()
                .all(|c| c.as_str().is_some_and(|c| categories.contains(&c)))
        }) {
            return false;
        }
    }
    if let Some(disclose) = m.get("disclose") {
        if !matches!(disclose.as_str(), Some("agent-decides" | "never")) {
            return false;
        }
    }
    m.get("capture").is_none_or(Value::is_boolean)
}

/// `verifyEngineDelegation(params.engine, run/engine.token)` and `params.token === params.engine.token`.
pub fn verify_engine(
    params: &Map<String, Value>,
    engine_token: Option<&Secret>,
) -> Result<(), Refusal> {
    let expected = engine_token
        .filter(|t| is_hex64(t.expose()))
        .ok_or(ENGINE_DELEGATION)?;
    let delegation = params
        .get("engine")
        .and_then(Value::as_object)
        .ok_or(ENGINE_DELEGATION)?;
    if delegation.keys().any(|k| k != "clientId" && k != "token")
        || delegation.get("clientId") != Some(&Value::from("plur1bus-engine"))
    {
        return Err(ENGINE_DELEGATION);
    }
    let supplied = delegation
        .get("token")
        .and_then(Value::as_str)
        .ok_or(ENGINE_DELEGATION)?;
    if !expected.matches(supplied) {
        return Err(ENGINE_DELEGATION);
    }
    let token = params.get("token").and_then(Value::as_str).unwrap_or("");
    if !constant_time_eq(token.as_bytes(), supplied.as_bytes()) {
        return Err(Refusal::new(
            "E_UNAUTHORIZED",
            "engine-delegation",
            "engine credential mismatch",
        ));
    }
    Ok(())
}

/// module-api's `checkAdoptionNonce`: the nonce must equal `run/supervisor.token` (64 hex), lower-cased on both sides and
/// compared in constant time. `expected` is the file's content, `None` when it is missing.
pub fn adoption_nonce_matches(expected: Option<&Secret>, nonce: &str) -> bool {
    let Some(expected) = expected else {
        return false;
    };
    let want = Zeroizing::new(expected.expose().trim().to_ascii_lowercase());
    let given = Zeroizing::new(nonce.to_ascii_lowercase());
    is_hex64(&want) && is_hex64(&given) && constant_time_eq(want.as_bytes(), given.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn constant_time_eq_is_equality_on_the_equal_and_the_unequal_path() {
        assert!(constant_time_eq(b"", b""));
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"), "last byte");
        assert!(!constant_time_eq(b"abc", b"xbc"), "first byte");
        assert!(!constant_time_eq(b"abc", b"abcd"), "length");
        assert!(!constant_time_eq(b"abcd", b"abc"));
        let a = Secret::fresh().unwrap();
        let b = Secret::fresh().unwrap();
        assert!(a.matches(a.expose()));
        assert!(!a.matches(b.expose()));
        let mut off = a.expose().to_owned();
        let last = off.pop().unwrap();
        off.push(if last == '0' { '1' } else { '0' });
        assert!(!a.matches(&off), "one hex digit off");
        assert!(!a.matches(&a.expose()[..63]));
    }

    #[test]
    fn a_fresh_secret_is_64_lower_hex_characters_and_never_printed() {
        let s = Secret::fresh().unwrap();
        assert_eq!(s.expose().len(), 64);
        assert!(s
            .expose()
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
        assert_ne!(s.expose(), Secret::fresh().unwrap().expose());
        let printed = format!("{s:?} {:?}", Some(&s));
        assert!(!printed.contains(s.expose()), "{printed}");
        assert_eq!(format!("{s:?}"), "Secret(..)");
    }

    #[test]
    fn api_delegations_are_checked_like_module_api() {
        let token = Secret::fresh().unwrap();
        let ok = json!({"clientId":"harness-api","token":token.expose()});
        assert_eq!(verify_api_delegation(&ok, &token), Ok(None));
        let with = json!({"clientId":"harness-api","token":token.expose(),"transport":"remote",
            "principal":{"userId":"alice","kind":"person","role":"member","agentRights":{"bernd":"use"},"tokenScopes":["a"],
            "binding":{"audience":"mcp","agentId":" bernd ","groups":["g"],"memory":{"recall":{"user":true},"filter":["health"],"disclose":"never","capture":false}}}});
        assert_eq!(
            verify_api_delegation(&with, &token),
            Ok(Some("remote".into()))
        );
        let other = Secret::fresh().unwrap();
        for bad in [
            json!({"clientId":"harness-api","token":other.expose()}),
            json!({"clientId":"other","token":token.expose()}),
            json!({"clientId":"harness-api","token":token.expose(),"extra":1}),
            json!({"clientId":"harness-api","token":token.expose(),"transport":"lan"}),
            json!({"clientId":"harness-api","token":token.expose(),"principal":{"userId":"-x","kind":"person","role":"member"}}),
            json!({"clientId":"harness-api","token":token.expose(),"principal":{"userId":"a","kind":"robot","role":"member"}}),
            json!({"clientId":"harness-api","token":token.expose(),"principal":{"userId":"a","kind":"person","role":"member","agentRights":{"b":"own"}}}),
            json!({"clientId":"harness-api","token":token.expose(),"principal":{"userId":"a","kind":"person","role":"member","binding":{"audience":"mcp","agentId":"   "}}}),
            json!({"clientId":"harness-api","token":token.expose(),"principal":{"userId":"a","kind":"person","role":"member","isAdmin":true}}),
            json!([]),
        ] {
            assert_eq!(
                verify_api_delegation(&bad, &token),
                Err(API_DELEGATION),
                "{bad}"
            );
        }
        assert_eq!(
            verify_api_delegation(&ok, &Secret::new(String::new())),
            Err(API_DELEGATION),
            "no API token: deny"
        );
    }

    #[test]
    fn engine_delegations_need_the_engine_token_twice() {
        let engine = Secret::fresh().unwrap();
        let params = |token: &str, inner: &str| {
            json!({"token":token,"engine":{"clientId":"plur1bus-engine","token":inner}})
                .as_object()
                .unwrap()
                .clone()
        };
        assert_eq!(
            verify_engine(&params(engine.expose(), engine.expose()), Some(&engine)),
            Ok(())
        );
        let other = Secret::fresh().unwrap();
        assert_eq!(
            verify_engine(&params(engine.expose(), other.expose()), Some(&engine)),
            Err(ENGINE_DELEGATION)
        );
        assert_eq!(
            verify_engine(&params(engine.expose(), engine.expose()), None),
            Err(ENGINE_DELEGATION)
        );
        let mismatch =
            verify_engine(&params(other.expose(), engine.expose()), Some(&engine)).unwrap_err();
        assert_eq!(
            (mismatch.code, mismatch.reason),
            ("E_UNAUTHORIZED", Some("engine-delegation"))
        );
    }

    /// Mode-V vectors recorded from module-api itself (`scripts/parity/export-auth.ts`, task review L9): every ported
    /// check gives module-api's verdict on every case, except the ones marked P4D-8, which module-api accepts (it coerces
    /// `role` and `kind` with `String()`) and the port refuses (fail closed). Credentials are markers in the vectors; both
    /// sides put fresh random values in their place.
    #[test]
    fn the_ported_checks_give_module_apis_verdicts() {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../fixtures/parity/auth/module-api.json"
        ))
        .unwrap();
        let fresh = || Secret::fresh().unwrap().expose().to_owned();
        let (api, engine, sup, other) = (fresh(), fresh(), fresh(), fresh());
        let values = [
            ("@api@", api.clone()),
            ("@API@", api.to_uppercase()),
            ("@engine@", engine.clone()),
            ("@ENGINE@", engine.to_uppercase()),
            ("@sup@", sup.clone()),
            ("@SUP@", sup.to_uppercase()),
            ("@other@", other),
        ];
        let subst = |text: &str| {
            values.iter().fold(text.to_owned(), |t, (marker, value)| {
                t.replace(marker, value)
            })
        };
        let cases = |section: &str| vectors[section].as_array().unwrap().clone();
        let name = |case: &Value| case["name"].as_str().unwrap().to_owned();
        let valid = |case: &Value| case["valid"].as_bool().unwrap();

        let mut divergent = Vec::new();
        for case in cases("api-delegation") {
            let input: Value =
                serde_json::from_str(&subst(case["inputJson"].as_str().unwrap())).unwrap();
            let token = if case["apiToken"] == "none" {
                Secret::new(String::new())
            } else {
                Secret::new(api.clone())
            };
            let got = verify_api_delegation(&input, &token);
            if case["note"]
                .as_str()
                .is_some_and(|n| n.starts_with("P4D-8"))
            {
                assert!(valid(&case), "{}: module-api accepts it", name(&case));
                assert_eq!(
                    got,
                    Err(API_DELEGATION),
                    "{}: the port refuses it",
                    name(&case)
                );
                divergent.push(name(&case));
                continue;
            }
            assert_eq!(got.is_ok(), valid(&case), "api-delegation {}", name(&case));
            if !valid(&case) {
                assert_eq!(
                    (case["error"].as_str(), case["reason"].as_str()),
                    (Some(API_DELEGATION.code), API_DELEGATION.reason)
                );
            }
        }
        assert_eq!(divergent.len(), 3, "the P4D-8 cases: {divergent:?}");

        for case in cases("engine-delegation") {
            let params: Value =
                serde_json::from_str(&subst(case["paramsJson"].as_str().unwrap())).unwrap();
            let file = match case["engineFile"].as_str().unwrap() {
                "fresh" => Some(Secret::new(engine.clone())),
                "upper" => Some(Secret::new(engine.to_uppercase())),
                "malformed" => Some(Secret::new("short".to_owned())),
                _ => None,
            };
            let got = verify_engine(params.as_object().unwrap(), file.as_ref());
            assert_eq!(
                got.is_ok(),
                valid(&case),
                "engine-delegation {}",
                name(&case)
            );
            if let Err(refusal) = got {
                assert_eq!(
                    (Some(refusal.code), refusal.reason),
                    (case["error"].as_str(), case["reason"].as_str())
                );
            }
        }

        for case in cases("adoption-nonce") {
            let file = case["file"].as_str().map(|f| Secret::new(subst(f)));
            let nonce = subst(case["nonce"].as_str().unwrap());
            assert_eq!(
                adoption_nonce_matches(file.as_ref(), &nonce),
                valid(&case),
                "adoption-nonce {}",
                name(&case)
            );
        }
    }

    #[test]
    fn the_adoption_nonce_is_the_supervisor_token_case_insensitively() {
        let token = Secret::fresh().unwrap();
        assert!(adoption_nonce_matches(Some(&token), token.expose()));
        assert!(adoption_nonce_matches(
            Some(&token),
            &token.expose().to_uppercase()
        ));
        assert!(!adoption_nonce_matches(
            Some(&token),
            Secret::fresh().unwrap().expose()
        ));
        assert!(!adoption_nonce_matches(None, token.expose()));
        assert!(!adoption_nonce_matches(
            Some(&Secret::new("short".into())),
            "short"
        ));
    }
}
