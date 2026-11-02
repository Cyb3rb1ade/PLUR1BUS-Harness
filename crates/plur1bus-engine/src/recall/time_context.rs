//! Caller-provided activity/reminder data rendered with the pin's localization.

use super::render::RenderError;
use super::render_value::{number, text};
use super::temporal_constants::{HINTS, RULES};
use chrono::{DateTime, Timelike};
use chrono_tz::Tz;
use serde_json::Value;

fn local_time(ms: f64, timezone: &str) -> Result<String, RenderError> {
    let date = DateTime::from_timestamp_millis(ms as i64).ok_or(RenderError::InvalidTimestamp)?;
    let zone = timezone
        .parse::<Tz>()
        .map_err(|_| RenderError::InvalidTimezone)?;
    Ok(date
        .with_timezone(&zone)
        .format("%Y-%m-%d %H:%M")
        .to_string())
}

/// Hour used by the optional mood-style directive.
pub fn local_hour(ms: f64, timezone: &str) -> Result<u32, RenderError> {
    let date = DateTime::from_timestamp_millis(ms as i64).ok_or(RenderError::InvalidTimestamp)?;
    let zone = timezone
        .parse::<Tz>()
        .map_err(|_| RenderError::InvalidTimezone)?;
    Ok(date.with_timezone(&zone).hour())
}

/// The always-present session time block. Future activity preserves negative elapsed minutes.
pub fn format_time(previous: Option<f64>, now: f64, language: &str) -> Result<String, RenderError> {
    let zurich = local_time(now, "Europe/Zurich")?;
    let utc = local_time(now, "UTC")?;
    let body = if let Some(previous) = previous {
        let minutes = ((now - previous) / 60_000.0).floor();
        let hours = ((now - previous) / 3_600_000.0).floor();
        let elapsed = if hours >= 1.0 {
            format!("{hours:.0}h {:.0}m", minutes % 60.0)
        } else {
            format!("{minutes:.0}m")
        };
        if language == "de" {
            format!("Letzte Aktivität: vor {elapsed}. Aktuelle Zeit:")
        } else {
            format!("Last activity: {elapsed} ago. Current time:")
        }
    } else if language == "de" {
        "Erste Aktivität. Aktuelle Zeit:".into()
    } else {
        "First activity. Current time:".into()
    };
    Ok(format!(
        concat!(
            "<time-context>\n{body} {zurich} Europe/Zurich (UTC ",
            "{utc}).\n</time-context>",
        ),
        body = body,
        zurich = zurich,
        utc = utc
    ))
}

/// Time-gap bucket, using the exact strict threshold comparisons.
#[must_use]
pub fn gap_bucket(elapsed: Option<f64>) -> &'static str {
    let Some(ms) = elapsed else {
        return "new_session";
    };
    [
        (300_000.0, "immediate"),
        (3_600_000.0, "recent"),
        (43_200_000.0, "same_day"),
        (129_600_000.0, "overnight"),
        (604_800_000.0, "multi_day"),
    ]
    .into_iter()
    .find(|(bound, _)| ms < *bound)
    .map_or("stale", |(_, name)| name)
}

fn plural(count: f64, unit: &str) -> String {
    format!("{count:.0} {unit}{}", if count == 1.0 { "" } else { "s" })
}

/// Human-readable temporal gap, separate from the compact time block.
#[must_use]
pub fn elapsed_human(ms: f64) -> String {
    let minutes = (ms / 60_000.0).floor();
    let hours = (ms / 3_600_000.0).floor();
    let days = (ms / 86_400_000.0).floor();
    if minutes < 60.0 {
        return plural(minutes, "minute");
    }
    if hours < 24.0 {
        let tail = minutes % 60.0;
        return plural(hours, "hour")
            + &if tail == 0.0 {
                String::new()
            } else {
                format!(" {}", plural(tail, "minute"))
            };
    }
    let tail = hours % 24.0;
    plural(days, "day")
        + &if tail == 0.0 {
            String::new()
        } else {
            format!(" {}", plural(tail, "hour"))
        }
}

/// Temporal continuity text; the pin uses the same English rules for both locales.
pub fn format_temporal(
    previous: Option<f64>,
    now: f64,
    timezone: &str,
) -> Result<String, RenderError> {
    let elapsed = previous.map(|at| (now - at).max(0.0));
    let bucket = gap_bucket(elapsed);
    let hint = HINTS
        .iter()
        .find(|(key, _)| *key == bucket)
        .map_or("", |(_, hint)| *hint);
    let mut lines = vec![
        "<temporal-context>".to_owned(),
        format!(
            "Current local time: {} ({timezone})",
            local_time(now, timezone)?
        ),
    ];
    if let Some(previous) = previous {
        lines.push(format!(
            "Previous user-visible turn: {}",
            local_time(previous, timezone)?
        ));
        lines.push(format!(
            "Elapsed since previous user-visible turn: {}",
            elapsed_human(elapsed.unwrap_or(0.0))
        ));
    } else {
        lines.push("Previous user-visible turn: none".into());
    }
    lines.extend([
        format!("Gap bucket: {bucket}"),
        format!("Continuity hint: {hint}"),
        String::new(),
        "Rules:".into(),
        RULES.into(),
        "</temporal-context>".into(),
    ]);
    Ok(lines.join("\n"))
}

/// Due rows first, pending rows last; duplicate IDs retain the first position and last value.
#[must_use]
pub fn merge_reminders(due: &[Value], pending: &[Value]) -> Vec<Value> {
    let mut out = Vec::<Value>::new();
    for row in due.iter().chain(pending) {
        let key = row
            .get("id")
            .filter(|v| super::render_value::truthy(v))
            .unwrap_or(&row["reminderKey"]);
        if let Some(index) = out.iter().position(|r| {
            r.get("id")
                .filter(|v| super::render_value::truthy(v))
                .unwrap_or(&r["reminderKey"])
                == key
        }) {
            out[index] = row.clone();
        } else {
            out.push(row.clone());
        }
    }
    out
}

/// Reminder evidence uses the small de/en engine catalogue subset.
#[must_use]
pub fn format_reminders(reminders: &[Value], language: &str, now: f64) -> String {
    if reminders.is_empty() {
        return String::new();
    }
    let mut lines = vec![if language == "de" {
        "⏰ Fällige Erinnerungen:"
    } else {
        "⏰ Due reminders:"
    }
    .to_owned()];
    for row in reminders {
        let at = number(&row["remindAt"]);
        let at = if at.is_finite() { at } else { 0.0 };
        let minutes = ((now - at) / 60_000.0).floor().max(0.0);
        let hours = (minutes / 60.0).floor();
        let elapsed = if hours > 0.0 {
            format!("{hours:.0}h {:.0}m", minutes % 60.0)
        } else {
            format!("{minutes:.0}m")
        };
        let raw = if row["text"].is_string() {
            text(&row["text"])
        } else {
            String::new()
        };
        let escaped = super::memory_sanitize::escape(&raw).replace('"', "&quot;");
        lines.push(if language == "de" {
            format!("  • \"{escaped}\" (fällig seit {elapsed})")
        } else {
            format!("  • \"{escaped}\" (due {elapsed} ago)")
        });
    }
    format!("<reminder-nudge>\n{}\n</reminder-nudge>", lines.join("\n"))
}
