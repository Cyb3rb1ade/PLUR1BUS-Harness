//! `identity/ratelimit.ts`: the brute-force limiter as arithmetic over a row and a clock, behind [`AttemptStore`] (the
//! `attempts` table of `identity.sqlite`, which P4-12 task 4 puts SQLite behind). Times are epoch milliseconds as `i64`
//! (the column is `INTEGER`); sums saturate instead of overflowing.
use std::collections::BTreeMap;

/// `LimitSpec`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LimitSpec {
    /// Failures in one window that lock the key.
    pub limit: i64,
    /// The window, in milliseconds, counted from the first failure.
    pub window_ms: i64,
    /// How long a lock lasts.
    pub lock_ms: i64,
}

/// 5 failures per handle per 15 minutes, lock 15 minutes (`SOURCE_LIMIT`).
pub const SOURCE_LIMIT: LimitSpec = LimitSpec {
    limit: 5,
    window_ms: 15 * 60_000,
    lock_ms: 15 * 60_000,
};
/// 20 failures over every handle together per 15 minutes, lock 15 minutes (`GLOBAL_LIMIT`).
pub const GLOBAL_LIMIT: LimitSpec = LimitSpec {
    limit: 20,
    window_ms: 15 * 60_000,
    lock_ms: 15 * 60_000,
};
/// The key of the overall counter (`GLOBAL_KEY`).
pub const GLOBAL_KEY: &str = "global";
/// A row older than this (window start) and not locked any more is pruned.
pub const PRUNE_AFTER_MS: i64 = 24 * 3_600_000;

/// One row of `attempts`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AttemptRow {
    /// Failures counted in the current window.
    pub failures: i64,
    /// Start of the current window.
    pub window_start: i64,
    /// End of the lock; a lock is running while this is above the clock.
    pub locked_until: i64,
}

/// The `attempts` table: one row per key.
pub trait AttemptStore {
    /// What the store can fail with (SQLite for the real one).
    type Error;
    /// `SELECT failures, window_start, locked_until FROM attempts WHERE key = ?`.
    fn get(&self, key: &str) -> Result<Option<AttemptRow>, Self::Error>;
    /// The upsert: insert the row or replace all three columns.
    fn put(&mut self, key: &str, row: AttemptRow) -> Result<(), Self::Error>;
    /// `DELETE FROM attempts WHERE key = ?`.
    fn delete(&mut self, key: &str) -> Result<(), Self::Error>;
    /// `DELETE FROM attempts WHERE locked_until < ? AND window_start < ?`.
    fn prune_rows(&mut self, locked_before: i64, window_before: i64) -> Result<(), Self::Error>;
}

/// The row after one more failure at `now`.
pub fn failure_row(prev: Option<AttemptRow>, spec: &LimitSpec, now: i64) -> AttemptRow {
    let in_window = prev.filter(|r| now.saturating_sub(r.window_start) <= spec.window_ms);
    let (mut failures, mut start) = match in_window {
        Some(r) => (r.failures, r.window_start),
        None => (0, now),
    };
    failures = failures.saturating_add(1);
    let mut locked_until = prev.map_or(0, |r| r.locked_until);
    if failures >= spec.limit {
        locked_until = now.saturating_add(spec.lock_ms);
        failures = 0;
        start = now;
    }
    AttemptRow {
        failures,
        window_start: start,
        locked_until,
    }
}

/// The row `release` writes, `None` when it changes nothing. Only an event of the current window can be taken back; reaching the
/// limit locks and resets the count, so a lock that is still running is that last event and is lifted with it.
pub fn release_row(
    prev: Option<AttemptRow>,
    spec: &LimitSpec,
    event_at: i64,
    now: i64,
) -> Option<AttemptRow> {
    let r = prev?;
    if event_at < now.saturating_sub(spec.window_ms) {
        return None;
    }
    if r.failures > 0 && now.saturating_sub(r.window_start) <= spec.window_ms {
        Some(AttemptRow {
            failures: r.failures - 1,
            ..r
        })
    } else if r.failures == 0 && r.locked_until > now {
        Some(AttemptRow {
            failures: spec.limit.saturating_sub(1),
            window_start: r.window_start,
            locked_until: 0,
        })
    } else {
        None
    }
}

/// `lockedFor(keys)`: milliseconds until every one of `keys` accepts a claim again; 0 when none is locked.
pub fn locked_for<S: AttemptStore>(store: &S, keys: &[&str], now: i64) -> Result<i64, S::Error> {
    let mut wait = 0;
    for key in keys {
        if let Some(r) = store.get(key)? {
            if r.locked_until > now {
                wait = wait.max(r.locked_until - now);
            }
        }
    }
    Ok(wait)
}

/// `failure(key, spec)`.
pub fn failure<S: AttemptStore>(
    store: &mut S,
    key: &str,
    spec: &LimitSpec,
    now: i64,
) -> Result<(), S::Error> {
    let row = failure_row(store.get(key)?, spec, now);
    store.put(key, row)
}

/// `success(key)`: forgets the key's failures (and a lock).
pub fn success<S: AttemptStore>(store: &mut S, key: &str) -> Result<(), S::Error> {
    store.delete(key)
}

/// `release(key, spec, eventAt)`: takes back one counted event that turned out legitimate.
pub fn release<S: AttemptStore>(
    store: &mut S,
    key: &str,
    spec: &LimitSpec,
    event_at: i64,
    now: i64,
) -> Result<(), S::Error> {
    match release_row(store.get(key)?, spec, event_at, now) {
        Some(row) => store.put(key, row),
        None => Ok(()),
    }
}

/// `prune()`: rows whose lock has ended and whose window began over a day ago.
pub fn prune<S: AttemptStore>(store: &mut S, now: i64) -> Result<(), S::Error> {
    store.prune_rows(now, now.saturating_sub(PRUNE_AFTER_MS))
}

/// An in-memory `attempts` table (the keys in byte order, as SQLite's `ORDER BY key` gives them).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MemoryAttempts {
    /// The rows by key.
    pub rows: BTreeMap<String, AttemptRow>,
}

impl AttemptStore for MemoryAttempts {
    type Error = std::convert::Infallible;
    fn get(&self, key: &str) -> Result<Option<AttemptRow>, Self::Error> {
        Ok(self.rows.get(key).copied())
    }
    fn put(&mut self, key: &str, row: AttemptRow) -> Result<(), Self::Error> {
        self.rows.insert(key.to_owned(), row);
        Ok(())
    }
    fn delete(&mut self, key: &str) -> Result<(), Self::Error> {
        self.rows.remove(key);
        Ok(())
    }
    fn prune_rows(&mut self, locked_before: i64, window_before: i64) -> Result<(), Self::Error> {
        self.rows
            .retain(|_, r| !(r.locked_until < locked_before && r.window_start < window_before));
        Ok(())
    }
}
