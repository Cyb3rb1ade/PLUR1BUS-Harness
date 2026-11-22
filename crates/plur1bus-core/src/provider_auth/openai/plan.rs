//! `openai-auth/plan.ts`: "Sign in with ChatGPT" for the plan route (D110). Dynamic client registration on the first
//! authorize, OIDC with a nonce, PKCE (S256), a `state` compared in constant time, the scope gate `chatgpt.tokens.use.direct`,
//! and a rotating, single-use refresh token: it is marked spent durably *before* the exchange, so neither a crash nor an
//! unknown network outcome can present it twice; an answer that repeats it is refused. Every durable change of one account
//! runs under [`SerialOwner`]; the audit line comes before the record is stored.
//!
//! The stored registration is JSON in TypeScript's member order (`clientId, sub, workspace, accessToken, refreshToken,
//! expiresAt, refreshExpiresAt, scope`, then `refreshConsumed`), and its `expiresAt` is moved up to 15 s early at random so
//! that many installations do not refresh at the same instant.
use super::super::http::Form;
use super::super::ports::{base64url, js_number, Clock, RandomBytes, RandomUnit};
use super::super::record::SecretStore;
use super::super::secret::Secret;
use super::identity::{discovery, HostIdentity, JwksVerifier};
use super::ports::{
    call, fail, object, positive, text, AuditPort, HttpPort, HttpRequest, OpenAIError, PkcePort,
    SerialOwner,
};
use super::profiles::{require_owner, PlanPrincipal, RESOURCE, SCOPES, SCOPE_GATE};
use super::wire::guard_siwc;
use crate::js::json_stringify;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// The registration entry client id of the first authorize.
pub const ENTRY_CLIENT: &str = "dynamic_agent_client";

/// A stored registration.
#[derive(Clone, PartialEq)]
pub struct Registration {
    /// The issued client id (`oaiapp_…`).
    pub client_id: String,
    /// The account.
    pub sub: String,
    /// The workspace.
    pub workspace: String,
    /// The access token.
    pub access_token: Secret,
    /// The refresh token.
    pub refresh_token: Secret,
    /// When the access token expires (as stored: with the jitter).
    pub expires_at: f64,
    /// When the refresh token expires.
    pub refresh_expires_at: f64,
    /// The granted scope.
    pub scope: String,
    /// The refresh token was spent (or moved away).
    pub refresh_consumed: Option<Value>,
}

impl std::fmt::Debug for Registration {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Registration")
            .field("workspace", &self.workspace)
            .field("token", &"[redacted]")
            .finish()
    }
}

impl Registration {
    /// `JSON.stringify(record)` in TypeScript's member order.
    pub fn encode(&self) -> Secret {
        let mut s = format!(
            "{{\"clientId\":{},\"sub\":{},\"workspace\":{},\"accessToken\":{},\"refreshToken\":{},\"expiresAt\":{},\"refreshExpiresAt\":{},\"scope\":{}",
            json_stringify(&self.client_id),
            json_stringify(&self.sub),
            json_stringify(&self.workspace),
            json_stringify(self.access_token.expose()),
            json_stringify(self.refresh_token.expose()),
            js_number(self.expires_at),
            js_number(self.refresh_expires_at),
            json_stringify(&self.scope)
        );
        if let Some(c) = &self.refresh_consumed {
            s.push_str(",\"refreshConsumed\":");
            s.push_str(&super::super::record::js_json(c));
        }
        s.push('}');
        Secret::new(s)
    }

    fn consumed(&self) -> bool {
        self.refresh_consumed
            .as_ref()
            .is_some_and(super::super::record::truthy)
    }

    fn has_scope(&self) -> bool {
        self.scope.split(' ').any(|s| s == SCOPE_GATE)
    }
}

/// `tokens(raw, now)`: the token answer of the plan route.
fn tokens(
    t: &serde_json::Map<String, Value>,
    now: f64,
) -> Result<(Secret, Secret, f64, f64, String), OpenAIError> {
    match t.get("token_type") {
        Some(Value::String(tt)) if crate::js::to_lower_case(tt) == "bearer" => {}
        _ => return fail("endpoint-rejected"),
    }
    let scope = text(t.get("scope"))?;
    if !scope.split(' ').any(|s| s == SCOPE_GATE) {
        return fail("scope-denied");
    }
    let access = Secret::new(text(t.get("access_token"))?);
    let refresh = Secret::new(text(t.get("refresh_token"))?);
    let expires_at = now + positive(t.get("expires_in"))? * 1000.0;
    let refresh_in = match t.get("refresh_expires_in") {
        None => 30.0 * 86_400.0,
        v => positive(v)?,
    };
    Ok((
        access,
        refresh,
        expires_at,
        now + refresh_in * 1000.0,
        scope,
    ))
}

/// What a plan is built from (`PlanPorts`).
pub struct PlanPorts<'a> {
    /// The secret store.
    pub store: &'a dyn SecretStore,
    /// The serialising owner.
    pub owner: &'a SerialOwner,
    /// The HTTP port.
    pub http: &'a dyn HttpPort,
    /// The clock.
    pub clock: &'a dyn Clock,
    /// The host identity.
    pub host: &'a HostIdentity<'a>,
    /// The ID token verifier.
    pub verifier: &'a JwksVerifier<'a>,
    /// The audit port.
    pub audit: &'a dyn AuditPort,
    /// `state`, nonce and verifier.
    pub random_bytes: &'a dyn RandomBytes,
    /// The expiry jitter (`Math.random`).
    pub random: &'a dyn RandomUnit,
    /// The login deadline, 10 minutes by default.
    pub timeout_ms: Option<f64>,
    /// The refresh skew, 120 s by default.
    pub refresh_skew_ms: Option<f64>,
}

/// `ChatGPTPlan`: owns no background process.
pub struct ChatGPTPlan<'a> {
    p: PlanPorts<'a>,
}

fn random_text(r: &dyn RandomBytes) -> Result<Secret, OpenAIError> {
    let mut b = [0u8; 32];
    if !r.fill(&mut b) {
        return fail("transport-failed");
    }
    Ok(Secret::new(base64url(&b)))
}

fn query_all(u: &url::Url, key: &str) -> Vec<String> {
    u.query_pairs()
        .filter(|(k, _)| k == key)
        .map(|(_, v)| v.into_owned())
        .collect()
}

impl<'a> ChatGPTPlan<'a> {
    /// `new ChatGPTPlan(ports)`.
    pub fn new(p: PlanPorts<'a>) -> ChatGPTPlan<'a> {
        ChatGPTPlan { p }
    }

    /// `accountRef(account)`.
    pub fn account_ref(&self, account: &str) -> Result<String, OpenAIError> {
        let ok = (1..=80).contains(&account.len())
            && account
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c));
        if !ok {
            return fail("invalid-request");
        }
        Ok(format!("openai.plan.{account}"))
    }

    fn jitter(&self) -> f64 {
        (self.p.random.next() * 15_000.0).floor()
    }

    /// `#load(ref)`: a record that does not read is refused; the registration entry client is never a stored client.
    fn load(&self, r: &str) -> Result<Option<Registration>, OpenAIError> {
        let raw = self
            .p
            .store
            .get(r)
            .map_err(|_| OpenAIError::new("transport-failed"))?;
        let Some(raw) = raw else { return Ok(None) };
        let v: Value =
            serde_json::from_str(raw.expose()).map_err(|_| OpenAIError::new("transport-failed"))?;
        let o = object(&v)?;
        let mut t = Vec::new();
        for k in [
            "clientId",
            "sub",
            "workspace",
            "accessToken",
            "refreshToken",
            "scope",
        ] {
            t.push(text(o.get(k))?);
        }
        if t[0] == ENTRY_CLIENT {
            return fail("auth-required");
        }
        let expires_at = positive(o.get("expiresAt"))?;
        let refresh_expires_at = positive(o.get("refreshExpiresAt"))?;
        Ok(Some(Registration {
            client_id: t[0].clone(),
            sub: t[1].clone(),
            workspace: t[2].clone(),
            access_token: Secret::new(t[3].clone()),
            refresh_token: Secret::new(t[4].clone()),
            expires_at,
            refresh_expires_at,
            scope: t[5].clone(),
            refresh_consumed: o.get("refreshConsumed").cloned(),
        }))
    }

    fn audit(&self, kind: &str) -> Result<(), OpenAIError> {
        self.p
            .audit
            .audit(&json!({ "kind": kind }))
            .map_err(|_| OpenAIError::new("transport-failed"))
    }

    /// `login(account, principal)` through `pkce`: `{ profileId, expiresAt }` (the expiry before the stored jitter).
    pub fn login(
        &self,
        account: &str,
        principal: &PlanPrincipal,
        pkce: &mut dyn PkcePort,
    ) -> Result<(String, f64), OpenAIError> {
        require_owner(principal)?;
        let r = self.account_ref(account)?;
        self.p.owner.exclusive(&r, || {
            let old = self.load(&r)?;
            let d = discovery(self.p.http)?;
            let state = random_text(self.p.random_bytes)?;
            let nonce = random_text(self.p.random_bytes)?;
            let verifier = random_text(self.p.random_bytes)?;
            let host = self.p.host.id()?;
            // The PKCE port opens the listener before the browser URL is built; only the port varies.
            let redirect = pkce.redirect()?;
            let result = self.finish_login(
                &r,
                old.as_ref(),
                &d,
                &state,
                &nonce,
                &verifier,
                &host,
                &redirect,
                pkce,
            );
            pkce.close();
            result
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn finish_login(
        &self,
        r: &str,
        old: Option<&Registration>,
        d: &super::identity::Discovery,
        state: &Secret,
        nonce: &Secret,
        verifier: &Secret,
        host: &str,
        redirect: &str,
        pkce: &mut dyn PkcePort,
    ) -> Result<(String, f64), OpenAIError> {
        let target = url::Url::parse(redirect).map_err(|_| OpenAIError::new("invalid-request"))?;
        if target.scheme() != "http"
            || target.host_str() != Some("127.0.0.1")
            || target.path() != "/auth/callback"
            || target.port().is_none()
            || !target.username().is_empty()
            || target.password().is_some_and(|p| !p.is_empty())
            || target.query().is_some_and(|q| !q.is_empty())
            || target.fragment().is_some_and(|f| !f.is_empty())
        {
            return fail("invalid-request");
        }
        let mut u = url::Url::parse(&d.authorization_endpoint)
            .map_err(|_| OpenAIError::new("transport-failed"))?;
        let client = old.map_or(ENTRY_CLIENT.to_owned(), |o| o.client_id.clone());
        let challenge = base64url(&Sha256::digest(verifier.expose().as_bytes()));
        let mut params: Vec<(&str, String)> = vec![("client_id", client)];
        if old.is_none() {
            params.push(("agent_name_hint", "PLUR1BUS".to_owned()));
        }
        params.extend([
            ("ext_agent_host_id", host.to_owned()),
            ("response_type", "code".to_owned()),
            ("redirect_uri", redirect.to_owned()),
            ("scope", SCOPES.join(" ")),
            ("resource", RESOURCE.to_owned()),
            ("code_challenge_method", "S256".to_owned()),
            ("code_challenge", challenge),
            ("state", state.expose().to_owned()),
            ("nonce", nonce.expose().to_owned()),
        ]);
        let mut pairs: Vec<(String, String)> = u
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        for (k, v) in params {
            match pairs.iter().position(|(x, _)| x == k) {
                Some(i) => {
                    pairs[i].1 = v;
                    let mut n = 0;
                    pairs.retain(|(x, _)| {
                        n += 1;
                        n - 1 == i || x != k
                    });
                }
                None => pairs.push((k.to_owned(), v)),
            }
        }
        let mut ser = url::form_urlencoded::Serializer::new(String::new());
        for (k, v) in &pairs {
            ser.append_pair(k, v);
        }
        u.set_query(Some(&ser.finish()));
        let deadline = self.p.clock.now() + self.p.timeout_ms.unwrap_or(600_000.0);
        let callback = pkce.authorize(&Secret::new(u.as_str()), redirect, deadline)?;
        // Release the listener before the token exchange.
        pkce.close();
        let cb =
            url::Url::parse(callback.expose()).map_err(|_| OpenAIError::new("transport-failed"))?;
        let states = query_all(&cb, "state");
        let actual = states.first().map_or("", String::as_str);
        if cb.origin() != target.origin()
            || cb.path() != target.path()
            || cb.fragment().is_some_and(|f| !f.is_empty())
            || !cb.username().is_empty()
            || cb.password().is_some_and(|p| !p.is_empty())
            || states.len() != 1
            || !state.matches(actual)
        {
            return fail("state-mismatch");
        }
        let errors = query_all(&cb, "error");
        if errors.first().map(String::as_str) == Some("access_denied") {
            return fail("access-denied");
        }
        let codes = query_all(&cb, "code");
        let clients = query_all(&cb, "client_id");
        if !errors.is_empty() || codes.len() != 1 || clients.len() > 1 {
            return fail("auth-required");
        }
        let issued = match clients.first() {
            Some(c) => text(Some(&Value::String(c.clone())))?,
            None => text(old.map(|o| Value::String(o.client_id.clone())).as_ref())?,
        };
        let issued_ok = issued.len() > 7
            && issued.starts_with("oaiapp_")
            && issued[7..]
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-');
        if !issued_ok || old.is_some_and(|o| o.client_id != issued) {
            return fail("auth-required");
        }
        let form: Form = vec![
            ("grant_type".into(), Secret::new("authorization_code")),
            ("client_id".into(), Secret::new(issued.clone())),
            (
                "code".into(),
                Secret::new(text(Some(&Value::String(codes[0].clone())))?),
            ),
            ("code_verifier".into(), verifier.clone()),
            ("redirect_uri".into(), Secret::new(redirect)),
            ("resource".into(), Secret::new(RESOURCE)),
        ];
        let raw = call(
            self.p.http,
            &HttpRequest::form(d.token_endpoint.clone(), form),
        )?;
        let raw = object(&raw)?.clone();
        let id_token = Secret::new(text(raw.get("id_token"))?);
        let identity = self.p.verifier.validate(&id_token, d, &issued, nonce)?;
        if old.is_some_and(|o| o.sub != identity.sub || o.workspace != identity.workspace) {
            return fail("owner-only");
        }
        let (access, refresh, expires_at, refresh_expires_at, scope) =
            tokens(&raw, self.p.clock.now())?;
        // Fail closed before persistence.
        self.audit("login")?;
        let record = Registration {
            client_id: issued,
            sub: identity.sub,
            workspace: identity.workspace,
            access_token: access,
            refresh_token: refresh,
            expires_at: expires_at - self.jitter(),
            refresh_expires_at,
            scope,
            refresh_consumed: None,
        };
        self.p
            .store
            .set(r, &record.encode())
            .map_err(|_| OpenAIError::new("transport-failed"))?;
        Ok(("openai:chatgpt-plan".to_owned(), expires_at))
    }

    /// `lease(account, principal)`: the access token, refreshed when it is within the skew.
    pub fn lease(&self, account: &str, principal: &PlanPrincipal) -> Result<Secret, OpenAIError> {
        require_owner(principal)?;
        let r = self.account_ref(account)?;
        self.p.owner.exclusive(&r, || {
            let rec = self.load(&r)?;
            let now = self.p.clock.now();
            let Some(rec) = rec.filter(|x| !x.consumed() && x.refresh_expires_at > now) else {
                return fail("auth-required");
            };
            if !rec.has_scope() {
                return fail("scope-denied");
            }
            if rec.expires_at - self.p.refresh_skew_ms.unwrap_or(120_000.0) > now {
                return Ok(rec.access_token);
            }
            let d = discovery(self.p.http)?;
            // Mark spent durably BEFORE the exchange: a crash or an unknown network outcome cannot reuse the old token.
            let mut spent = rec.clone();
            spent.refresh_consumed = Some(Value::Bool(true));
            self.p
                .store
                .set(&r, &spent.encode())
                .map_err(|_| OpenAIError::new("transport-failed"))?;
            let exchange = || -> Result<Secret, OpenAIError> {
                let form: Form = vec![
                    ("grant_type".into(), Secret::new("refresh_token")),
                    ("client_id".into(), Secret::new(rec.client_id.clone())),
                    ("refresh_token".into(), rec.refresh_token.clone()),
                    ("resource".into(), Secret::new(RESOURCE)),
                ];
                let raw = call(
                    self.p.http,
                    &HttpRequest::form(d.token_endpoint.clone(), form),
                )?;
                let mut raw = object(&raw)?.clone();
                if !raw.contains_key("scope") || raw.get("scope").is_some_and(Value::is_null) {
                    raw.insert("scope".into(), Value::String(rec.scope.clone()));
                }
                let (access, refresh, expires_at, refresh_expires_at, scope) =
                    tokens(&raw, self.p.clock.now())?;
                if refresh.expose() == rec.refresh_token.expose() {
                    return fail("auth-required");
                }
                self.audit("refresh")?;
                let next = Registration {
                    client_id: rec.client_id.clone(),
                    sub: rec.sub.clone(),
                    workspace: rec.workspace.clone(),
                    access_token: access.clone(),
                    refresh_token: refresh,
                    expires_at: expires_at - self.jitter(),
                    refresh_expires_at,
                    scope,
                    refresh_consumed: None,
                };
                self.p
                    .store
                    .set(&r, &next.encode())
                    .map_err(|_| OpenAIError::new("transport-failed"))?;
                Ok(access)
            };
            exchange().map_err(|_| {
                let _ = self.audit("refresh_failed");
                OpenAIError::new("auth-required")
            })
        })
    }

    /// `metadata(account)`: `{ workspace, expiresAt, needsLogin }`, or `None` without a record.
    pub fn metadata(&self, account: &str) -> Result<Option<(String, f64, bool)>, OpenAIError> {
        let r = self.account_ref(account)?;
        Ok(self.load(&r)?.map(|x| {
            let needs = x.consumed() || x.refresh_expires_at <= self.p.clock.now();
            (x.workspace, x.expires_at, needs)
        }))
    }

    /// `models(account, principal)`.
    pub fn models(
        &self,
        account: &str,
        principal: &PlanPrincipal,
    ) -> Result<Vec<String>, OpenAIError> {
        let token = self.lease(account, principal)?;
        let mut req = HttpRequest::get(format!("{RESOURCE}/models"));
        req.authorization = Some(token);
        let body = call(self.p.http, &req)?;
        let Some(list) = object(&body)?.get("data").and_then(Value::as_array) else {
            return fail("endpoint-rejected");
        };
        list.iter().map(|v| text(object(v)?.get("id"))).collect()
    }

    /// `responses(account, principal, request)`: the guarded request, the raw answer (held as a secret payload).
    pub fn responses(
        &self,
        account: &str,
        principal: &PlanPrincipal,
        request: &Value,
    ) -> Result<Value, OpenAIError> {
        let json = guard_siwc(request)?;
        let token = self.lease(account, principal)?;
        let req = HttpRequest {
            method: "POST",
            url: format!("{RESOURCE}/responses"),
            authorization: Some(token),
            form: None,
            json: Some(json),
        };
        call(self.p.http, &req)
    }

    /// `logout(account)`: revoke when possible; the local record and the audit line happen whatever the network says.
    pub fn logout(&self, account: &str) -> Result<(), OpenAIError> {
        let r = self.account_ref(account)?;
        self.p.owner.exclusive(&r, || {
            let revoke = || -> Result<(), OpenAIError> {
                if let Some(rec) = self.load(&r)? {
                    let d = discovery(self.p.http)?;
                    let form: Form = vec![
                        ("token".into(), rec.refresh_token.clone()),
                        ("client_id".into(), Secret::new(rec.client_id.clone())),
                        ("token_type_hint".into(), Secret::new("refresh_token")),
                    ];
                    call(self.p.http, &HttpRequest::form(d.revocation_endpoint, form))?;
                }
                Ok(())
            };
            // `try { revoke } finally { delete; audit }`: a failure in the `finally` part replaces the revoke's outcome.
            let result = revoke();
            self.p
                .store
                .delete(&r)
                .map_err(|_| OpenAIError::new("transport-failed"))?;
            self.audit("logout")?;
            result
        })
    }

    /// `transfer(account, destination, principal)`: move, never copy, the rotating credential to the person's other machine.
    pub fn transfer(
        &self,
        account: &str,
        destination: &dyn Fn(&Secret) -> Result<(), OpenAIError>,
        principal: &PlanPrincipal,
    ) -> Result<(), OpenAIError> {
        require_owner(principal)?;
        let r = self.account_ref(account)?;
        self.p.owner.exclusive(&r, || {
            let Some(rec) = self.load(&r)?.filter(|x| !x.consumed()) else {
                return fail("auth-required");
            };
            let mut spent = rec.clone();
            spent.refresh_consumed = Some(Value::Bool(true));
            self.p
                .store
                .set(&r, &spent.encode())
                .map_err(|_| OpenAIError::new("transport-failed"))?;
            destination(&rec.encode()).map_err(|_| OpenAIError::new("transport-failed"))?;
            self.p
                .store
                .delete(&r)
                .map_err(|_| OpenAIError::new("transport-failed"))
        })
    }
}
