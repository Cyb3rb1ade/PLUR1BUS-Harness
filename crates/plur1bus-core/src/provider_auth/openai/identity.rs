//! `openai-auth/identity.ts`: the installation's host identity (an Ed25519 key in the secret store, named by its RFC 7638
//! thumbprint as an RFC 9278 URN), OIDC discovery of the issuer, and local verification of an ID token against the issuer's
//! JWKS. A signature is verified here, with `ring`, never trusted from decoded claims or a remote answer: RS256 over the
//! JWK's modulus and exponent, EdDSA over its Ed25519 point. Every refusal of a token is the one code `id-token-invalid`.
use super::super::ports::{base64url, Clock, RandomBytes};
use super::super::record::SecretStore;
use super::super::secret::Secret;
use super::ports::{call, fail, object, text, HttpPort, HttpRequest, OpenAIError, SerialOwner};
use crate::js::json_stringify;
use crate::policy::js_value::strict_eq;
use base64::Engine;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};

/// The issuer the plan route trusts.
pub const ISSUER: &str = "https://auth.openai.com";
/// Where its discovery document is.
pub const DISCOVERY_URL: &str = "https://auth.openai.com/.well-known/openid-configuration";
/// The secret store handle of the host key.
pub const HOST_KEY_REF: &str = "openai.host.key";

/// Node's lenient base64url read (`Buffer.from(s, "base64url")`) for the alphabet a JWT part may hold.
pub fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    let engine = base64::engine::GeneralPurpose::new(
        &base64::alphabet::URL_SAFE,
        base64::engine::GeneralPurposeConfig::new()
            .with_decode_allow_trailing_bits(true)
            .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent),
    );
    engine.decode(s).ok()
}

/// `HostIdentity`.
pub struct HostIdentity<'a> {
    store: &'a dyn SecretStore,
    owner: &'a SerialOwner,
    random: &'a dyn RandomBytes,
}

impl<'a> HostIdentity<'a> {
    /// `new HostIdentity(store, owner)`; the key is drawn from `random` the first time.
    pub fn new(
        store: &'a dyn SecretStore,
        owner: &'a SerialOwner,
        random: &'a dyn RandomBytes,
    ) -> HostIdentity<'a> {
        HostIdentity {
            store,
            owner,
            random,
        }
    }

    /// `id()`: `urn:ietf:params:oauth:jwk-thumbprint:sha-256:<thumbprint>`. A stored key that does not read is an error
    /// (`persist-failed`), never silently replaced.
    pub fn id(&self) -> Result<String, OpenAIError> {
        self.owner.exclusive("openai.host", || {
            let persist = || OpenAIError::new("persist-failed");
            let raw = match self.store.get(HOST_KEY_REF).map_err(|_| persist())? {
                Some(raw) => raw,
                None => {
                    let mut seed = [0u8; 32];
                    if !self.random.fill(&mut seed) {
                        return Err(persist());
                    }
                    let pair = ring::signature::Ed25519KeyPair::from_seed_unchecked(&seed)
                        .map_err(|_| persist())?;
                    use ring::signature::KeyPair;
                    let jwk = format!(
                        "{{\"crv\":\"Ed25519\",\"d\":{},\"x\":{},\"kty\":\"OKP\"}}",
                        json_stringify(&base64url(&seed)),
                        json_stringify(&base64url(pair.public_key().as_ref()))
                    );
                    let raw = Secret::new(jwk);
                    self.store.set(HOST_KEY_REF, &raw).map_err(|_| persist())?;
                    raw
                }
            };
            let jwk: Value = serde_json::from_str(raw.expose()).map_err(|_| persist())?;
            let (Some("OKP"), Some("Ed25519"), Some(d)) = (
                jwk.get("kty").and_then(Value::as_str),
                jwk.get("crv").and_then(Value::as_str),
                jwk.get("d").and_then(Value::as_str),
            ) else {
                return Err(persist());
            };
            let seed = b64url_decode(d)
                .filter(|s| s.len() == 32)
                .ok_or_else(persist)?;
            let pair = ring::signature::Ed25519KeyPair::from_seed_unchecked(&seed)
                .map_err(|_| persist())?;
            use ring::signature::KeyPair;
            let x = base64url(pair.public_key().as_ref());
            // RFC 7638: the required public members in lexicographic order; the private `d` is never hashed.
            let members = format!(
                "{{\"crv\":\"Ed25519\",\"kty\":\"OKP\",\"x\":{}}}",
                json_stringify(&x)
            );
            Ok(format!(
                "urn:ietf:params:oauth:jwk-thumbprint:sha-256:{}",
                base64url(&Sha256::digest(members.as_bytes()))
            ))
        })
    }
}

/// `Discovery`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Discovery {
    /// `issuer`
    pub issuer: String,
    /// `authorization_endpoint`
    pub authorization_endpoint: String,
    /// `token_endpoint`
    pub token_endpoint: String,
    /// `revocation_endpoint`
    pub revocation_endpoint: String,
    /// `jwks_uri`
    pub jwks_uri: String,
}

/// `discovery(http)`: the issuer must be the trusted one and every endpoint on its origin, without credentials, query or
/// fragment.
pub fn discovery(http: &dyn HttpPort) -> Result<Discovery, OpenAIError> {
    let body = call(http, &HttpRequest::get(DISCOVERY_URL))?;
    let data = object(&body)?;
    if data.get("issuer").and_then(Value::as_str) != Some(ISSUER) {
        return fail("discovery-invalid");
    }
    let mut out = Vec::new();
    for k in [
        "authorization_endpoint",
        "token_endpoint",
        "revocation_endpoint",
        "jwks_uri",
    ] {
        let t = text(data.get(k))?;
        let u = url::Url::parse(&t).map_err(|_| OpenAIError::new("transport-failed"))?;
        if u.origin().ascii_serialization() != ISSUER
            || !u.username().is_empty()
            || u.password().is_some_and(|p| !p.is_empty())
            || u.query().is_some_and(|q| !q.is_empty())
            || u.fragment().is_some_and(|f| !f.is_empty())
        {
            return fail("discovery-invalid");
        }
        out.push(t);
    }
    Ok(Discovery {
        issuer: ISSUER.to_owned(),
        authorization_endpoint: out[0].clone(),
        token_endpoint: out[1].clone(),
        revocation_endpoint: out[2].clone(),
        jwks_uri: out[3].clone(),
    })
}

/// The identity an ID token proves.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenIdentity {
    /// `sub`
    pub sub: String,
    /// The workspace (`workspace`, `workspace_id` or the plan's account id).
    pub workspace: String,
}

/// A cached key set and when it stops being fresh.
type CachedKeys = (f64, Vec<Map<String, Value>>);

/// `JwksVerifier`: the key set cached for five minutes per URL; concurrent fetches share one.
pub struct JwksVerifier<'a> {
    http: &'a dyn HttpPort,
    clock: &'a dyn Clock,
    cache: Mutex<HashMap<String, CachedKeys>>,
    fetch: Mutex<()>,
}

impl<'a> JwksVerifier<'a> {
    /// `new JwksVerifier(http, clock)`.
    pub fn new(http: &'a dyn HttpPort, clock: &'a dyn Clock) -> JwksVerifier<'a> {
        JwksVerifier {
            http,
            clock,
            cache: Mutex::new(HashMap::new()),
            fetch: Mutex::new(()),
        }
    }

    fn keys(&self, url: &str) -> Result<Vec<Map<String, Value>>, OpenAIError> {
        let cached = |s: &Self| {
            s.cache
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .get(url)
                .filter(|(until, _)| *until > s.clock.now())
                .map(|(_, k)| k.clone())
        };
        if let Some(k) = cached(self) {
            return Ok(k);
        }
        let _one = self.fetch.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(k) = cached(self) {
            return Ok(k);
        }
        let body = call(self.http, &HttpRequest::get(url))?;
        let data = object(&body)?;
        let Some(list) = data
            .get("keys")
            .and_then(Value::as_array)
            .filter(|l| l.len() <= 64)
        else {
            return fail("id-token-invalid");
        };
        let keys = list
            .iter()
            .map(|k| object(k).cloned())
            .collect::<Result<Vec<_>, _>>()?;
        self.cache
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(url.to_owned(), (self.clock.now() + 300_000.0, keys.clone()));
        Ok(keys)
    }

    /// `validate(token, { discovery, audience, nonce })`.
    pub fn validate(
        &self,
        token: &Secret,
        d: &Discovery,
        audience: &str,
        nonce: &Secret,
    ) -> Result<TokenIdentity, OpenAIError> {
        self.check(token.expose(), d, audience, nonce)
            .ok_or_else(|| OpenAIError::new("id-token-invalid"))
    }

    fn check(
        &self,
        token: &str,
        d: &Discovery,
        audience: &str,
        nonce: &Secret,
    ) -> Option<TokenIdentity> {
        if token.encode_utf16().count() > 32768 {
            return None;
        }
        let parts: Vec<&str> = token.split('.').collect();
        if parts.len() != 3
            || parts.iter().any(|p| {
                p.is_empty()
                    || !p
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
            })
        {
            return None;
        }
        let header: Value = serde_json::from_slice(&b64url_decode(parts[0])?).ok()?;
        let claims: Value = serde_json::from_slice(&b64url_decode(parts[1])?).ok()?;
        let (header, claims) = (header.as_object()?, claims.as_object()?);
        let alg = header
            .get("alg")
            .and_then(Value::as_str)
            .filter(|a| *a == "RS256" || *a == "EdDSA")?;
        let keys = self.keys(&d.jwks_uri).ok()?;
        let matches: Vec<&Map<String, Value>> = keys
            .iter()
            .filter(|k| {
                // `k.kid === header.kid`: absent equals absent, numbers compare as doubles (`1` is `1.0`), and an array or
                // object equals nothing, not even one of the same shape (review C, RC-2).
                strict_eq(k.get("kid"), header.get("kid"))
                    && k.get("alg")
                        .is_none_or(|a| !super::super::record::truthy(a) || a.as_str() == Some(alg))
                    && k.get("use").is_none_or(|u| {
                        !super::super::record::truthy(u) || u.as_str() == Some("sig")
                    })
            })
            .collect();
        let [jwk] = matches.as_slice() else {
            return None;
        };
        // `createPublicKey({ format: "jwk" })` reads a key with a member `d` (whatever its value) as a private key: it throws
        // unless the private members are complete, and an Ed25519 key's public half is then taken from `d`, not from `x`.
        // A published key set holds public keys; one carrying `d` is refused whatever the rest says (review C, RC-3; where
        // Node would still accept such a key, Rust is stricter: K4-D7).
        if jwk.contains_key("d") {
            return None;
        }
        let kty = jwk.get("kty").and_then(Value::as_str);
        let signed = format!("{}.{}", parts[0], parts[1]);
        let signature = b64url_decode(parts[2])?;
        let ok = match alg {
            "RS256" if kty == Some("RSA") => {
                let n = b64url_decode(jwk.get("n")?.as_str()?)?;
                let e = b64url_decode(jwk.get("e")?.as_str()?)?;
                ring::signature::RsaPublicKeyComponents { n: &n, e: &e }
                    .verify(
                        &ring::signature::RSA_PKCS1_2048_8192_SHA256,
                        signed.as_bytes(),
                        &signature,
                    )
                    .is_ok()
            }
            "EdDSA"
                if kty == Some("OKP")
                    && jwk.get("crv").and_then(Value::as_str) == Some("Ed25519") =>
            {
                let x = b64url_decode(jwk.get("x")?.as_str()?)?;
                // Through the shared verifier: the TypeScript side verifies with OpenSSL, which refuses keys and
                // signature halves of small order that `ring` alone would accept (review B, RB-1).
                crate::ed25519::verify(&x, signed.as_bytes(), &signature)
            }
            _ => false,
        };
        if !ok {
            return None;
        }
        let now_s = self.clock.now() / 1000.0;
        let aud_ok = match claims.get("aud") {
            Some(Value::String(a)) => a == audience,
            Some(Value::Array(a)) => {
                a.iter().any(|x| x.as_str() == Some(audience))
                    && (a.len() == 1 || claims.get("azp").and_then(Value::as_str) == Some(audience))
            }
            _ => false,
        };
        let exp_ok = claims
            .get("exp")
            .and_then(Value::as_f64)
            .is_some_and(|e| e.is_finite() && e > now_s);
        let nonce_ok = claims.get("nonce").and_then(Value::as_str) == Some(nonce.expose());
        if claims.get("iss").and_then(Value::as_str) != Some(d.issuer.as_str())
            || !aud_ok
            || !exp_ok
            || !nonce_ok
        {
            return None;
        }
        if let Some(nbf) = claims.get("nbf") {
            if !nbf.as_f64().is_some_and(|n| n <= now_s) {
                return None;
            }
        }
        // `claims.workspace ?? claims.workspace_id ?? object(claims[".../auth"]).chatgpt_account_id`: null counts as absent.
        let present = |k: &str| claims.get(k).filter(|v| !v.is_null());
        let workspace = match present("workspace").or_else(|| present("workspace_id")) {
            Some(w) => w.clone(),
            None => object(claims.get("https://api.openai.com/auth")?)
                .ok()?
                .get("chatgpt_account_id")
                .cloned()
                .unwrap_or(Value::Null),
        };
        Some(TokenIdentity {
            sub: text(claims.get("sub")).ok()?,
            workspace: text(Some(&workspace)).ok()?,
        })
    }
}
