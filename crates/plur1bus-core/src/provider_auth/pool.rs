//! `auth/pool.ts`: one credential pool per profile, the only cooldown authority (ADR-005 "Exactly one cooldown authority"):
//! the cron runner and interactive turns ask the same pool, so they cannot disagree about whether a credential is usable.
//!
//! RULING (TypeScript, ADR-005 "failure-classified cooldowns"; the sizes are ours): a confirmed failure cools long, an
//! ambiguous one briefly, and the credential left alone in the pool cools far shorter than one of several, because there is
//! nothing to fail over to. A vendor `Retry-After` replaces the table value, clamped to one second .. one day. A cooldown
//! is never shortened. A credential is usable again at exactly `until` (the remaining time is `max(0, until - now)`).
use super::errors::{AuthError, AuthErrorCode};
use super::ports::{js_number, AuthLog, Clock, NoLog};
use serde_json::{json, Map, Value};

/// `COOLDOWN_MS.confirmed.several`.
pub const CONFIRMED_SEVERAL_MS: f64 = 3_600_000.0;
/// `COOLDOWN_MS.confirmed.sole`.
pub const CONFIRMED_SOLE_MS: f64 = 300_000.0;
/// `COOLDOWN_MS.ambiguous.several`.
pub const AMBIGUOUS_SEVERAL_MS: f64 = 60_000.0;
/// `COOLDOWN_MS.ambiguous.sole`.
pub const AMBIGUOUS_SOLE_MS: f64 = 15_000.0;
/// `RETRY_AFTER_MIN_MS`.
pub const RETRY_AFTER_MIN_MS: f64 = 1_000.0;
/// `RETRY_AFTER_MAX_MS`.
pub const RETRY_AFTER_MAX_MS: f64 = 86_400_000.0;

/// `Strategy`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Strategy {
    /// `fill_first`
    #[default]
    FillFirst,
    /// `round_robin`
    RoundRobin,
    /// `least_used`
    LeastUsed,
}

impl Strategy {
    /// The TypeScript string.
    pub fn as_str(self) -> &'static str {
        match self {
            Strategy::FillFirst => "fill_first",
            Strategy::RoundRobin => "round_robin",
            Strategy::LeastUsed => "least_used",
        }
    }
}

/// `PoolEntry`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PoolEntry {
    /// The credential id.
    pub id: String,
    /// Its secret store handle.
    pub secret_ref: String,
    /// A display label.
    pub label: Option<String>,
}

/// `FailureCode`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FailureCode {
    /// `rate_limited`
    RateLimited,
    /// `quota_exhausted`
    QuotaExhausted,
    /// `auth_rejected`
    AuthRejected,
    /// `forbidden`
    Forbidden,
}

impl FailureCode {
    /// The TypeScript string.
    pub fn as_str(self) -> &'static str {
        match self {
            FailureCode::RateLimited => "rate_limited",
            FailureCode::QuotaExhausted => "quota_exhausted",
            FailureCode::AuthRejected => "auth_rejected",
            FailureCode::Forbidden => "forbidden",
        }
    }

    fn parse(s: &str) -> Option<FailureCode> {
        Some(match s {
            "rate_limited" => FailureCode::RateLimited,
            "quota_exhausted" => FailureCode::QuotaExhausted,
            "auth_rejected" => FailureCode::AuthRejected,
            "forbidden" => FailureCode::Forbidden,
            _ => return None,
        })
    }
}

/// `Certainty`: `confirmed` when the vendor said so unambiguously, `ambiguous` for an HTTP status alone.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Certainty {
    /// `confirmed`
    Confirmed,
    /// `ambiguous`
    Ambiguous,
}

impl Certainty {
    /// The TypeScript string.
    pub fn as_str(self) -> &'static str {
        match self {
            Certainty::Confirmed => "confirmed",
            Certainty::Ambiguous => "ambiguous",
        }
    }
}

/// What the adapter could read from the vendor's answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Hint {
    /// `quota_exhausted`
    QuotaExhausted,
    /// `rate_limit`
    RateLimit,
}

/// `Failure`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Failure {
    /// The HTTP status.
    pub status: u16,
    /// The model of the failed call.
    pub model: Option<String>,
    /// The vendor's `Retry-After`, in milliseconds.
    pub retry_after_ms: Option<f64>,
    /// What the adapter read from the answer.
    pub hint: Option<Hint>,
}

impl Failure {
    /// A failure with a status only.
    pub fn status(status: u16) -> Failure {
        Failure {
            status,
            ..Failure::default()
        }
    }

    /// `f.model` when it is a non-empty string (JavaScript's truthiness).
    fn model(&self) -> Option<&str> {
        self.model.as_deref().filter(|m| !m.is_empty())
    }
}

/// `Classification`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Classification {
    /// Our own reason code.
    pub code: FailureCode,
    /// How sure.
    pub certainty: Certainty,
    /// `true`: the model only; `false`: the whole credential.
    pub model_scope: bool,
}

impl Classification {
    /// The TypeScript object.
    pub fn json(&self) -> Value {
        json!({ "code": self.code.as_str(), "certainty": self.certainty.as_str(), "scope": if self.model_scope { "model" } else { "credential" } })
    }
}

/// `classifyFailure`: 429 and 401/403 start a cooldown; every other status is not the credential's fault.
pub fn classify_failure(f: &Failure) -> Option<Classification> {
    let model_scope = f.model().is_some();
    match f.status {
        429 if f.hint == Some(Hint::QuotaExhausted) => Some(Classification {
            code: FailureCode::QuotaExhausted,
            certainty: Certainty::Confirmed,
            model_scope: false,
        }),
        429 => Some(Classification {
            code: FailureCode::RateLimited,
            certainty: Certainty::Ambiguous,
            model_scope,
        }),
        401 => Some(Classification {
            code: FailureCode::AuthRejected,
            certainty: Certainty::Confirmed,
            model_scope: false,
        }),
        403 => Some(Classification {
            code: FailureCode::Forbidden,
            certainty: Certainty::Ambiguous,
            model_scope,
        }),
        _ => None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Cooldown {
    until: f64,
    code: FailureCode,
    certainty: Certainty,
}

/// A map that iterates in insertion order and keeps a key's place when it is set again (JavaScript's `Map`).
#[derive(Clone, Debug)]
struct Ordered<V>(Vec<(String, V)>);

impl<V> Default for Ordered<V> {
    fn default() -> Ordered<V> {
        Ordered(Vec::new())
    }
}

impl<V> Ordered<V> {
    fn get(&self, k: &str) -> Option<&V> {
        self.0.iter().find(|(x, _)| x == k).map(|(_, v)| v)
    }
    fn set(&mut self, k: String, v: V) {
        match self.0.iter_mut().find(|(x, _)| *x == k) {
            Some(slot) => slot.1 = v,
            None => self.0.push((k, v)),
        }
    }
    fn delete(&mut self, k: &str) {
        self.0.retain(|(x, _)| x != k);
    }
    fn has(&self, k: &str) -> bool {
        self.get(k).is_some()
    }
}

/// `CredentialStatus`.
#[derive(Clone, Debug, PartialEq)]
pub struct CredentialStatus {
    /// The credential id.
    pub id: String,
    /// Its label.
    pub label: Option<String>,
    /// How often it was selected.
    pub uses: f64,
    /// Milliseconds until it is usable for any model.
    pub cooldown_remaining_ms: f64,
    /// The last failure's classification.
    pub last_error: Option<(FailureCode, Certainty)>,
    /// Per model: milliseconds until usable.
    pub model_cooldowns: Vec<(String, f64)>,
}

impl CredentialStatus {
    /// The TypeScript object.
    pub fn json(&self) -> Value {
        let mut m = Map::new();
        m.insert("id".into(), json!(self.id));
        if let Some(l) = &self.label {
            m.insert("label".into(), json!(l));
        }
        m.insert("uses".into(), json!(self.uses));
        m.insert(
            "cooldownRemainingMs".into(),
            json!(self.cooldown_remaining_ms),
        );
        m.insert(
            "lastError".into(),
            self.last_error.map_or(
                Value::Null,
                |(c, k)| json!({ "code": c.as_str(), "certainty": k.as_str() }),
            ),
        );
        m.insert(
            "modelCooldowns".into(),
            Value::Object(
                self.model_cooldowns
                    .iter()
                    .map(|(k, v)| (k.clone(), json!(v)))
                    .collect(),
            ),
        );
        Value::Object(m)
    }
}

/// One cooldown of a [`PoolSnapshot`].
#[derive(Clone, Debug, PartialEq)]
pub struct SnapshotCooldown {
    /// The credential id.
    pub id: String,
    /// The model, for a model cooldown.
    pub model: Option<String>,
    /// When it ends.
    pub until: f64,
    /// Why.
    pub code: FailureCode,
    /// How sure.
    pub certainty: Certainty,
}

/// `PoolSnapshot`: non-secret state, so a later task can keep cooldowns across a restart.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PoolSnapshot {
    /// The cooldowns, credential ones first.
    pub cooldowns: Vec<SnapshotCooldown>,
    /// Uses per credential.
    pub uses: Vec<(String, f64)>,
    /// The round-robin cursor.
    pub cursor: f64,
}

impl PoolSnapshot {
    /// The TypeScript object.
    pub fn json(&self) -> Value {
        let cooldowns: Vec<Value> = self
            .cooldowns
            .iter()
            .map(|c| {
                let mut m = Map::new();
                m.insert("id".into(), json!(c.id));
                if let Some(model) = &c.model {
                    m.insert("model".into(), json!(model));
                }
                m.insert("until".into(), json!(c.until));
                m.insert("code".into(), json!(c.code.as_str()));
                m.insert("certainty".into(), json!(c.certainty.as_str()));
                Value::Object(m)
            })
            .collect();
        let uses: Map<String, Value> = self
            .uses
            .iter()
            .map(|(k, v)| (k.clone(), json!(v)))
            .collect();
        json!({ "cooldowns": cooldowns, "uses": uses, "cursor": self.cursor })
    }

    /// Reads the JSON `snapshot()` produced (entries that do not parse are skipped, as `restore` skips unknown ids).
    pub fn from_json(v: &Value) -> PoolSnapshot {
        let cooldowns = v["cooldowns"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|c| {
                        Some(SnapshotCooldown {
                            id: c["id"].as_str()?.to_owned(),
                            model: c["model"].as_str().map(str::to_owned),
                            until: c["until"].as_f64()?,
                            code: FailureCode::parse(c["code"].as_str()?)?,
                            certainty: match c["certainty"].as_str()? {
                                "confirmed" => Certainty::Confirmed,
                                _ => Certainty::Ambiguous,
                            },
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let uses = v["uses"]
            .as_object()
            .map(|m| {
                m.iter()
                    .filter_map(|(k, n)| Some((k.clone(), n.as_f64()?)))
                    .collect()
            })
            .unwrap_or_default();
        PoolSnapshot {
            cooldowns,
            uses,
            cursor: v["cursor"].as_f64().unwrap_or(0.0),
        }
    }
}

/// The result of `reportFailure`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Reported {
    /// The classification.
    pub classification: Classification,
    /// The cooldown applied.
    pub cooldown_ms: f64,
}

/// `CredentialPool`.
pub struct CredentialPool<'a> {
    /// The profile.
    pub profile_id: String,
    /// The strategy.
    pub strategy: Strategy,
    entries: Vec<PoolEntry>,
    clock: &'a dyn Clock,
    log: &'a dyn AuthLog,
    cool: Ordered<Cooldown>,
    cool_model: Ordered<Cooldown>,
    uses: Ordered<f64>,
    last: Ordered<(FailureCode, Certainty)>,
    cursor: f64,
}

fn model_key(id: &str, model: &str) -> String {
    format!("{id}\0{model}")
}

impl<'a> CredentialPool<'a> {
    /// `new CredentialPool({ profileId, entries, strategy, clock, log })`; duplicate ids are refused.
    pub fn new(
        profile_id: &str,
        entries: Vec<PoolEntry>,
        strategy: Strategy,
        clock: &'a dyn Clock,
        log: Option<&'a dyn AuthLog>,
    ) -> Result<CredentialPool<'a>, AuthError> {
        let mut ids: Vec<&str> = entries.iter().map(|e| e.id.as_str()).collect();
        ids.sort_unstable();
        ids.dedup();
        if ids.len() != entries.len() {
            return Err(AuthError::new(
                AuthErrorCode::InvalidProfile,
                format!("Credential pool for {profile_id} has duplicate credential ids."),
            )
            .profile(profile_id));
        }
        Ok(CredentialPool {
            profile_id: profile_id.to_owned(),
            strategy,
            entries,
            clock,
            log: log.unwrap_or(&NoLog),
            cool: Ordered::default(),
            cool_model: Ordered::default(),
            uses: Ordered::default(),
            last: Ordered::default(),
            cursor: 0.0,
        })
    }

    /// `size`.
    pub fn size(&self) -> usize {
        self.entries.len()
    }

    /// `#remaining(id, model)`: milliseconds until `id` is usable for `model` (0 = usable now).
    fn remaining(&self, id: &str, model: Option<&str>) -> f64 {
        let now = self.clock.now();
        let a = self.cool.get(id).map_or(0.0, |c| c.until);
        let b = model
            .and_then(|m| self.cool_model.get(&model_key(id, m)))
            .map_or(0.0, |c| c.until);
        0f64.max(a - now).max(b - now)
    }

    /// `select({ model })`: the credential to use, or `all_cooling_down` with the earliest retry time.
    pub fn select(&mut self, model: Option<&str>) -> Result<PoolEntry, AuthError> {
        let model = model.filter(|m| !m.is_empty());
        if self.entries.is_empty() {
            return Err(AuthError::new(
                AuthErrorCode::NoCredential,
                "No credential is configured for this profile.",
            )
            .profile(&self.profile_id));
        }
        let avail: Vec<usize> = (0..self.entries.len())
            .filter(|&i| self.remaining(&self.entries[i].id, model) == 0.0)
            .collect();
        if avail.is_empty() {
            let wait = self
                .entries
                .iter()
                .map(|e| self.remaining(&e.id, model))
                .fold(f64::INFINITY, f64::min);
            return Err(AuthError::new(
                AuthErrorCode::AllCoolingDown,
                format!(
                    "Every credential for this profile is cooling down; retry in {} s.",
                    js_number((wait / 1000.0).ceil())
                ),
            )
            .profile(&self.profile_id)
            .retryable(true)
            .retry_after(wait));
        }
        let mut pick = avail[0];
        match self.strategy {
            Strategy::FillFirst => {}
            Strategy::RoundRobin => {
                pick = avail
                    .iter()
                    .copied()
                    .find(|&i| i as f64 >= self.cursor)
                    .unwrap_or(avail[0]);
                self.cursor = ((pick + 1) % self.entries.len()) as f64;
            }
            Strategy::LeastUsed => {
                let uses = |i: usize| self.uses.get(&self.entries[i].id).copied().unwrap_or(0.0);
                pick = avail
                    .iter()
                    .copied()
                    .reduce(|a, b| if uses(b) < uses(a) { b } else { a })
                    .unwrap_or(pick);
            }
        }
        let id = self.entries[pick].id.clone();
        let n = self.uses.get(&id).copied().unwrap_or(0.0);
        self.uses.set(id, n + 1.0);
        Ok(self.entries[pick].clone())
    }

    /// `entry(id)`.
    pub fn entry(&self, id: &str) -> Option<&PoolEntry> {
        self.entries.iter().find(|e| e.id == id)
    }

    /// `reportFailure(credentialId, failure)`: what was decided, or `None` when the status is not a credential failure.
    pub fn report_failure(&mut self, credential_id: &str, f: &Failure) -> Option<Reported> {
        let c = classify_failure(f)?;
        self.entry(credential_id)?;
        let model = if c.model_scope { f.model() } else { None };
        // "sole remaining": no other credential is usable for this scope right now.
        let sole = !self
            .entries
            .iter()
            .any(|e| e.id != credential_id && self.remaining(&e.id, model) == 0.0);
        let base = match (c.certainty, sole) {
            (Certainty::Confirmed, true) => CONFIRMED_SOLE_MS,
            (Certainty::Confirmed, false) => CONFIRMED_SEVERAL_MS,
            (Certainty::Ambiguous, true) => AMBIGUOUS_SOLE_MS,
            (Certainty::Ambiguous, false) => AMBIGUOUS_SEVERAL_MS,
        };
        let ms = match f.retry_after_ms {
            Some(r) if r.is_finite() => r.clamp(RETRY_AFTER_MIN_MS, RETRY_AFTER_MAX_MS),
            _ => base,
        };
        let until = self.clock.now() + ms;
        let (map, key) = match model {
            Some(m) => (&mut self.cool_model, model_key(credential_id, m)),
            None => (&mut self.cool, credential_id.to_owned()),
        };
        // A cooldown is never shortened.
        if map.get(&key).is_none_or(|prev| prev.until < until) {
            map.set(
                key,
                Cooldown {
                    until,
                    code: c.code,
                    certainty: c.certainty,
                },
            );
        }
        self.last
            .set(credential_id.to_owned(), (c.code, c.certainty));
        self.log.log(
            "auth.pool.cooldown",
            &[
                ("profileId", json!(self.profile_id)),
                ("credentialId", json!(credential_id)),
                ("code", json!(c.code.as_str())),
                ("certainty", json!(c.certainty.as_str())),
                (
                    "scope",
                    json!(if model.is_some() {
                        "model"
                    } else {
                        "credential"
                    }),
                ),
                ("ms", json!(ms)),
                ("sole", json!(sole)),
            ],
        );
        Some(Reported {
            classification: c,
            cooldown_ms: ms,
        })
    }

    /// `reportSuccess(credentialId, model)`: ends an ambiguous cooldown on that scope early; a confirmed one runs its course.
    pub fn report_success(&mut self, credential_id: &str, model: Option<&str>) {
        if self
            .cool
            .get(credential_id)
            .is_some_and(|c| c.certainty == Certainty::Ambiguous)
        {
            self.cool.delete(credential_id);
        }
        if let Some(m) = model.filter(|m| !m.is_empty()) {
            let key = model_key(credential_id, m);
            if self
                .cool_model
                .get(&key)
                .is_some_and(|c| c.certainty == Certainty::Ambiguous)
            {
                self.cool_model.delete(&key);
            }
        }
        if !self.cool.has(credential_id) {
            self.last.delete(credential_id);
        }
    }

    /// `status()`: per credential the cooldown remaining and the last error with its classification.
    pub fn status(&self) -> Vec<CredentialStatus> {
        let now = self.clock.now();
        self.entries
            .iter()
            .map(|e| {
                let model_cooldowns = self
                    .cool_model
                    .0
                    .iter()
                    .filter_map(|(k, v)| {
                        let (id, m) = k.split_once('\0')?;
                        (id == e.id && v.until > now).then(|| (m.to_owned(), v.until - now))
                    })
                    .collect();
                CredentialStatus {
                    id: e.id.clone(),
                    label: e.label.clone(),
                    uses: self.uses.get(&e.id).copied().unwrap_or(0.0),
                    cooldown_remaining_ms: self.remaining(&e.id, None),
                    last_error: self.last.get(&e.id).copied(),
                    model_cooldowns,
                }
            })
            .collect()
    }

    /// `snapshot()`.
    pub fn snapshot(&self) -> PoolSnapshot {
        let mut cooldowns: Vec<SnapshotCooldown> = self
            .cool
            .0
            .iter()
            .map(|(id, v)| SnapshotCooldown {
                id: id.clone(),
                model: None,
                until: v.until,
                code: v.code,
                certainty: v.certainty,
            })
            .collect();
        for (k, v) in &self.cool_model.0 {
            let (id, model) = k.split_once('\0').unwrap_or((k, ""));
            cooldowns.push(SnapshotCooldown {
                id: id.to_owned(),
                model: Some(model.to_owned()),
                until: v.until,
                code: v.code,
                certainty: v.certainty,
            });
        }
        PoolSnapshot {
            cooldowns,
            uses: self.uses.0.clone(),
            cursor: self.cursor,
        }
    }

    /// `restore(snapshot)`: cooldowns and uses of known credentials; the last errors stay.
    pub fn restore(&mut self, s: &PoolSnapshot) {
        self.cool = Ordered::default();
        self.cool_model = Ordered::default();
        self.uses = Ordered::default();
        for c in &s.cooldowns {
            if self.entry(&c.id).is_none() {
                continue;
            }
            let cd = Cooldown {
                until: c.until,
                code: c.code,
                certainty: c.certainty,
            };
            match c.model.as_deref().filter(|m| !m.is_empty()) {
                Some(m) => self.cool_model.set(model_key(&c.id, m), cd),
                None => self.cool.set(c.id.clone(), cd),
            }
        }
        for (id, n) in &s.uses {
            if self.entry(id).is_some() {
                self.uses.set(id.clone(), *n);
            }
        }
        let len = self.entries.len().max(1) as f64;
        self.cursor = s.cursor % len;
    }
}
