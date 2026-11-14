//! The generated server half (feature `server`, P4-03): pruned validators against the method fixtures and against
//! negative params per method family, and the dispatcher's order and outcomes with a small in-process server.
use plur1bus_rpc::server::CoreMethods;
use plur1bus_rpc::server::{
    compile, dispatch_core, findings, pruned_root, schema, server_of, DispatchError, MethodError,
    Validators, BRIDGE_METHODS, CORE_METHODS, ENGINE_METHODS, MODULE_METHODS, SUPERVISOR_METHODS,
    TOOLS_METHODS,
};
use plur1bus_rpc::types;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::task::{Context, Poll, Waker};

const SERVERS: [&str; 6] = ["bridge", "core", "engine", "module", "supervisor", "tools"];

/// `packages/rpc-schema/fixtures/methods/<m>.json` as (method, params, result); `jobs.run.system`/`.user` are `jobs.run`.
fn fixtures() -> Vec<(String, Value, Value)> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/rpc-schema/fixtures/methods");
    let mut all = Vec::new();
    for entry in std::fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        let stem = path.file_stem().unwrap().to_str().unwrap().to_owned();
        let method = match stem.as_str() {
            "jobs.run.system" | "jobs.run.user" => "jobs.run".to_owned(),
            _ => stem,
        };
        let fixture: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        all.push((method, fixture["params"].clone(), fixture["result"].clone()));
    }
    all.sort_by(|a, b| a.0.cmp(&b.0));
    all
}

fn methods() -> &'static serde_json::Map<String, Value> {
    schema()["$defs"]["methods"].as_object().unwrap()
}

/// What `capabilities()` and the TypeScript server compile: the whole document, entered at the method's params.
fn full_validator(method: &str) -> jsonschema::Validator {
    let mut root = schema().clone();
    root["$ref"] = json!(format!("#/$defs/methods/{method}/params"));
    compile(&root).unwrap()
}

#[test]
fn every_reference_in_the_schema_names_a_top_level_definition() {
    // The pruning closure relies on it.
    fn walk(v: &Value, bad: &mut Vec<String>) {
        match v {
            Value::Object(m) => m.iter().for_each(|(k, x)| match (k.as_str(), x) {
                ("$ref", Value::String(r))
                    if r.strip_prefix("#/$defs/").is_some_and(|n| !n.contains('/')) => {}
                ("$ref", other) => bad.push(other.to_string()),
                _ => walk(x, bad),
            }),
            Value::Array(a) => a.iter().for_each(|x| walk(x, bad)),
            _ => {}
        }
    }
    let mut bad = Vec::new();
    walk(schema(), &mut bad);
    assert!(bad.is_empty(), "{bad:?}");
}

#[test]
fn the_generated_method_lists_are_the_schema_split_by_x_server() {
    let mut by_server: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for (name, definition) in methods() {
        by_server
            .entry(server_of(definition))
            .or_default()
            .push(name);
    }
    for (server, generated) in SERVERS.iter().zip([
        BRIDGE_METHODS,
        CORE_METHODS,
        ENGINE_METHODS,
        MODULE_METHODS,
        SUPERVISOR_METHODS,
        TOOLS_METHODS,
    ]) {
        let mut expected = by_server.remove(server).unwrap_or_default();
        expected.sort_unstable();
        assert_eq!(generated, expected.as_slice(), "{server}");
    }
    assert!(
        by_server.is_empty(),
        "an x-server value without a trait: {:?}",
        by_server.keys()
    );
}

#[test]
fn every_method_fixture_passes_its_pruned_params_and_result_validators() {
    let validators: BTreeMap<&str, Validators> = SERVERS
        .iter()
        .map(|s| (*s, Validators::for_server(s).unwrap()))
        .collect();
    let mut checked = BTreeSet::new();
    for (method, params, result) in fixtures() {
        let server = server_of(&methods()[&method]);
        let v = &validators[server];
        if let Err(e) = v.check_params(&method, params) {
            panic!("{method} params: {e:?}");
        }
        if let Err(e) = v.check_result(&method, &result) {
            panic!("{method} result: {e:?}");
        }
        checked.insert(method);
    }
    assert_eq!(
        checked,
        methods().keys().cloned().collect(),
        "every RPC method"
    );
}

/// Per method family (the name up to the first dot) at least one invalid params object is refused, by the pruned
/// validator and by the full-document validator alike; every method refuses an unknown key (its params are closed).
#[test]
fn invalid_params_of_every_method_family_are_refused_by_pruned_and_full_validators_alike() {
    let fixtures: BTreeMap<String, Value> = fixtures()
        .into_iter()
        .map(|(method, params, _)| (method, params))
        .collect();
    let mut families: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for name in methods().keys() {
        families
            .entry(name.split('.').next().unwrap())
            .or_default()
            .push(name);
    }
    assert!(families.len() >= 40, "{} families", families.len());
    for (family, names) in &families {
        for (i, name) in names.iter().enumerate() {
            let definition = &methods()[*name];
            let pruned = compile(&pruned_root(schema(), &definition["params"])).unwrap();
            let mut unknown = fixtures[*name].clone();
            unknown["p4aNegativeUnknownKey"] = json!(true);
            let mut cases = vec![("unknown key", unknown)];
            if i == 0 {
                // The family's first method also gets a wrong type and, where it has one, a missing required field;
                // these three go through the full-document validator too.
                cases.push(("not an object", json!([])));
                if let Some(required) = definition["params"]["required"]
                    .as_array()
                    .and_then(|r| r.first())
                {
                    let mut missing = fixtures[*name].clone();
                    missing
                        .as_object_mut()
                        .unwrap()
                        .remove(required.as_str().unwrap());
                    cases.push(("required field missing", missing));
                }
            }
            for (what, params) in cases {
                let found = findings(&pruned, &params);
                assert!(
                    !found.is_empty(),
                    "{family}: {name} accepted params with {what}"
                );
                if i == 0 {
                    assert!(
                        !full_validator(name).is_valid(&params),
                        "{family}: {name}: the full validator accepts what the pruned one refuses ({what})"
                    );
                }
            }
        }
    }
}

/// Runs a future that never waits (the probe's methods are synchronous).
fn ready<F: Future>(future: F) -> F::Output {
    let mut future = std::pin::pin!(future);
    match future
        .as_mut()
        .poll(&mut Context::from_waker(Waker::noop()))
    {
        Poll::Ready(output) => output,
        Poll::Pending => panic!("the probe never waits"),
    }
}

fn assert_send<T: Send>(_: &T) {}

/// Serves two core methods: `events.unsubscribe` (refusing the subscription id `refuse`) and `telemetry.cache.summary`
/// (returning whatever result it was given, so a test can make it violate the schema).
struct Probe {
    calls: AtomicUsize,
    summary: Value,
}

impl CoreMethods for Probe {
    type Context = ();

    fn events_unsubscribe(
        &self,
        _cx: &(),
        params: types::EventsUnsubscribeParams,
    ) -> impl Future<Output = Result<types::EventsUnsubscribeResult, MethodError>> + Send {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let id = serde_json::to_value(&params).unwrap()["subscriptionId"].clone();
        async move {
            if id == "refuse" {
                let code = serde_json::from_value(json!("E_NOT_FOUND")).unwrap();
                return Err(MethodError::rpc(code, "no such subscription")
                    .with_reason("subscription-unknown"));
            }
            Ok(serde_json::from_value(json!({"removed": id == "sub-1"})).unwrap())
        }
    }

    fn telemetry_cache_summary(
        &self,
        _cx: &(),
        _params: types::TelemetryCacheSummaryParams,
    ) -> impl Future<Output = Result<types::TelemetryCacheSummaryResult, MethodError>> + Send {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let result = serde_json::from_value(self.summary.clone()).unwrap();
        async move { Ok(result) }
    }
}

fn probe() -> (Probe, Validators) {
    let summary = fixtures()
        .into_iter()
        .find(|(m, _, _)| m == "telemetry.cache.summary")
        .unwrap()
        .2;
    (
        Probe {
            calls: AtomicUsize::new(0),
            summary,
        },
        Validators::for_server("core").unwrap(),
    )
}

#[test]
fn a_served_method_goes_through_both_validators_and_meta_is_removed_first() {
    let (probe, validators) = probe();
    let future = dispatch_core(
        &probe,
        &(),
        &validators,
        "events.unsubscribe",
        json!({"subscriptionId": "sub-1"}),
    );
    assert_send(&future);
    assert_eq!(ready(future).unwrap(), json!({"removed": true}));
    // D111: `_meta` is not a method field; it neither fails the closed params nor reaches the method.
    let with_meta = json!({"subscriptionId": "sub-2", "_meta": {"traceparent": "trace-test"}});
    assert_eq!(
        ready(dispatch_core(
            &probe,
            &(),
            &validators,
            "events.unsubscribe",
            with_meta
        ))
        .unwrap(),
        json!({"removed": false})
    );
    assert_eq!(probe.calls.load(Ordering::SeqCst), 2);
}

#[test]
fn the_dispatcher_refuses_in_module_api_order_and_never_calls_the_method_with_bad_params() {
    let (probe, validators) = probe();
    for method in ["no.such.method", "engine.auth", "supervisor.auth"] {
        let outcome = ready(dispatch_core(&probe, &(), &validators, method, json!({})));
        assert!(
            matches!(outcome, Err(DispatchError::UnknownMethod)),
            "{method}: {outcome:?}"
        );
    }
    let outcome = ready(dispatch_core(
        &probe,
        &(),
        &validators,
        "events.unsubscribe",
        json!({"subscriptionId": 7}),
    ));
    assert!(
        matches!(&outcome, Err(DispatchError::InvalidParams(f)) if !f.is_empty()),
        "{outcome:?}"
    );
    assert_eq!(probe.calls.load(Ordering::SeqCst), 0);
}

#[test]
fn an_unserved_method_is_reported_for_the_relay_after_its_params_are_checked() {
    let (probe, validators) = probe();
    let status = fixtures()
        .into_iter()
        .find(|(m, _, _)| m == "core.status")
        .unwrap()
        .1;
    let outcome = ready(dispatch_core(
        &probe,
        &(),
        &validators,
        "core.status",
        status,
    ));
    assert!(
        matches!(outcome, Err(DispatchError::NotServed)),
        "{outcome:?}"
    );
    let outcome = ready(dispatch_core(
        &probe,
        &(),
        &validators,
        "core.status",
        json!({"unexpected": 1}),
    ));
    assert!(
        matches!(outcome, Err(DispatchError::InvalidParams(_))),
        "{outcome:?}"
    );
}

#[test]
fn a_refusal_keeps_its_code_and_reason() {
    let (probe, validators) = probe();
    let outcome = ready(dispatch_core(
        &probe,
        &(),
        &validators,
        "events.unsubscribe",
        json!({"subscriptionId": "refuse"}),
    ));
    let Err(DispatchError::Method(failure)) = outcome else {
        panic!("{outcome:?}");
    };
    assert_eq!(serde_json::to_value(&failure.error).unwrap(), "E_NOT_FOUND");
    assert_eq!(failure.reason.as_deref(), Some("subscription-unknown"));
}

/// ADR-012 §2: a result that violates the schema never leaves. `since` is a `date-time` the generated type holds as a
/// plain string, so only the result validator can catch it.
#[test]
fn a_result_that_violates_the_schema_is_refused() {
    let (mut probe, validators) = probe();
    let params = json!({"window": "24h", "sessionId": "s-1"});
    assert!(ready(dispatch_core(
        &probe,
        &(),
        &validators,
        "telemetry.cache.summary",
        params.clone()
    ))
    .is_ok());
    probe.summary["since"] = json!("yesterday");
    let outcome = ready(dispatch_core(
        &probe,
        &(),
        &validators,
        "telemetry.cache.summary",
        params,
    ));
    assert!(
        matches!(&outcome, Err(DispatchError::ResultSchema(f)) if f.iter().any(|x| x.starts_with("/since "))),
        "{outcome:?}"
    );
}

/// ajv-formats' rules where the TypeScript server and `jsonschema` would disagree.
#[test]
fn date_time_and_uuid_follow_ajv_formats() {
    let check = |format: &str, value: &str| {
        compile(&json!({"type": "string", "format": format}))
            .unwrap()
            .is_valid(&json!(value))
    };
    assert!(
        check("date-time", "2026-11-07 12:00:00Z"),
        "ajv accepts a space separator"
    );
    assert!(check("date-time", "2026-11-07t12:00:00z"));
    assert!(!check("date-time", "2026-02-30T12:00:00Z"));
    assert!(
        !check("date-time", "2026-11-07T12:00:00"),
        "a zone is required"
    );
    assert!(check(
        "uuid",
        "urn:uuid:123e4567-e89b-12d3-a456-426614174000"
    ));
    assert!(check("uuid", "123E4567-E89B-12D3-A456-426614174000"));
    assert!(!check("uuid", "123e4567e89b12d3a456426614174000"));
}

/// P4-03 review F6: the format probes the review ran against ajv-formats, pinned as vectors
/// (`fixtures/parity/formats/ajv-formats.json`, recorded by `scripts/parity/export-formats.ts`). An upgrade of `jsonschema`
/// that changes a verdict fails here instead of drifting from the TypeScript server unnoticed.
#[test]
fn every_format_probe_matches_ajv_formats() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/parity/formats/ajv-formats.json");
    let vectors: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let cases = vectors["cases"].as_array().unwrap();
    assert!(cases.len() >= 40);
    let mut wrong = Vec::new();
    for case in cases {
        let format = case["format"].as_str().unwrap();
        let value = case["value"].as_str().unwrap();
        let validator = compile(&json!({"type": "string", "format": format})).unwrap();
        if validator.is_valid(&json!(value)) != case["valid"].as_bool().unwrap() {
            wrong.push(format!(
                "{format} {value:?}: ajv-formats says {}",
                case["valid"]
            ));
        }
    }
    assert!(wrong.is_empty(), "{wrong:#?}");
}

/// P4-10 security review L2: a finding names the instance path and the failed rule (ajv's words), never the value it
/// failed on, which can be a credential; property names a client sent are not echoed either.
#[test]
fn a_finding_never_quotes_the_value_it_failed_on() {
    let validator = compile(&json!({
        "type": "object",
        "required": ["needed"],
        "additionalProperties": false,
        "properties": {
            "needed": {},
            "token": {"type": "string", "pattern": "^[0-9a-f]{64}$"},
            "count": {"type": ["integer", "null"], "minimum": 1},
            "kind": {"enum": ["a", "b"]},
            "list": {"type": "array", "maxItems": 1}
        }
    }))
    .unwrap();
    let marker = "value-the-caller-sent";
    let found = findings(
        &validator,
        &json!({
            "token": [marker],
            "count": 0,
            "kind": marker,
            "list": [marker, marker],
            "key-the-caller-sent": marker
        }),
    );
    let all = found.join("; ");
    assert!(!all.contains(marker), "{all}");
    assert!(!all.contains("key-the-caller-sent"), "{all}");
    for expected in [
        "/token must be string",
        "/count must be >= 1",
        "/kind must be equal to one of the allowed values",
        "/list must NOT have more than 1 items",
        "/ must have required property 'needed'",
        "/ must NOT have additional properties",
    ] {
        assert!(found.iter().any(|f| f == expected), "{expected}: {all}");
    }
    let typed = findings(&validator, &json!({"needed": 1, "count": "x"}));
    assert_eq!(
        typed,
        ["/count must be integer,null"],
        "every allowed type, ajv's join"
    );
    let shaped = findings(&validator, &json!({"needed": 1, "token": "zz"}));
    assert_eq!(shaped, ["/token must match pattern \"^[0-9a-f]{64}$\""]);
}
