//! `auth/secret-store.ts`: the one way the package persists or reads a secret (the [`SecretStore`] port), the stored OAuth
//! record and its encoding, and the bridge to the core's audited secret store (`secrets::`).
//!
//! API keys and user-pasted tokens are stored as the bare value; an OAuth login is a JSON record under the credential's
//! `secret_ref`, written byte for byte as `encodeRecord` writes it, so either core reads what the other wrote.
use super::errors::{AuthError, AuthErrorCode};
use super::ports::js_number;
use super::secret::Secret;
use crate::js::json_stringify;
use crate::secrets::leases::IssueOptions;
use crate::secrets::{SecretErrorCode, SecretPrincipal};
use serde_json::{json, Map, Value};

/// `SecretStore` of `auth/secret-store.ts`: `ref` is a handle, never a value. A failure is an [`AuthError`] with a constant
/// message.
pub trait SecretStore: Send + Sync {
    /// The value under `ref`, `None` when nothing is stored.
    fn get(&self, r: &str) -> Result<Option<Secret>, AuthError>;
    /// Stores `value` under `ref`.
    fn set(&self, r: &str, value: &Secret) -> Result<(), AuthError>;
    /// Removes `ref`.
    fn delete(&self, r: &str) -> Result<(), AuthError>;
}

/// `OAuthRecord`. Times are epoch milliseconds as JavaScript numbers.
#[derive(Clone, PartialEq)]
pub struct OAuthRecord {
    /// The access token.
    pub access_token: Secret,
    /// The refresh token, when the vendor issued one.
    pub refresh_token: Option<Secret>,
    /// When the access token stops working.
    pub expires_at: Option<f64>,
    /// The known end of life of the refresh token itself.
    pub refresh_expires_at: Option<f64>,
    /// Incremented by every refresh; a lease carries it so a late 401 cannot invalidate a newer token.
    pub generation: f64,
    /// Set once the vendor rejected the refresh token. Kept as the JSON value it was read as (TypeScript tests truthiness
    /// and writes back what it read).
    pub reauth_required: Option<Value>,
}

impl std::fmt::Debug for OAuthRecord {
    /// `util.inspect` of a protected record: the version and generation, never a token.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OAuthRecord")
            .field("v", &1)
            .field("generation", &self.generation)
            .field("token", &"[redacted]")
            .finish()
    }
}

/// JavaScript truthiness of a JSON value.
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `JSON.stringify(v)` for a value read from JSON: JavaScript's number text, its string escaping.
pub fn js_json(v: &Value) -> String {
    match v {
        Value::Null => "null".to_owned(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => js_number(n.as_f64().unwrap_or(0.0)),
        Value::String(s) => json_stringify(s),
        Value::Array(a) => format!("[{}]", a.iter().map(js_json).collect::<Vec<_>>().join(",")),
        Value::Object(m) => format!(
            "{{{}}}",
            m.iter()
                .map(|(k, x)| format!("{}:{}", json_stringify(k), js_json(x)))
                .collect::<Vec<_>>()
                .join(",")
        ),
    }
}

impl OAuthRecord {
    /// A fresh record of generation `generation`.
    pub fn new(access_token: Secret, generation: f64) -> OAuthRecord {
        OAuthRecord {
            access_token,
            refresh_token: None,
            expires_at: None,
            refresh_expires_at: None,
            generation,
            reauth_required: None,
        }
    }

    /// `!rec.refreshToken`: absent or empty.
    pub fn has_refresh_token(&self) -> bool {
        self.refresh_token.as_ref().is_some_and(|t| !t.is_empty())
    }

    /// Whether `reauthRequired` is truthy.
    pub fn needs_reauth(&self) -> bool {
        self.reauth_required.as_ref().is_some_and(truthy)
    }

    /// `encodeRecord(r)`: the only place that serialises token values.
    pub fn encode(&self) -> Secret {
        let mut s = String::from("{\"v\":1,\"accessToken\":");
        s.push_str(&json_stringify(self.access_token.expose()));
        if let Some(r) = &self.refresh_token {
            s.push_str(",\"refreshToken\":");
            s.push_str(&json_stringify(r.expose()));
        }
        if let Some(e) = self.expires_at {
            s.push_str(",\"expiresAt\":");
            s.push_str(&js_number(e));
        }
        if let Some(e) = self.refresh_expires_at {
            s.push_str(",\"refreshExpiresAt\":");
            s.push_str(&js_number(e));
        }
        s.push_str(",\"generation\":");
        s.push_str(&js_number(self.generation));
        if let Some(r) = &self.reauth_required {
            s.push_str(",\"reauthRequired\":");
            s.push_str(&js_json(r));
        }
        s.push('}');
        Secret::new(s)
    }

    /// `JSON.stringify(record)` of a protected record: `{ v, generation, expiresAt, reauthRequired, token: "[redacted]" }`.
    pub fn redacted_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("v".into(), json!(1));
        m.insert("generation".into(), json!(self.generation));
        if let Some(e) = self.expires_at {
            m.insert("expiresAt".into(), json!(e));
        }
        if let Some(r) = &self.reauth_required {
            m.insert("reauthRequired".into(), r.clone());
        }
        m.insert("token".into(), json!("[redacted]"));
        Value::Object(m)
    }

    /// `decodeRecord(raw, profileId)`: a malformed record is refused without echoing it.
    pub fn decode(raw: &str, profile_id: &str) -> Result<OAuthRecord, AuthError> {
        let invalid = || {
            AuthError::new(
                AuthErrorCode::InvalidSecretRecord,
                "The stored credential is unreadable; sign in again.",
            )
            .profile(profile_id)
            .action(format!("plur1bus login {profile_id}"))
        };
        let v: Value = serde_json::from_str(raw).map_err(|_| invalid())?;
        let Value::Object(o) = v else {
            return Err(invalid());
        };
        if o.get("v").and_then(Value::as_f64) != Some(1.0) {
            return Err(invalid());
        }
        let Some(Value::String(access)) = o.get("accessToken") else {
            return Err(invalid());
        };
        let Some(generation) = o.get("generation").and_then(Value::as_f64) else {
            return Err(invalid());
        };
        let refresh_token = match o.get("refreshToken") {
            None => None,
            Some(Value::String(s)) => Some(Secret::new(s.clone())),
            Some(_) => return Err(invalid()),
        };
        let num = |k: &str| match o.get(k) {
            None => Ok(None),
            Some(Value::Number(n)) => Ok(n.as_f64()),
            Some(_) => Err(invalid()),
        };
        Ok(OAuthRecord {
            access_token: Secret::new(access.clone()),
            refresh_token,
            expires_at: num("expiresAt")?,
            refresh_expires_at: num("refreshExpiresAt")?,
            generation,
            reauth_required: o.get("reauthRequired").cloned(),
        })
    }
}

/// `createAuthSecretStore(service)`: reads take a short core lease and revoke it at once; writes and deletes use the owner
/// API, after the caller has authorised an in-process login.
pub struct SecretsBridge<'a> {
    service: &'a crate::secrets::SecretStore,
}

impl<'a> SecretsBridge<'a> {
    /// The bridge over the core's secret store.
    pub fn new(service: &'a crate::secrets::SecretStore) -> SecretsBridge<'a> {
        SecretsBridge { service }
    }
}

fn owner() -> SecretPrincipal {
    SecretPrincipal::Owner {
        id: None,
        surface: None,
    }
}

impl SecretStore for SecretsBridge<'_> {
    fn get(&self, r: &str) -> Result<Option<Secret>, AuthError> {
        let options = IssueOptions {
            purpose: "auth",
            profile_id: "auth",
            ttl_ms: None,
        };
        match self.service.lease(&SecretPrincipal::Core, r, options) {
            Ok(lease) => {
                let value = Secret::new(lease.value.clone());
                // The lease is only the read; it ends here whatever happens to the value.
                let _ = self
                    .service
                    .revoke_lease(&SecretPrincipal::Core, &lease.lease_id);
                Ok(Some(value))
            }
            Err(e) if e.code == SecretErrorCode::NotFound => Ok(None),
            Err(_) => Err(AuthError::new(
                AuthErrorCode::InvalidSecretRecord,
                "Stored credential could not be read.",
            )),
        }
    }

    fn set(&self, r: &str, value: &Secret) -> Result<(), AuthError> {
        self.service
            .set(&owner(), r, value.expose(), None)
            .map(|_| ())
            .map_err(|_| {
                AuthError::new(
                    AuthErrorCode::PersistFailed,
                    "Credential could not be saved.",
                )
            })
    }

    fn delete(&self, r: &str) -> Result<(), AuthError> {
        match self.service.delete(&owner(), r) {
            Ok(()) => Ok(()),
            Err(e) if e.code == SecretErrorCode::NotFound => Ok(()),
            Err(_) => Err(AuthError::new(
                AuthErrorCode::PersistFailed,
                "Credential could not be removed.",
            )),
        }
    }
}
