//! `auth/refresh.ts`: the single refresh owner (ADR-005 "Token lifecycle"). The core is the only process that refreshes, and
//! inside it one refresh is in flight per credential, so a rotating, single-use refresh token is spent exactly once however
//! many callers ask at the same moment: the first caller runs the exchange, every other caller waits for it and gets its
//! result. A rotated token is persisted before any waiter is released; one the store refuses is kept in memory and written
//! on the next access, because the vendor has already invalidated the previous one.
//!
//! The schedule: a token counts as fresh until `expiresAt - skew - jitter` (`>` against the clock: at that instant it is due),
//! where the jitter is `floor(random * min(30 s, skew / 4))`, drawn once per token generation. A transient failure backs off
//! `min(60 s, 1 s * 2^(n-1)) + floor(random * 1 s)` (n capped at 10) and keeps the old token while it is still valid
//! (`expiresAt > now`). A refresh token with a known end (`refreshExpiresAt <= now`) or one the vendor rejected marks the
//! record `reauthRequired` and stops every further attempt until a new login replaces it.
//!
//! The timer is a port ([`RefreshTimer`]): this module asks for a wake-up after a delay and cancels it; whoever drives the
//! timer calls [`RefreshOwner::fire`] when it is due. Nothing here sleeps or starts a thread.
use super::errors::{AuthError, AuthErrorCode};
use super::ports::{AuthLog, Clock, NoLog, RandomUnit};
use super::profile::AuthProfile;
use super::record::{OAuthRecord, SecretStore};
use super::secret::Secret;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

/// `RefreshResult`.
#[derive(Clone, PartialEq)]
pub struct RefreshResult {
    /// The new access token.
    pub access_token: Secret,
    /// A rotated refresh token; absent for a vendor that does not rotate (the old one stays).
    pub refresh_token: Option<Secret>,
    /// `expires_in`
    pub expires_in_seconds: Option<f64>,
    /// `refresh_expires_in`
    pub refresh_expires_in_seconds: Option<f64>,
}

/// `RefreshRejected`: `InvalidGrant` means the vendor rejected the refresh token; `Transient` that the endpoint could not
/// be reached or answered 5xx. An unknown failure is never taken as proof that the login is dead.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RefreshRejected {
    /// `invalid_grant`
    InvalidGrant,
    /// `transient`
    Transient,
}

/// `Refresher`: the token-endpoint call (RFC 6749 §6). [`super::http::HttpRefresher`] implements it.
pub trait Refresher: Send + Sync {
    /// Spends `refresh_token`.
    fn refresh(
        &self,
        profile: &AuthProfile,
        refresh_token: &Secret,
    ) -> Result<RefreshResult, RefreshRejected>;
}

/// `RefreshTimer`: one pending wake-up per credential handle.
pub trait RefreshTimer: Send + Sync {
    /// Wake [`RefreshOwner::fire`] for `key` after `delay_ms` (replaces nothing; the owner cancels first).
    fn schedule(&self, key: &str, delay_ms: f64);
    /// Cancel the wake-up for `key`.
    fn cancel(&self, key: &str);
}

/// A timer that never fires (the TypeScript tests' default is a real `setTimeout`; a caller without a timer refreshes on use).
#[derive(Clone, Copy, Debug, Default)]
pub struct NoTimer;

impl RefreshTimer for NoTimer {
    fn schedule(&self, _key: &str, _delay_ms: f64) {}
    fn cancel(&self, _key: &str) {}
}

/// `FreshRecord`.
#[derive(Clone, Debug, PartialEq)]
pub struct FreshRecord {
    /// The record.
    pub record: OAuthRecord,
    /// True when this call ran, or joined, a refresh.
    pub refreshed: bool,
}

#[derive(Clone, Copy, PartialEq)]
struct Due {
    generation: f64,
    expires_at: Option<f64>,
    at: f64,
}

#[derive(Clone, Copy)]
struct Backoff {
    attempts: u32,
    until: f64,
    generation: f64,
}

struct Flight {
    waiters: usize,
    result: Option<Result<FreshRecord, AuthError>>,
}

#[derive(Default)]
struct State {
    active: HashMap<String, u64>,
    flights: HashMap<u64, Flight>,
    next_flight: u64,
    timers: HashMap<String, (AuthProfile, String)>,
    due: HashMap<String, Due>,
    backoff: HashMap<String, Backoff>,
    unpersisted: HashMap<String, OAuthRecord>,
    closed: bool,
}

/// What the owner is built from.
#[derive(Clone, Copy)]
pub struct RefreshOwnerOptions<'a> {
    /// The secret store.
    pub store: &'a dyn SecretStore,
    /// The clock.
    pub clock: &'a dyn Clock,
    /// The token endpoint.
    pub refresher: &'a dyn Refresher,
    /// The log sink.
    pub log: Option<&'a dyn AuthLog>,
    /// The timer.
    pub timer: &'a dyn RefreshTimer,
    /// `Math.random`.
    pub random: &'a dyn RandomUnit,
}

/// `RefreshOwner`.
pub struct RefreshOwner<'a> {
    store: &'a dyn SecretStore,
    clock: &'a dyn Clock,
    refresher: &'a dyn Refresher,
    log: &'a dyn AuthLog,
    timer: &'a dyn RefreshTimer,
    random: &'a dyn RandomUnit,
    state: Mutex<State>,
    done: Condvar,
    wait_limit: Duration,
}

/// How long a caller waits for another caller's exchange by default: longer than one exchange may take (the token POST
/// gives up after 30 s by default), so the limit only ends a wait on an exchange that will not end.
pub const DEFAULT_WAIT_LIMIT: Duration = Duration::from_secs(120);

/// What a waiter gets when the exchange it waited for ended without a result (a port panicked) or outlasted the wait.
fn interrupted(p: &AuthProfile, credential_id: &str) -> AuthError {
    AuthError::new(
        AuthErrorCode::RefreshFailed,
        "Could not refresh sign-in; try again shortly.",
    )
    .profile(&p.id)
    .credential(credential_id)
    .retryable(true)
}

/// Ends the flight of one exchange however [`RefreshOwner::run`] leaves, by return or by a panic of a port: the handle leaves
/// `active`, the waiters get `result` (a retryable `refresh_failed` when `run` did not return), and every waiter is woken.
/// Without it a panic would keep the handle in `active`, and every later caller would wait for a result that never comes
/// (review C, RC-4). It only touches the owner's state; it calls no port, so it cannot panic again while unwinding.
struct Release<'o, 'a> {
    owner: &'o RefreshOwner<'a>,
    r: &'o str,
    id: u64,
    result: Result<FreshRecord, AuthError>,
}

impl Drop for Release<'_, '_> {
    fn drop(&mut self) {
        let mut st = self.owner.lock();
        if st.active.get(self.r) == Some(&self.id) {
            st.active.remove(self.r);
        }
        let keep = st.flights.get(&self.id).is_some_and(|f| f.waiters > 0);
        if keep {
            if let Some(f) = st.flights.get_mut(&self.id) {
                f.result = Some(self.result.clone());
            }
        } else {
            st.flights.remove(&self.id);
        }
        drop(st);
        self.owner.done.notify_all();
    }
}

/// A store call, with a panic of the port read as a failure like an `Err` of it. Where TypeScript wraps a port call in
/// `try`/`catch`, a panicking Rust port takes the same branch as a throwing TypeScript one.
fn caught<T>(f: impl FnOnce() -> Result<T, AuthError>) -> Result<T, ()> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(Ok(v)) => Ok(v),
        _ => Err(()),
    }
}

fn reauth(p: &AuthProfile, credential_id: &str) -> AuthError {
    AuthError::new(
        AuthErrorCode::ReauthRequired,
        format!(
            "Sign-in for {} has expired or was revoked. Sign in again.",
            p.display_name
        ),
    )
    .profile(&p.id)
    .credential(credential_id)
    .action(format!("plur1bus login {}", p.id))
}

impl<'a> RefreshOwner<'a> {
    /// `new RefreshOwner(options)`.
    pub fn new(o: RefreshOwnerOptions<'a>) -> RefreshOwner<'a> {
        RefreshOwner {
            store: o.store,
            clock: o.clock,
            refresher: o.refresher,
            log: o.log.unwrap_or(&NoLog),
            timer: o.timer,
            random: o.random,
            state: Mutex::new(State::default()),
            done: Condvar::new(),
            wait_limit: DEFAULT_WAIT_LIMIT,
        }
    }

    /// The longest a caller waits for another caller's exchange of the same handle before it gets a retryable
    /// `refresh_failed` ([`DEFAULT_WAIT_LIMIT`] unless set). TypeScript awaits the shared promise without a limit; a thread
    /// is not free to wait forever.
    pub fn with_wait_limit(mut self, limit: Duration) -> RefreshOwner<'a> {
        self.wait_limit = limit;
        self
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn log(&self, event: &str, fields: &[(&str, Value)]) {
        self.log.log(event, fields);
    }

    /// `#random()`: a draw clamped to `[0, 1]`, 0 when it is not a number.
    fn draw(&self) -> f64 {
        let n = self.random.next();
        if n.is_finite() {
            n.clamp(0.0, 1.0)
        } else {
            0.0
        }
    }

    /// `fresh(profile, ref, credentialId)`: a record whose access token is valid beyond the skew; refreshes first when not.
    pub fn fresh(
        &self,
        profile: &AuthProfile,
        r: &str,
        credential_id: &str,
    ) -> Result<FreshRecord, AuthError> {
        let rec = self.load(profile, r, credential_id)?;
        if self.is_fresh(profile, &rec, r) {
            self.schedule(profile, r, credential_id, &rec);
            return Ok(FreshRecord {
                record: rec,
                refreshed: false,
            });
        }
        let now = self.clock.now();
        let retry = self.lock().backoff.get(r).copied();
        if let Some(b) = retry.filter(|b| b.generation == rec.generation && b.until > now) {
            if rec.expires_at.is_none_or(|e| e > now) {
                return Ok(FreshRecord {
                    record: rec,
                    refreshed: false,
                });
            }
            return Err(self.retry_error(profile, credential_id, b.until));
        }
        self.join_or_start(profile, r, credential_id)
    }

    /// One exchange per handle: the first caller runs it, the others wait for its result.
    fn join_or_start(
        &self,
        profile: &AuthProfile,
        r: &str,
        credential_id: &str,
    ) -> Result<FreshRecord, AuthError> {
        let mut st = self.lock();
        if let Some(&id) = st.active.get(r) {
            if let Some(f) = st.flights.get_mut(&id) {
                f.waiters += 1;
            }
            // A waiter never waits longer than `wait_limit`, whatever the exchange does (review C, RC-4).
            let deadline = Instant::now() + self.wait_limit;
            loop {
                let finished = st.flights.get(&id).is_none_or(|f| f.result.is_some());
                if finished {
                    break;
                }
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    // The runner still owns the flight; it drops it once nobody waits.
                    if let Some(f) = st.flights.get_mut(&id) {
                        f.waiters -= 1;
                    }
                    return Err(interrupted(profile, credential_id));
                }
                st = match self.done.wait_timeout(st, left) {
                    Ok((g, _)) => g,
                    Err(poisoned) => poisoned.into_inner().0,
                };
            }
            let Some(f) = st.flights.get_mut(&id) else {
                return Err(interrupted(profile, credential_id));
            };
            f.waiters -= 1;
            let result = f
                .result
                .clone()
                .unwrap_or_else(|| Err(interrupted(profile, credential_id)));
            if f.waiters == 0 {
                st.flights.remove(&id);
            }
            return result;
        }
        let id = st.next_flight;
        st.next_flight += 1;
        st.active.insert(r.to_owned(), id);
        st.flights.insert(
            id,
            Flight {
                waiters: 0,
                result: None,
            },
        );
        drop(st);
        let mut release = Release {
            owner: self,
            r,
            id,
            result: Err(interrupted(profile, credential_id)),
        };
        let result = self.run(profile, r, credential_id);
        release.result = result.clone();
        drop(release);
        result
    }

    /// How many callers wait for the exchange of `r` (the concurrency tests use it to line their callers up).
    #[cfg(test)]
    pub(crate) fn waiting(&self, r: &str) -> usize {
        let st = self.lock();
        st.active
            .get(r)
            .and_then(|id| st.flights.get(id))
            .map_or(0, |f| f.waiters)
    }

    /// `invalidate(profile, ref, credentialId, generation)`: the access token of `generation` was rejected; no-op when a
    /// newer one exists or an exchange is in flight.
    pub fn invalidate(
        &self,
        profile: &AuthProfile,
        r: &str,
        credential_id: &str,
        generation: f64,
    ) -> Result<(), AuthError> {
        if self.lock().active.contains_key(r) {
            return Ok(());
        }
        let Ok(rec) = self.load(profile, r, credential_id) else {
            return Ok(());
        };
        if rec.generation != generation || !rec.has_refresh_token() {
            return Ok(());
        }
        {
            let mut st = self.lock();
            st.due.remove(r);
            st.backoff.remove(r);
        }
        let mut next = rec;
        next.expires_at = Some(0.0);
        self.save(r, next, profile, credential_id)
    }

    fn run(
        &self,
        profile: &AuthProfile,
        r: &str,
        credential_id: &str,
    ) -> Result<FreshRecord, AuthError> {
        // Re-read: an exchange may have finished since the caller looked.
        let rec = self.load(profile, r, credential_id)?;
        if self.is_fresh(profile, &rec, r) {
            self.schedule(profile, r, credential_id, &rec);
            return Ok(FreshRecord {
                record: rec,
                refreshed: true,
            });
        }
        let now = self.clock.now();
        let still_valid = rec.expires_at.is_none_or(|e| e > now);
        let Some(refresh_token) = rec.refresh_token.clone().filter(|t| !t.is_empty()) else {
            if still_valid {
                return Ok(FreshRecord {
                    record: rec,
                    refreshed: false,
                });
            }
            return Err(reauth(profile, credential_id));
        };
        if rec.refresh_expires_at.is_some_and(|x| x <= now) {
            self.mark_reauth(profile, r, credential_id, &rec)?;
            return Err(reauth(profile, credential_id));
        }
        self.log(
            "auth.refresh.start",
            &[
                ("profileId", json!(profile.id)),
                ("credentialId", json!(credential_id)),
            ],
        );
        // TypeScript takes whatever the refresher throws, other than `RefreshRejected`, as `transient` ("an unknown failure is
        // never taken as proof the login is dead"); a panicking port is that throw here. It is caught at this point, not
        // only cleaned up by `Release`, because the transient branch needs the failure as a value: it draws the backoff,
        // arms the timer, logs, and hands every waiter the old token while it is valid, which a guard running during the
        // unwind could only do by calling those ports with a panic in flight (review C, RC-4).
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.refresher.refresh(profile, &refresh_token)
        }))
        .unwrap_or(Err(RefreshRejected::Transient));
        match outcome {
            Err(RefreshRejected::InvalidGrant) => {
                self.log(
                    "auth.refresh.rejected",
                    &[
                        ("profileId", json!(profile.id)),
                        ("credentialId", json!(credential_id)),
                    ],
                );
                self.mark_reauth(profile, r, credential_id, &rec)?;
                Err(reauth(profile, credential_id))
            }
            Err(RefreshRejected::Transient) => {
                let previous = self.lock().backoff.get(r).map_or(0, |b| b.attempts);
                let attempts = (previous + 1).min(10);
                let delay = 60_000f64.min(1000.0 * 2f64.powi(attempts as i32 - 1))
                    + (self.draw() * 1000.0).floor();
                let until = self.clock.now() + delay;
                self.lock().backoff.insert(
                    r.to_owned(),
                    Backoff {
                        attempts,
                        until,
                        generation: rec.generation,
                    },
                );
                self.schedule_at(profile, r, credential_id, until);
                self.log(
                    "auth.refresh.transient",
                    &[
                        ("profileId", json!(profile.id)),
                        ("credentialId", json!(credential_id)),
                        ("usable", json!(still_valid)),
                    ],
                );
                if still_valid {
                    // Inside the skew window the old token still works.
                    return Ok(FreshRecord {
                        record: rec,
                        refreshed: false,
                    });
                }
                Err(self.retry_error(profile, credential_id, until))
            }
            Ok(res) => {
                let t = self.clock.now();
                let refresh_expires_at = match res.refresh_expires_in_seconds {
                    Some(s) => Some(t + s * 1000.0),
                    // `!res.refreshToken`: an empty rotated token keeps the known end too (review C, RC-5).
                    None if res.refresh_token.as_ref().is_none_or(|t| t.is_empty()) => {
                        rec.refresh_expires_at
                    }
                    None => None,
                };
                let next = OAuthRecord {
                    access_token: res.access_token,
                    refresh_token: res.refresh_token.or(rec.refresh_token),
                    expires_at: res.expires_in_seconds.map(|s| t + s * 1000.0),
                    refresh_expires_at,
                    generation: rec.generation + 1.0,
                    reauth_required: None,
                };
                self.save(r, next.clone(), profile, credential_id)?;
                {
                    let mut st = self.lock();
                    st.backoff.remove(r);
                    st.due.remove(r);
                }
                self.schedule(profile, r, credential_id, &next);
                self.log(
                    "auth.refresh.ok",
                    &[
                        ("profileId", json!(profile.id)),
                        ("credentialId", json!(credential_id)),
                        ("generation", json!(next.generation)),
                    ],
                );
                Ok(FreshRecord {
                    record: next,
                    refreshed: true,
                })
            }
        }
    }

    fn load(
        &self,
        profile: &AuthProfile,
        r: &str,
        credential_id: &str,
    ) -> Result<OAuthRecord, AuthError> {
        let pending = self.lock().unpersisted.get(r).cloned();
        if let Some(p) = pending {
            self.save(r, p.clone(), profile, credential_id)?;
            return Ok(self.lock().unpersisted.get(r).cloned().unwrap_or(p));
        }
        // `try { raw = await store.get(ref) } catch`: whatever the store does, a panic included, is a read failure.
        let raw = caught(|| self.store.get(r)).map_err(|_| {
            AuthError::new(
                AuthErrorCode::InvalidSecretRecord,
                "Stored credential could not be read.",
            )
            .profile(&profile.id)
        })?;
        let Some(raw) = raw else {
            return Err(AuthError::new(
                AuthErrorCode::NoCredential,
                format!("No sign-in is stored for {}.", profile.display_name),
            )
            .profile(&profile.id)
            .credential(credential_id)
            .action(format!("plur1bus login {}", profile.id)));
        };
        let rec = OAuthRecord::decode(raw.expose(), &profile.id)?;
        if rec.needs_reauth() {
            return Err(reauth(profile, credential_id));
        }
        Ok(rec)
    }

    /// Persist, or hold in memory and retry on the next access: the vendor has already invalidated the previous token.
    fn save(
        &self,
        r: &str,
        rec: OAuthRecord,
        profile: &AuthProfile,
        credential_id: &str,
    ) -> Result<(), AuthError> {
        // `try { await store.set(...) } catch`: a store that panics while writing a rotated record must not lose it (the
        // vendor has already invalidated the previous refresh token), so a panic is a refused write like any other.
        match caught(|| self.store.set(r, &rec.encode())) {
            Ok(()) => {
                self.lock().unpersisted.remove(r);
                Ok(())
            }
            Err(_) => {
                self.lock().unpersisted.insert(r.to_owned(), rec);
                self.log(
                    "auth.persist.failed",
                    &[
                        ("profileId", json!(profile.id)),
                        ("credentialId", json!(credential_id)),
                    ],
                );
                Err(AuthError::new(
                    AuthErrorCode::PersistFailed,
                    "Refreshed credential could not be saved; retry before restarting.",
                )
                .retryable(true))
            }
        }
    }

    /// Keep the record (the access token may still work) but stop every further refresh until a new login replaces it.
    fn mark_reauth(
        &self,
        profile: &AuthProfile,
        r: &str,
        credential_id: &str,
        rec: &OAuthRecord,
    ) -> Result<(), AuthError> {
        {
            let mut st = self.lock();
            if st.timers.remove(r).is_some() {
                self.timer.cancel(r);
            }
            st.backoff.remove(r);
        }
        let mut next = rec.clone();
        next.reauth_required = Some(Value::Bool(true));
        self.save(r, next, profile, credential_id)
    }

    fn refresh_at(&self, profile: &AuthProfile, rec: &OAuthRecord, r: &str) -> f64 {
        let held = self.lock().due.get(r).copied();
        if let Some(h) =
            held.filter(|h| h.generation == rec.generation && h.expires_at == rec.expires_at)
        {
            return h.at;
        }
        let skew = profile.refresh_skew_ms();
        let jitter = (self.draw() * 30_000f64.min(skew / 4.0)).floor();
        let at = rec.expires_at.unwrap_or(f64::INFINITY) - skew - jitter;
        self.lock().due.insert(
            r.to_owned(),
            Due {
                generation: rec.generation,
                expires_at: rec.expires_at,
                at,
            },
        );
        at
    }

    fn is_fresh(&self, profile: &AuthProfile, rec: &OAuthRecord, r: &str) -> bool {
        rec.expires_at.is_none() || self.refresh_at(profile, rec, r) > self.clock.now()
    }

    fn retry_error(&self, profile: &AuthProfile, credential_id: &str, until: f64) -> AuthError {
        AuthError::new(
            AuthErrorCode::RefreshFailed,
            "Could not refresh sign-in; try again shortly.",
        )
        .profile(&profile.id)
        .credential(credential_id)
        .retryable(true)
        .retry_after(0f64.max(until - self.clock.now()))
    }

    fn schedule(&self, profile: &AuthProfile, r: &str, credential_id: &str, rec: &OAuthRecord) {
        if rec.needs_reauth() || !rec.has_refresh_token() || rec.expires_at.is_none() {
            return;
        }
        // Very short-lived tokens would otherwise spin at zero delay inside the skew window.
        let earliest = self.clock.now() + 1000.0;
        let at = earliest.max(self.refresh_at(profile, rec, r));
        self.schedule_at(profile, r, credential_id, at);
    }

    fn schedule_at(&self, profile: &AuthProfile, r: &str, credential_id: &str, at: f64) {
        let mut st = self.lock();
        if st.timers.contains_key(r) {
            self.timer.cancel(r);
        }
        if st.closed {
            return;
        }
        st.timers
            .insert(r.to_owned(), (profile.clone(), credential_id.to_owned()));
        drop(st);
        self.timer.schedule(r, 0f64.max(at - self.clock.now()));
    }

    /// The timer for `r` is due: refresh as a caller would (failures are classified and logged by the owner itself).
    pub fn fire(&self, r: &str) {
        let Some((profile, credential_id)) = self.lock().timers.remove(r) else {
            return;
        };
        let _ = self.fresh(&profile, r, &credential_id);
    }

    /// `close()`: cancel background work on core shutdown; an exchange in flight still finishes and persists.
    pub fn close(&self) {
        let mut st = self.lock();
        st.closed = true;
        for key in st.timers.keys() {
            self.timer.cancel(key);
        }
        st.timers.clear();
    }
}
