//! The refresh owner when a port panics in the middle of an exchange, and when an exchange outlasts the wait (review C,
//! RC-4). TypeScript takes any throw of the refresher as `transient`, any throw of the store as a failed read or write, and
//! releases the shared flight in `finally` whatever happened; here no caller may hang on a handle whose exchange died, and
//! no caller waits past the owner's wait limit. Callers run on their own threads and are collected with a deadline, so a
//! regression shows as a failed assertion, not as a hung test.
use super::errors::{AuthError, AuthErrorCode};
use super::ports::AuthLog;
use super::profile::{validate_profile, AuthProfile};
use super::record::SecretStore;
use super::refresh::{
    FreshRecord, NoTimer, RefreshOwner, RefreshOwnerOptions, RefreshRejected, RefreshResult,
    Refresher,
};
use super::secret::Secret;
use super::testing::{Draws, FakeClock, MemStore};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::{Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const T0: f64 = 1_700_000_000_000.0;
const R: &str = "o/1";

fn leak<T>(v: T) -> &'static T {
    Box::leak(Box::new(v))
}

/// A door the first exchange waits at, so the other callers can line up behind it.
#[derive(Default)]
struct Door(Mutex<bool>, Condvar);

impl Door {
    fn pass(&self) {
        let mut open = self.0.lock().unwrap();
        while !*open {
            open = self.1.wait(open).unwrap();
        }
    }
    fn open(&self) {
        *self.0.lock().unwrap() = true;
        self.1.notify_all();
    }
}

/// The refresher: the first call waits at the door, then panics when `panic_first` is set; every call answers a rotated
/// token pair numbered by the call.
#[derive(Default)]
struct Port {
    door: Door,
    panic_first: AtomicBool,
    calls: AtomicU32,
}

impl Refresher for Port {
    fn refresh(&self, _p: &AuthProfile, _t: &Secret) -> Result<RefreshResult, RefreshRejected> {
        let n = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        if n == 1 {
            self.door.pass();
            if self.panic_first.load(Ordering::SeqCst) {
                panic!("the refresher port failed");
            }
        }
        Ok(RefreshResult {
            access_token: Secret::new(format!("new-at-{n}")),
            refresh_token: Some(Secret::new(format!("new-rt-{n}"))),
            expires_in_seconds: Some(3600.0),
            refresh_expires_in_seconds: None,
        })
    }
}

/// The store, panicking on the next `get` or `set` when asked to.
#[derive(Default)]
struct Store {
    inner: MemStore,
    panic_get: AtomicBool,
    panic_set: AtomicBool,
}

impl SecretStore for Store {
    fn get(&self, r: &str) -> Result<Option<Secret>, AuthError> {
        if self.panic_get.swap(false, Ordering::SeqCst) {
            panic!("the store port failed reading");
        }
        self.inner.get(r)
    }
    fn set(&self, r: &str, v: &Secret) -> Result<(), AuthError> {
        if self.panic_set.swap(false, Ordering::SeqCst) {
            panic!("the store port failed writing");
        }
        self.inner.set(r, v)
    }
    fn delete(&self, r: &str) -> Result<(), AuthError> {
        self.inner.delete(r)
    }
}

/// A log sink that, once, waits at its door on `event` and then panics (a port TypeScript does not guard either).
#[derive(Default)]
struct Log {
    panic_on: Mutex<Option<&'static str>>,
    door: Door,
}

impl AuthLog for Log {
    fn log(&self, event: &str, _fields: &[(&str, Value)]) {
        let mut on = self.panic_on.lock().unwrap();
        if *on == Some(event) {
            *on = None;
            drop(on);
            self.door.pass();
            panic!("the log port failed");
        }
    }
}

struct Rig {
    owner: &'static RefreshOwner<'static>,
    port: &'static Port,
    store: &'static Store,
    log: &'static Log,
    clock: &'static FakeClock,
    profile: &'static AuthProfile,
}

fn rig(wait_limit: Option<Duration>) -> Rig {
    let port = leak(Port::default());
    let store = leak(Store::default());
    let log = leak(Log::default());
    let clock = leak(FakeClock::at(T0));
    store.inner.put(
        R,
        &format!(
            "{{\"v\":1,\"accessToken\":\"old-at\",\"refreshToken\":\"old-rt\",\"expiresAt\":{},\"generation\":0}}",
            T0 - 1000.0
        ),
    );
    let owner = RefreshOwner::new(RefreshOwnerOptions {
        store,
        clock,
        refresher: port,
        log: Some(log),
        timer: leak(NoTimer),
        random: leak(Draws::of(&[0.0])),
    });
    let owner = leak(match wait_limit {
        Some(l) => owner.with_wait_limit(l),
        None => owner,
    });
    let profile = leak(
        validate_profile(&json!({ "id": "e:oauth", "display_name": "Example IdP", "kind": "oauth_pkce",
            "capabilities": ["chat"], "auth_header_scheme": "Authorization: Bearer {token}",
            "authorization_endpoint": "https://idp.example/authorize", "token_endpoint": "https://idp.example/token",
            "policy_status": "allowed", "policy_source": "https://idp.example/policy", "policy_checked": "2026-11-01" }))
        .unwrap(),
    );
    Rig {
        owner,
        port,
        store,
        log,
        clock,
        profile,
    }
}

/// What one caller ended with: its answer, or `None` when its own thread panicked.
type Answer = Option<Result<FreshRecord, AuthError>>;

/// Starts `n` callers of `fresh` on their own threads.
fn start(r: &Rig, n: usize) -> mpsc::Receiver<Answer> {
    let (tx, rx) = mpsc::channel();
    for _ in 0..n {
        let (owner, profile, tx) = (r.owner, r.profile, tx.clone());
        thread::spawn(move || {
            let answer = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                owner.fresh(profile, R, "c1")
            }));
            let _ = tx.send(answer.ok());
        });
    }
    rx
}

/// Collects `n` answers; panics when one does not come within `within`.
fn collect(rx: &mpsc::Receiver<Answer>, n: usize, within: Duration, what: &str) -> Vec<Answer> {
    let end = Instant::now() + within;
    (0..n)
        .map(|i| {
            rx.recv_timeout(end.saturating_duration_since(Instant::now()))
                .unwrap_or_else(|_| {
                    panic!("{what}: caller {i} of {n} did not return within {within:?}")
                })
        })
        .collect()
}

/// Runs `n` callers at once with the first exchange held at the door until the other `n - 1` wait for it.
fn line_up(r: &Rig, n: usize, what: &str) -> Vec<Answer> {
    let rx = start(r, n);
    let t0 = Instant::now();
    while r.owner.waiting(R) < n - 1 && t0.elapsed() < Duration::from_secs(10) {
        thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(
        r.owner.waiting(R),
        n - 1,
        "{what}: the others join the one exchange"
    );
    r.port.door.open();
    collect(&rx, n, Duration::from_secs(10), what)
}

fn code(a: &Answer) -> Option<AuthErrorCode> {
    a.as_ref().and_then(|x| x.as_ref().err()).map(|e| e.code)
}

fn token(a: &Answer) -> Option<String> {
    a.as_ref()
        .and_then(|x| x.as_ref().ok())
        .map(|f| f.record.access_token.expose().to_owned())
}

#[test]
fn a_panicking_refresher_is_a_transient_failure_for_every_caller() {
    for n in [3usize, 64] {
        let what = format!("{n} callers");
        let r = rig(None);
        r.port.panic_first.store(true, Ordering::SeqCst);
        let answers = line_up(&r, n, &what);
        // The token has expired, so a transient failure is a retryable `refresh_failed` with the backoff, for the caller
        // that ran the exchange and for everyone who waited for it; nobody's thread dies.
        for a in &answers {
            assert_eq!(code(a), Some(AuthErrorCode::RefreshFailed), "{what}: {a:?}");
            let e = a.as_ref().unwrap().as_ref().unwrap_err();
            assert!(
                e.retryable && e.retry_after_ms.is_some_and(|ms| ms > 0.0),
                "{what}"
            );
        }
        assert_eq!(
            r.port.calls.load(Ordering::SeqCst),
            1,
            "{what}: one exchange"
        );
        // Later callers inside the backoff get the same error at once, without a second exchange, as in TypeScript.
        let later = collect(&start(&r, n), n, Duration::from_secs(5), &what);
        assert!(
            later
                .iter()
                .all(|a| code(a) == Some(AuthErrorCode::RefreshFailed)),
            "{what}"
        );
        assert_eq!(
            r.port.calls.load(Ordering::SeqCst),
            1,
            "{what}: no exchange in the backoff"
        );
        // After the backoff the next caller exchanges again and gets the new token.
        r.clock.advance(2000.0);
        let again = collect(&start(&r, 1), 1, Duration::from_secs(5), &what);
        assert_eq!(token(&again[0]).as_deref(), Some("new-at-2"), "{what}");
    }
}

#[test]
fn a_store_that_panics_while_writing_keeps_the_rotated_record() {
    for n in [3usize, 64] {
        let what = format!("{n} callers");
        let r = rig(None);
        r.store.panic_set.store(true, Ordering::SeqCst);
        let answers = line_up(&r, n, &what);
        // A refused write of the rotated record, as when the store throws in TypeScript: everyone gets the retryable
        // `persist_failed`, the record is held in memory, and the old refresh token is never presented again.
        assert!(
            answers
                .iter()
                .all(|a| code(a) == Some(AuthErrorCode::PersistFailed)),
            "{what}: {:?}",
            answers.iter().map(code).collect::<Vec<_>>()
        );
        let later = collect(&start(&r, 1), 1, Duration::from_secs(5), &what);
        assert_eq!(token(&later[0]).as_deref(), Some("new-at-1"), "{what}");
        assert_eq!(
            r.port.calls.load(Ordering::SeqCst),
            1,
            "{what}: one exchange"
        );
        assert!(
            r.store.inner.read(R).unwrap().contains("new-rt-1"),
            "{what}"
        );
    }
}

#[test]
fn a_store_that_panics_while_reading_is_an_unreadable_record() {
    let r = rig(None);
    r.store.panic_get.store(true, Ordering::SeqCst);
    let first = collect(&start(&r, 1), 1, Duration::from_secs(5), "read");
    assert_eq!(code(&first[0]), Some(AuthErrorCode::InvalidSecretRecord));
    r.port.door.open();
    let again = collect(&start(&r, 1), 1, Duration::from_secs(5), "read");
    assert_eq!(token(&again[0]).as_deref(), Some("new-at-1"));
}

#[test]
fn a_port_panic_nobody_catches_still_releases_the_handle() {
    for n in [3usize, 64] {
        let what = format!("{n} callers");
        let r = rig(None);
        // The log port panics on the event the exchange writes first; TypeScript does not guard that call either, so the
        // caller running the exchange fails with it, and the flight is released all the same.
        *r.log.panic_on.lock().unwrap() = Some("auth.refresh.start");
        r.port.door.open();
        let rx = start(&r, n);
        let t0 = Instant::now();
        while r.owner.waiting(R) < n - 1 && t0.elapsed() < Duration::from_secs(10) {
            thread::sleep(Duration::from_millis(1));
        }
        assert_eq!(
            r.owner.waiting(R),
            n - 1,
            "{what}: the others join the one exchange"
        );
        r.log.door.open();
        let answers = collect(&rx, n, Duration::from_secs(10), &what);
        let died = answers.iter().filter(|a| a.is_none()).count();
        assert_eq!(
            died, 1,
            "{what}: only the caller running the exchange fails with the panic"
        );
        for a in answers.iter().flatten() {
            let e = a.as_ref().unwrap_err();
            assert!(
                e.code == AuthErrorCode::RefreshFailed && e.retryable,
                "{what}: {e:?}"
            );
        }
        assert_eq!(
            r.port.calls.load(Ordering::SeqCst),
            0,
            "{what}: the exchange died before the refresher"
        );
        // The handle is free again: the next callers run one new exchange and all get its token.
        let later = collect(&start(&r, n), n, Duration::from_secs(10), &what);
        assert!(
            later
                .iter()
                .all(|a| token(a).as_deref() == Some("new-at-1")),
            "{what}: later callers get a token"
        );
        assert_eq!(r.port.calls.load(Ordering::SeqCst), 1, "{what}");
    }
}

/// Review C, RC-5: `rec.refreshExpiresAt !== undefined && !res.refreshToken ? { refreshExpiresAt: rec.refreshExpiresAt }`;
/// an empty rotated token is falsy, so the known end of the refresh token is kept. `HttpRefresher` never answers "" (its
/// token parser refuses it); another `Refresher` port can.
#[test]
fn an_empty_rotated_refresh_token_keeps_the_known_end() {
    struct Empty;
    impl Refresher for Empty {
        fn refresh(&self, _p: &AuthProfile, _t: &Secret) -> Result<RefreshResult, RefreshRejected> {
            Ok(RefreshResult {
                access_token: Secret::new("new-at"),
                refresh_token: Some(Secret::new("")),
                expires_in_seconds: Some(3600.0),
                refresh_expires_in_seconds: None,
            })
        }
    }
    let r = rig(None);
    let end = T0 + 9_000_000.0;
    r.store.inner.put(
        R,
        &format!(
            "{{\"v\":1,\"accessToken\":\"old-at\",\"refreshToken\":\"old-rt\",\"expiresAt\":{},\"refreshExpiresAt\":{end},\"generation\":0}}",
            T0 - 1000.0
        ),
    );
    let draws = Draws::of(&[0.0]);
    let owner = RefreshOwner::new(RefreshOwnerOptions {
        store: r.store,
        clock: r.clock,
        refresher: &Empty,
        log: None,
        timer: &NoTimer,
        random: &draws,
    });
    let got = owner.fresh(r.profile, R, "c1").unwrap();
    assert_eq!(got.record.refresh_expires_at, Some(end));
    let stored = r.store.inner.read(R).unwrap();
    assert!(
        stored.contains(&format!("\"refreshExpiresAt\":{end}")),
        "{stored}"
    );
    assert!(stored.contains("\"refreshToken\":\"\""), "{stored}");
}

#[test]
fn no_caller_waits_past_the_wait_limit() {
    let r = rig(Some(Duration::from_millis(100)));
    let rx = start(&r, 4);
    let t0 = Instant::now();
    while r.owner.waiting(R) < 3 && t0.elapsed() < Duration::from_secs(10) {
        thread::sleep(Duration::from_millis(1));
    }
    assert_eq!(r.owner.waiting(R), 3);
    // The exchange is still held at the door; the three waiters give up with a retryable `refresh_failed`.
    let waited = collect(&rx, 3, Duration::from_secs(5), "wait limit");
    assert!(t0.elapsed() < Duration::from_secs(5));
    for a in &waited {
        let e = a.as_ref().unwrap().as_ref().unwrap_err();
        assert!(
            e.code == AuthErrorCode::RefreshFailed && e.retryable,
            "{e:?}"
        );
    }
    assert_eq!(r.owner.waiting(R), 0);
    // The exchange itself finishes and persists; the next caller finds its result without a second exchange.
    r.port.door.open();
    let runner = collect(&rx, 1, Duration::from_secs(5), "wait limit");
    assert_eq!(token(&runner[0]).as_deref(), Some("new-at-1"));
    let later = collect(&start(&r, 1), 1, Duration::from_secs(5), "wait limit");
    assert_eq!(token(&later[0]).as_deref(), Some("new-at-1"));
    assert_eq!(r.port.calls.load(Ordering::SeqCst), 1);
}
