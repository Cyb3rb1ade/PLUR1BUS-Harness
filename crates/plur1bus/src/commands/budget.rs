//! `plur1bus budget status|set`: usage per agent and model and the soft/hard limits (M2 L8, ADR-010 §4).
//! Both go through the core (`budget.status`, `budget.set`); the usage store is the core's, never read from here.
use crate::cli::BudgetCmd;
use crate::commands::memory_ops::{connect_core, require_supports};
use crate::output::Out;
use crate::paths::Layout;
use serde_json::{json, Value};
use std::time::Duration;

/// USD with at most six decimals to micro-USD (`"2.5"` -> 2_500_000), without going through a float.
pub fn parse_usd_micros(s: &str) -> Result<u64, String> {
    let bad = || format!("`{s}` is not a USD amount (digits with at most 6 decimals, e.g. 2.50)");
    let (whole, frac) = match s.split_once('.') {
        Some((w, f)) => (w, f),
        None => (s, ""),
    };
    if whole.is_empty() && frac.is_empty() {
        return Err(bad());
    }
    if !whole.chars().all(|c| c.is_ascii_digit())
        || !frac.chars().all(|c| c.is_ascii_digit())
        || frac.len() > 6
    {
        return Err(bad());
    }
    let w: u64 = if whole.is_empty() {
        0
    } else {
        whole.parse().map_err(|_| bad())?
    };
    let f: u64 = format!("{frac:0<6}").parse().map_err(|_| bad())?;
    w.checked_mul(1_000_000)
        .and_then(|v| v.checked_add(f))
        .filter(|v| *v <= (1u64 << 53))
        .ok_or_else(bad)
}

fn parse_tokens(s: &str) -> Result<u64, String> {
    s.parse::<u64>()
        .ok()
        .filter(|v| *v <= (1u64 << 53))
        .ok_or_else(|| format!("`{s}` is not a token count (a whole number)"))
}

/// Cost (micro-USD) with the cents the person sees, more digits only when they matter.
pub fn format_usd(micros: u64) -> String {
    let whole = micros / 1_000_000;
    let frac = format!("{:06}", micros % 1_000_000);
    let trimmed = frac.trim_end_matches('0');
    let digits = if trimmed.len() < 2 {
        &frac[..2]
    } else {
        trimmed
    };
    format!("${whole}.{digits}")
}

fn bound(metric: &str, v: &str) -> Result<u64, String> {
    if metric == "cost" {
        parse_usd_micros(v)
    } else {
        parse_tokens(v)
    }
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
        let metric = a
            .metric
            .as_deref()
            .ok_or("a limit needs --metric cost|tokens")?;
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
            limit.insert("soft".into(), json!(bound(metric, v)?));
        } else if a.clear_soft {
            limit.insert("soft".into(), Value::Null);
        }
        if let Some(v) = &a.hard {
            limit.insert("hard".into(), json!(bound(metric, v)?));
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

fn amount(metric: &str, n: &Value) -> String {
    match (metric, n.as_u64()) {
        ("cost", Some(v)) => format_usd(v),
        (_, Some(v)) => format!("{v} tokens"),
        _ => "-".into(),
    }
}

fn limit_line(l: &Value) -> String {
    let metric = l["metric"].as_str().unwrap_or("");
    let who = match l["scope"].as_str() {
        Some("agent") => format!("agent {}", l["agentId"].as_str().unwrap_or("?")),
        _ => "global".to_string(),
    };
    let used = l
        .get("used")
        .map(|u| format!("  used {}", amount(metric, u)))
        .unwrap_or_default();
    let state = l["state"]
        .as_str()
        .map(|s| format!("  [{s}]"))
        .unwrap_or_default();
    format!(
        "  {who:<16} {:<6} {metric:<6} soft {:<14} hard {:<14}{used}{state}",
        l["period"].as_str().unwrap_or(""),
        amount(metric, &l["soft"]),
        amount(metric, &l["hard"]),
    )
}

fn render_limits(limits: &Value) -> Vec<String> {
    match limits.as_array() {
        Some(a) if !a.is_empty() => a.iter().map(limit_line).collect(),
        _ => vec!["  none".to_string()],
    }
}

fn render_status(v: &Value) -> String {
    let mut lines = vec![format!(
        "budget (time zone {}, prices {})",
        v["timeZone"].as_str().unwrap_or("?"),
        v["priceVersion"].as_str().unwrap_or("?")
    )];
    for p in v["periods"].as_array().into_iter().flatten() {
        let t = &p["total"];
        lines.push(format!(
            "{} {}: {} events, {} in / {} out tokens, {}{}",
            p["period"].as_str().unwrap_or(""),
            p["key"].as_str().unwrap_or(""),
            t["events"],
            t["inputTokens"],
            t["outputTokens"],
            format_usd(t["costMicros"].as_u64().unwrap_or(0)),
            match t["unpricedEvents"].as_u64() {
                Some(n) if n > 0 => format!(" ({n} unpriced)"),
                _ => String::new(),
            }
        ));
        for a in p["agents"].as_array().into_iter().flatten() {
            for m in a["models"].as_array().into_iter().flatten() {
                lines.push(format!(
                    "  {} / {}: {} in / {} out, {}",
                    a["agentId"].as_str().unwrap_or("?"),
                    m["model"].as_str().unwrap_or("?"),
                    m["inputTokens"],
                    m["outputTokens"],
                    format_usd(m["costMicros"].as_u64().unwrap_or(0))
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
                Err(msg) => out.fail("E_INVALID_PARAMS", &msg, json!({}), 2),
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
    fn usd_parses_without_floats() {
        assert_eq!(parse_usd_micros("2"), Ok(2_000_000));
        assert_eq!(parse_usd_micros("2.5"), Ok(2_500_000));
        assert_eq!(parse_usd_micros("0.000001"), Ok(1));
        assert_eq!(parse_usd_micros(".5"), Ok(500_000));
        assert_eq!(parse_usd_micros("19.999999"), Ok(19_999_999));
        for bad in [
            "",
            ".",
            "-1",
            "1.0000001",
            "1e3",
            "$2",
            "2,5",
            "1 000",
            "99999999999999999999",
        ] {
            assert!(parse_usd_micros(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn usd_formats_cents_and_keeps_small_amounts() {
        assert_eq!(format_usd(0), "$0.00");
        assert_eq!(format_usd(2_500_000), "$2.50");
        assert_eq!(format_usd(3_200), "$0.0032");
        assert_eq!(format_usd(1), "$0.000001");
        assert_eq!(format_usd(12_000_000), "$12.00");
    }

    #[test]
    fn agent_cost_limit_maps_to_micros() {
        let p = set_params(&SetArgs {
            agent: Some("main".into()),
            period: Some("day".into()),
            metric: Some("cost".into()),
            soft: Some("2".into()),
            hard: Some("5.25".into()),
            ..args()
        })
        .unwrap();
        assert_eq!(
            p,
            json!({ "limit": { "scope": "agent", "agentId": "main", "period": "day", "metric": "cost", "soft": 2_000_000, "hard": 5_250_000 } })
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
    fn incomplete_or_malformed_requests_say_what_is_missing() {
        assert!(set_params(&args()).unwrap_err().contains("nothing to set"));
        assert!(set_params(&SetArgs {
            period: Some("day".into()),
            metric: Some("cost".into()),
            hard: Some("1".into()),
            ..args()
        })
        .unwrap_err()
        .contains("--global or --agent"));
        assert!(set_params(&SetArgs {
            global: true,
            metric: Some("cost".into()),
            hard: Some("1".into()),
            ..args()
        })
        .unwrap_err()
        .contains("--period"));
        assert!(set_params(&SetArgs {
            global: true,
            period: Some("day".into()),
            hard: Some("1".into()),
            ..args()
        })
        .unwrap_err()
        .contains("--metric"));
        assert!(set_params(&SetArgs {
            global: true,
            period: Some("day".into()),
            metric: Some("cost".into()),
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
            metric: Some("cost".into()),
            hard: Some("abc".into()),
            ..args()
        })
        .unwrap_err()
        .contains("USD"));
    }

    #[test]
    fn status_renders_periods_models_and_limit_states() {
        let v = json!({
            "timeZone": "UTC", "priceVersion": "v1", "now": "2026-10-06T12:00:00.000Z",
            "periods": [{ "period": "day", "key": "2026-10-06", "start": "", "end": "",
                "total": { "events": 2, "inputTokens": 100, "outputTokens": 50, "cacheReadTokens": 0, "cacheWriteTokens": 0, "costMicros": 3200, "unpricedEvents": 1 },
                "agents": [{ "agentId": "main", "total": {}, "models": [{ "model": "m-small", "inputTokens": 100, "outputTokens": 50, "costMicros": 3200 }] }] }],
            "limits": [{ "scope": "agent", "agentId": "main", "period": "day", "metric": "cost", "soft": 2_000_000, "hard": 5_000_000, "used": 3200, "state": "ok" }]
        });
        let text = render_status(&v);
        assert!(
            text.contains("day 2026-10-06: 2 events, 100 in / 50 out tokens, $0.0032 (1 unpriced)"),
            "{text}"
        );
        assert!(
            text.contains("main / m-small: 100 in / 50 out, $0.0032"),
            "{text}"
        );
        assert!(
            text.contains("agent main")
                && text.contains("soft $2.00")
                && text.contains("hard $5.00")
                && text.contains("[ok]"),
            "{text}"
        );
    }
}
