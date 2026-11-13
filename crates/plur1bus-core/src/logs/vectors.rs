//! Replay of the parity vectors recorded from the TypeScript write path (`scripts/parity/export-logs.ts`,
//! `fixtures/parity/logs/{levels,trace,output,files,lines,records}.json`). Vectors are recorded, never edited by hand.
//!
//! Where the Rust line differs in bytes from the TypeScript line (attribute keys are sorted, because a `serde_json::Map`
//! has no insertion order), the recorded case carries a `note` and the line the Rust writer produces (`canonical`); the
//! test then pins both: the Rust bytes are `canonical`, and both parse to the same value.
use super::files::{list_log_files, locale_compare, Stream};
use super::levels::{LevelPolicy, LevelSettings, Source};
use super::lines::{
    align_forward, backward_lines, forward_lines, last_line_boundary, seek_by_ts, ForwardOptions,
    MAX_LINE,
};
use super::output::{sanitise, signal_level, Signal};
use super::sink::SinkHooks;
use super::trace::{from_rpc_meta, parse_traceparent, parse_traceparent_value, with_trace};
use super::writer::{cap, iso_time, OutStream, WriteFields, Writer, WriterOptions};
use plur1bus_log_schema::Level;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::Write;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

const T0: i64 = 1_791_374_400_000;

fn fixture(name: &str) -> Value {
    let path = format!(
        "{}/../../fixtures/parity/logs/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap()
}

fn level(v: &Value) -> Level {
    Level::parse(v.as_str().unwrap()).unwrap()
}

fn settings(v: &Value, now: i64) -> LevelSettings {
    LevelSettings {
        default_level: v.get("defaultLevel").map(level),
        levels: v
            .get("levels")
            .and_then(Value::as_object)
            .map(|m| m.iter().map(|(k, l)| (k.clone(), level(l))).collect())
            .unwrap_or_default(),
        trace_until: v
            .get("traceUntilIn")
            .and_then(Value::as_i64)
            .map(|d| now + d),
    }
}

#[test]
fn level_policy_vectors() {
    let cases = fixture("levels");
    let mut steps_run = 0;
    for case in cases["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let now = Arc::new(AtomicI64::new(T0));
        let n = now.clone();
        let mut policy = LevelPolicy::new(Arc::new(move || n.load(Ordering::SeqCst)), None);
        for (step, expected) in case["steps"]
            .as_array()
            .unwrap()
            .iter()
            .zip(case["results"].as_array().unwrap())
        {
            steps_run += 1;
            let got = match step["op"].as_str().unwrap() {
                "clock" => {
                    now.store(T0 + step["at"].as_i64().unwrap(), Ordering::SeqCst);
                    json!({})
                }
                "update" => match policy.update(&settings(&step["settings"], T0)) {
                    Ok(()) => json!({"ok": true}),
                    Err(e) => json!({"error": e.to_string()}),
                },
                _ => {
                    let source = Source::new(
                        step["kind"].as_str().unwrap(),
                        step["id"].as_str().unwrap(),
                        None,
                    );
                    let mut expired = Vec::new();
                    let level = policy.resolve_reporting(&source, &mut expired);
                    json!({"level": level.as_str(), "expired": expired})
                }
            };
            assert_eq!(&got, expected, "{name}: {step}");
        }
    }
    assert!(steps_run > 40, "{steps_run}");
}

#[test]
fn trace_vectors() {
    let v = fixture("trace");
    for case in v["parse"].as_array().unwrap() {
        let got = parse_traceparent_value(&case["input"]).map(
            |c| json!({"trace_id": c.trace_id, "span_id": c.span_id, "traceparent": c.traceparent}),
        );
        assert_eq!(
            got.unwrap_or(Value::Null),
            case["output"],
            "{}",
            case["name"]
        );
    }
    for case in v["fromMeta"].as_array().unwrap() {
        let ctx = from_rpc_meta(&case["meta"], case["trusted"].as_bool().unwrap());
        let adopted = ctx.link_trace_id.is_none() && case["adopted"].as_bool().unwrap();
        assert_eq!(
            adopted,
            case["adopted"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
        assert_eq!(
            if adopted {
                json!(ctx.traceparent)
            } else {
                Value::Null
            },
            case["traceparent"],
            "{}",
            case["name"]
        );
        assert_eq!(
            ctx.link_trace_id.map_or(Value::Null, Value::String),
            case["link"],
            "{}",
            case["name"]
        );
    }
}

#[test]
fn output_vectors() {
    let v = fixture("output");
    for case in v["sanitise"].as_array().unwrap() {
        assert_eq!(
            sanitise(case["input"].as_str().unwrap()),
            case["output"].as_str().unwrap(),
            "{}",
            case["name"]
        );
    }
    for case in v["signal"].as_array().unwrap() {
        let i = &case["input"];
        let s = Signal {
            exit_code: i.get("exitCode").and_then(Value::as_i64),
            signal: i.get("signal").and_then(Value::as_str).map(str::to_string),
            http_status: i
                .get("httpStatus")
                .and_then(Value::as_u64)
                .map(|n| n as u16),
            retrying: i.get("retrying").and_then(Value::as_bool).unwrap_or(false),
            protocol_error: i
                .get("protocolError")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        };
        assert_eq!(
            signal_level(&s).as_str(),
            case["output"].as_str().unwrap(),
            "{}",
            case["name"]
        );
    }
    for case in v["cap"].as_array().unwrap() {
        assert_eq!(
            cap(
                case["text"].as_str().unwrap(),
                case["bytes"].as_u64().unwrap() as usize
            ),
            case["output"].as_str().unwrap(),
            "{:?}",
            case
        );
    }
}

#[test]
fn file_listing_and_collation_vectors() {
    let v = fixture("files");
    for case in v["cases"].as_array().unwrap() {
        let dir = tempfile::tempdir().unwrap();
        for name in case["names"].as_array().unwrap() {
            std::fs::write(dir.path().join(name.as_str().unwrap()), "").unwrap();
        }
        let stream = if case["stream"] == "audit" {
            Stream::Audit
        } else {
            Stream::Diagnostic
        };
        let got: Vec<Value> = list_log_files(dir.path(), stream)
            .iter()
            .map(|f| json!({"name": f.path.file_name().unwrap().to_str().unwrap(), "component": f.component, "generation": f.generation}))
            .collect();
        assert_eq!(Value::Array(got), case["listed"], "{}", case["name"]);
    }
    let mut input: Vec<String> = v["collation"]["input"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap().to_string())
        .collect();
    input.sort_by(|a, b| locale_compare(a, b));
    let sorted: Vec<String> = v["collation"]["sorted"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap().to_string())
        .collect();
    assert_eq!(input, sorted);
}

fn segments_bytes(segments: &Value) -> Vec<u8> {
    let mut out = Vec::new();
    for s in segments.as_array().unwrap() {
        if let Some(text) = s.as_str() {
            out.extend_from_slice(text.as_bytes());
        } else if let Some(fill) = s.get("fill") {
            out.extend(std::iter::repeat_n(
                fill.as_str().unwrap().as_bytes()[0],
                s["bytes"].as_u64().unwrap() as usize,
            ));
        } else {
            let t = &s["tsLines"];
            for i in 0..t["count"].as_i64().unwrap() {
                let ts = iso_time(T0 + i * t["stepMs"].as_i64().unwrap()).unwrap();
                let pad = "x".repeat(t["pad"].as_u64().unwrap() as usize);
                out.extend_from_slice(
                    format!("{{\"ts\":\"{ts}\",\"n\":{i},\"pad\":\"{pad}\"}}\n").as_bytes(),
                );
            }
        }
    }
    out
}

fn shaped(text: &str, too_long: bool) -> Value {
    if text.len() <= 64 {
        json!({"text": text, "tooLong": too_long})
    } else {
        json!({"tooLong": too_long, "len": text.len(), "head": text.chars().take(16).collect::<String>(), "sha256": format!("{:x}", Sha256::digest(text.as_bytes()))})
    }
}

/// `{count, lines}`; the recorded list may keep only its first lines (the long stamped file).
fn assert_lines(got: &[super::lines::RawLine], expected: &Value, what: &str) {
    let want = expected["lines"].as_array().unwrap();
    assert_eq!(
        got.len() as u64,
        expected["count"].as_u64().unwrap(),
        "{what}: count"
    );
    for (i, w) in want.iter().enumerate() {
        assert_eq!(
            &shaped(&got[i].text, got[i].too_long),
            w,
            "{what}: line {i}"
        );
    }
}

#[test]
fn line_reader_vectors() {
    let v = fixture("lines");
    for case in v["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.log");
        let bytes = segments_bytes(&case["segments"]);
        File::create(&path).unwrap().write_all(&bytes).unwrap();
        let file = File::open(&path).unwrap();
        let size = bytes.len() as u64;
        assert_eq!(size, case["size"].as_u64().unwrap(), "{name}");
        for f in case["forward"].as_array().unwrap() {
            let mut o =
                ForwardOptions::new(f["start"].as_u64().unwrap(), f["end"].as_u64().unwrap());
            if let Some(m) = f.get("maxLine") {
                o.max_line = m.as_u64().unwrap() as usize;
            }
            let got: Vec<_> = forward_lines(&file, o).map(Result::unwrap).collect();
            assert_lines(&got, f, &format!("{name} forward {f}"));
        }
        for b in case["backward"].as_array().unwrap() {
            let max = b
                .get("maxLine")
                .map_or(MAX_LINE, |m| m.as_u64().unwrap() as usize);
            let got: Vec<_> = backward_lines(&file, b["end"].as_u64().unwrap(), max, None)
                .unwrap()
                .map(Result::unwrap)
                .collect();
            assert_lines(&got, b, &format!("{name} backward end {}", b["end"]));
        }
        for b in case["boundary"].as_array().unwrap() {
            assert_eq!(
                last_line_boundary(&file, b["end"].as_u64().unwrap(), None).unwrap(),
                b["output"].as_u64().unwrap(),
                "{name} boundary {b}"
            );
        }
        for a in case["align"].as_array().unwrap() {
            assert_eq!(
                align_forward(&file, a["off"].as_i64().unwrap(), size, None).unwrap(),
                a["output"].as_u64().unwrap(),
                "{name} align {a}"
            );
        }
        for s in case["seek"].as_array().unwrap() {
            let unreadable = s.get("unreadable").is_some();
            let ts_of = |line: &str| -> Option<String> {
                if unreadable {
                    return None;
                }
                let at = line.find("\"ts\":\"")? + 6;
                let end = line[at..].find('"')?;
                Some(line[at..at + end].to_string())
            };
            let got = seek_by_ts(
                &file,
                size,
                s["ts"].as_str().unwrap(),
                &ts_of,
                s["strict"].as_bool().unwrap(),
                None,
            )
            .unwrap();
            assert_eq!(got, s["output"].as_u64().unwrap(), "{name} seek {s}");
        }
    }
}

fn expand(v: &Value) -> Value {
    match v {
        Value::Array(a) => Value::Array(a.iter().map(expand).collect()),
        Value::Object(o) => match o.get("$repeat") {
            Some(r) => Value::String(
                r[0].as_str()
                    .unwrap()
                    .repeat(r[1].as_u64().unwrap() as usize),
            ),
            None => Value::Object(o.iter().map(|(k, x)| (k.clone(), expand(x))).collect()),
        },
        other => other.clone(),
    }
}

fn error_text(e: &super::error::LogError) -> String {
    match e {
        super::error::LogError::Invalid { code, .. } => format!("invalid log record: {code}"),
        other => other.to_string(),
    }
}

#[test]
fn writer_record_vectors() {
    let v = fixture("records");
    let mut notes = 0;
    for case in v["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("logs");
        let now = Arc::new(AtomicI64::new(T0));
        let n = now.clone();
        let mut o = WriterOptions::new(&dir, "core", Source::new("harness", "core", Some("0.1.0")));
        o.now = Some(Arc::new(move || n.load(Ordering::SeqCst)));
        o.timers = false;
        o.hooks = SinkHooks {
            secure_path: Arc::new(|_, _| true),
            ..SinkHooks::default()
        };
        o.redact_pii = case["options"]["redactPii"] == true;
        let w = Writer::new(o).unwrap();
        let mut errors: Vec<Value> = Vec::new();
        with_trace(
            parse_traceparent(v["trace"].as_str().unwrap()).unwrap(),
            || {
                for op in case["ops"].as_array().unwrap() {
                    let result = match op["op"].as_str().unwrap() {
                        "write" => {
                            let mut fields = WriteFields::default();
                            let f = &op["fields"];
                            fields.level = f.get("level").map(level);
                            fields.stream = f.get("stream").map(|s| {
                                if s == "stderr" {
                                    OutStream::Stderr
                                } else {
                                    OutStream::Stdout
                                }
                            });
                            fields.bypass_rate = f["bypassRate"] == true;
                            fields.source = f.get("source").map(|s| {
                                Source::new(
                                    s["kind"].as_str().unwrap(),
                                    s["id"].as_str().unwrap(),
                                    s["version"].as_str(),
                                )
                            });
                            w.write(op["event"].as_str().unwrap(), expand(&op["attrs"]), fields)
                        }
                        "many" => {
                            let mut last = Ok(());
                            for i in 0..op["count"].as_u64().unwrap() {
                                last = w.write(
                                    op["event"].as_str().unwrap(),
                                    json!({ op["key"].as_str().unwrap(): i }),
                                    WriteFields::default(),
                                );
                            }
                            last
                        }
                        "legacy" => {
                            let fields: Map<String, Value> =
                                expand(&op["fields"]).as_object().cloned().unwrap();
                            w.write_legacy(
                                level(&op["level"]),
                                expand(&op["msg"]).as_str().unwrap(),
                                &fields,
                            )
                        }
                        "advance" => {
                            now.fetch_add(op["ms"].as_i64().unwrap(), Ordering::SeqCst);
                            Ok(())
                        }
                        "tick" => w.tick(false),
                        "flush" => w.flush(true),
                        "close" => w.close(),
                        "secret" => {
                            w.register_secret(op["value"].as_str().unwrap(), op["pinned"] == true);
                            Ok(())
                        }
                        "levels" => {
                            w.update_levels(settings(&op["settings"], now.load(Ordering::SeqCst)))
                        }
                        other => panic!("{name}: unknown op {other}"),
                    };
                    errors.push(
                        result
                            .err()
                            .map_or(Value::Null, |e| Value::String(error_text(&e))),
                    );
                }
            },
        );
        w.flush(true).unwrap();
        assert_eq!(Value::Array(errors), case["errors"], "{name}: errors");
        let text = std::fs::read_to_string(dir.join("core.log")).unwrap_or_default();
        let all: Vec<&str> = text.lines().collect();
        assert_eq!(
            all.len() as u64,
            case["count"].as_u64().unwrap(),
            "{name}: line count"
        );
        let recorded = case["lines"].as_array().unwrap();
        let ours = &all[all.len() - recorded.len()..];
        let noted = case.get("note").is_some();
        notes += usize::from(noted);
        for (i, line) in ours.iter().enumerate() {
            let ts_line = recorded[i].as_str().unwrap();
            assert_eq!(
                *line,
                case["canonical"][i].as_str().unwrap(),
                "{name}: line {i} (canonical)"
            );
            let (a, b): (Value, Value) = (
                serde_json::from_str(line).unwrap(),
                serde_json::from_str(ts_line).unwrap(),
            );
            assert_eq!(a, b, "{name}: line {i} (same value)");
            if !noted {
                assert_eq!(*line, ts_line, "{name}: line {i} (same bytes)");
            }
        }
    }
    assert!(notes >= 5, "{notes}");
}
