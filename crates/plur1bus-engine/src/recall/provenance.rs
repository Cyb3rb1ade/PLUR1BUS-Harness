//! Observation age, operational risk and independent valid-time attributes.

use super::render_date::parse_timestamp;
use super::render_value::text;
use serde_json::Value;

const OPERATIONAL: &[&str] = &[
    "cron",
    "crontab",
    "cronjob",
    "systemctl",
    "service",
    "timer",
    "deploy",
    "deployment",
    "gateway",
    "protect script",
    "update script",
    "deploy script",
    "lockfile",
    "lock file",
    "duplicate job",
    "duplikat",
    "database migration",
    "db migration",
    "journalctl",
    "production",
    "live",
];
const DESTRUCTIVE: &[&str] = &[
    "disable",
    "stop",
    "delete",
    "remove",
    "move",
    "drop",
    "reset hard",
    "reset --hard",
    "rm -",
    "chmod",
    "chown",
];
const HIGH: &[&str] = &[
    "edit",
    "change",
    "alter",
    "modify",
    "rewrite",
    "update",
    "crontab",
    "cron",
    "cronjob",
    "deploy script",
    "protect script",
    "update script",
];
const MEDIUM: &[&str] = &[
    "restart",
    "reload",
    "status",
    "check",
    "verify",
    "list-timers",
    "list-units",
    "systemctl",
];
const LOW: &[&str] = &["journalctl", "log", "logged", "warning", "error"];

/// Provenance needed to render a record; retrieval time never refreshes its content.
#[derive(Clone, Debug, PartialEq)]
pub struct TemporalProvenance {
    /// Valid nonzero creation timestamp, if present.
    pub created_at: Option<f64>,
    /// Clamped age based on updatedAt, then createdAt.
    pub age_ms: Option<f64>,
    /// Compact label such as `1h ago`.
    pub age_label: String,
    /// `fresh`, `recent`, `stale` or `unknown`.
    pub freshness: &'static str,
    /// Whether any operational keyword matched.
    pub operational: bool,
    /// Risk level from the first applicable keyword group.
    pub risk: &'static str,
    /// Canonical documents are reference material.
    pub authoritative: bool,
    /// Stale/unknown operational evidence requires live verification.
    pub requires_live_verification: bool,
}

fn keyword(source: &str, value: &str) -> bool {
    if value
        .chars()
        .all(|c| c.is_alphanumeric() || c == '_' || c == '-')
    {
        let boundary = |c: char| !(c.is_alphanumeric() || c == '_' || c == '-');
        source.match_indices(value).any(|(at, _)| {
            source[..at].chars().next_back().is_none_or(boundary)
                && source[at + value.len()..]
                    .chars()
                    .next()
                    .is_none_or(boundary)
        })
    } else {
        source.contains(value)
    }
}

/// Format age with JavaScript Math.round and its unit thresholds.
#[must_use]
pub fn format_age(age: Option<f64>) -> String {
    let Some(age) = age.filter(|n| n.is_finite()) else {
        return "unknown".into();
    };
    for (scale, bound, unit) in [(60_000.0, 60.0, "m"), (3_600_000.0, 24.0, "h")] {
        let rounded = (age / scale + 0.5).floor();
        if rounded < bound {
            return format!("{rounded:.0}{unit} ago");
        }
    }
    format!("{:.0}d ago", (age / 86_400_000.0 + 0.5).floor())
}

/// Compute observation-time provenance without using validity or lastRetrievedAt.
#[must_use]
pub fn build(memory: &Value, now: f64) -> TemporalProvenance {
    let created = parse_timestamp(&memory["createdAt"]);
    let timestamp = parse_timestamp(&memory["updatedAt"]).or(created);
    let age = timestamp.map(|at| (now - at).max(0.0));
    let freshness = match age {
        None => "unknown",
        Some(age) if age <= 900_000.0 => "fresh",
        Some(age) if age <= 7_200_000.0 => "recent",
        _ => "stale",
    };
    let source = ["text", "display", "summary"]
        .iter()
        .map(|key| text(&memory[key]))
        .find(|s| !s.is_empty())
        .unwrap_or_default()
        .to_lowercase();
    let operational = OPERATIONAL.iter().any(|k| keyword(&source, k));
    let risk = if !operational {
        "none"
    } else {
        [
            (DESTRUCTIVE, "destructive"),
            (HIGH, "high"),
            (MEDIUM, "medium"),
            (LOW, "low"),
        ]
        .into_iter()
        .find(|(keys, _)| keys.iter().any(|k| keyword(&source, k)))
        .map_or("medium", |(_, level)| level)
    };
    let authoritative = memory["authoritative"] == true;
    TemporalProvenance {
        created_at: created,
        age_ms: age,
        age_label: format_age(age),
        freshness,
        operational,
        risk,
        authoritative,
        requires_live_verification: operational
            && !authoritative
            && matches!(freshness, "stale" | "unknown"),
    }
}
