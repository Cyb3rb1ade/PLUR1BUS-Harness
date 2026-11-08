#![allow(
    clippy::unwrap_used,
    reason = "actual Node runtime probe vectors and real Lance adapter tests"
)]
use super::*;
use std::{collections::BTreeMap, sync::Mutex};
#[derive(Default)]
struct Live {
    calls: Vec<Value>,
    rows: BTreeMap<String, Value>,
}
struct Host {
    case: Value,
    live: Arc<Mutex<Live>>,
}
impl Host {
    fn event(&self, value: Value) {
        self.live.lock().unwrap().calls.push(value);
    }
}
struct Db {
    case: Value,
    live: Arc<Mutex<Live>>,
}
impl ProbeDb for Db {
    fn store(&self, row: &Value, _: &Cancel) -> Result<(), Error> {
        let mut l = self.live.lock().unwrap();
        l.calls.push(json!({"kind":"store","row":row}));
        if self.case["storeFails"] == true {
            return Err(Error::Host);
        }
        l.rows
            .insert(row["id"].as_str().unwrap().into(), row.clone());
        Ok(())
    }
    fn search(&self, vector: &[f64], _: &Cancel) -> Result<Vec<String>, Error> {
        let mut l = self.live.lock().unwrap();
        l.calls
            .push(json!({"kind":"search","vector":vector,"limit":5,"threshold":0}));
        if self.case["searchFails"] == true {
            return Err(Error::Host);
        }
        Ok(if self.case["miss"] == true {
            vec![]
        } else {
            l.rows.keys().cloned().collect()
        })
    }
    fn delete(&self, id: &str, c: &Cancel) -> Result<(), Error> {
        check(c)?;
        let mut l = self.live.lock().unwrap();
        l.calls.push(json!({"kind":"delete","id":id}));
        if self.case["deleteFails"] == true {
            return Err(Error::Host);
        }
        l.rows.remove(id);
        Ok(())
    }
}
impl ProbeHost for Host {
    fn active_generation(&self, _: &Cancel) -> Result<Option<String>, Error> {
        Ok(Some(
            self.case["active"]
                .as_str()
                .unwrap_or("target-generation")
                .into(),
        ))
    }
    fn create_id(&self) -> String {
        self.case["id"]
            .as_str()
            .unwrap_or("86db0fe4-922c-4ea2-9259-ea35ef10537d")
            .into()
    }
    fn now_ms(&self) -> f64 {
        self.case["now"].as_f64().unwrap_or(1234.0)
    }
    fn embed(&self, input: &Value, c: &Cancel) -> Result<Vec<f64>, Error> {
        self.event(json!({"kind":"embed","input":input}));
        let purpose = input["purpose"].as_str().unwrap();
        if purpose == "query" {
            if self.case["cancelQuery"] == true {
                c.cancel();
                return Err(Error::Cancelled);
            }
            if self.case["queryFails"] == true {
                return Err(Error::Provider);
            }
        }
        Ok(match self.case[purpose].as_str() {
            Some("width") => vec![1.0, 0.0],
            Some("nan") => vec![f64::NAN, 0.0, 0.0],
            _ => vec![1.0, 0.0, 0.0],
        })
    }
    fn open(&self, target: &Value, _: &str, _: &Cancel) -> Result<Box<dyn ProbeDb>, Error> {
        self.event(json!({"kind":"open","target":target}));
        if self.case["openFails"] == true {
            return Err(Error::Host);
        }
        Ok(Box::new(Db {
            case: self.case.clone(),
            live: self.live.clone(),
        }))
    }
    fn audit(&self, entry: &Value) -> Result<bool, Error> {
        self.event(json!({"kind":"audit","entry":entry}));
        Ok(self.case["auditFails"] != true)
    }
}
fn normalized(value: &Value) -> Value {
    let json = crate::text::json::parse_json(&value.to_string()).unwrap();
    serde_json::from_str(&crate::text::json::write_json(
        &super::super::state_json::normalize(&json, 0).unwrap(),
    ))
    .unwrap()
}
#[test]
fn actual_node_runtime_probe_order_rows_cleanup_and_failures_match() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/ops/golden/reembedding-runtime-probe.json"
    ))
    .unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 19);
    for case in cases {
        let host = Host {
            case: case.clone(),
            live: Arc::new(Mutex::new(Live::default())),
        };
        let result = run(&host, &case["request"], &Cancel::never());
        if case.get("error").is_some() {
            let failure = result.unwrap_err();
            assert_eq!(
                failure.operation.is_some() && failure.cleanup.is_some(),
                case["aggregate"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
        } else {
            assert_eq!(result.unwrap(), case["value"]);
        }
        let live = host.live.lock().unwrap();
        assert_eq!(
            normalized(&json!(live.calls)),
            normalized(&case["calls"]),
            "{}",
            case["name"]
        );
        assert_eq!(
            normalized(&json!(live.rows.values().collect::<Vec<_>>())),
            normalized(&case["remaining"]),
            "{}",
            case["name"]
        );
    }
}
#[test]
fn cancellation_after_store_still_audits_and_removes_only_its_probe() {
    let host = Host {
        case: json!({"cancelQuery":true}),
        live: Arc::new(Mutex::new(Live::default())),
    };
    let cancel = Cancel::never();
    let failure = run(
        &host,
        &json!({"expectedGeneration":"target-generation","fingerprint":{"dimensions":3}}),
        &cancel,
    )
    .unwrap_err();
    assert_eq!(failure.operation, Some(Error::Cancelled));
    assert_eq!(failure.cleanup, None);
    assert!(cancel.is_cancelled());
    let live = host.live.lock().unwrap();
    assert!(live.rows.is_empty());
    assert_eq!(live.calls[live.calls.len() - 2]["kind"], "audit");
    assert_eq!(live.calls.last().unwrap()["kind"], "delete");
}
struct RealHost {
    store: Arc<Store>,
    audit_allowed: bool,
    audits: Mutex<Vec<Value>>,
}
impl ProbeHost for RealHost {
    fn active_generation(&self, c: &Cancel) -> Result<Option<String>, Error> {
        check(c)?;
        Ok(Some("target-generation".into()))
    }
    fn create_id(&self) -> String {
        "86db0fe4-922c-4ea2-9259-ea35ef10537d".into()
    }
    fn now_ms(&self) -> f64 {
        1234.0
    }
    fn embed(&self, _: &Value, c: &Cancel) -> Result<Vec<f64>, Error> {
        check(c)?;
        Ok(vec![1.0, 0.0, 0.0])
    }
    fn open(&self, target: &Value, id: &str, c: &Cancel) -> Result<Box<dyn ProbeDb>, Error> {
        check(c)?;
        assert_eq!(target["agentId"], AGENT);
        assert_eq!(target["generation"], "target-generation");
        Ok(Box::new(StoreProbeDb::new(self.store.clone(), id)?))
    }
    fn audit(&self, entry: &Value) -> Result<bool, Error> {
        self.audits.lock().unwrap().push(entry.clone());
        Ok(self.audit_allowed)
    }
}
#[test]
fn actual_lance_probe_is_recalled_then_deleted_only_after_audit() {
    for allowed in [true, false] {
        let root =
            tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let fingerprint = json!({"provider":"openai","model":"synthetic-probe","dimensions":3});
        let identity = crate::embedding::identity::identity_from_value(&fingerprint).unwrap();
        let store = Arc::new(Store::create(&root.path().join(AGENT), &identity, 3).unwrap());
        let host = RealHost {
            store: store.clone(),
            audit_allowed: allowed,
            audits: Mutex::new(Vec::new()),
        };
        let result = run(
            &host,
            &json!({"expectedGeneration":"target-generation","fingerprint":fingerprint}),
            &Cancel::never(),
        );
        assert_eq!(result.is_ok(), allowed);
        assert_eq!(
            store.count(&RowFilter::default()).unwrap(),
            usize::from(!allowed)
        );
        let audit = host.audits.lock().unwrap();
        assert_eq!(audit.len(), 1);
        assert!(audit[0].get("text").is_none());
        let db = StoreProbeDb::new(store.clone(), &host.create_id()).unwrap();
        assert!(db
            .delete("11111111-1111-4111-8111-111111111111", &Cancel::never())
            .is_err());
        assert_eq!(
            store.count(&RowFilter::default()).unwrap(),
            usize::from(!allowed)
        );
        if !allowed {
            let failure = result.unwrap_err();
            assert_eq!(failure.operation, None);
            assert_eq!(failure.cleanup, Some(Error::Audit));
            let row = store.get(&host.create_id()).unwrap().unwrap();
            assert_eq!(row.agent_id, AGENT);
            assert_eq!(row.scope, "agent-private");
            assert_eq!(row.owner_user_id, "");
        }
    }
}
