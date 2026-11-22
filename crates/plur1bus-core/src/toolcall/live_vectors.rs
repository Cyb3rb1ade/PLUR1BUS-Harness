//! Replays `fixtures/parity/capabilities/live-index.json` (mode V, `scripts/parity/export-live-index.ts`): the entry of a
//! registered tool, and scenarios over a real registry file in which the ports answer from the record (the skill
//! store's scan, the calibration file, the extension feed, the local embedder). The embedder double checks that Rust asks
//! for the same texts, of the same kind, in the same order.
use super::capabilities::SearchFilters;
use super::capability_vectors::TestClock;
use super::json::{parse_units, JsStr, Parsed, V};
use super::live_index::{
    tool_entry, validate_recheck_args, CapabilityView, EmbedderStatus, ExtensionCapability,
    ExtensionFeed, IndexedSkill, LiveCapabilityIndex, LiveStatus, LocalEmbedding, Prepared,
    SkillScan, SkillSource,
};
use super::registry::SqliteCapabilityRegistry;
use super::validation::{PortFailed, Thrown};
use super::vectors::js;
use crate::toolcall::capabilities::CapabilityIndex;
use serde_json::Value;
use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::rc::Rc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../fixtures/parity/capabilities/live-index.json"
    ))
    .expect("fixture parses")
}

fn value(spec: &Value) -> V {
    match parse_units(js(spec).units()) {
        Ok(Parsed::Value(v)) => v,
        other => panic!("not JSON: {other:?}"),
    }
}

#[test]
fn tool_entry_cases() {
    let f = fixture();
    for c in f["toolEntries"].as_array().unwrap() {
        let tool = value(&c[0]);
        let scope = c[1].as_str().unwrap();
        match (tool_entry(&tool, scope), c[2].get("throws")) {
            (Ok(entry), None) => assert_eq!(entry.stringify(), js(&c[2]).lossy(), "{}", c[0]),
            (Err(e), Some(t)) => assert_eq!(Some(e.name), t["name"].as_str(), "{}", c[0]),
            (got, _) => panic!("{} {scope}: Rust {got:?}, TypeScript {}", c[0], c[2]),
        }
    }
}

#[test]
fn recheck_arguments() {
    assert!(validate_recheck_args(None).is_ok());
    assert!(validate_recheck_args(Some(&V::Null)).is_ok());
    assert!(validate_recheck_args(Some(&V::obj([]))).is_ok());
    for bad in [
        V::obj([("invalid", V::Bool(true))]),
        V::Arr(vec![]),
        V::Num(0.0),
        V::s(""),
        V::Bool(false),
    ] {
        assert_eq!(
            validate_recheck_args(Some(&bad)),
            Err("capability recheck takes no arguments")
        );
    }
}

fn scan_of(v: &Value) -> SkillScan {
    SkillScan {
        skills: v["skills"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| IndexedSkill {
                entry: value(&s[0]),
                text: js(&s[1]),
                authored_description: (!s[2].is_null()).then(|| js(&s[2])),
            })
            .collect(),
        error: v["error"].as_bool().unwrap(),
    }
}

#[derive(Default)]
struct Scans {
    store: SkillScan,
    feed: SkillScan,
}

struct ScanDouble(Rc<RefCell<Scans>>);

impl SkillSource for ScanDouble {
    fn scan(&mut self, items: Option<&[(String, bool)]>) -> SkillScan {
        let scans = self.0.borrow();
        match items {
            None => scans.store.clone(),
            Some([]) => SkillScan::default(),
            Some(_) => scans.feed.clone(),
        }
    }
}

struct FeedDouble(Result<Vec<ExtensionCapability>, PortFailed>);

impl ExtensionFeed for FeedDouble {
    fn snapshot(&mut self) -> Result<Vec<ExtensionCapability>, PortFailed> {
        self.0.clone()
    }
}

struct EngineDouble {
    mode: Rc<RefCell<String>>,
    expected: Rc<RefCell<VecDeque<Value>>>,
}

impl LocalEmbedding for EngineDouble {
    fn status(&self) -> Option<EmbedderStatus> {
        let provider = if *self.mode.borrow() == "cloud" {
            "cloud"
        } else {
            "local-onnx"
        };
        Some(EmbedderStatus {
            ready: true,
            provider: provider.to_owned(),
            identity: format!(
                r#"{{"provider":"{provider}","model":"fixture","fingerprintId":"fx","dimensions":3}}"#
            ),
            dimensions: 3.0,
        })
    }

    fn embed(&mut self, texts: &[JsStr], kind: &str) -> Result<Vec<Vec<f32>>, PortFailed> {
        let call = self
            .expected
            .borrow_mut()
            .pop_front()
            .expect("Rust embeds where TypeScript did not");
        assert_eq!(call[0].as_str(), Some(kind));
        let want: Vec<JsStr> = call[1].as_array().unwrap().iter().map(js).collect();
        assert_eq!(texts, want.as_slice(), "embedded texts");
        if call[2].is_string() {
            return Err(PortFailed);
        }
        Ok(call[2]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| {
                v.as_array()
                    .unwrap()
                    .iter()
                    .map(|x| x.as_f64().map_or(f32::NAN, |x| x as f32))
                    .collect()
            })
            .collect())
    }
}

fn hits(index: &CapabilityIndex, queries: &Value) -> V {
    V::Arr(
        queries
            .as_array()
            .unwrap()
            .iter()
            .map(|q| {
                let q = q.as_str().unwrap();
                let found = index.search(q, &SearchFilters::default()).unwrap();
                V::Arr(vec![
                    V::s(q),
                    V::s(&V::Arr(found.iter().map(|h| h.to_v()).collect()).stringify()),
                ])
            })
            .collect(),
    )
}

fn compare_thrown(case: &str, want: &Value, got: &Thrown) {
    let t = &want["throws"];
    assert_eq!(t["name"].as_str(), Some(got.name), "{case}: {got:?}");
    if let Some(m) = t.get("message") {
        assert_eq!(m.as_str(), Some(got.message.as_str()), "{case}");
    }
}

fn status_v(s: &LiveStatus) -> V {
    s.to_v()
}

#[test]
fn live_index_scenarios() {
    let f = fixture();
    let tools: HashMap<String, V> = f["tools"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), value(v)))
        .collect();
    let mut steps_run = 0;
    for s in f["scenarios"].as_array().unwrap() {
        let name = s["name"].as_str().unwrap();
        let home = tempfile::tempdir().unwrap();
        let clock = Arc::new(TestClock(AtomicI64::new(1_000 * 3_600_000)));
        let registry =
            SqliteCapabilityRegistry::open(&home.path().join("capabilities.sqlite"), clock.clone())
                .unwrap();
        let scans = Rc::new(RefCell::new(Scans::default()));
        let calibration: Rc<RefCell<Option<String>>> = Rc::new(RefCell::new(None));
        let mode = Rc::new(RefCell::new("local".to_owned()));
        let expected = Rc::new(RefCell::new(VecDeque::new()));
        let source = Rc::clone(&calibration);
        let mut live = LiveCapabilityIndex::new(
            registry,
            clock.clone(),
            Box::new(ScanDouble(Rc::clone(&scans))),
            Box::new(move || Ok(source.borrow().clone())),
            Some(Box::new(EngineDouble {
                mode: Rc::clone(&mode),
                expected: Rc::clone(&expected),
            })),
        )
        .unwrap();
        let mut views: HashMap<String, CapabilityView> = HashMap::new();
        let mut prepared: HashMap<String, CapabilityIndex> = HashMap::new();
        for (i, step) in s["steps"].as_array().unwrap().iter().enumerate() {
            let op = step["op"].as_str().unwrap();
            let case = format!("{name} #{i} {op}");
            let want = js(&step["out"]).lossy();
            let want_value: Value = serde_json::from_str(&want).unwrap();
            *expected.borrow_mut() = step
                .get("embed")
                .and_then(Value::as_array)
                .map(|calls| calls.iter().cloned().collect())
                .unwrap_or_default();
            let got: Result<V, Thrown> = match op {
                "store" => {
                    let mut cells = scans.borrow_mut();
                    cells.store = scan_of(&want_value["scan"]);
                    if let Some(feed) = want_value.get("feedScan") {
                        cells.feed = scan_of(feed);
                    }
                    *calibration.borrow_mut() = step["store"]
                        .get("calibration")
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                    steps_run += 1;
                    continue;
                }
                "feed" => {
                    if let Some(feed) = want_value.get("feedScan") {
                        scans.borrow_mut().feed = scan_of(feed);
                    }
                    let list = match step["extensions"].as_array() {
                        None => Err(PortFailed),
                        Some(items) => Ok(items
                            .iter()
                            .map(|e| ExtensionCapability {
                                name: e["name"].as_str().unwrap().to_owned(),
                                enabled: e["enabled"].as_bool().unwrap(),
                                agents: e["agents"].as_array().map(|a| {
                                    a.iter().map(|x| x.as_str().unwrap().to_owned()).collect()
                                }),
                            })
                            .collect()),
                    };
                    live.set_extension_feed(Some(Box::new(FeedDouble(list))));
                    live.sync_extensions().unwrap();
                    let mut out = super::json::Obj::new();
                    if let Some(feed) = want_value.get("feedScan") {
                        out.set("feedScan", V::from_serde(feed));
                    }
                    out.set("status", status_v(&live.status().unwrap()));
                    // The recorded scan is data; only the status is Rust's answer.
                    let got = out.get("status").unwrap().stringify();
                    let recorded = value(&step["out"]);
                    assert_eq!(got, recorded.get("status").unwrap().stringify(), "{case}");
                    steps_run += 1;
                    continue;
                }
                "view" => {
                    let list: Vec<V> = step["tools"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|t| tools[t.as_str().unwrap()].clone())
                        .collect();
                    let blocked: Vec<String> = step
                        .get("blocked")
                        .and_then(Value::as_array)
                        .map(|b| b.iter().map(|x| x.as_str().unwrap().to_owned()).collect())
                        .unwrap_or_default();
                    live.view(
                        step["scope"].as_str().unwrap(),
                        &list,
                        &blocked,
                        step.get("agent").and_then(Value::as_str),
                    )
                    .map(|view| {
                        let mut ids: Vec<String> = view.ids.iter().cloned().collect();
                        crate::js::sort_default(&mut ids);
                        let out = V::obj([
                            ("ids", V::strs(&ids)),
                            (
                                "skills",
                                V::Arr(
                                    view.skills
                                        .iter()
                                        .map(|s| s.entry.get("name").cloned().unwrap_or(V::Null))
                                        .collect(),
                                ),
                            ),
                            ("searches", hits(&view.index, &step["queries"])),
                            ("discovery", hits(&view.discovery, &step["queries"])),
                        ]);
                        views.insert(step["as"].as_str().unwrap().to_owned(), view);
                        out
                    })
                }
                "search" => {
                    let of = step["of"].as_str().unwrap();
                    let index = prepared.get(of).unwrap_or_else(|| &views[of].index);
                    Ok(hits(index, &step["queries"]))
                }
                "record" => live
                    .registry_mut()
                    .record(
                        step["id"].as_str().unwrap(),
                        step["agent"].as_str().unwrap(),
                        step["event"].as_str().unwrap(),
                    )
                    .map(|()| V::Null)
                    .map_err(|e| Thrown::error(format!("{e:?}"))),
                "advance" => {
                    clock
                        .0
                        .fetch_add(step["ms"].as_i64().unwrap(), Ordering::SeqCst);
                    Ok(V::Null)
                }
                "engine" => {
                    *mode.borrow_mut() = step["mode"].as_str().unwrap().to_owned();
                    Ok(V::Null)
                }
                "prepare" => {
                    let view = &views[step["of"].as_str().unwrap()];
                    let query = js(&step["query"]);
                    let answer = live.prepare(&query, view, &|| false).unwrap();
                    let own = matches!(answer, Prepared::View);
                    let searched = match &answer {
                        Prepared::View => hits(&view.index, &step["queries"]),
                        Prepared::Vectors(index) => hits(index, &step["queries"]),
                    };
                    if let Prepared::Vectors(index) = answer {
                        prepared.insert(step["as"].as_str().unwrap().to_owned(), index);
                    }
                    Ok(V::obj([
                        ("own", V::Bool(own)),
                        ("searches", searched),
                        ("status", status_v(&live.status().unwrap())),
                    ]))
                }
                "recheck" => live.recheck().map(|s| status_v(&s)),
                "status" => live.status().map(|s| status_v(&s)),
                "ids" => {
                    let mut ids: Vec<String> = live
                        .registry()
                        .snapshot()
                        .unwrap()
                        .iter()
                        .filter_map(|e| e.get("id").and_then(V::as_js).map(JsStr::lossy))
                        .collect();
                    crate::js::sort_default(&mut ids);
                    Ok(V::strs(&ids))
                }
                other => panic!("unknown op {other}"),
            };
            match (got, want_value.get("throws")) {
                (Ok(v), None) => assert_eq!(v.stringify(), want, "{case}"),
                (Err(e), Some(_)) => compare_thrown(&case, &want_value, &e),
                (got, _) => panic!("{case}: Rust {got:?}, TypeScript {want}"),
            }
            assert!(
                expected.borrow().is_empty(),
                "{case}: TypeScript embedded more"
            );
            steps_run += 1;
        }
    }
    assert!(steps_run > 100, "{steps_run} steps");
}
