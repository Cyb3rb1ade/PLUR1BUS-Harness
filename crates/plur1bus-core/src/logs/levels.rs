//! `levels.ts`: the live level policy. The default and per-source levels, the precedence of a more specific key, and the
//! `trace` level, which needs a future expiry within 24 hours and falls back to `debug` once, with one expiry event.
use super::error::LogError;
use plur1bus_log_schema::{is_source_key, Level};
use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

/// A clock: milliseconds since the Unix epoch (`Date.now`). Every time-dependent type takes one, so a test injects its own.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// The system clock.
pub fn system_clock() -> Clock {
    Arc::new(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
            .unwrap_or(0)
    })
}

/// Who writes: a catalogued kind, an id and an optional version (`Source` of `levels.ts`).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Source {
    /// One of the source kinds of the record schema (`harness`, `extension`, `provider`, ...).
    pub kind: String,
    /// The component's id.
    pub id: String,
    /// Its version, if it has one.
    pub version: Option<String>,
}

impl Source {
    /// A source from its three parts.
    pub fn new(kind: &str, id: &str, version: Option<&str>) -> Source {
        Source {
            kind: kind.to_string(),
            id: id.to_string(),
            version: version.map(str::to_string),
        }
    }
}

/// The snapshot a policy is updated with (`LevelSettings`). An absent default is `info`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LevelSettings {
    /// The level of every source no override matches.
    pub default_level: Option<Level>,
    /// Overrides by source key (`<kind>` or `<kind>:<id>`; a key also covers `<key>/...`).
    pub levels: BTreeMap<String, Level>,
    /// When the `trace` level lapses (ms since the epoch); required while any level is `trace`.
    pub trace_until: Option<i64>,
}

const DAY_MS: i64 = 86_400_000;

/// Called once per source key when its `trace` level lapses.
pub type ExpiredHook = Box<dyn FnMut(&str) + Send>;

/// The policy: replaced atomically by [`update`](LevelPolicy::update), asked by [`resolve`](LevelPolicy::resolve).
pub struct LevelPolicy {
    settings: LevelSettings,
    expired_keys: HashSet<String>,
    now: Clock,
    expired: Option<ExpiredHook>,
}

impl LevelPolicy {
    /// A policy at `info` with no overrides. `expired` is called once per source key when its `trace` level lapses.
    pub fn new(now: Clock, expired: Option<ExpiredHook>) -> LevelPolicy {
        LevelPolicy {
            settings: LevelSettings {
                default_level: Some(Level::Info),
                ..LevelSettings::default()
            },
            expired_keys: HashSet::new(),
            now,
            expired,
        }
    }

    /// Replaces the snapshot atomically: removing an override restores its parent or the default at once. Invalid
    /// settings change nothing.
    pub fn update(&mut self, next: &LevelSettings) -> Result<(), LogError> {
        for key in next.levels.keys() {
            if !is_source_key(key) {
                return Err(LogError::Range("invalid source level".into()));
            }
        }
        let has_trace = next.default_level == Some(Level::Trace)
            || next.levels.values().any(|l| *l == Level::Trace);
        if has_trace {
            let now = (self.now)();
            match next.trace_until {
                Some(until) if until > now && until <= now + DAY_MS => {}
                _ => {
                    return Err(LogError::Range(
                        "trace requires a future expiry within 24 hours".into(),
                    ))
                }
            }
        }
        self.settings = next.clone();
        self.expired_keys.clear();
        Ok(())
    }

    /// The level for `source`; a lapsed `trace` answers `debug` and is reported once through the `expired` callback.
    pub fn resolve(&mut self, source: &Source) -> Level {
        let mut reported = Vec::new();
        let level = self.resolve_reporting(source, &mut reported);
        if let Some(callback) = self.expired.as_mut() {
            for key in &reported {
                callback(key);
            }
        }
        level
    }

    /// [`resolve`](Self::resolve) that hands the newly lapsed source key to the caller instead of the callback (a writer
    /// emits its expiry record itself, while it holds its own state).
    pub fn resolve_reporting(&mut self, source: &Source, expired: &mut Vec<String>) -> Level {
        let key = format!("{}:{}", source.kind, source.id);
        let best = self
            .settings
            .levels
            .keys()
            .filter(|k| **k == source.kind || **k == key || key.starts_with(&format!("{k}/")))
            .max_by_key(|k| k.len());
        let level = best
            .and_then(|k| self.settings.levels.get(k).copied())
            .or(self.settings.default_level)
            .unwrap_or(Level::Info);
        if level == Level::Trace
            && self
                .settings
                .trace_until
                .is_some_and(|until| (self.now)() >= until)
        {
            if self.expired_keys.insert(key.clone()) {
                expired.push(key);
            }
            return Level::Debug;
        }
        level
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI64, Ordering};

    fn clock(start: i64) -> (Clock, Arc<AtomicI64>) {
        let t = Arc::new(AtomicI64::new(start));
        let c = t.clone();
        (Arc::new(move || c.load(Ordering::SeqCst)), t)
    }

    fn src(kind: &str, id: &str) -> Source {
        Source::new(kind, id, None)
    }

    /// `writer.test.ts`: "live precedence, trace admission and one expiry without config mutation".
    #[test]
    fn precedence_trace_admission_and_one_expiry() {
        let (now, t) = clock(1_000_000);
        let expired = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let sink = expired.clone();
        let mut p = LevelPolicy::new(
            now,
            Some(Box::new(move |k| sink.lock().unwrap().push(k.to_string()))),
        );
        let levels: BTreeMap<String, Level> = [
            ("extension", Level::Error),
            ("extension:mcp-server", Level::Debug),
            ("extension:mcp-server/a", Level::Info),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
        p.update(&LevelSettings {
            default_level: Some(Level::Warn),
            levels,
            trace_until: None,
        })
        .unwrap();
        assert_eq!(p.resolve(&src("extension", "mcp-server/a")), Level::Info);
        assert_eq!(p.resolve(&src("extension", "mcp-server/b")), Level::Debug);
        assert_eq!(p.resolve(&src("extension", "mcp-serverx")), Level::Error);
        let trace = |until| LevelSettings {
            default_level: Some(Level::Trace),
            trace_until: until,
            ..LevelSettings::default()
        };
        assert!(p.update(&trace(None)).is_err());
        assert!(p.update(&trace(Some(1_000_000 + 86_400_001))).is_err());
        assert!(
            p.update(&trace(Some(1_000_000))).is_err(),
            "not in the future"
        );
        p.update(&trace(Some(1_000_000 + 1000))).unwrap();
        t.store(1_001_001, Ordering::SeqCst);
        assert_eq!(p.resolve(&src("harness", "core")), Level::Debug);
        assert_eq!(p.resolve(&src("harness", "core")), Level::Debug);
        assert_eq!(*expired.lock().unwrap(), vec!["harness:core"]);
        p.update(&LevelSettings {
            default_level: Some(Level::Info),
            ..LevelSettings::default()
        })
        .unwrap();
        assert_eq!(p.resolve(&src("harness", "core")), Level::Info);
    }

    #[test]
    fn an_invalid_update_changes_nothing_and_a_source_key_must_be_well_formed() {
        let (now, _) = clock(0);
        let mut p = LevelPolicy::new(now, None);
        p.update(&LevelSettings {
            default_level: Some(Level::Warn),
            ..LevelSettings::default()
        })
        .unwrap();
        let bad = LevelSettings {
            default_level: Some(Level::Debug),
            levels: [("bad key!".to_string(), Level::Info)]
                .into_iter()
                .collect(),
            trace_until: None,
        };
        assert_eq!(
            p.update(&bad).unwrap_err().to_string(),
            "invalid source level"
        );
        assert_eq!(p.resolve(&src("harness", "core")), Level::Warn);
    }

    #[test]
    fn no_default_means_info_and_a_lapsed_override_is_reported_per_key() {
        let (now, t) = clock(10);
        let mut p = LevelPolicy::new(now, None);
        p.update(&LevelSettings {
            default_level: None,
            levels: [("provider:a".to_string(), Level::Trace)]
                .into_iter()
                .collect(),
            trace_until: Some(20),
        })
        .unwrap();
        let mut seen = Vec::new();
        assert_eq!(
            p.resolve_reporting(&src("provider", "a"), &mut seen),
            Level::Trace
        );
        assert_eq!(
            p.resolve_reporting(&src("harness", "x"), &mut seen),
            Level::Info
        );
        t.store(20, Ordering::SeqCst);
        assert_eq!(
            p.resolve_reporting(&src("provider", "a"), &mut seen),
            Level::Debug
        );
        assert_eq!(
            p.resolve_reporting(&src("provider", "a"), &mut seen),
            Level::Debug
        );
        assert_eq!(seen, vec!["provider:a"]);
    }
}
