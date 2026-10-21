//! `plur1bus budget status|set`: usage per agent and model and the soft/hard limits (M2 L8, ADR-010 §4).
//! Both go through the core (`budget.status`, `budget.set`); the usage store is the core's, never read from here.
use crate::cli::BudgetCmd;
use crate::commands::memory_ops::{connect_core, require_supports};
use crate::output::Out;
use crate::paths::Layout;
use serde_json::{json, Value};
use std::time::Duration;

/// The wire name of a `--metric` value (`video-seconds` on the command line is `videoSeconds` on the wire).
fn wire_metric(m: &str) -> &str {
    match m {
        "video-seconds" => "videoSeconds",
        other => other,
    }
}

/// What one unit of a wire metric is called, for errors and output.
fn unit_name(metric: &str) -> &'static str {
    match metric {
        "images" => "images",
        "videoSeconds" => "video seconds",
        _ => "tokens",
    }
}

fn parse_amount(s: &str, metric: &str) -> Result<u64, String> {
    let what = match metric {
        "images" => "an image count",
        "videoSeconds" => "a number of video seconds",
        _ => "a token count",
    };
    s.parse::<u64>()
        .ok()
        .filter(|v| *v <= (1u64 << 53))
        .ok_or_else(|| format!("`{s}` is not {what} (a whole number)"))
}

pub struct SetArgs {
    pub global: bool,
    pub agent: Option<String>,
    pub period: Option<String>,
    pub metric: Option<String>,
    pub soft: Option<String>,
    pub hard: Option<String>,
    pub clear_soft: bool,
    pub clear_hard: bool,
    pub timezone: Option<String>,
}

/// Maps the command line to `budget.set` parameters, or says what is missing.
pub fn set_params(a: &SetArgs) -> Result<Value, String> {
    let mut params = serde_json::Map::new();
    if let Some(tz) = &a.timezone {
        params.insert("timeZone".into(), json!(tz));
    }
    let wants_limit = a.global
        || a.agent.is_some()
        || a.period.is_some()
        || a.metric.is_some()
        || a.soft.is_some()
        || a.hard.is_some()
        || a.clear_soft
        || a.clear_hard;
    if wants_limit {
        if !a.global && a.agent.is_none() {
            return Err("a limit needs --global or --agent <ID>".into());
        }
        let period = a
            .period
            .as_deref()
            .ok_or("a limit needs --period day|month")?;
        // Tokens, images or video seconds (owner decisions of 2026-10-19: no money dimension); `--metric` defaults to tokens.
        let metric = wire_metric(a.metric.as_deref().unwrap_or("tokens"));
        if a.soft.is_none() && a.hard.is_none() && !a.clear_soft && !a.clear_hard {
            return Err("give at least one of --soft, --hard, --clear-soft, --clear-hard".into());
        }
        let mut limit = serde_json::Map::new();
        limit.insert(
            "scope".into(),
            json!(if a.global { "global" } else { "agent" }),
        );
        if let Some(id) = &a.agent {
            limit.insert("agentId".into(), json!(id));
        }
        limit.insert("period".into(), json!(period));
        limit.insert("metric".into(), json!(metric));
        if let Some(v) = &a.soft {
            limit.insert("soft".into(), json!(parse_amount(v, metric)?));
        } else if a.clear_soft {
            limit.insert("soft".into(), Value::Null);
        }
        if let Some(v) = &a.hard {
            limit.insert("hard".into(), json!(parse_amount(v, metric)?));
        } else if a.clear_hard {
            limit.insert("hard".into(), Value::Null);
        }
        params.insert("limit".into(), Value::Object(limit));
    }
    if params.is_empty() {
        return Err("nothing to set: give a limit (--global|--agent, --period, --metric, --soft|--hard) or --timezone".into());
    }
    Ok(Value::Object(params))
}

fn amount(n: &Value, metric: &str) -> String {
    match n.as_u64() {
        Some(v) => format!("{v} {}", unit_name(metric)),
        None => "-".into(),
    }
}

fn limit_line(l: &Value) -> String {
    let metric = l["metric"].as_str().unwrap_or("");
    let shown = if metric == "videoSeconds" {
        "video-seconds"
    } else {
        metric
    };
    let who = match l["scope"].as_str() {
        Some("agent") => format!("agent {}", l["agentId"].as_str().unwrap_or("?")),
        _ => "global".to_string(),
    };
    let used = l
        .get("used")
        .map(|u| format!("  used {}", amount(u, metric)))
        .unwrap_or_default();
    let state = l["state"]
        .as_str()
        .map(|s| format!("  [{s}]"))
        .unwrap_or_default();
    format!(
        "  {who:<16} {:<6} {shown:<6} soft {:<14} hard {:<14}{used}{state}",
        l["period"].as_str().unwrap_or(""),
        amount(&l["soft"], metric),
        amount(&l["hard"], metric),
    )
}

/// ", 3 images, 8 video seconds" when the period has media units; empty otherwise (and from an older core).
fn media_units(t: &Value) -> String {
    let mut s = String::new();
    for (key, name) in [("images", "images"), ("videoSeconds", "video seconds")] {
        if let Some(n) = t[key].as_u64().filter(|n| *n > 0) {
            s.push_str(&format!(", {n} {name}"));
        }
    }
    s
}

fn render_limits(limits: &Value) -> Vec<String> {
    match limits.as_array() {
        Some(a) if !a.is_empty() => a.iter().map(limit_line).collect(),
        _ => vec!["  none".to_string()],
    }
}

fn render_status(v: &Value) -> String {
    let mut lines = vec![format!(
        "budget (time zone {})",
        v["timeZone"].as_str().unwrap_or("?")
    )];
    for p in v["periods"].as_array().into_iter().flatten() {
        let t = &p["total"];
        lines.push(format!(
            "{} {}: {} events, {} in / {} out tokens{}",
            p["period"].as_str().unwrap_or(""),
            p["key"].as_str().unwrap_or(""),
            t["events"],
            t["inputTokens"],
            t["outputTokens"],
            media_units(t),
        ));
        for a in p["agents"].as_array().into_iter().flatten() {
            for m in a["models"].as_array().into_iter().flatten() {
                lines.push(format!(
                    "  {} / {}: {} in / {} out{}",
                    a["agentId"].as_str().unwrap_or("?"),
                    m["model"].as_str().unwrap_or("?"),
                    m["inputTokens"],
                    m["outputTokens"],
                    media_units(m),
                ));
            }
        }
    }
    lines.push("limits:".into());
    lines.extend(render_limits(&v["limits"]));
    lines.join("\n")
}

fn render_set(v: &Value) -> String {
    let mut lines = vec![
        format!("time zone {}", v["timeZone"].as_str().unwrap_or("?")),
        "limits:".into(),
    ];
    lines.extend(render_limits(&v["limits"]));
    lines.join("\n")
}

pub fn run(out: &Out, layout: &Layout, cmd: BudgetCmd) {
    match cmd {
        BudgetCmd::Status { agent } => {
            let mut client = connect_core(out, layout, "budget", Duration::from_secs(15));
            require_supports(out, &client, "budget.status");
            let params = match agent {
                Some(a) => json!({ "agentId": a }),
                None => json!({}),
            };
            match client.call("budget.status", params) {
                Ok(v) => out.ok("budget.status/1", &v, || render_status(&v)),
                Err(e) => out.from_rpc_error(&e),
            }
        }
        BudgetCmd::Set {
            global,
            agent,
            period,
            metric,
            soft,
            hard,
            clear_soft,
            clear_hard,
            timezone,
        } => {
            let args = SetArgs {
                global,
                agent,
                period,
                metric,
                soft,
                hard,
                clear_soft,
                clear_hard,
                timezone,
            };
            let params = match set_params(&args) {
                Ok(p) => p,
                Err(msg) => out.fail("E_INVALID_PARAMS", &msg, json!({})),
            };
            let mut client = connect_core(out, layout, "budget", Duration::from_secs(15));
            require_supports(out, &client, "budget.set");
            match client.call("budget.set", params) {
                Ok(v) => out.ok("budget.set/1", &v, || render_set(&v)),
                Err(e) => out.from_rpc_error(&e),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args() -> SetArgs {
        SetArgs {
            global: false,
            agent: None,
            period: None,
            metric: None,
            soft: None,
            hard: None,
            clear_soft: false,
            clear_hard: false,
            timezone: None,
        }
    }

    #[test]
    fn agent_token_limit_defaults_the_metric_to_tokens() {
        let p = set_params(&SetArgs {
            agent: Some("main".into()),
            period: Some("day".into()),
            soft: Some("200000".into()),
            hard: Some("500000".into()),
            ..args()
        })
        .unwrap();
        assert_eq!(
            p,
            json!({ "limit": { "scope": "agent", "agentId": "main", "period": "day", "metric": "tokens", "soft": 200_000, "hard": 500_000 } })
        );
    }

    #[test]
    fn global_token_limit_and_clear_and_timezone() {
        let p = set_params(&SetArgs {
            global: true,
            period: Some("month".into()),
            metric: Some("tokens".into()),
            hard: Some("1000000".into()),
            clear_soft: true,
            timezone: Some("Europe/Berlin".into()),
            ..args()
        })
        .unwrap();
        assert_eq!(
            p,
            json!({ "timeZone": "Europe/Berlin", "limit": { "scope": "global", "period": "month", "metric": "tokens", "soft": null, "hard": 1_000_000 } })
        );
        assert_eq!(
            set_params(&SetArgs {
                timezone: Some("UTC".into()),
                ..args()
            })
            .unwrap(),
            json!({ "timeZone": "UTC" })
        );
    }

    #[test]
    fn image_and_video_second_limits_use_the_wire_metric_names() {
        let p = set_params(&SetArgs {
            agent: Some("main".into()),
            period: Some("day".into()),
            metric: Some("images".into()),
            hard: Some("2".into()),
            ..args()
        })
        .unwrap();
        assert_eq!(
            p,
            json!({ "limit": { "scope": "agent", "agentId": "main", "period": "day", "metric": "images", "hard": 2 } })
        );
        let p = set_params(&SetArgs {
            global: true,
            period: Some("month".into()),
            metric: Some("video-seconds".into()),
            soft: Some("60".into()),
            hard: Some("120".into()),
            ..args()
        })
        .unwrap();
        assert_eq!(
            p,
            json!({ "limit": { "scope": "global", "period": "month", "metric": "videoSeconds", "soft": 60, "hard": 120 } })
        );
        assert!(set_params(&SetArgs {
            global: true,
            period: Some("day".into()),
            metric: Some("images".into()),
            hard: Some("2.5".into()),
            ..args()
        })
        .unwrap_err()
        .contains("image count"));
        assert!(set_params(&SetArgs {
            global: true,
            period: Some("day".into()),
            metric: Some("video-seconds".into()),
            hard: Some("x".into()),
            ..args()
        })
        .unwrap_err()
        .contains("video seconds"));
    }

    #[test]
    fn status_renders_media_units_and_unit_limits() {
        let v = json!({
            "timeZone": "UTC", "now": "2026-10-19T12:00:00.000Z",
            "periods": [{ "period": "day", "key": "2026-10-19", "start": "", "end": "",
                "total": { "events": 3, "inputTokens": 0, "outputTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0, "images": 2, "videoSeconds": 8 },
                "agents": [{ "agentId": "main", "total": {}, "models": [{ "model": "img-small", "inputTokens": 0, "outputTokens": 0, "images": 2 }] }] }],
            "limits": [
                { "scope": "agent", "agentId": "main", "period": "day", "metric": "images", "soft": null, "hard": 2, "used": 2, "state": "hard" },
                { "scope": "global", "period": "month", "metric": "videoSeconds", "soft": 60, "hard": 120, "used": 8, "state": "ok" }
            ]
        });
        let text = render_status(&v);
        assert!(
            text.contains(
                "day 2026-10-19: 3 events, 0 in / 0 out tokens, 2 images, 8 video seconds"
            ),
            "{text}"
        );
        assert!(
            text.contains("main / img-small: 0 in / 0 out, 2 images"),
            "{text}"
        );
        assert!(
            text.contains("images")
                && text.contains("hard 2 images")
                && text.contains("used 2 images")
                && text.contains("[hard]"),
            "{text}"
        );
        assert!(
            text.contains("video-seconds")
                && text.contains("soft 60 video seconds")
                && text.contains("used 8 video seconds"),
            "{text}"
        );
    }

    #[test]
    fn incomplete_or_malformed_requests_say_what_is_missing() {
        assert!(set_params(&args()).unwrap_err().contains("nothing to set"));
        assert!(set_params(&SetArgs {
            period: Some("day".into()),
            metric: Some("tokens".into()),
            hard: Some("1".into()),
            ..args()
        })
        .unwrap_err()
        .contains("--global or --agent"));
        assert!(set_params(&SetArgs {
            global: true,
            metric: Some("tokens".into()),
            hard: Some("1".into()),
            ..args()
        })
        .unwrap_err()
        .contains("--period"));
        assert!(set_params(&SetArgs {
            global: true,
            period: Some("day".into()),
            metric: Some("tokens".into()),
            ..args()
        })
        .unwrap_err()
        .contains("at least one"));
        assert!(set_params(&SetArgs {
            global: true,
            period: Some("day".into()),
            metric: Some("tokens".into()),
            hard: Some("1.5".into()),
            ..args()
        })
        .unwrap_err()
        .contains("token count"));
        assert!(set_params(&SetArgs {
            global: true,
            period: Some("day".into()),
            hard: Some("abc".into()),
            ..args()
        })
        .unwrap_err()
        .contains("token count"));
    }

    #[test]
    fn status_renders_periods_models_and_limit_states() {
        let v = json!({
            "timeZone": "UTC", "now": "2026-10-06T12:00:00.000Z",
            "periods": [{ "period": "day", "key": "2026-10-06", "start": "", "end": "",
                "total": { "events": 2, "inputTokens": 100, "outputTokens": 50, "cacheReadTokens": 0, "cacheWriteTokens": 0 },
                "agents": [{ "agentId": "main", "total": {}, "models": [{ "model": "m-small", "inputTokens": 100, "outputTokens": 50 }] }] }],
            "limits": [{ "scope": "agent", "agentId": "main", "period": "day", "metric": "tokens", "soft": 2_000, "hard": 5_000, "used": 150, "state": "ok" }]
        });
        let text = render_status(&v);
        assert!(
            text.contains("day 2026-10-06: 2 events, 100 in / 50 out tokens"),
            "{text}"
        );
        assert!(!text.contains('$'), "{text}");
        assert!(text.contains("main / m-small: 100 in / 50 out"), "{text}");
        assert!(
            text.contains("agent main")
                && text.contains("soft 2000 tokens")
                && text.contains("hard 5000 tokens")
                && text.contains("used 150 tokens")
                && text.contains("[ok]"),
            "{text}"
        );
    }
}
