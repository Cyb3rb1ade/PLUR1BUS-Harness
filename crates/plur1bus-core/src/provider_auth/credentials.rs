//! `auth/credentials.ts`: what provider adapters consume. One call per request: get a lease, send, report the outcome so the
//! pool and the refresh owner learn from it.
//!
//! The order of the ladder for one request: a federated or `dynamic_on_authorize` profile belongs to the OpenAI service (D110)
//! and gets nothing here; a vendor CLI's profile holds no credential; ADC asks the ambient source; every other profile asks
//! its pool, and a pooled credential whose secret is missing or whose login is dead is cooled like a 401 and the next one is
//! tried, each credential at most once per request. A 401 on a token believed valid spends one refresh before the credential
//! is blamed.
use super::errors::{AuthError, AuthErrorCode};
use super::pool::{CredentialPool, Failure, PoolEntry, Strategy};
use super::ports::{AuthLog, Clock, NoLog, RandomUnit};
use super::profile::{AuthKind, AuthProfile, ClientRegistration};
use super::record::SecretStore;
use super::refresh::{RefreshOwner, RefreshOwnerOptions, RefreshTimer, Refresher};
use super::secret::Secret;
use serde_json::{json, Value};
use std::fmt;
use std::sync::{Mutex, MutexGuard, PoisonError};

/// `AuthorizationLease`: the header a provider adapter attaches and when it stops being valid. The value is a secret: the
/// printed and JSON forms are redacted.
#[derive(Clone)]
pub struct AuthorizationLease {
    /// The profile.
    pub profile_id: String,
    /// The credential (`adc` for the ambient source).
    pub credential_id: String,
    /// Epoch ms, or `None` when the credential does not expire.
    pub expires_at: Option<f64>,
    /// This lease carries a token minted (or joined) by a refresh just now.
    pub refreshed: bool,
    /// The token generation, for 401 handling.
    pub generation: Option<f64>,
    name: String,
    value: Secret,
}

impl AuthorizationLease {
    /// The header: its name and value (`Authorization: Bearer …` or what the profile's scheme says).
    pub fn header(&self) -> (&str, &Secret) {
        (&self.name, &self.value)
    }

    /// All headers for a request: the credential header over `extra` (`{ ...extra, [name]: value }`; a same-named entry keeps
    /// its place and takes the credential).
    pub fn headers(&self, extra: &[(String, String)]) -> Vec<(String, Secret)> {
        let mut out: Vec<(String, Secret)> = extra
            .iter()
            .map(|(k, v)| (k.clone(), Secret::new(v.clone())))
            .collect();
        match out.iter_mut().find(|(k, _)| *k == self.name) {
            Some(slot) => slot.1 = self.value.clone(),
            None => out.push((self.name.clone(), self.value.clone())),
        }
        out
    }

    /// `JSON.stringify(lease)`.
    pub fn redacted_json(&self) -> Value {
        json!({ "profileId": self.profile_id, "credentialId": self.credential_id, "header": self.name, "expiresAt": self.expires_at, "value": "[redacted]" })
    }
}

impl fmt::Display for AuthorizationLease {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "AuthorizationLease({}/{})",
            self.profile_id, self.credential_id
        )
    }
}

impl fmt::Debug for AuthorizationLease {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}

/// `CallResult`.
#[derive(Clone, Debug, PartialEq)]
pub enum CallResult {
    /// The call succeeded (for `model`).
    Ok {
        /// The model of the call.
        model: Option<String>,
    },
    /// The call failed.
    Failed(Failure),
}

/// An ADC token (`AdcTokenSource#token`).
#[derive(Clone)]
pub struct AdcLease {
    /// The access token.
    pub access_token: Secret,
    /// When it expires, when known.
    pub expires_at: Option<f64>,
}

/// `AdcTokenSource`: the ambient Google credential; [`super::adc::GoogleAdc`] implements it.
pub trait AdcTokenSource: Send + Sync {
    /// A token for `profile`.
    fn token(&self, profile: &AuthProfile) -> Result<AdcLease, AuthError>;
}

/// `ProfileCredentials`.
pub struct ProfileCredentials {
    /// The profile.
    pub profile: AuthProfile,
    /// Its pooled credentials.
    pub entries: Vec<PoolEntry>,
    /// The pool's strategy.
    pub strategy: Strategy,
}

/// What the provider is built from.
pub struct CredentialsProviderOptions<'a> {
    /// The profiles.
    pub profiles: Vec<ProfileCredentials>,
    /// The secret store.
    pub store: &'a dyn SecretStore,
    /// The clock.
    pub clock: &'a dyn Clock,
    /// The token endpoint.
    pub refresher: &'a dyn Refresher,
    /// The ambient source, when there is one.
    pub adc: Option<&'a dyn AdcTokenSource>,
    /// The log sink.
    pub log: Option<&'a dyn AuthLog>,
    /// The refresh owner's timer.
    pub timer: &'a dyn RefreshTimer,
    /// The refresh owner's randomness.
    pub random: &'a dyn RandomUnit,
}

/// `createCredentialsProvider(options)`.
pub struct CredentialsProvider<'a> {
    owner: RefreshOwner<'a>,
    store: &'a dyn SecretStore,
    adc: Option<&'a dyn AdcTokenSource>,
    log: &'a dyn AuthLog,
    profiles: Vec<(AuthProfile, Mutex<CredentialPool<'a>>)>,
}

impl<'a> CredentialsProvider<'a> {
    /// Builds the provider; a profile without entries but with a `secret_ref` is a pool of one (`default`).
    pub fn new(o: CredentialsProviderOptions<'a>) -> Result<CredentialsProvider<'a>, AuthError> {
        let log: &'a dyn AuthLog = o.log.unwrap_or(&NoLog);
        let owner = RefreshOwner::new(RefreshOwnerOptions {
            store: o.store,
            clock: o.clock,
            refresher: o.refresher,
            log: Some(log),
            timer: o.timer,
            random: o.random,
        });
        let mut profiles = Vec::new();
        for pc in o.profiles {
            let entries = if !pc.entries.is_empty() {
                pc.entries
            } else if let Some(r) = &pc.profile.secret_ref {
                vec![PoolEntry {
                    id: "default".to_owned(),
                    secret_ref: r.clone(),
                    label: None,
                }]
            } else {
                Vec::new()
            };
            let pool =
                CredentialPool::new(&pc.profile.id, entries, pc.strategy, o.clock, Some(log))?;
            match profiles
                .iter_mut()
                .find(|(p, _): &&mut (AuthProfile, _)| p.id == pc.profile.id)
            {
                Some(slot) => *slot = (pc.profile, Mutex::new(pool)),
                None => profiles.push((pc.profile, Mutex::new(pool))),
            }
        }
        Ok(CredentialsProvider {
            owner,
            store: o.store,
            adc: o.adc,
            log,
            profiles,
        })
    }

    fn lookup(&self, id: &str) -> Result<(&AuthProfile, &Mutex<CredentialPool<'a>>), AuthError> {
        let (p, pool) = self
            .profiles
            .iter()
            .find(|(p, _)| p.id == id)
            .ok_or_else(|| {
                AuthError::new(
                    AuthErrorCode::UnknownProfile,
                    format!("No auth profile named {id}."),
                )
                .profile(id)
            })?;
        Ok((p, pool))
    }

    /// `pool(profileId)`: the pool the cron runner asks too.
    pub fn pool(&self, id: &str) -> Option<MutexGuard<'_, CredentialPool<'a>>> {
        self.profiles
            .iter()
            .find(|(p, _)| p.id == id)
            .map(|(_, pool)| pool.lock().unwrap_or_else(PoisonError::into_inner))
    }

    /// The refresh owner (its timer calls [`RefreshOwner::fire`]).
    pub fn owner(&self) -> &RefreshOwner<'a> {
        &self.owner
    }

    /// `close()`.
    pub fn close(&self) {
        self.owner.close();
    }

    fn lease(
        p: &AuthProfile,
        credential_id: &str,
        token: &str,
        expires_at: Option<f64>,
        refreshed: bool,
        generation: Option<f64>,
    ) -> AuthorizationLease {
        let (name, value) = p.header(token);
        AuthorizationLease {
            profile_id: p.id.clone(),
            credential_id: credential_id.to_owned(),
            expires_at,
            refreshed,
            generation,
            name,
            value: Secret::new(value),
        }
    }

    /// `getAuthorization({ profileId, model })`.
    pub fn get_authorization(
        &self,
        profile_id: &str,
        model: Option<&str>,
    ) -> Result<AuthorizationLease, AuthError> {
        let (profile, pool) = self.lookup(profile_id)?;
        let lock = || pool.lock().unwrap_or_else(PoisonError::into_inner);
        if profile.kind == AuthKind::FederatedToken
            || profile.client_registration == Some(ClientRegistration::DynamicOnAuthorize)
        {
            return Err(AuthError::new(
                AuthErrorCode::NoCredential,
                "This profile requires the D110 OpenAI service.",
            ));
        }
        if profile.kind == AuthKind::ExternalCli {
            return Err(AuthError::new(
                AuthErrorCode::DelegatedLogin,
                format!(
                    "{} signs in through the vendor's own CLI; the harness holds no credential for it.",
                    profile.display_name
                ),
            )
            .profile(&profile.id));
        }
        if profile.kind == AuthKind::Adc {
            let Some(adc) = self.adc else {
                return Err(AuthError::new(
                    AuthErrorCode::AdcUnavailable,
                    format!(
                        "No application-default credential source is available for {}.",
                        profile.display_name
                    ),
                )
                .profile(&profile.id));
            };
            let t = adc.token(profile).map_err(|_| {
                AuthError::new(
                    AuthErrorCode::AdcUnavailable,
                    format!(
                        "Could not obtain an application-default credential for {}.",
                        profile.display_name
                    ),
                )
                .profile(&profile.id)
                .retryable(true)
            })?;
            return Ok(Self::lease(
                profile,
                "adc",
                t.access_token.expose(),
                t.expires_at,
                false,
                None,
            ));
        }
        // Failover: a credential whose secret is missing or whose login is dead is cooled and the next one is tried.
        let mut tried: Vec<String> = Vec::new();
        loop {
            // The pool is not held while a refresh runs, so concurrent callers can join it.
            let entry = lock().select(model)?;
            if tried.contains(&entry.id) {
                return Err(AuthError::new(
                    AuthErrorCode::AllCoolingDown,
                    format!("No usable credential is left for {}.", profile.display_name),
                )
                .profile(&profile.id));
            }
            tried.push(entry.id.clone());
            let attempt = if profile.is_refreshable() {
                self.owner
                    .fresh(profile, &entry.secret_ref, &entry.id)
                    .map(|f| {
                        Self::lease(
                            profile,
                            &entry.id,
                            f.record.access_token.expose(),
                            f.record.expires_at,
                            f.refreshed,
                            Some(f.record.generation),
                        )
                    })
            } else {
                match self.store.get(&entry.secret_ref) {
                    Ok(Some(raw)) => Ok(Self::lease(
                        profile,
                        &entry.id,
                        raw.expose(),
                        None,
                        false,
                        None,
                    )),
                    Ok(None) => Err(AuthError::new(
                        AuthErrorCode::NoCredential,
                        format!("No key is stored for {}.", profile.display_name),
                    )
                    .profile(&profile.id)
                    .credential(&entry.id)
                    .action(format!("plur1bus login {}", profile.id))),
                    Err(e) => Err(e),
                }
            };
            match attempt {
                Ok(lease) => return Ok(lease),
                Err(e) => {
                    // A dead login on one pooled credential is a confirmed auth failure for it; fail over if another exists.
                    let dead = matches!(
                        e.code,
                        AuthErrorCode::ReauthRequired | AuthErrorCode::NoCredential
                    );
                    let mut pool = lock();
                    if !dead || pool.size() < 2 {
                        return Err(e);
                    }
                    pool.report_failure(&entry.id, &Failure::status(401));
                }
            }
        }
    }

    /// `reportResult(lease, result)`.
    pub fn report_result(
        &self,
        lease: &AuthorizationLease,
        result: &CallResult,
    ) -> Result<(), AuthError> {
        let (profile, pool) = self.lookup(&lease.profile_id)?;
        let mut pool = pool.lock().unwrap_or_else(PoisonError::into_inner);
        let f = match result {
            CallResult::Ok { model } => {
                pool.report_success(&lease.credential_id, model.as_deref());
                return Ok(());
            }
            CallResult::Failed(f) => f,
        };
        let entry = pool.entry(&lease.credential_id).cloned();
        if let (401, true, false, Some(generation), Some(entry)) = (
            f.status,
            profile.is_refreshable(),
            lease.refreshed,
            lease.generation,
            entry,
        ) {
            // A token believed valid was rejected: spend one refresh on it before blaming the credential.
            drop(pool);
            self.owner
                .invalidate(profile, &entry.secret_ref, &entry.id, generation)?;
            self.log.log(
                "auth.lease.rejected",
                &[
                    ("profileId", json!(profile.id)),
                    ("credentialId", json!(entry.id)),
                    ("action", json!("refresh-next")),
                ],
            );
            return Ok(());
        }
        pool.report_failure(&lease.credential_id, f);
        Ok(())
    }
}
