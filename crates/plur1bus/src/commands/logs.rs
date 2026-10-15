//! `plur1bus logs query|tail`: Owner/Admin views over `logs.query` / `logs.tail`.
//! `--json` prints the RPC page. `--trace` is sent as `traceId` (exact match on
//! `record.trace_id`). Invalid params are `E_INVALID_PARAMS` (exit 2);
//! a signal while following is exit 130.
use super::surfaces::{call, emit};
use crate::output::{Out, EXIT_INTERRUPTED};
use crate::paths::Layout;
use clap::Subcommand;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

const LEVELS: [&str; 6] = ["trace", "debug", "info", "warn", "error", "fatal"];
const STREAMS: [&str; 2] = ["diagnostic", "audit"];
const TS: &str = "RFC 3339 UTC timestamp (YYYY-MM-DDTHH:MM:SS[.mmm]Z)";

#[derive(Debug, Subcommand)]
pub enum LogsCmd {
    /// [experimental] Query diagnostic logs (newest first)
    Query {
        /// Minimum level
        #[arg(long, value_parser = LEVELS)]
        level: Option<String>,
        /// File role, source.id or source.kind
        #[arg(long)]
        component: Option<String>,
        /// 32-hex trace id (exact match on the record's trace_id)
        #[arg(long)]
        trace: Option<String>,
        /// Inclusive lower bound
        #[arg(long, value_name = "TS")]
        from: Option<String>,
        /// Inclusive upper bound
        #[arg(long, value_name = "TS")]
        to: Option<String>,
        #[arg(long, default_value_t = 100, value_parser = clap::value_parser!(u32).range(1..=1000))]
        limit: u32,
        #[arg(long, value_parser = STREAMS)]
        stream: Option<String>,
    },
    /// [experimental] Tail diagnostic logs (oldest of the newest page first)
    Tail {
        /// Minimum level
        #[arg(long, value_parser = LEVELS)]
        level: Option<String>,
        /// File role, source.id or source.kind
        #[arg(long)]
        component: Option<String>,
        /// 32-hex trace id (exact match on the record's trace_id)
        #[arg(long)]
        trace: Option<String>,
        /// Keep polling until interrupted
        #[arg(long)]
        follow: bool,
        #[arg(long, default_value_t = 50, value_parser = clap::value_parser!(u32).range(1..=1000))]
        limit: u32,
        #[arg(long, value_parser = STREAMS)]
        stream: Option<String>,
    },
}

struct Filters {
    level: Option<String>,
    component: Option<String>,
    trace: Option<String>,
    from: Option<String>,
    to: Option<String>,
    limit: u32,
    stream: Option<String>,
}

fn filters(cmd: &LogsCmd) -> Filters {
    match cmd {
        LogsCmd::Query {
            level,
            component,
            trace,
            from,
            to,
            limit,
            stream,
        } => Filters {
            level: level.clone(),
            component: component.clone(),
            trace: trace.clone(),
            from: from.clone(),
            to: to.clone(),
            limit: *limit,
            stream: stream.clone(),
        },
        LogsCmd::Tail {
            level,
            component,
            trace,
            limit,
            stream,
            ..
        } => Filters {
            level: level.clone(),
            component: component.clone(),
            trace: trace.clone(),
            from: None,
            to: None,
            limit: *limit,
            stream: stream.clone(),
        },
    }
}

/// Same rules as TS `bound()`: `YYYY-MM-DDTHH:MM:SS[.d{1,3}]Z` and a real calendar time.
fn is_rfc3339(s: &str) -> bool {
    let b = s.as_bytes();
    if !b.ends_with(b"Z") || b.len() < 20 {
        return false;
    }
    let body = &b[..b.len() - 1];
    if body.len() < 19 || body[10] != b'T' {
        return false;
    }
    let date = &body[..10];
    let time = &body[11..];
    if date[4] != b'-' || date[7] != b'-' || time.len() < 8 || time[2] != b':' || time[5] != b':' {
        return false;
    }
    if !date[..4].iter().all(u8::is_ascii_digit)
        || !date[5..7].iter().all(u8::is_ascii_digit)
        || !date[8..].iter().all(u8::is_ascii_digit)
        || !time[..2].iter().all(u8::is_ascii_digit)
        || !time[3..5].iter().all(u8::is_ascii_digit)
        || !time[6..8].iter().all(u8::is_ascii_digit)
    {
        return false;
    }
    if time.len() > 8 {
        if time[8] != b'.' {
            return false;
        }
        let frac = &time[9..];
        if frac.is_empty() || frac.len() > 3 || !frac.iter().all(u8::is_ascii_digit) {
            return false;
        }
    }
    let year = atoi(&date[..4]);
    let month = atoi(&date[5..7]);
    let day = atoi(&date[8..]);
    let hour = atoi(&time[..2]);
    let minute = atoi(&time[3..5]);
    let second = atoi(&time[6..8]);
    hour <= 23
        && minute <= 59
        && second <= 59
        && (1..=12).contains(&month)
        && day >= 1
        && day <= days_in_month(year, month)
}

fn atoi(digits: &[u8]) -> u32 {
    digits.iter().fold(0, |n, c| n * 10 + u32::from(c - b'0'))
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400)) => {
            29
        }
        2 => 28,
        _ => 0,
    }
}

fn is_trace_id(s: &str) -> bool {
    s.len() == 32
        && s.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
        && s != "0".repeat(32)
}

/// RPC method and params. `Err` is the message for `E_INVALID_PARAMS`.
pub fn request(cmd: &LogsCmd) -> Result<(&'static str, Value), String> {
    let f = filters(cmd);
    if let Some(c) = &f.component {
        if c.is_empty() || c.len() > 64 {
            return Err("component must be 1..=64 characters".into());
        }
    }
    if let Some(t) = &f.trace {
        if !is_trace_id(t) {
            return Err("trace must be 32 lowercase hex characters, not all-zero".into());
        }
    }
    for (name, v) in [("from", &f.from), ("to", &f.to)] {
        if let Some(s) = v {
            if !is_rfc3339(s) {
                return Err(format!("{name} must be an {TS}"));
            }
        }
    }
    let method = match cmd {
        LogsCmd::Query { .. } => "logs.query",
        LogsCmd::Tail { .. } => "logs.tail",
    };
    let mut p = json!({ "limit": f.limit });
    if let Some(l) = f.level {
        p["minLevel"] = json!(l);
    }
    if let Some(c) = f.component {
        p["component"] = json!(c);
    }
    if let Some(t) = f.trace {
        p["traceId"] = json!(t);
    }
    if let Some(s) = f.from {
        p["from"] = json!(s);
    }
    if let Some(s) = f.to {
        p["to"] = json!(s);
    }
    if let Some(s) = f.stream {
        p["stream"] = json!(s);
    }
    Ok((method, p))
}

fn line(rec: &Value) -> String {
    let ts = rec["ts"].as_str().unwrap_or("-");
    let level = rec["level"].as_str().unwrap_or("-");
    let component = rec["component"].as_str().unwrap_or("-");
    let inner = &rec["record"];
    let event = inner["event"]
        .as_str()
        .or_else(|| inner["action"].as_str())
        .unwrap_or("-");
    let msg = inner["msg"].as_str().unwrap_or("");
    if msg.is_empty() {
        format!("{ts} {level:<5} {component}  {event}")
    } else {
        format!("{ts} {level:<5} {component}  {event}  {msg}")
    }
}

pub fn render(page: &Value) -> String {
    page["records"]
        .as_array()
        .into_iter()
        .flatten()
        .map(line)
        .collect::<Vec<_>>()
        .join("\n")
}

fn interrupt_flag() -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    #[cfg(unix)]
    {
        use signal_hook::consts::{SIGINT, SIGTERM};
        for sig in [SIGINT, SIGTERM] {
            let _ = signal_hook::flag::register(sig, Arc::clone(&flag));
        }
    }
    flag
}

pub fn run(out: &Out, layout: &Layout, cmd: LogsCmd) {
    let follow = matches!(cmd, LogsCmd::Tail { follow: true, .. });
    let (method, mut params) = request(&cmd).unwrap_or_else(|why| {
        out.fail(
            "E_INVALID_PARAMS",
            &why,
            json!({ "reason": "invalid-params" }),
        )
    });
    let interrupted = interrupt_flag();
    if !follow {
        let page = call(out, layout, method, params);
        out.ok(&format!("{method}/1"), &page, || render(&page));
        return;
    }
    params["waitMs"] = json!(1_000);
    loop {
        if interrupted.load(Ordering::Relaxed) {
            out.fail_exit(
                "E_CANCELLED",
                "interrupted",
                json!({ "reason": "signal" }),
                EXIT_INTERRUPTED,
            );
        }
        let page = call(out, layout, method, params.clone());
        let text = render(&page);
        if out.json {
            emit(out, method, &page);
        } else if !text.is_empty() {
            crate::output::say(&text);
        }
        match page["nextCursor"].as_str() {
            Some(c) => params["cursor"] = json!(c),
            None => {
                if let Some(o) = params.as_object_mut() {
                    o.remove("cursor");
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::{Cli, Cmd};
    use crate::output::exit_code_for;
    use clap::Parser;

    fn parse(args: &[&str]) -> LogsCmd {
        let cli = Cli::try_parse_from(std::iter::once("plur1bus").chain(args.iter().copied()))
            .unwrap_or_else(|e| panic!("{args:?}: {e}"));
        match cli.cmd {
            Cmd::Logs { sub } => sub,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn query_maps_filters_onto_logs_query() {
        let cmd = parse(&[
            "logs",
            "query",
            "--level",
            "warn",
            "--component",
            "core",
            "--trace",
            "4bf92f3577b34da6a3ce929d0e0e4736",
            "--from",
            "2026-10-07T09:00:00.000Z",
            "--to",
            "2026-10-07T10:00:00Z",
            "--limit",
            "7",
            "--stream",
            "diagnostic",
        ]);
        assert_eq!(
            request(&cmd).unwrap(),
            (
                "logs.query",
                json!({
                    "limit": 7,
                    "minLevel": "warn",
                    "component": "core",
                    "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
                    "from": "2026-10-07T09:00:00.000Z",
                    "to": "2026-10-07T10:00:00Z",
                    "stream": "diagnostic"
                })
            )
        );
    }

    #[test]
    fn tail_maps_onto_logs_tail() {
        let cmd = parse(&["logs", "tail", "--level", "error", "--follow"]);
        assert_eq!(
            request(&cmd).unwrap(),
            ("logs.tail", json!({ "limit": 50, "minLevel": "error" }))
        );
        match cmd {
            LogsCmd::Tail { follow, .. } => assert!(follow),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn invalid_trace_and_time_are_e_invalid_params() {
        assert!(request(&parse(&["logs", "query", "--trace", "zzzz"])).is_err());
        assert!(request(&parse(&["logs", "query", "--trace", &"0".repeat(32)])).is_err());
        assert!(request(&parse(&["logs", "query", "--from", "yesterday"])).is_err());
        assert!(request(&parse(&["logs", "query", "--from", "2026-02-30T00:00:00Z"])).is_err());
        assert!(request(&parse(&[
            "logs",
            "query",
            "--from",
            "2026-10-07T09:00:00.0Z"
        ]))
        .is_ok());
        assert!(request(&parse(&[
            "logs",
            "query",
            "--from",
            "2026-10-07T09:00:00.00Z"
        ]))
        .is_ok());
        assert_eq!(exit_code_for("E_INVALID_PARAMS"), 2);
    }

    #[test]
    fn clap_rejects_an_unknown_level() {
        assert!(Cli::try_parse_from(["plur1bus", "logs", "query", "--level", "loud"]).is_err());
    }

    #[test]
    fn render_prints_ts_level_component_and_event() {
        let page = json!({
            "records": [{
                "ts": "2026-10-07T00:00:00.000Z",
                "level": "info",
                "component": "core",
                "stream": "diagnostic",
                "record": { "event": "core.process.started", "msg": "core started" }
            }]
        });
        assert_eq!(
            render(&page),
            "2026-10-07T00:00:00.000Z info  core  core.process.started  core started"
        );
    }

    #[test]
    fn signal_exit_is_130() {
        assert_eq!(EXIT_INTERRUPTED, 130);
    }
}
