//! `openai-auth/profiles.ts`: the D110 profiles as data, the owner rule of the plan route, regional endpoints, API-key expiry
//! warnings, cross-billing failover, the retired import route, and the never-list of foreign credential stores (D109): a path
//! that resolves into another client's store is refused before anything opens it.
use super::super::ports::Clock;
use super::super::ports::PortFailure;
use super::super::record::SecretStore;
use super::super::secret::Secret;
use super::ports::{fail, AuditPort, OpenAIError};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// `RESOURCE`.
pub const RESOURCE: &str = "https://api.openai.com/v1";
/// `SCOPES`.
pub const SCOPES: [&str; 6] = [
    "openid",
    "profile",
    "email",
    "offline_access",
    "resource.invoke",
    "chatgpt.tokens.use.direct",
];
/// The scope the plan route needs.
pub const SCOPE_GATE: &str = "chatgpt.tokens.use.direct";
/// `EU_NOTICE`.
pub const EU_NOTICE: &str =
    "EU residency requires your organisation's Modified Retention amendment.";
/// `UI_TEXT` (the vendor's UI guidelines).
pub const UI_TEXT: [(&str, &str); 6] = [
    ("button", "Continue with ChatGPT"),
    ("firstUse", "You're using your ChatGPT plan"),
    ("indicator", "Using ChatGPT plan"),
    ("manage", "Manage usage"),
    ("usageUrl", "https://chatgpt.com/settings/usage"),
    (
        "source",
        "https://developers.openai.com/siwc/ui-ux-guidelines",
    ),
];

/// `PlanPrincipal`: supplied by the authenticated surface, never by agent input.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlanPrincipal {
    /// The plan's owner.
    pub owner: String,
    /// The person acting.
    pub user: String,
    /// The owner of the agent acting.
    pub agent_owner: String,
    /// `local`, `self-hosted` or `hosted-multi-user`.
    pub deployment: String,
}

/// `requireOwner(p)`: a plan credential is used only by its owner, through the owner's agent, on a local or self-hosted core.
pub fn require_owner(p: &PlanPrincipal) -> Result<(), OpenAIError> {
    if p.owner.is_empty()
        || p.user != p.owner
        || p.agent_owner != p.owner
        || !matches!(p.deployment.as_str(), "local" | "self-hosted")
    {
        return fail("owner-only");
    }
    Ok(())
}

/// `endpoint(region)`.
pub fn endpoint(region: &str) -> Result<String, OpenAIError> {
    match region {
        "global" => Ok("https://api.openai.com/v1".to_owned()),
        "us" | "eu" => Ok(format!("https://{region}.api.openai.com/v1")),
        _ => fail("invalid-request"),
    }
}

/// `keyStatus(expiresAt, now)`: days left `<= 0` is `auth-required`, `<= 3` and `<= 14` warn.
pub fn key_status(expires_at: Option<f64>, now: f64) -> Result<&'static str, OpenAIError> {
    let Some(e) = expires_at else {
        return Ok("valid");
    };
    if !e.is_finite() {
        return fail("invalid-request");
    }
    let days = (e - now) / 86_400_000.0;
    Ok(if days <= 0.0 {
        "auth-required"
    } else if days <= 3.0 {
        "expires-3-days"
    } else if days <= 14.0 {
        "expires-14-days"
    } else {
        "valid"
    })
}

/// `ApiKeyCredential`: an expired key is refused before the store is touched.
pub struct ApiKeyCredential<'a> {
    store: &'a dyn SecretStore,
    clock: &'a dyn Clock,
    r: String,
    expires_at: Option<f64>,
}

impl<'a> ApiKeyCredential<'a> {
    /// `new ApiKeyCredential(store, clock, ref, expiresAt)`.
    pub fn new(
        store: &'a dyn SecretStore,
        clock: &'a dyn Clock,
        r: &str,
        expires_at: Option<f64>,
    ) -> ApiKeyCredential<'a> {
        ApiKeyCredential {
            store,
            clock,
            r: r.to_owned(),
            expires_at,
        }
    }

    /// `status()`.
    pub fn status(&self) -> Result<&'static str, OpenAIError> {
        key_status(self.expires_at, self.clock.now())
    }

    /// `lease()`.
    pub fn lease(&self) -> Result<Secret, OpenAIError> {
        if self.status()? == "auth-required" {
            return fail("auth-required");
        }
        match self.store.get(&self.r) {
            Ok(Some(k)) if !k.is_empty() => Ok(k),
            _ => fail("auth-required"),
        }
    }
}

/// `safetyIdentifier(principal)`: SHA-256 hex.
pub fn safety_identifier(principal: &str) -> String {
    Sha256::digest(principal.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// `chooseFailover(from, candidates, cross, errorCode, audit)`: a plan usage limit never fails over; another billing path only
/// with an explicit cross-billing policy, and the decision is recorded.
pub fn choose_failover(
    from: &str,
    candidates: &[(String, String)],
    cross: &[(String, String)],
    error_code: Option<&str>,
    audit: Option<&dyn AuditPort>,
) -> Result<Option<String>, PortFailure> {
    if error_code == Some("subscription_sharing_usage_limit_exceeded") {
        return Ok(None);
    }
    let candidate = candidates
        .iter()
        .find(|(_, path)| path == from || cross.iter().any(|(f, t)| f == from && t == path));
    if let (Some((_, to)), Some(a)) = (candidate, audit) {
        a.audit(
            &json!({ "kind": "failover", "from": from, "to": to, "crossBilling": from != to }),
        )?;
    }
    Ok(candidate.map(|(id, _)| id.clone()))
}

/// `importedProfile(id)`: metadata only; route 3 is retired and imported credentials are never usable.
pub fn imported_profile(id: &str) -> Result<Value, OpenAIError> {
    if id != "openai:chatgpt-oauth-restricted" {
        return fail("invalid-request");
    }
    Ok(json!({
        "id": id, "enabled": false, "reason": "D13 route 3 is retired; imported credentials are never usable",
        "replacement": "openai:chatgpt-plan",
        "action": "Sign in with ChatGPT again, use an API key, or attach the official client over ACP",
    }))
}

/// `CredentialDenyPort`.
pub trait CredentialDenyPort: Send + Sync {
    /// The canonical path (case, home and environment aliases, links resolved) without opening the file.
    fn canonicalize(&self, path: &str) -> Result<String, PortFailure>;
    /// Whether the canonical path is a foreign credential store.
    fn denied(&self, canonical: &str) -> Result<bool, PortFailure>;
}

/// `credentialAccess(deny, path, read)`: refuse before `read` runs; any failure of the port is `credential-denied`.
pub fn credential_access<T>(
    deny: &dyn CredentialDenyPort,
    path: &str,
    read: impl FnOnce() -> Result<T, OpenAIError>,
) -> Result<T, OpenAIError> {
    let denied = deny
        .canonicalize(path)
        .and_then(|c| deny.denied(&c))
        .map_err(|_| OpenAIError::new("credential-denied"))?;
    if denied {
        return fail("credential-denied");
    }
    read()
}

/// One entry of `FOREIGN_CREDENTIAL_STORES`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ForeignStore {
    /// The application's directory name (under the home, with a leading dot).
    pub app: String,
    /// The environment variable that moves it.
    pub env: String,
    /// The files that hold credentials.
    pub suffixes: Vec<&'static str>,
    /// Whether it also keeps a keychain item.
    pub keychain: bool,
}

/// `FOREIGN_CREDENTIAL_STORES`. The names are assembled from parts, as in TypeScript: the repository's source rule reserves
/// foreign host identifiers to its separate importer. This list only denies access; it reads no files.
pub fn foreign_credential_stores() -> Vec<ForeignStore> {
    vec![
        ForeignStore {
            app: "codex".into(),
            env: "CODEX_HOME".into(),
            suffixes: vec!["auth.json"],
            keychain: true,
        },
        ForeignStore {
            app: ["open", "claw"].concat(),
            env: ["OPEN", "CLAW_HOME"].concat(),
            suffixes: vec!["credentials", "agents"],
            keychain: false,
        },
        ForeignStore {
            app: "hermes".into(),
            env: "HERMES_HOME".into(),
            suffixes: vec![".env", "auth.json", "credentials", "siwc"],
            keychain: false,
        },
    ]
}

/// The canonicaliser of a deny list.
pub type Canonicalize = dyn Fn(&str) -> Result<String, PortFailure> + Send + Sync;
/// The foreign-registration metadata of a deny list.
pub type ForeignRegistration = dyn Fn(&str) -> Result<bool, PortFailure> + Send + Sync;

/// The deny port of `createCredentialDenyPort`: paths compared with `\` as `/`, trailing slashes dropped, lower case.
pub struct DenyList<'a> {
    canonicalize: &'a Canonicalize,
    roots: Vec<String>,
    items: Vec<String>,
    foreign_registration: Option<&'a ForeignRegistration>,
}

fn normalized(s: &str) -> String {
    s.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

impl<'a> DenyList<'a> {
    /// `createCredentialDenyPort({ canonicalize, roots, keychainItems, foreignRegistration })`.
    pub fn new(
        canonicalize: &'a Canonicalize,
        roots: &[String],
        keychain_items: &[String],
        foreign_registration: Option<&'a ForeignRegistration>,
    ) -> DenyList<'a> {
        DenyList {
            canonicalize,
            roots: roots.iter().map(|r| normalized(r)).collect(),
            items: keychain_items.iter().map(|r| normalized(r)).collect(),
            foreign_registration,
        }
    }
}

impl CredentialDenyPort for DenyList<'_> {
    fn canonicalize(&self, path: &str) -> Result<String, PortFailure> {
        (self.canonicalize)(path)
    }
    fn denied(&self, path: &str) -> Result<bool, PortFailure> {
        let p = normalized(path);
        if self
            .roots
            .iter()
            .any(|r| p == *r || p.starts_with(&format!("{r}/")))
            || self.items.contains(&p)
        {
            return Ok(true);
        }
        match self.foreign_registration {
            Some(f) => f(path),
            None => Ok(false),
        }
    }
}
