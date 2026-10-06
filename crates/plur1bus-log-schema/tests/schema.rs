//! The Rust side of the acceptance list that does not need the TypeScript fixtures: the level map, unknown events,
//! invalid levels, and the rules `validate_line` enforces.
use plur1bus_log_schema::{catalogue, is_source_key, lookup_event, validate_line, Level};
use serde_json::{json, Value};

/// Hard timeout for every test (the work is a few milliseconds; a hang fails with a name instead of eating the job).
fn within<F: FnOnce() + Send + 'static>(f: F) {
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = std::thread::spawn(move || {
        f();
        let _ = tx.send(());
    });
    match rx.recv_timeout(std::time::Duration::from_secs(60)) {
        Ok(()) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            handle.join().expect("test body panicked")
        }
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => panic!("test exceeded 60 s"),
    }
}

fn example(event: &str) -> Value {
    catalogue()
        .events
        .iter()
        .find(|e| e.event == event)
        .unwrap()
        .examples[0]
        .clone()
}

/// Serialise with the written key order (serde_json's Value sorts keys, so build the line by hand).
fn line(v: &Value) -> String {
    let order = plur1bus_log_schema::key_order();
    let o = v.as_object().unwrap();
    let parts: Vec<String> = order
        .iter()
        .filter_map(|k| o.get(*k).map(|x| format!("{}:{}", json!(k), x)))
        .collect();
    format!("{{{}}}", parts.join(","))
}

fn code(l: &str) -> &'static str {
    match validate_line(l) {
        Ok(_) => "ok",
        Err(e) => e.code.as_str(),
    }
}

#[test]
fn the_level_mapping_table_is_fully_tested() {
    within(|| {
        let expected = [
            (Level::Trace, "trace", 0, 1, "TRACE", 7, "debug"),
            (Level::Debug, "debug", 1, 5, "DEBUG", 7, "debug"),
            (Level::Info, "info", 2, 9, "INFO", 6, "informational"),
            (Level::Warn, "warn", 3, 13, "WARN", 4, "warning"),
            (Level::Error, "error", 4, 17, "ERROR", 3, "error"),
            (Level::Fatal, "fatal", 5, 21, "FATAL", 2, "critical"),
        ];
        assert_eq!(Level::ALL.len(), expected.len());
        for (level, name, rank, sev, text, syslog, syslog_name) in expected {
            assert_eq!(level.as_str(), name);
            assert_eq!(Level::parse(name), Some(level));
            assert_eq!(level.rank(), rank);
            assert_eq!(level.severity_number(), sev);
            assert_eq!(level.severity_text(), text);
            assert_eq!(level.syslog_severity(), syslog);
            assert_eq!(level.syslog_name(), syslog_name);
        }
        for a in Level::ALL {
            for b in Level::ALL {
                assert_eq!(a.at_least(b), a.rank() >= b.rank(), "{a:?} >= {b:?}");
            }
        }
        for bad in ["verbose", "INFO", "Warn", "", "notice", "critical"] {
            assert_eq!(Level::parse(bad), None, "{bad:?}");
        }
    });
}

#[test]
fn an_unknown_event_is_rejected() {
    within(|| {
        for name in [
            "made.up.event",
            "supervisor.child.given_up.forged",
            "repair",
            "Not A Name",
            "",
            "a",
            "x.y.z.w.v",
        ] {
            let mut r = example("provider.request.failed");
            r["event"] = json!(name);
            assert_eq!(code(&line(&r)), "unknown_event", "{name:?}");
            assert!(lookup_event(name).is_none(), "{name:?}");
        }
        assert_eq!(
            lookup_event("repair.service.renew").unwrap().event,
            "repair.*"
        );
    });
}

#[test]
fn an_invalid_level_is_rejected() {
    within(|| {
        for level in [
            json!("verbose"),
            json!("INFO"),
            json!(""),
            json!("critical"),
            json!(9),
            json!(null),
            json!(true),
        ] {
            let mut r = example("provider.request.failed");
            r["level"] = level.clone();
            assert_eq!(code(&line(&r)), "invalid_level", "{level}");
        }
        let mut r = example("provider.request.failed");
        r["level"] = json!("fatal");
        assert_eq!(code(&line(&r)), "level_not_allowed");
    });
}

#[test]
fn every_catalogue_entry_is_consistent() {
    within(|| {
        let c = catalogue();
        assert!(c.events.len() >= 120);
        for e in &c.events {
            assert!(e.allows_level(e.default_level()), "{}", e.event);
            assert!(c.attr_groups.contains_key(&e.attrs), "{}", e.event);
            assert_eq!(e.since, "D111");
            if e.stream == "audit" {
                assert_eq!(e.kinds, ["harness"], "{}", e.event);
            }
        }
        assert_eq!(lookup_event("scheduler.run.scheduled"), None);
        assert!(
            !lookup_event("scheduler.run.skipped")
                .unwrap()
                .allows_level(Level::Debug),
            "ADR-009: a skip is never below info"
        );
        assert_eq!(
            lookup_event("process.output.line").unwrap().levels,
            ["info"],
            "foreign text never raises a level"
        );
    });
}

#[test]
fn a_forged_source_kind_is_refused() {
    within(|| {
        let mut r = example("supervisor.child.given_up");
        r["source"] = json!({ "kind": "extension", "id": "plugin/evil", "version": "1" });
        assert_eq!(code(&line(&r)), "source_kind_not_allowed");
    });
}

#[test]
fn limits_order_and_timestamps() {
    within(|| {
        let base = example("provider.request.failed");
        assert_eq!(code(&line(&base)), "ok");
        let mut r = base.clone();
        r["msg"] = json!("x".repeat(2049));
        assert_eq!(code(&line(&r)), "msg_too_long");
        r["msg"] = json!("é".repeat(1025));
        assert_eq!(code(&line(&r)), "msg_too_long", "bytes, not characters");
        let mut r = base.clone();
        r["ts"] = json!("2026-02-30T09:14:03.218Z");
        assert_eq!(code(&line(&r)), "schema");
        r["ts"] = json!("2024-02-29T09:14:03.218Z");
        assert_eq!(code(&line(&r)), "ok");
        assert_eq!(
            code(&format!("{{\"level\":\"info\",{}", &line(&base)[1..])),
            "key_order"
        );
        assert_eq!(code("[]"), "not_object");
        assert_eq!(code("{nope"), "not_object");
    });
}

#[test]
fn source_keys() {
    within(|| {
        for ok in [
            "harness",
            "provider:openai",
            "extension:mcp-server",
            "extension:mcp-server/files",
            "model:ollama/llama3",
            "harness:module/fixture",
        ] {
            assert!(is_source_key(ok), "{ok}");
        }
        for bad in [
            "",
            "plugin",
            "harness:",
            "Harness",
            "harness:UPPER",
            ":core",
            "os:",
        ] {
            assert!(!is_source_key(bad), "{bad}");
        }
    });
}
