//! `openai-auth/service.ts`: the trusted in-process API of the plan logins. The principal comes from the authenticated
//! surface, never from agent input. A credential is listed, leased, used and removed only by the person it belongs to; the
//! index of credentials (`openai.credentials.index` in the secret store) is changed under its own serialising key.
//!
//! TypeScript splits a login into `startLogin` (returns the authorize URL while the login runs on) and `awaitLogin`; that
//! split is promise plumbing. Here [`AuthService::login`] runs the whole login through the PKCE port, which is what shows
//! the URL, and [`PendingLogins`] keeps the bookkeeping of the split (at most 16 live and 64 kept logins, finished ones
//! evicted first, a login visible only to its person) for the flip that builds the asynchronous surface on it.
use super::super::ports::{Clock, RandomBytes, RandomUnit};
use super::super::record::SecretStore;
use super::super::secret::Secret;
use super::identity::{HostIdentity, JwksVerifier};
use super::plan::{ChatGPTPlan, PlanPorts};
use super::ports::{fail, AuditPort, HttpPort, OpenAIError, PkcePort, SerialOwner};
use super::profiles::{require_owner, PlanPrincipal};
use crate::js::json_stringify;
use serde_json::Value;
use sha2::{Digest, Sha256};

const INDEX: &str = "openai.credentials.index";

/// `CredentialInfo`.
#[derive(Clone, Debug, PartialEq)]
pub struct CredentialInfo {
    /// 64 hex characters.
    pub id: String,
    /// The person.
    pub person: String,
    /// The workspace.
    pub workspace: String,
    /// When the access token expires.
    pub expires_at: Option<f64>,
    /// A new login is needed.
    pub needs_login: bool,
}

impl CredentialInfo {
    fn encode(&self) -> String {
        let expires = self
            .expires_at
            .map_or_else(|| "null".to_owned(), super::super::ports::js_number);
        format!(
            "{{\"id\":{},\"person\":{},\"workspace\":{},\"kind\":\"oauth_pkce\",\"billingPath\":\"plan\",\"expiresAt\":{expires},\"needsLogin\":{}}}",
            json_stringify(&self.id),
            json_stringify(&self.person),
            json_stringify(&self.workspace),
            self.needs_login
        )
    }
}

/// What the service is built from (`AuthServiceOptions`).
pub struct AuthServiceOptions<'a> {
    /// The secret store.
    pub store: &'a dyn SecretStore,
    /// The serialising owner.
    pub owner: &'a SerialOwner,
    /// The HTTP port.
    pub http: &'a dyn HttpPort,
    /// The clock.
    pub clock: &'a dyn Clock,
    /// The audit port.
    pub audit: &'a dyn AuditPort,
    /// The installation's host identity (one per service).
    pub host: &'a HostIdentity<'a>,
    /// `state`, nonce and verifier.
    pub random_bytes: &'a dyn RandomBytes,
    /// The expiry jitter.
    pub random: &'a dyn RandomUnit,
    /// `crypto.randomUUID` (a credential id and a login id per login).
    pub uuid: &'a dyn Fn() -> String,
    /// The login deadline.
    pub timeout_ms: Option<f64>,
    /// The refresh skew.
    pub refresh_skew_ms: Option<f64>,
}

/// `AuthService`. Like TypeScript's `#plan()`, every operation works on a plan of its own (with its own ID-token verifier and
/// key cache) over the shared store, owner and host identity.
pub struct AuthService<'a> {
    o: AuthServiceOptions<'a>,
}

fn hex64(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

impl<'a> AuthService<'a> {
    /// `new AuthService(options)`.
    pub fn new(o: AuthServiceOptions<'a>) -> AuthService<'a> {
        AuthService { o }
    }

    /// `#plan()`: a plan with a fresh verifier.
    fn with_plan<T>(&self, f: impl FnOnce(&ChatGPTPlan<'_>) -> T) -> T {
        let verifier = JwksVerifier::new(self.o.http, self.o.clock);
        let plan = ChatGPTPlan::new(PlanPorts {
            store: self.o.store,
            owner: self.o.owner,
            http: self.o.http,
            clock: self.o.clock,
            host: self.o.host,
            verifier: &verifier,
            audit: self.o.audit,
            random_bytes: self.o.random_bytes,
            random: self.o.random,
            timeout_ms: self.o.timeout_ms,
            refresh_skew_ms: self.o.refresh_skew_ms,
        });
        f(&plan)
    }

    /// `#index()`: a malformed index is `persist-failed`, never an empty list.
    fn index(&self) -> Result<Vec<CredentialInfo>, OpenAIError> {
        let persist = || OpenAIError::new("persist-failed");
        let Some(raw) = self.o.store.get(INDEX).map_err(|_| persist())? else {
            return Ok(Vec::new());
        };
        if raw.is_empty() {
            return Ok(Vec::new());
        }
        let rows: Value = serde_json::from_str(raw.expose()).map_err(|_| persist())?;
        let rows = rows.as_array().ok_or_else(persist)?;
        rows.iter()
            .map(|r| {
                let id = r
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|i| hex64(i))
                    .ok_or_else(persist)?;
                let person = r
                    .get("person")
                    .and_then(Value::as_str)
                    .ok_or_else(persist)?;
                let workspace = r
                    .get("workspace")
                    .and_then(Value::as_str)
                    .ok_or_else(persist)?;
                Ok(CredentialInfo {
                    id: id.to_owned(),
                    person: person.to_owned(),
                    workspace: workspace.to_owned(),
                    expires_at: r.get("expiresAt").and_then(Value::as_f64),
                    needs_login: r
                        .get("needsLogin")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                })
            })
            .collect()
    }

    fn write_index(&self, rows: &[CredentialInfo]) -> Result<(), OpenAIError> {
        let text = format!(
            "[{}]",
            rows.iter()
                .map(CredentialInfo::encode)
                .collect::<Vec<_>>()
                .join(",")
        );
        self.o
            .store
            .set(INDEX, &Secret::new(text))
            .map_err(|_| OpenAIError::new("persist-failed"))
    }

    fn save(&self, info: &CredentialInfo) -> Result<(), OpenAIError> {
        self.o.owner.exclusive(INDEX, || {
            let mut rows: Vec<CredentialInfo> = self
                .index()?
                .into_iter()
                .filter(|r| r.id != info.id)
                .collect();
            rows.push(info.clone());
            self.write_index(&rows)
        })
    }

    fn owned(&self, id: &str, p: &PlanPrincipal) -> Result<CredentialInfo, OpenAIError> {
        require_owner(p)?;
        self.index()?
            .into_iter()
            .find(|r| r.id == id && r.person == p.user)
            .ok_or_else(|| OpenAIError::new("auth-required"))
    }

    /// A new credential id: `sha256(user + ":" + randomUUID())` in hex.
    fn new_id(&self, user: &str) -> String {
        let uuid = (self.o.uuid)();
        Sha256::digest(format!("{user}:{uuid}").as_bytes())
            .iter()
            .map(|x| format!("{x:02x}"))
            .collect()
    }

    /// `startLogin` + `awaitLogin`: a login for `principal` (a new credential, or `credential_id` again) through `pkce`. The
    /// login id is drawn as `startLogin` draws it, for the flip's [`PendingLogins`].
    pub fn login(
        &self,
        principal: &PlanPrincipal,
        credential_id: Option<&str>,
        pkce: &mut dyn PkcePort,
    ) -> Result<CredentialInfo, OpenAIError> {
        require_owner(principal)?;
        let id = match credential_id {
            Some(id) => id.to_owned(),
            None => self.new_id(&principal.user),
        };
        if credential_id.is_some() {
            self.owned(&id, principal)?;
        }
        let _login_id = (self.o.uuid)();
        self.with_plan(|p| p.login(&id, principal, pkce))?;
        let Some((workspace, expires_at, _)) = self.with_plan(|p| p.metadata(&id))? else {
            return fail("persist-failed");
        };
        let info = CredentialInfo {
            id: id.clone(),
            person: principal.user.clone(),
            workspace,
            expires_at: Some(expires_at),
            needs_login: false,
        };
        if self.save(&info).is_err() {
            let _ = self.with_plan(|p| p.logout(&id));
            return fail("persist-failed");
        }
        Ok(info)
    }

    /// `listCredentials(principal)`: the person's own, with fresh metadata.
    pub fn list_credentials(
        &self,
        principal: &PlanPrincipal,
    ) -> Result<Vec<CredentialInfo>, OpenAIError> {
        require_owner(principal)?;
        let mut out = Vec::new();
        for info in self
            .index()
            .map_err(|_| OpenAIError::new("persist-failed"))?
        {
            if info.person != principal.user {
                continue;
            }
            if let Some((workspace, expires_at, needs)) =
                self.with_plan(|p| p.metadata(&info.id))?
            {
                out.push(CredentialInfo {
                    workspace,
                    expires_at: Some(expires_at),
                    needs_login: needs,
                    ..info
                });
            }
        }
        Ok(out)
    }

    /// `lease(id, principal)`.
    pub fn lease(&self, id: &str, principal: &PlanPrincipal) -> Result<Secret, OpenAIError> {
        self.owned(id, principal)?;
        self.with_plan(|p| p.lease(id, principal))
    }

    /// `models(id, principal)`.
    pub fn models(&self, id: &str, principal: &PlanPrincipal) -> Result<Vec<String>, OpenAIError> {
        self.owned(id, principal)?;
        self.with_plan(|p| p.models(id, principal))
    }

    /// `logout(id, principal)`: the index entry goes whatever the revocation says.
    pub fn logout(&self, id: &str, principal: &PlanPrincipal) -> Result<(), OpenAIError> {
        self.owned(id, principal)?;
        let result = self.with_plan(|p| p.logout(id));
        self.o.owner.exclusive(INDEX, || {
            let rows: Vec<CredentialInfo> =
                self.index()?.into_iter().filter(|r| r.id != id).collect();
            self.write_index(&rows)
        })?;
        result
    }
}

/// The bookkeeping of `startLogin`/`awaitLogin`/`cancelLogin`.
#[derive(Debug, Default)]
pub struct PendingLogins {
    entries: Vec<(String, String, bool)>,
}

impl PendingLogins {
    /// Registers a login of `person`; finished ones are evicted first once 16 are kept; at most 16 live and 64 kept.
    pub fn start(&mut self, login_id: &str, person: &str) -> Result<(), OpenAIError> {
        // `for (const [key, a] of pending) if (a.settled && pending.size >= 16) pending.delete(key)`: oldest first.
        let mut size = self.entries.len();
        self.entries.retain(|e| {
            if e.2 && size >= 16 {
                size -= 1;
                false
            } else {
                true
            }
        });
        if self.entries.iter().filter(|e| !e.2).count() >= 16 || self.entries.len() >= 64 {
            return fail("invalid-request");
        }
        self.entries
            .push((login_id.to_owned(), person.to_owned(), false));
        Ok(())
    }

    /// The login finished (either way).
    pub fn settle(&mut self, login_id: &str) {
        if let Some(e) = self.entries.iter_mut().find(|e| e.0 == login_id) {
            e.2 = true;
        }
    }

    /// `awaitLogin`/`cancelLogin`: only the person who started it may touch it.
    pub fn take(&mut self, login_id: &str, person: &str) -> Result<(), OpenAIError> {
        match self
            .entries
            .iter()
            .position(|e| e.0 == login_id && e.1 == person)
        {
            Some(i) => {
                self.entries.remove(i);
                Ok(())
            }
            None => fail("owner-only"),
        }
    }

    /// `status(principal).pendingLogins`.
    pub fn count(&self, person: &str) -> usize {
        self.entries.iter().filter(|e| e.1 == person).count()
    }
}
