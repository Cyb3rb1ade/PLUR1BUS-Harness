//! `secrets/store.ts`: the secret store over two backends (ADR-005).
//!
//! The OS keyring is tried first; the encrypted file is used only while `secrets.fileFallback.enabled` is set. With the
//! fallback on, a name can live in both (a keyring that was away while the name was rotated or deleted): the newer
//! `updatedAt` wins, a keyring copy not newer than a tombstone of the file is a deleted one, on a tie the keyring wins,
//! and an owner read brings the keyring back in line ([`SecretStore::status`], [`SecretStore::list`]). Every value the
//! store reads or writes is registered with the redaction registry before it is returned. The audit line comes first:
//! when it cannot be written, nothing is released or changed.
//!
//! The TypeScript store is asynchronous and guards every `await` against an outage that happened meanwhile (its
//! `generation`). This one is synchronous behind one lock, which removes most interleavings, not the outage itself: a
//! backend in a helper process can die inside any call. Such a backend raises the [`StartupOptions::unavailable`] flag;
//! the store looks at it after every backend call and then does what `backendUnavailable()` does (state `unavailable`,
//! every lease revoked, a retry after `retry_after_ms`), so the checks sit where they sit in TypeScript.
//!
//! Different by construction, not in what a caller sees:
//! - one writer at a time is the lock, not a promise chain, and a lease cannot overlap a write, so the three attempts of
//!   `lease` are one and `lease-invalid: the secret changed while the lease was being issued` cannot occur;
//! - the start-up budget is checked between backend calls (a call that blocks is the helper's to interrupt);
//! - change listeners run after the lock is released, so a listener may call the store. The names one operation committed
//!   arrive in order; two operations on two threads may be told in either order (a listener gets a name, not a state, and
//!   reads the store for what holds now). A listener that panics does not stop the others;
//! - an outage is also looked for at the start of every operation, so a helper that went away while no call was in flight
//!   has revoked every lease before the next call answers.
use super::audit::{AuditAction, DetailValue};
use super::backend::{compare_names, SecretBackend};
use super::error::{SecretError, SecretErrorCode};
use super::leases::{IssueOptions, Lease, LeaseInfo, LeaseTable};
use super::types::{
    check_description, check_name, check_value, is_secret_name, BackendKind, BackendProbe,
    SecretMeta, SecretPrincipal, MIN_DESCRIPTION_VALUE_CHARS, MIN_SECRET_SURFACE,
};
use crate::identity::codes::RandomSource;
use crate::js::utf16;
use crate::logs::redact::SecretSet;
use crate::rbac::surface::surface_satisfies;
use plur1bus_log_schema::redact::utf16::utf16_len;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

/// The fixed text of `no-backend`, with the remedy.
pub const NO_BACKEND: &str = "no secret backend is available: the OS keyring is not usable and the encrypted-file fallback is disabled; set secrets.fileFallback.enabled to true (plur1bus config set secrets.fileFallback.enabled true) to use the encrypted file";
/// The text of `backend-unavailable` and the remedy of a store whose backends went away.
pub const UNAVAILABLE: &str = "Secret-Store unavailable";
/// The registry group of the start-up snapshot (`Symbol("startup-store")`).
const STARTUP_GROUP: &str = "startup-store";

/// What the store logs (`SecretStoreLogger`): a message and structured fields, never a value.
pub trait SecretStoreLogger: Send {
    /// `debug(msg, fields)`.
    fn debug(&self, message: &str, fields: Value);
    /// `info(msg, fields)`.
    fn info(&self, message: &str, fields: Value);
    /// `warn(msg, fields)`.
    fn warn(&self, message: &str, fields: Value);
}

/// One audit record as the store hands it to its sink (`AuditEvent` without `at` and `actor`, which the sink adds).
#[derive(Clone, Debug, PartialEq)]
pub struct AuditEvent {
    /// What was done or refused.
    pub action: AuditAction,
    /// The secret's name; `None` for calls without one and for a refused caller's free text.
    pub target: Option<String>,
    /// Who asked.
    pub principal: SecretPrincipal,
    /// The detail as given; the sink keeps the whitelisted keys ([`super::audit::sanitize_detail`]).
    pub detail: Vec<(String, DetailValue)>,
}

/// Where audit records go (`AuditSink`). An error means the line is not durable: the store then releases and changes
/// nothing (`audit-unavailable`).
pub trait AuditSink: Send {
    /// Writes one record.
    fn record(&mut self, event: &AuditEvent) -> Result<(), SecretError>;
}

/// `SecretStartupStatus.state`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StartupState {
    /// No preload was ever started.
    Idle,
    /// A preload is running.
    Loading,
    /// The snapshot is registered and at least one backend serves.
    Ready,
    /// No backend serves now; see the reason.
    Unavailable,
    /// The store was closed.
    Closed,
}

impl StartupState {
    /// The wire name.
    pub fn as_str(self) -> &'static str {
        match self {
            StartupState::Idle => "idle",
            StartupState::Loading => "loading",
            StartupState::Ready => "ready",
            StartupState::Unavailable => "unavailable",
            StartupState::Closed => "closed",
        }
    }
}

/// `SecretStartupStatus.reason`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StartupReason {
    /// The preload did not finish inside its budget.
    StartupTimeout,
    /// A backend went away.
    BackendUnavailable,
    /// The keyring is not usable and the fallback is off.
    NoBackend,
}

impl StartupReason {
    /// The wire name.
    pub fn as_str(self) -> &'static str {
        match self {
            StartupReason::StartupTimeout => "startup-timeout",
            StartupReason::BackendUnavailable => "backend-unavailable",
            StartupReason::NoBackend => "no-backend",
        }
    }
}

/// `SecretStartupStatus`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StartupStatus {
    /// Where the store is.
    pub state: StartupState,
    /// Why it is unavailable.
    pub reason: Option<StartupReason>,
    /// False when unread values could still occur in arbitrary queued start-up records.
    pub safe_to_flush: bool,
}

impl StartupStatus {
    /// `{ state, reason?, safeToFlush }`.
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("state".into(), json!(self.state.as_str()));
        if let Some(reason) = self.reason {
            out.insert("reason".into(), json!(reason.as_str()));
        }
        out.insert("safeToFlush".into(), json!(self.safe_to_flush));
        Value::Object(out)
    }
}

/// `SecretStatus`: what `secret.status` answers.
#[derive(Clone, Debug, PartialEq)]
pub struct SecretStatus {
    /// The backend values go to now: `keyring`, `file` or `none`.
    pub backend: &'static str,
    /// True whenever the keyring is not the backend in use.
    pub degraded: bool,
    /// The keyring's probe.
    pub keyring: BackendProbe,
    /// `secrets.fileFallback.enabled`.
    pub file_enabled: bool,
    /// The file's probe; `None` when the fallback is off (it is not probed then).
    pub file_available: Option<bool>,
    /// The file's reason when it cannot serve.
    pub file_reason: Option<String>,
    /// Names held in the selected backend, `None` when it cannot be listed.
    pub count: Option<usize>,
    /// Leases that are live now.
    pub active_leases: usize,
    /// Every name the owner can see, with a description that holds no registered value.
    pub secrets: Option<Vec<SecretMeta>>,
    /// What to do when no backend serves.
    pub remedy: Option<&'static str>,
}

impl SecretStatus {
    /// The JSON object of the TypeScript (optional members only when present; empty timestamps omitted).
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("backend".into(), json!(self.backend));
        out.insert("degraded".into(), json!(self.degraded));
        let mut keyring = Map::new();
        keyring.insert("available".into(), json!(self.keyring.available));
        if let Some(reason) = self.keyring.reason.as_deref().filter(|r| !r.is_empty()) {
            keyring.insert("reason".into(), json!(reason));
        }
        out.insert("keyring".into(), Value::Object(keyring));
        let mut file = Map::new();
        file.insert("enabled".into(), json!(self.file_enabled));
        file.insert("available".into(), json!(self.file_available));
        if let Some(reason) = self.file_reason.as_deref().filter(|r| !r.is_empty()) {
            file.insert("reason".into(), json!(reason));
        }
        out.insert("file".into(), Value::Object(file));
        out.insert("count".into(), json!(self.count));
        out.insert("activeLeases".into(), json!(self.active_leases));
        if let Some(secrets) = &self.secrets {
            let list = secrets
                .iter()
                .map(|m| {
                    let mut one = Map::new();
                    one.insert("name".into(), json!(m.name));
                    one.insert("backend".into(), json!(m.backend.as_str()));
                    if !m.created_at.is_empty() {
                        one.insert("createdAt".into(), json!(m.created_at));
                    }
                    if !m.updated_at.is_empty() {
                        one.insert("updatedAt".into(), json!(m.updated_at));
                    }
                    if let Some(by) = m.updated_by.as_deref().filter(|s| !s.is_empty()) {
                        one.insert("updatedBy".into(), json!(by));
                    }
                    if let Some(text) = m.description.as_deref().filter(|s| !s.is_empty()) {
                        one.insert("description".into(), json!(text));
                    }
                    Value::Object(one)
                })
                .collect();
            out.insert("secrets".into(), Value::Array(list));
        }
        if let Some(remedy) = self.remedy {
            out.insert("remedy".into(), json!(remedy));
        }
        Value::Object(out)
    }
}

/// `SecretStoreOptions.startup` and the clocks.
pub struct StartupOptions {
    /// How long a preload may take, in milliseconds (default 3000).
    pub budget_ms: f64,
    /// How long an unavailable store waits before it tries again (default 30000).
    pub retry_after_ms: f64,
    /// Raised by a backend whose helper process went away inside a call; the store lowers it and goes unavailable.
    pub unavailable: Arc<AtomicBool>,
    /// Called when the store goes unavailable: retires the helpers (`startup.cancel`).
    pub cancel: Option<Box<dyn FnMut() + Send>>,
    /// Called once by [`SecretStore::close`]: closes the helpers (`startup.close`).
    pub close: Option<Box<dyn FnMut() + Send>>,
}

impl Default for StartupOptions {
    fn default() -> StartupOptions {
        StartupOptions {
            budget_ms: 3000.0,
            retry_after_ms: 30_000.0,
            unavailable: Arc::default(),
            cancel: None,
            close: None,
        }
    }
}

/// `SecretStoreOptions`.
pub struct SecretStoreOptions {
    /// The OS keyring backend, tried first.
    pub keyring: Box<dyn SecretBackend + Send>,
    /// The encrypted-file backend, used only while `file_fallback()` is true.
    pub file: Box<dyn SecretBackend + Send>,
    /// `secrets.fileFallback.enabled`, read per use (a live key).
    pub file_fallback: Box<dyn Fn() -> bool + Send>,
    /// Where audit records go.
    pub audit: Box<dyn AuditSink>,
    /// `Date.now()`: epoch milliseconds, for timestamps and lease expiry.
    pub clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    /// `performance.now()`: a monotonic clock in milliseconds, for the retry and the start-up budget.
    pub monotonic: Box<dyn Fn() -> f64 + Send>,
    /// The randomness of lease ids.
    pub random: Box<dyn RandomSource + Send>,
    /// The store's log.
    pub logger: Option<Box<dyn SecretStoreLogger>>,
    /// The registry shared with the configuration's registrations and every sink.
    pub redaction: Arc<SecretSet>,
    /// The trusted runtime lifecycle.
    pub startup: StartupOptions,
}

/// `Date.parse(iso)` for the timestamps a backend writes (`toISOString`): `YYYY-MM-DDTHH:mm:ss.sssZ`, also without the
/// milliseconds or the seconds, with a `±HH:mm` offset, or a date alone. Anything else is `None` (the store reads it as 0,
/// as it reads `NaN`). Other forms `Date.parse` accepts depend on the engine and the time zone and are `None` here.
pub fn parse_iso_ms(text: &str) -> Option<i64> {
    fn number(bytes: &[u8]) -> Option<i64> {
        if bytes.is_empty() || !bytes.iter().all(u8::is_ascii_digit) {
            return None;
        }
        std::str::from_utf8(bytes).ok()?.parse().ok()
    }
    let b = text.as_bytes();
    if b.len() < 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let (year, month, day) = (number(&b[0..4])?, number(&b[5..7])?, number(&b[8..10])?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let (mut hour, mut minute, mut second, mut milli, mut offset) = (0, 0, 0, 0, 0);
    if b.len() > 10 {
        let rest = &b[10..];
        if rest.len() < 6 || rest[0] != b'T' || rest[3] != b':' {
            return None;
        }
        hour = number(&rest[1..3])?;
        minute = number(&rest[4..6])?;
        let mut at = 6;
        if rest.get(at) == Some(&b':') {
            second = number(rest.get(at + 1..at + 3)?)?;
            at += 3;
            if rest.get(at) == Some(&b'.') {
                milli = number(rest.get(at + 1..at + 4)?)?;
                at += 4;
            }
        }
        match rest.get(at) {
            Some(b'Z') if at + 1 == rest.len() => {}
            Some(sign @ (b'+' | b'-')) if at + 6 == rest.len() && rest[at + 3] == b':' => {
                let minutes = number(&rest[at + 1..at + 3])? * 60 + number(&rest[at + 4..at + 6])?;
                offset = if *sign == b'+' { minutes } else { -minutes };
            }
            _ => return None,
        }
        if hour > 24
            || minute > 59
            || second > 59
            || (hour == 24 && (minute, second, milli) != (0, 0, 0))
        {
            return None;
        }
    }
    // Days since the epoch of a proleptic Gregorian date (Howard Hinnant's `days_from_civil`).
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400_000 + (hour * 60 + minute - offset) * 60_000 + second * 1000 + milli)
}

/// `ms(iso)` of the store: the time value, 0 for anything that is none.
fn ms(iso: &str) -> i64 {
    parse_iso_ms(iso).unwrap_or(0)
}

/// `LABEL`: `^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$`, the shape of a lease's purpose and profile id.
fn is_label(text: &str) -> bool {
    let bytes = text.as_bytes();
    (1..=128).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || b"._:/@-".contains(b))
}

/// A JavaScript number as JSON writes it: an integral value without a fraction (`300000`, not `300000.0`); `NaN` and the
/// infinities have no JSON form.
fn js_number(n: f64) -> Option<serde_json::Number> {
    if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
        Some(serde_json::Number::from(n as i64))
    } else {
        serde_json::Number::from_f64(n)
    }
}

fn text_detail(key: &str, value: &str) -> (String, DetailValue) {
    (key.to_owned(), DetailValue::Str(utf16(value)))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Which {
    Keyring,
    File,
}

struct Selection {
    /// The backend values go to now; `None` is the kind `none`.
    backend: Option<Which>,
    /// The file, while the keyring serves and the file can be read too.
    other: Option<Which>,
    keyring: BackendProbe,
    file_available: Option<bool>,
    file_reason: Option<String>,
}

impl Selection {
    fn kind(&self) -> &'static str {
        match self.backend {
            Some(Which::Keyring) => "keyring",
            Some(Which::File) => "file",
            None => "none",
        }
    }
}

struct Found {
    value: String,
    from: Which,
    generation: u64,
}

#[derive(Default)]
struct Plan {
    purge: Vec<String>,
    promote: Vec<String>,
    drop_other: Vec<String>,
    clear: Vec<String>,
}

impl Plan {
    fn idle(&self) -> bool {
        self.purge.is_empty()
            && self.promote.is_empty()
            && self.drop_other.is_empty()
            && self.clear.is_empty()
    }
}

struct Merged {
    /// Every name the owner can see, newest version winning, in the order a JavaScript `Map` would hold them.
    metas: Vec<SecretMeta>,
    /// What the primary backend lists, without the buried names.
    primary: usize,
    plan: Plan,
}

struct Inner {
    keyring: Box<dyn SecretBackend + Send>,
    file: Box<dyn SecretBackend + Send>,
    file_fallback: Box<dyn Fn() -> bool + Send>,
    audit: Box<dyn AuditSink>,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    monotonic: Box<dyn Fn() -> f64 + Send>,
    logger: Option<Box<dyn SecretStoreLogger>>,
    redaction: Arc<SecretSet>,
    leases: LeaseTable,
    options: StartupOptions,
    /// Every value read in a preload, cumulative over retries (a deleted secret stays masked until the process ends).
    startup_values: Vec<String>,
    preloaded: bool,
    startup: StartupStatus,
    generation: u64,
    retry_at: f64,
    keyring_ready: bool,
    file_ready: bool,
    last_kind: Option<&'static str>,
    closed: bool,
    /// Names whose change was committed during the current call; told to the listeners once the lock is released.
    committed: Vec<String>,
    /// What a holder outside this store has not been told yet ([`SecretStore::drain_effects`]).
    effects: Effects,
}

/// What the store's operations did to things somebody outside it may hold: a lease that was handed out
/// ([`SecretStore::lease_out`]) and a copy of the start-up snapshot. Collected until it is taken
/// ([`SecretStore::drain_effects`]). The legacy core behind the front door is such a holder (P4-20 flip B): it keeps the
/// leases it asked for and masks with a registry of its own.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Effects {
    /// Every lease is void: the store went unavailable or was closed.
    pub all: bool,
    /// The names whose leases are void, each once, in the order it happened: a change of the name was run, whether it
    /// succeeded or not (a `set`, a `delete`, a step of the sync between keyring and file).
    pub names: Vec<String>,
    /// A preload finished: the start-up snapshot as it is now, every value of it.
    pub preloaded: Option<Vec<String>>,
}

impl Effects {
    /// Whether there is nothing to tell.
    pub fn is_empty(&self) -> bool {
        !self.all && self.names.is_empty() && self.preloaded.is_none()
    }
}

fn unavailable() -> SecretError {
    SecretError::new(SecretErrorCode::BackendUnavailable, UNAVAILABLE)
}

fn no_backend() -> SecretError {
    SecretError::new(SecretErrorCode::NoBackend, NO_BACKEND)
}

fn no_secret_named(name: &str) -> SecretError {
    SecretError::with_detail(
        SecretErrorCode::NotFound,
        format!("no secret named {name}"),
        json!({ "name": name }),
    )
}

fn owner_id(p: &SecretPrincipal) -> Option<&str> {
    match p {
        SecretPrincipal::Owner { id, .. } => id.as_deref(),
        _ => None,
    }
}

fn kind_name(p: &SecretPrincipal) -> &'static str {
    match p {
        SecretPrincipal::Owner { .. } => "owner",
        SecretPrincipal::Core => "core",
        SecretPrincipal::Agent { .. } => "agent",
    }
}

impl Inner {
    fn warn(&self, message: &str, fields: Value) {
        if let Some(logger) = &self.logger {
            logger.warn(message, fields);
        }
    }

    fn be(&mut self, which: Which) -> &mut (dyn SecretBackend + Send) {
        match which {
            Which::Keyring => self.keyring.as_mut(),
            Which::File => self.file.as_mut(),
        }
    }

    fn kind_of(&self, which: Which) -> BackendKind {
        match which {
            Which::Keyring => self.keyring.kind(),
            Which::File => self.file.kind(),
        }
    }

    /// A backend whose helper went away inside the last call has raised the flag: the store goes unavailable before the
    /// caller looks at the answer.
    fn absorb(&mut self) {
        if self.options.unavailable.swap(false, Ordering::SeqCst) {
            self.backend_unavailable(StartupReason::BackendUnavailable);
        }
    }

    fn get(&mut self, which: Which, name: &str) -> Result<Option<String>, SecretError> {
        let answer = self.be(which).get(name);
        self.absorb();
        answer
    }

    fn list_of(&mut self, which: Which) -> Result<Vec<SecretMeta>, SecretError> {
        let answer = self.be(which).list();
        self.absorb();
        answer
    }

    fn meta_in(&mut self, which: Which, name: &str) -> Result<Option<SecretMeta>, SecretError> {
        Ok(self.list_of(which)?.into_iter().find(|m| m.name == name))
    }

    fn probe(&mut self, which: Which) -> Result<BackendProbe, SecretError> {
        let answer = self.be(which).probe();
        self.absorb();
        answer
    }

    fn delete_in(
        &mut self,
        which: Which,
        name: &str,
        tombstone_at_ms: Option<i64>,
    ) -> Result<bool, SecretError> {
        let answer = self.be(which).delete(name, tombstone_at_ms);
        self.absorb();
        answer
    }

    /// `clearTombstone?.(name)`: nothing for a backend without tombstones.
    fn clear_tombstone(&mut self, which: Which, name: &str) -> Result<(), SecretError> {
        let answer = self.be(which).clear_tombstone(name);
        self.absorb();
        answer.unwrap_or(Ok(()))
    }

    fn assert_available(&self, expected: u64) -> Result<(), SecretError> {
        if expected != self.generation {
            return Err(unavailable());
        }
        if self.startup.state == StartupState::Unavailable
            && self.startup.reason == Some(StartupReason::NoBackend)
        {
            return Err(no_backend());
        }
        if !matches!(self.startup.state, StartupState::Idle | StartupState::Ready) {
            return Err(unavailable());
        }
        Ok(())
    }

    /// `backendUnavailable(reason)`: every in-flight release is invalid from here on.
    fn backend_unavailable(&mut self, reason: StartupReason) {
        if self.startup.state == StartupState::Closed {
            return;
        }
        self.generation += 1;
        self.effects.all = true;
        self.startup = StartupStatus {
            state: StartupState::Unavailable,
            reason: Some(reason),
            safe_to_flush: false,
        };
        self.keyring_ready = false;
        self.file_ready = false;
        self.retry_at = (self.monotonic)() + self.options.retry_after_ms;
        for lease in self.leases.active() {
            self.leases.revoke(&lease.lease_id);
        }
        if let Some(cancel) = self.options.cancel.as_mut() {
            cancel();
        }
    }

    fn audited(
        &mut self,
        p: &SecretPrincipal,
        action: AuditAction,
        target: Option<&str>,
        detail: Vec<(String, DetailValue)>,
    ) -> Result<(), SecretError> {
        self.audit.record(&AuditEvent {
            action,
            target: target.map(str::to_owned),
            principal: p.clone(),
            detail,
        })
    }

    /// Fail closed: a principal whose kind is not in `kinds` is refused, and the attempt is audited (best effort: a
    /// refusal needs no audit to hold).
    fn gate(
        &mut self,
        p: &SecretPrincipal,
        action: &str,
        name: Option<&str>,
        kinds: &[&str],
    ) -> Result<(), SecretError> {
        if kinds.contains(&kind_name(p)) {
            return Ok(());
        }
        Err(self.deny(p, action, name))
    }

    /// The write, delete and reveal paths: an owner who came in on a connection must have the level
    /// [`MIN_SECRET_SURFACE`] asks for. An owner without a surface is an in-process caller and has no connection to judge.
    fn gate_surface(
        &mut self,
        p: &SecretPrincipal,
        action: &str,
        name: Option<&str>,
    ) -> Result<(), SecretError> {
        match p {
            SecretPrincipal::Owner {
                surface: Some(surface),
                ..
            } if !surface_satisfies(*surface, Some(MIN_SECRET_SURFACE)) => {
                Err(self.deny(p, action, name))
            }
            _ => Ok(()),
        }
    }

    fn deny(&mut self, p: &SecretPrincipal, action: &str, name: Option<&str>) -> SecretError {
        // The target is only ever a well-formed name: a refused caller's free text, which may itself be a pasted secret,
        // is not written.
        let target = name.filter(|n| is_secret_name(n));
        let _ = self.audited(
            p,
            AuditAction::Denied,
            target,
            vec![text_detail("method", action)],
        );
        self.warn(
            "secret access denied",
            json!({ "method": action, "kind": kind_name(p) }),
        );
        SecretError::with_detail(
            SecretErrorCode::Denied,
            "secret operations are available to the owner only",
            json!({ "method": action }),
        )
    }

    fn unavailable_selection(&self) -> Selection {
        Selection {
            backend: None,
            other: None,
            keyring: BackendProbe {
                available: false,
                reason: Some(
                    self.startup
                        .reason
                        .map_or("backend-unavailable", StartupReason::as_str)
                        .to_owned(),
                ),
            },
            file_available: (self.file_fallback)().then_some(false),
            file_reason: None,
        }
    }

    fn serving(&self) -> bool {
        matches!(self.startup.state, StartupState::Idle | StartupState::Ready)
    }

    fn select(&mut self) -> Result<Selection, SecretError> {
        if self.startup.state != StartupState::Idle {
            if self.startup.state == StartupState::Unavailable
                && (self.monotonic)() >= self.retry_at
            {
                self.begin_preload();
            }
            if self.startup.state != StartupState::Ready {
                return Ok(self.unavailable_selection());
            }
        }
        let version = self.generation;
        let enabled = (self.file_fallback)();
        let probes = self.probe(Which::Keyring).and_then(|kp| {
            let fp = if enabled {
                Some(self.probe(Which::File)?)
            } else {
                None
            };
            Ok((kp, fp))
        });
        let (kp, fp) = match probes {
            Ok(probes) => probes,
            Err(e) if e.code == SecretErrorCode::BackendUnavailable => {
                self.backend_unavailable(StartupReason::BackendUnavailable);
                return Ok(self.unavailable_selection());
            }
            Err(e) => return Err(e),
        };
        if version != self.generation || !self.serving() {
            return Ok(self.unavailable_selection());
        }
        let file_serves = fp.as_ref().is_some_and(|p| p.available);
        if self.startup.state != StartupState::Idle {
            if !kp.available {
                self.keyring_ready = false;
            }
            if !file_serves {
                self.file_ready = false;
            }
            // A returning backend, or a newly enabled fallback, must register its complete readable snapshot first.
            if (kp.available && !self.keyring_ready) || (file_serves && !self.file_ready) {
                self.begin_preload();
                if self.startup.state != StartupState::Ready {
                    return Ok(self.unavailable_selection());
                }
                return self.select();
            }
        }
        let selection = Selection {
            backend: if kp.available {
                Some(Which::Keyring)
            } else if file_serves {
                Some(Which::File)
            } else {
                None
            },
            other: (kp.available && file_serves).then_some(Which::File),
            file_available: if kp.available || !file_serves {
                fp.as_ref().map(|p| p.available)
            } else {
                Some(true)
            },
            file_reason: fp
                .as_ref()
                .and_then(|p| p.reason.clone())
                .filter(|r| !r.is_empty()),
            keyring: kp,
        };
        if self.last_kind != Some(selection.kind()) {
            self.last_kind = Some(selection.kind());
            if let Some(logger) = &self.logger {
                let mut fields = Map::new();
                fields.insert("backend".into(), json!(selection.kind()));
                if let Some(reason) = selection
                    .keyring
                    .reason
                    .as_deref()
                    .filter(|r| !r.is_empty())
                {
                    fields.insert("keyringReason".into(), json!(reason));
                }
                logger.info("secret backend selected", Value::Object(fields));
            }
        }
        Ok(selection)
    }

    fn need(&self, selection: &Selection) -> Result<Which, SecretError> {
        self.assert_available(self.generation)?;
        selection.backend.ok_or_else(no_backend)
    }

    /// Names deleted while the keyring was away (the file backend, read while the keyring serves again).
    fn tombstones_of(&mut self, selection: &Selection) -> BTreeMap<String, String> {
        let Some(other) = selection.other else {
            return BTreeMap::new();
        };
        let answer = self.be(other).tombstones();
        self.absorb();
        match answer {
            None => BTreeMap::new(),
            Some(Ok(tombstones)) => tombstones,
            Some(Err(_)) => {
                self.warn("secret tombstones could not be read", json!({}));
                BTreeMap::new()
            }
        }
    }
}

/// A copy not newer than a tombstone of its name is a deleted one.
fn buried(tombstones: &BTreeMap<String, String>, name: &str, updated_at: &str) -> bool {
    tombstones
        .get(name)
        .is_some_and(|at| ms(updated_at) <= ms(at))
}

impl Inner {
    /// The value of `name`, and where it came from. With the file fallback on, a name can exist in both backends: the
    /// newer `updatedAt` wins, a keyring copy not newer than a tombstone of the file is a deleted one, and on a tie the
    /// keyring wins. Only the winner is read.
    fn find(&mut self, name: &str) -> Result<Option<Found>, SecretError> {
        let selection = self.select()?;
        let primary = self.need(&selection)?;
        let version = self.generation;
        let Some(other) = selection.other else {
            let value = self.get(primary, name)?;
            self.assert_available(version)?;
            return value
                .map(|value| self.take(value, primary, name, version))
                .transpose();
        };
        let theirs = self.meta_in(other, name)?;
        self.assert_available(version)?;
        let tombstones = self.tombstones_of(&selection);
        self.assert_available(version)?;
        let mut value = self.get(primary, name)?;
        self.assert_available(version)?;
        let mut mine: Option<SecretMeta> = None;
        if value.is_some() && (theirs.is_some() || tombstones.contains_key(name)) {
            mine = self.meta_in(primary, name)?;
            self.assert_available(version)?;
            let updated_at = mine.as_ref().map_or("", |m| m.updated_at.as_str());
            if buried(&tombstones, name, updated_at) {
                value = None;
            }
        }
        if let Some(value) = value {
            let newer_there = theirs.as_ref().is_some_and(|m| {
                ms(&m.updated_at) > mine.as_ref().map_or(0, |mine| ms(&mine.updated_at))
            });
            if !newer_there {
                return self.take(value, primary, name, version).map(Some);
            }
        }
        if theirs.is_none() {
            return Ok(None);
        }
        let value = self.get(other, name)?;
        self.assert_available(version)?;
        value
            .map(|value| self.take(value, other, name, version))
            .transpose()
    }

    /// A value that is about to be handed on: registered first, pinned under its name.
    fn take(
        &mut self,
        value: String,
        from: Which,
        name: &str,
        version: u64,
    ) -> Result<Found, SecretError> {
        self.assert_available(version)?;
        self.redaction.register_named(&value, name);
        Ok(Found {
            value,
            from,
            generation: version,
        })
    }

    /// Every name the owner can see, newest version winning, plus what the two backends owe each other (see `settle`).
    fn merged(&mut self, selection: &Selection) -> Result<Merged, SecretError> {
        let version = self.generation;
        let primary = match selection.backend {
            Some(backend) => self.list_of(backend)?,
            None => Vec::new(),
        };
        self.assert_available(version)?;
        let other = match selection.other {
            Some(other) => self.list_of(other)?,
            None => Vec::new(),
        };
        self.assert_available(version)?;
        let tombstones = self.tombstones_of(selection);
        self.assert_available(version)?;
        let mut plan = Plan {
            clear: tombstones.keys().cloned().collect(),
            ..Plan::default()
        };
        let mut metas: Vec<SecretMeta> = Vec::new();
        let mut listed = 0;
        for meta in primary {
            if buried(&tombstones, &meta.name, &meta.updated_at) {
                plan.purge.push(meta.name);
            } else {
                listed += 1;
                metas.push(meta);
            }
        }
        for meta in other {
            match metas.iter().position(|m| m.name == meta.name) {
                None => metas.push(meta),
                Some(at) if ms(&meta.updated_at) > ms(&metas[at].updated_at) => {
                    plan.promote.push(meta.name.clone());
                    metas[at] = meta;
                }
                Some(_) => plan.drop_other.push(meta.name),
            }
        }
        Ok(Merged {
            metas,
            primary: listed,
            plan,
        })
    }

    /// Runs a change of one name; whatever was leased from the old value is revoked, also when the change failed.
    fn changing<T>(
        &mut self,
        name: &str,
        change: impl FnOnce(&mut Inner) -> Result<T, SecretError>,
    ) -> Result<T, SecretError> {
        let answer = change(self);
        self.leases.revoke_name(name);
        if !self.effects.names.iter().any(|n| n == name) {
            self.effects.names.push(name.to_owned());
        }
        answer
    }

    /// The keyring is serving and the file holds something that happened while it was not: bring the keyring in line (a
    /// rotated value moves in, a deleted name is purged, a stale file copy is dropped) and forget the tombstones that
    /// have done their work. Audited like any other change, never fatal: a failed step is retried by the next owner read,
    /// and `find` already answers right.
    fn settle(&mut self, plan: &Plan) {
        if plan.idle() {
            return;
        }
        // A sync that cannot run is not a failure of the read that asked for it.
        let _ = self.settle_now();
    }

    fn settle_now(&mut self) -> Result<(), SecretError> {
        let selection = self.select()?;
        let (Some(Which::Keyring), Some(file)) = (selection.backend, selection.other) else {
            return Ok(());
        };
        let keyring = Which::Keyring;
        let version = self.generation;
        let fresh = self.merged(&selection)?.plan;
        let mut purged: Vec<&str> = Vec::new();
        for name in &fresh.purge {
            if self.step(version, name, AuditAction::Delete, "keyring", |inner| {
                inner.delete_in(keyring, name, None).map(|_| ())
            }) {
                purged.push(name);
            }
        }
        for name in &fresh.promote {
            let Some(meta) = self.meta_in(file, name)? else {
                continue;
            };
            let Some(value) = self.get(file, name).ok().flatten() else {
                continue;
            };
            // The time of the rotation is kept, not the time of the sync.
            let at = match ms(&meta.updated_at) {
                0 => (self.clock)(),
                at => at,
            };
            self.step(version, name, AuditAction::Set, "keyring", |inner| {
                let put = inner.be(keyring).put(
                    name,
                    &value,
                    at,
                    meta.updated_by.as_deref(),
                    Some(meta.description.as_deref().unwrap_or("")),
                    None,
                );
                inner.absorb();
                put?;
                inner.delete_in(file, name, None).map(|_| ())
            });
        }
        for name in &fresh.drop_other {
            self.step(version, name, AuditAction::Delete, "file", |inner| {
                inner.delete_in(file, name, None).map(|_| ())
            });
        }
        for name in &fresh.clear {
            // The keyring copy is still there: the tombstone keeps hiding it.
            if fresh.purge.contains(name) && !purged.contains(&name.as_str()) {
                continue;
            }
            let cleared = self
                .assert_available(version)
                .and_then(|()| self.clear_tombstone(file, name));
            if cleared.is_err() {
                self.warn(
                    "a secret tombstone could not be cleared",
                    json!({ "name": name }),
                );
            }
        }
        Ok(())
    }

    /// One step of the sync: audited as the core's own, with the reason `keyring-sync`.
    fn step(
        &mut self,
        version: u64,
        name: &str,
        action: AuditAction,
        backend: &str,
        change: impl FnOnce(&mut Inner) -> Result<(), SecretError>,
    ) -> bool {
        let done = self
            .assert_available(version)
            .and_then(|()| {
                self.audited(
                    &SecretPrincipal::Core,
                    action,
                    Some(name),
                    vec![
                        text_detail("reason", "keyring-sync"),
                        text_detail("backend", backend),
                    ],
                )
            })
            .and_then(|()| self.changing(name, change))
            .and_then(|()| self.assert_available(version));
        if done.is_err() {
            self.warn(
                "secret copies could not be brought in line",
                json!({ "name": name }),
            );
        }
        done.is_ok()
    }

    /// A description may not carry any value the store holds: not the one being written (checked with the text), not
    /// another secret's, not an older one of this name.
    fn assert_description_holds_no_value(
        &mut self,
        text: &str,
        selection: &Selection,
    ) -> Result<(), SecretError> {
        let leak = || {
            SecretError::new(
                SecretErrorCode::InvalidDescription,
                "secret description must not contain a secret value",
            )
        };
        if self.redaction.contains(text) {
            return Err(leak());
        }
        let Ok(merged) = self.merged(selection) else {
            return Ok(());
        };
        for meta in merged.metas {
            // An entry that cannot be read cannot be compared; the others still are.
            let Ok(Some(hit)) = self.find(&meta.name) else {
                continue;
            };
            if utf16_len(&hit.value) >= MIN_DESCRIPTION_VALUE_CHARS && text.contains(&hit.value) {
                return Err(leak());
            }
        }
        Ok(())
    }

    /// Start-up reads never settle copies or release values; the snapshot stays masked until the core exits.
    fn preload_values(
        &mut self,
        version: u64,
        deadline: f64,
    ) -> Result<(Vec<String>, bool, bool, Vec<Value>), SecretError> {
        let mut values = Vec::new();
        let (mut keyring_usable, mut file_usable) = (false, false);
        let mut failures = Vec::new();
        let mut sources = vec![("keyring", Which::Keyring)];
        if (self.file_fallback)() {
            sources.push(("file", Which::File));
        }
        for (label, source) in sources {
            self.within(version, deadline)?;
            let available = match self.probe(source) {
                Ok(probe) => probe.available,
                Err(_) => {
                    failures.push(json!({ "backend": label, "phase": "probe", "count": 1 }));
                    continue;
                }
            };
            if !available {
                continue;
            }
            match source {
                Which::Keyring => keyring_usable = true,
                Which::File => file_usable = true,
            }
            let entries = match self.list_of(source) {
                Ok(entries) => entries,
                Err(_) => {
                    failures.push(json!({ "backend": label, "phase": "list", "count": 1 }));
                    continue;
                }
            };
            let mut unreadable = 0;
            for entry in entries {
                self.within(version, deadline)?;
                // An inaccessible entry must not prevent registration of the others.
                match self.get(source, &entry.name) {
                    Ok(Some(value)) => values.push(value),
                    Ok(None) => {}
                    Err(_) => unreadable += 1,
                }
            }
            if unreadable > 0 {
                failures.push(json!({ "backend": label, "phase": "read", "count": unreadable }));
            }
        }
        Ok((values, keyring_usable, file_usable, failures))
    }

    /// One deadline covers the probes, the lists and every read of a preload.
    fn within(&mut self, version: u64, deadline: f64) -> Result<(), SecretError> {
        if version == self.generation && (self.monotonic)() >= deadline {
            self.backend_unavailable(StartupReason::StartupTimeout);
        }
        if version == self.generation {
            Ok(())
        } else {
            Err(unavailable())
        }
    }

    fn begin_preload(&mut self) {
        if self.startup.state == StartupState::Closed {
            return;
        }
        self.preloaded = true;
        self.generation += 1;
        let version = self.generation;
        self.startup = StartupStatus {
            state: StartupState::Loading,
            reason: None,
            safe_to_flush: false,
        };
        let deadline = (self.monotonic)() + self.options.budget_ms;
        match self.preload_values(version, deadline) {
            Ok((values, keyring_usable, file_usable, failures)) => {
                if version != self.generation || self.startup.state != StartupState::Loading {
                    return;
                }
                for value in values {
                    if !self.startup_values.contains(&value) {
                        self.startup_values.push(value);
                    }
                }
                let snapshot: Vec<&str> = self.startup_values.iter().map(String::as_str).collect();
                self.redaction.replace_group(STARTUP_GROUP, &snapshot);
                self.effects.preloaded = Some(self.startup_values.clone());
                self.keyring_ready = keyring_usable;
                self.file_ready = file_usable;
                self.startup = if keyring_usable || file_usable {
                    StartupStatus {
                        state: StartupState::Ready,
                        reason: None,
                        safe_to_flush: true,
                    }
                } else {
                    StartupStatus {
                        state: StartupState::Unavailable,
                        reason: Some(StartupReason::NoBackend),
                        safe_to_flush: true,
                    }
                };
                self.retry_at = (self.monotonic)() + self.options.retry_after_ms;
                for failure in failures {
                    self.warn("secret startup values could not all be read", failure);
                }
            }
            Err(_) => {
                if version == self.generation {
                    self.backend_unavailable(StartupReason::BackendUnavailable);
                }
            }
        }
    }
}

impl Inner {
    fn status(&mut self, p: &SecretPrincipal) -> Result<SecretStatus, SecretError> {
        self.gate(p, "status", None, &["owner", "core"])?;
        let mut selection = self.select()?;
        let version = self.generation;
        let mut count = None;
        let mut secrets = None;
        if selection.backend.is_some() {
            if let Ok(merged) = self.merged(&selection) {
                count = Some(merged.primary);
                let mut metas = merged.metas;
                metas.sort_by(|a, b| compare_names(&a.name, &b.name));
                secrets = Some(metas);
                self.settle(&merged.plan);
            }
        }
        if version != self.generation || !self.serving() {
            selection = self.unavailable_selection();
            count = None;
            secrets = None;
        }
        let redaction = self.redaction.clone();
        Ok(SecretStatus {
            backend: selection.kind(),
            degraded: selection.backend != Some(Which::Keyring),
            keyring: selection.keyring.clone(),
            file_enabled: (self.file_fallback)(),
            file_available: selection.file_available,
            file_reason: selection.file_reason.clone(),
            count,
            active_leases: self.leases.active().len(),
            secrets: secrets.map(|metas| {
                metas
                    .into_iter()
                    .map(|mut meta| {
                        meta.description = meta
                            .description
                            .filter(|text| !text.is_empty())
                            .map(|text| redaction.mask(&text));
                        meta
                    })
                    .collect()
            }),
            remedy: selection.backend.is_none().then(|| {
                if self.startup.state == StartupState::Unavailable
                    && self.startup.reason != Some(StartupReason::NoBackend)
                {
                    UNAVAILABLE
                } else {
                    NO_BACKEND
                }
            }),
        })
    }

    fn set(
        &mut self,
        p: &SecretPrincipal,
        name: &str,
        value: &str,
        description: Option<&str>,
    ) -> Result<SecretMeta, SecretError> {
        self.gate(p, "set", Some(name), &["owner"])?;
        self.gate_surface(p, "set", Some(name))?;
        check_name(name)?;
        check_value(value)?;
        let text = check_description(description, Some(value))?;
        let selection = self.select()?;
        let backend = self.need(&selection)?;
        let version = self.generation;
        if let Some(text) = text.as_deref().filter(|t| !t.is_empty()) {
            self.assert_description_holds_no_value(text, &selection)?;
            // The text may also not echo an older value of this very name, which `put` replaces (and which the other
            // names' check above sees only in full): fragments of it are refused too.
            if let Some(previous) = self.find(name)? {
                check_description(Some(text), Some(&previous.value))?;
            }
        }
        self.assert_available(version)?;
        self.redaction.register_named(value, name);
        let kind = self.kind_of(backend);
        self.audited(
            p,
            AuditAction::Set,
            Some(name),
            vec![text_detail("backend", kind.as_str())],
        )?;
        let now = (self.clock)();
        let meta = self.changing(name, |inner| {
            let redaction = inner.redaction.clone();
            let mut register = |previous: &str| redaction.register(previous);
            let put = inner.be(backend).put(
                name,
                value,
                now,
                owner_id(p),
                text.as_deref(),
                Some(&mut register),
            );
            inner.absorb();
            let meta = put?;
            inner.assert_available(version)?;
            // A copy of the old value in the other backend would come back when this one goes away: rotation removes it,
            // and a tombstone of an earlier delete has nothing left to hide.
            if let Some(other) = selection.other {
                let removed = inner
                    .delete_in(other, name, None)
                    .and_then(|_| inner.clear_tombstone(other, name));
                if removed.is_err() {
                    inner.warn(
                        "stale secret copy could not be removed",
                        json!({ "name": name }),
                    );
                }
            }
            Ok(meta)
        })?;
        self.assert_available(version)?;
        self.committed.push(name.to_owned());
        Ok(meta)
    }

    fn describe(
        &mut self,
        p: &SecretPrincipal,
        name: &str,
        description: &str,
    ) -> Result<SecretMeta, SecretError> {
        self.gate(p, "describe", Some(name), &["owner"])?;
        self.gate_surface(p, "describe", Some(name))?;
        check_name(name)?;
        let text = check_description(Some(description), None)?.unwrap_or_default();
        let selection = self.select()?;
        self.need(&selection)?;
        let found = self.find(name)?.ok_or_else(SecretError::not_found)?;
        if !text.is_empty() {
            self.assert_description_holds_no_value(&text, &selection)?;
        }
        check_description(Some(&text), Some(&found.value))?;
        self.assert_available(found.generation)?;
        let kind = self.kind_of(found.from);
        self.audited(
            p,
            AuditAction::Describe,
            Some(name),
            vec![text_detail("backend", kind.as_str())],
        )?;
        let now = (self.clock)();
        let redaction = self.redaction.clone();
        let mut register = |value: &str| redaction.register(value);
        let described =
            self.be(found.from)
                .describe(name, &text, now, owner_id(p), Some(&mut register));
        self.absorb();
        let meta = described?;
        self.assert_available(found.generation)?;
        Ok(meta)
    }

    fn meta(&mut self, p: &SecretPrincipal, name: &str) -> Result<SecretMeta, SecretError> {
        self.gate(p, "get", Some(name), &["owner"])?;
        check_name(name)?;
        self.audited(p, AuditAction::Get, Some(name), Vec::new())?;
        let selection = self.select()?;
        self.assert_available(self.generation)?;
        let version = self.generation;
        let found = if selection.backend.is_some() {
            self.merged(&selection)?
                .metas
                .into_iter()
                .find(|m| m.name == name)
        } else {
            None
        };
        self.assert_available(version)?;
        found.ok_or_else(|| no_secret_named(name))
    }

    fn reveal(
        &mut self,
        p: &SecretPrincipal,
        name: &str,
    ) -> Result<(SecretMeta, String), SecretError> {
        self.gate(p, "reveal", Some(name), &["owner"])?;
        self.gate_surface(p, "reveal", Some(name))?;
        check_name(name)?;
        self.audited(p, AuditAction::Reveal, Some(name), Vec::new())?;
        let hit = self.find(name)?.ok_or_else(|| no_secret_named(name))?;
        let meta = self.meta_in(hit.from, name)?.unwrap_or_else(|| SecretMeta {
            name: name.to_owned(),
            backend: self.kind_of(hit.from),
            created_at: String::new(),
            updated_at: String::new(),
            updated_by: None,
            description: None,
        });
        self.assert_available(hit.generation)?;
        Ok((meta, hit.value))
    }

    fn delete(&mut self, p: &SecretPrincipal, name: &str) -> Result<(), SecretError> {
        self.gate(p, "delete", Some(name), &["owner"])?;
        self.gate_surface(p, "delete", Some(name))?;
        check_name(name)?;
        let selection = self.select()?;
        self.need(&selection)?;
        let version = self.generation;
        self.audited(p, AuditAction::Delete, Some(name), Vec::new())?;
        let now = (self.clock)();
        let removed = self.changing(name, |inner| {
            let mut removed = false;
            // The file is all that can be changed while the keyring is away, so a delete there leaves a tombstone: the
            // keyring's older copy would otherwise come back with the keyring.
            let at = (selection.backend == Some(Which::File)).then_some(now);
            for backend in [selection.backend, selection.other].into_iter().flatten() {
                let tombstone = if backend == Which::File { at } else { None };
                if inner.delete_in(backend, name, tombstone)? {
                    removed = true;
                }
                inner.assert_available(version)?;
            }
            if let Some(other) = selection.other {
                if inner.clear_tombstone(other, name).is_err() {
                    inner.warn(
                        "a secret tombstone could not be cleared",
                        json!({ "name": name }),
                    );
                }
            }
            // An entry in the file backend stays on disk when the fallback is switched off or the file is not the
            // backend in use: a delete must not leave it to reappear when the flag is turned back on.
            if selection.backend != Some(Which::File) && selection.other != Some(Which::File) {
                match inner.delete_in(Which::File, name, None) {
                    Ok(true) => removed = true,
                    Ok(false) => {}
                    Err(_) => inner.warn(
                        "file backend copy could not be checked",
                        json!({ "name": name }),
                    ),
                }
            }
            Ok(removed)
        })?;
        self.assert_available(version)?;
        if !removed {
            return Err(no_secret_named(name));
        }
        self.committed.push(name.to_owned());
        Ok(())
    }

    fn list(&mut self, p: &SecretPrincipal) -> Result<Vec<SecretMeta>, SecretError> {
        self.gate(p, "list", None, &["owner"])?;
        let selection = self.select()?;
        let backend = self.need(&selection)?;
        let version = self.generation;
        let kind = self.kind_of(backend);
        self.audited(
            p,
            AuditAction::List,
            None,
            vec![text_detail("backend", kind.as_str())],
        )?;
        let merged = self.merged(&selection)?;
        self.settle(&merged.plan);
        self.assert_available(version)?;
        let mut metas = merged.metas;
        metas.sort_by(|a, b| compare_names(&a.name, &b.name));
        Ok(metas)
    }

    fn lease(
        &mut self,
        p: &SecretPrincipal,
        name: &str,
        options: IssueOptions<'_>,
    ) -> Result<Lease, SecretError> {
        self.gate(p, "lease", Some(name), &["owner", "core"])?;
        check_name(name)?;
        if !is_label(options.purpose) || !is_label(options.profile_id) {
            return Err(SecretError::new(
                SecretErrorCode::InvalidValue,
                "lease purpose and profileId must be short identifiers",
            ));
        }
        let mut detail = vec![
            text_detail("purpose", options.purpose),
            text_detail("profileId", options.profile_id),
        ];
        if let Some(ttl) = options.ttl_ms.and_then(js_number) {
            detail.push(("ttlMs".to_owned(), DetailValue::Num(ttl)));
        }
        self.audited(p, AuditAction::Lease, Some(name), detail)?;
        let hit = self.find(name)?.ok_or_else(|| no_secret_named(name))?;
        self.assert_available(hit.generation)?;
        self.leases.issue(name, &hit.value, options)
    }

    fn read_lease(&mut self, p: &SecretPrincipal, lease_id: &str) -> Result<Lease, SecretError> {
        self.gate(p, "lease.read", None, &["owner", "core"])?;
        self.assert_available(self.generation)?;
        self.audited(
            p,
            AuditAction::LeaseRead,
            None,
            vec![text_detail("leaseId", lease_id)],
        )?;
        self.leases.read(lease_id)
    }

    fn revoke_lease(&mut self, p: &SecretPrincipal, lease_id: &str) -> Result<bool, SecretError> {
        self.gate(p, "lease.revoke", None, &["owner", "core"])?;
        self.audited(
            p,
            AuditAction::LeaseRevoke,
            None,
            vec![text_detail("leaseId", lease_id)],
        )?;
        Ok(self.leases.revoke(lease_id))
    }
}

/// The handle [`SecretStore::on_change`] returns, for [`SecretStore::remove_listener`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ListenerId(u64);

type Listener = Arc<dyn Fn(&str) + Send + Sync>;

/// `createSecretStore(options)`.
pub struct SecretStore {
    inner: Mutex<Inner>,
    redaction: Arc<SecretSet>,
    listeners: Mutex<(u64, Vec<(u64, Listener)>)>,
}

impl SecretStore {
    /// A store over the two backends. Nothing is read until [`preload_redaction`](Self::preload_redaction) or the first
    /// operation.
    pub fn new(options: SecretStoreOptions) -> SecretStore {
        let clock = options.clock.clone();
        let leases = LeaseTable::new(Box::new(move || clock()), options.random);
        SecretStore {
            redaction: options.redaction.clone(),
            listeners: Mutex::new((0, Vec::new())),
            inner: Mutex::new(Inner {
                keyring: options.keyring,
                file: options.file,
                file_fallback: options.file_fallback,
                audit: options.audit,
                clock: options.clock,
                monotonic: options.monotonic,
                logger: options.logger,
                redaction: options.redaction,
                leases,
                options: options.startup,
                startup_values: Vec::new(),
                preloaded: false,
                startup: StartupStatus {
                    state: StartupState::Idle,
                    reason: None,
                    safe_to_flush: false,
                },
                generation: 0,
                retry_at: 0.0,
                keyring_ready: false,
                file_ready: false,
                last_kind: None,
                closed: false,
                committed: Vec::new(),
                effects: Effects::default(),
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Runs one operation under the lock, then tells the listeners what it committed (names only; a listener cannot
    /// change or delay the operation, and may call the store).
    fn run<T>(&self, operation: impl FnOnce(&mut Inner) -> T) -> T {
        let (answer, committed) = {
            let mut inner = self.lock();
            // A helper that went away while no call was in flight: every lease is gone before this operation looks.
            inner.absorb();
            let answer = operation(&mut inner);
            (answer, std::mem::take(&mut inner.committed))
        };
        if !committed.is_empty() {
            let listeners: Vec<Listener> = self
                .listeners
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .1
                .iter()
                .map(|(_, listener)| listener.clone())
                .collect();
            for name in &committed {
                for listener in &listeners {
                    // Observers cannot change a committed mutation, and one that fails does not silence the others.
                    let _ = catch_unwind(AssertUnwindSafe(|| listener(name)));
                }
            }
        }
        answer
    }

    /// The registry every value of this store is registered with.
    pub fn redaction(&self) -> &Arc<SecretSet> {
        &self.redaction
    }

    /// `preloadRedaction()`: trusted in-process, idempotent initialisation: reads every value once and registers it. No
    /// plaintext result, migration, audit access or lease.
    pub fn preload_redaction(&self) {
        self.run(|inner| {
            if !inner.preloaded
                || (inner.startup.state == StartupState::Unavailable
                    && (inner.monotonic)() >= inner.retry_at)
            {
                inner.begin_preload();
            }
        });
    }

    /// `startupStatus()`.
    pub fn startup_status(&self) -> StartupStatus {
        self.run(|inner| inner.startup)
    }

    /// `backendUnavailable()`: a runtime I/O failure invalidates every in-flight release before helpers are retired.
    pub fn backend_unavailable(&self) {
        self.run(|inner| inner.backend_unavailable(StartupReason::BackendUnavailable));
    }

    /// `close()`: every lease is revoked, the helpers are closed; later operations are `backend-unavailable`.
    pub fn close(&self) {
        self.run(|inner| {
            if inner.closed {
                return;
            }
            inner.closed = true;
            inner.generation += 1;
            inner.effects.all = true;
            inner.startup = StartupStatus {
                state: StartupState::Closed,
                reason: None,
                safe_to_flush: false,
            };
            for lease in inner.leases.active() {
                inner.leases.revoke(&lease.lease_id);
            }
            if let Some(close) = inner.options.close.as_mut() {
                close();
            }
        });
    }

    /// `onChange(listener)`: called with the name after a `set` or a `delete` was committed.
    pub fn on_change(&self, listener: Box<dyn Fn(&str) + Send + Sync>) -> ListenerId {
        let mut listeners = self
            .listeners
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let id = listeners.0;
        listeners.0 += 1;
        listeners.1.push((id, Arc::from(listener)));
        ListenerId(id)
    }

    /// Ends a subscription of [`on_change`](Self::on_change).
    pub fn remove_listener(&self, id: ListenerId) {
        self.listeners
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .1
            .retain(|(n, _)| *n != id.0);
    }

    /// `status(p)`: which backend serves, what the owner can see. Not audited; brings the keyring in line when the file
    /// holds something newer.
    pub fn status(&self, p: &SecretPrincipal) -> Result<SecretStatus, SecretError> {
        self.run(|inner| inner.status(p))
    }

    /// `set(p, name, value, description)`: `description` not given keeps the stored one; an empty one removes it.
    pub fn set(
        &self,
        p: &SecretPrincipal,
        name: &str,
        value: &str,
        description: Option<&str>,
    ) -> Result<SecretMeta, SecretError> {
        self.run(|inner| inner.set(p, name, value, description))
    }

    /// `describe(p, name, description)`: owner-only metadata edit; the value is not written and its leases stay.
    pub fn describe(
        &self,
        p: &SecretPrincipal,
        name: &str,
        description: &str,
    ) -> Result<SecretMeta, SecretError> {
        self.run(|inner| inner.describe(p, name, description))
    }

    /// `meta(p, name)`: metadata only; no value is read.
    pub fn meta(&self, p: &SecretPrincipal, name: &str) -> Result<SecretMeta, SecretError> {
        self.run(|inner| inner.meta(p, name))
    }

    /// `reveal(p, name)`: the one call that returns a value to the owner.
    pub fn reveal(
        &self,
        p: &SecretPrincipal,
        name: &str,
    ) -> Result<(SecretMeta, String), SecretError> {
        self.run(|inner| inner.reveal(p, name))
    }

    /// `delete(p, name)`: removes the name from every backend; `not-found` when none held it.
    pub fn delete(&self, p: &SecretPrincipal, name: &str) -> Result<(), SecretError> {
        self.run(|inner| inner.delete(p, name))
    }

    /// `list(p)`: names and metadata, never values.
    pub fn list(&self, p: &SecretPrincipal) -> Result<Vec<SecretMeta>, SecretError> {
        self.run(|inner| inner.list(p))
    }

    /// `lease(p, name, options)`: a short-lived, revocable lease (ADR-005 action 6).
    pub fn lease(
        &self,
        p: &SecretPrincipal,
        name: &str,
        options: IssueOptions<'_>,
    ) -> Result<Lease, SecretError> {
        self.run(|inner| inner.lease(p, name, options))
    }

    /// [`lease`](Self::lease) for a holder outside this store: the same gate, the same record, the same read, and the
    /// lease leaves the table. Its holder keeps it, lets it expire and revokes it; this store tells the holder what
    /// makes it void ([`drain_effects`](Self::drain_effects)). Nothing is recorded for the hand-over.
    pub fn lease_out(
        &self,
        p: &SecretPrincipal,
        name: &str,
        options: IssueOptions<'_>,
    ) -> Result<Lease, SecretError> {
        self.run(|inner| {
            let lease = inner.lease(p, name, options)?;
            inner.leases.revoke(&lease.lease_id);
            Ok(lease)
        })
    }

    /// Takes what has not been told yet ([`Effects`]) and forgets it.
    pub fn drain_effects(&self) -> Effects {
        self.run(|inner| std::mem::take(&mut inner.effects))
    }

    /// Whether there is something [`drain_effects`](Self::drain_effects) would hand out. For an owner that changed
    /// the store itself and has to tell the holder outside to come and fetch it.
    pub fn has_effects(&self) -> bool {
        self.run(|inner| {
            inner.effects.all
                || !inner.effects.names.is_empty()
                || inner.effects.preloaded.is_some()
        })
    }

    /// The start-up snapshot as it is now: every value a preload read (the registry masks them as one group).
    pub fn startup_values(&self) -> Vec<String> {
        self.run(|inner| inner.startup_values.clone())
    }

    /// `readLease(p, leaseId)`: re-reads a live lease.
    pub fn read_lease(&self, p: &SecretPrincipal, lease_id: &str) -> Result<Lease, SecretError> {
        self.run(|inner| inner.read_lease(p, lease_id))
    }

    /// `revokeLease(p, leaseId)`: false when there was no such lease.
    pub fn revoke_lease(&self, p: &SecretPrincipal, lease_id: &str) -> Result<bool, SecretError> {
        self.run(|inner| inner.revoke_lease(p, lease_id))
    }

    /// `activeLeases(p)`: the live leases, without values.
    pub fn active_leases(&self, p: &SecretPrincipal) -> Result<Vec<LeaseInfo>, SecretError> {
        self.run(|inner| {
            inner.gate(p, "lease.list", None, &["owner", "core"])?;
            Ok(inner.leases.active())
        })
    }
}
