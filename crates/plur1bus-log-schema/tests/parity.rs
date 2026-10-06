//! The Rust mirror must agree with the TypeScript package. `packages/log-schema/fixtures/vectors.json` is generated
//! by TypeScript from the shared schema files (`pnpm gen`); every assertion here compares what Rust derives from the
//! same files, or what it decides about a vector line, with what TypeScript wrote down.
use plur1bus_log_schema as ls;
use serde_json::{json, Value};
use std::{collections::BTreeSet, fs, path::PathBuf};

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

fn vectors() -> Value {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/log-schema/fixtures/vectors.json");
    serde_json::from_str(
        &fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e} (run `pnpm gen`)", p.display())),
    )
    .unwrap()
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap().to_string())
        .collect()
}

#[test]
fn levels_match_typescript() {
    within(|| {
        let v = vectors();
        let table = v["levels"].as_array().unwrap();
        assert_eq!(table.len(), ls::Level::ALL.len());
        for (row, level) in table.iter().zip(ls::Level::ALL) {
            assert_eq!(row["name"], level.as_str());
            assert_eq!(row["rank"], level.rank(), "{level:?} rank");
            assert_eq!(
                row["severityNumber"],
                level.severity_number(),
                "{level:?} severity number"
            );
            assert_eq!(
                row["severityText"],
                level.severity_text(),
                "{level:?} severity text"
            );
            assert_eq!(
                row["syslogSeverity"],
                level.syslog_severity(),
                "{level:?} syslog severity"
            );
            assert_eq!(
                row["syslogName"],
                level.syslog_name(),
                "{level:?} syslog name"
            );
        }
    });
}

#[test]
fn level_constants_match_levels_json() {
    within(|| {
        // The `const` tables in lib.rs are a hand-written mirror of levels.json; this keeps them honest.
        let file: Value = serde_json::from_str(ls::LEVELS_JSON).unwrap();
        let rows = file["levels"].as_array().unwrap();
        assert_eq!(rows.len(), 6);
        for (row, level) in rows.iter().zip(ls::Level::ALL) {
            assert_eq!(row["name"], level.as_str());
            assert_eq!(row["rank"], level.rank());
            assert_eq!(row["otel"]["severityNumber"], level.severity_number());
            assert_eq!(row["otel"]["severityText"], level.severity_text());
            assert_eq!(row["syslog"]["severity"], level.syslog_severity());
            assert_eq!(row["syslog"]["name"], level.syslog_name());
        }
    });
}

#[test]
fn record_constants_match_typescript() {
    within(|| {
        let v = vectors();
        assert_eq!(strings(&v["keyOrder"]), ls::key_order());
        assert_eq!(strings(&v["sourceKinds"]), ls::source_kinds());
        let l = ls::limits();
        assert_eq!(
            v["limits"],
            json!({ "msgBytes": l.msg_bytes, "attrsBytes": l.attrs_bytes, "lineBytes": l.line_bytes, "dedupWindowMs": l.dedup_window_ms, "rateSustainedPerSecond": l.rate_sustained_per_second, "rateBurst": l.rate_burst })
        );
        assert_eq!(v["catalogueVersion"], ls::catalogue().version);
    });
}

#[test]
fn catalogue_matches_typescript() {
    within(|| {
        let v = vectors();
        let ts = v["events"].as_array().unwrap();
        let rs = &ls::catalogue().events;
        assert_eq!(ts.len(), rs.len());
        for (t, r) in ts.iter().zip(rs) {
            assert_eq!(t["event"], r.event);
            assert_eq!(strings(&t["kinds"]), r.kinds, "{}", r.event);
            assert_eq!(t["stream"], r.stream, "{}", r.event);
            assert_eq!(t["level"], r.level, "{}", r.event);
            assert_eq!(strings(&t["levels"]), r.levels, "{}", r.event);
            assert_eq!(t["attrs"], r.attrs, "{}", r.event);
            assert_eq!(
                strings(&t["requiredAttrs"]),
                r.required_attrs,
                "{}",
                r.event
            );
            assert_eq!(t["streamed"], r.streamed, "{}", r.event);
            assert_eq!(t["family"], r.family, "{}", r.event);
            assert_eq!(t["activity"], r.activity, "{}", r.event);
            assert_eq!(t["stability"], r.stability, "{}", r.event);
            assert_eq!(
                t["attrsSchema"],
                ls::attrs_schema_for(r),
                "attrs schema of {}",
                r.event
            );
        }
    });
}

#[test]
fn every_vector_gets_the_typescript_verdict() {
    within(|| {
        let v = vectors();
        let vs = v["vectors"].as_array().unwrap();
        assert!(vs.len() > 100);
        let mut codes = BTreeSet::new();
        for x in vs {
            let (name, line, expect) = (
                x["name"].as_str().unwrap(),
                x["line"].as_str().unwrap(),
                x["expect"].as_str().unwrap(),
            );
            let got = match ls::validate_line(line) {
                Ok(_) => "ok",
                Err(e) => e.code.as_str(),
            };
            assert_eq!(
                got,
                expect,
                "vector {name}: {:?}",
                ls::validate_line(line).err()
            );
            codes.insert(expect.to_string());
        }
        assert_eq!(
            codes.len(),
            12,
            "every verdict code is exercised: {codes:?}"
        );
    });
}

#[test]
fn the_schema_validates_every_catalogue_example() {
    within(|| {
        // One vector per catalogue example (the line is TypeScript's JSON.stringify, which keeps the key order).
        let v = vectors();
        let examples: BTreeSet<String> = v["vectors"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|x| {
                x["name"]
                    .as_str()?
                    .strip_prefix("example:")
                    .map(str::to_string)
            })
            .collect();
        let events: BTreeSet<String> = ls::catalogue()
            .events
            .iter()
            .map(|e| e.event.clone())
            .collect();
        assert_eq!(examples, events, "a vector line for every catalogue entry");
        for e in &ls::catalogue().events {
            assert!(!e.examples.is_empty(), "{} has an example", e.event);
            let line = v["vectors"]
                .as_array()
                .unwrap()
                .iter()
                .find(|x| x["name"] == format!("example:{}", e.event))
                .unwrap()["line"]
                .as_str()
                .unwrap();
            let hit = ls::validate_line(line).unwrap_or_else(|err| panic!("{}: {err:?}", e.event));
            assert_eq!(hit.event, e.event, "the example resolves to its own entry");
            // The embedded example is the same record, key order aside.
            assert_eq!(
                serde_json::from_str::<Value>(line).unwrap(),
                e.examples[0],
                "{}",
                e.event
            );
        }
    });
}

#[test]
fn redaction_data_matches_typescript_and_the_canaries_match() {
    within(|| {
        let v = vectors();
        assert_eq!(strings(&v["redaction"]["order"]), ls::redaction_order());
        for rule in v["redaction"]["rules"].as_array().unwrap() {
            let id = rule["id"].as_str().unwrap();
            let theirs = strings(&rule["patterns"]);
            let r = &ls::redaction()["rules"];
            let ours = r
                .as_array()
                .unwrap()
                .iter()
                .find(|x| x["id"] == id)
                .unwrap();
            assert_eq!(ours["kind"], rule["kind"], "{id}");
            let have: Vec<String> = ["patterns", "steps", "classes"]
                .iter()
                .filter_map(|k| ours.get(*k))
                .flat_map(|a| {
                    a.as_array()
                        .unwrap()
                        .iter()
                        .map(|p| p["id"].as_str().unwrap().to_string())
                })
                .collect();
            assert_eq!(have, theirs, "pattern ids of {id}");
        }
        let mut all = ls::rule_patterns("pattern");
        all.extend(ls::rule_patterns("pii"));
        all.extend(ls::rule_patterns("url"));
        for p in &all {
            let _ = p.regex(); // every pattern compiles in the Rust regex engine
        }
        let find = |id: &str| {
            all.iter()
                .find(|p| p.id == id)
                .unwrap_or_else(|| panic!("pattern {id}"))
        };
        for c in v["redactionCanaries"].as_array().unwrap() {
            let p = find(c["pattern"].as_str().unwrap());
            let text: String = strings(&c["parts"]).concat();
            let m = p
                .regex()
                .find(&text)
                .unwrap_or_else(|| panic!("{} matches its canary", p.id));
            assert_eq!(m.as_str(), strings(&c["matches"]).concat(), "{}", p.id);
            if p.left_boundary && m.start() > 0 {
                assert!(
                    !text.as_bytes()[m.start() - 1].is_ascii_alphanumeric(),
                    "{} left boundary",
                    p.id
                );
            }
        }
        for n in v["redactionNonMatches"].as_array().unwrap() {
            let p = find(n["pattern"].as_str().unwrap());
            let text = n["text"].as_str().unwrap();
            let counts = p.regex().find(text).is_some_and(|m| {
                let exempt = p
                    .exempt_when_whole_match_is
                    .as_deref()
                    .is_some_and(|e| regex::Regex::new(e).unwrap().is_match(m.as_str()));
                let blocked = p.left_boundary
                    && m.start() > 0
                    && text.as_bytes()[m.start() - 1].is_ascii_alphanumeric();
                !exempt && !blocked
            });
            assert!(!counts, "{} must not count on {}", p.id, n["note"]);
        }
    });
}
