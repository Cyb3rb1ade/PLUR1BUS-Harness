//! Replays `fixtures/parity/attestation/service.json` (mode V, `scripts/parity/export-attestation.ts`). The helper double
//! answers like `scripted-attest.mjs`: the template's members, with `"$nonce"` and `"$hash"` filled from the request the
//! Rust service built and the members of `$omit` left out; a probe answers `$probe` or the script's default.
use super::helper::{HelperHost, HelperOutcome, HelperSpec};
use super::service::{AttestAudit, AttestInput, AttestProbe, AttestationService};
use serde_json::{json, Map, Value};

struct Scripted(Value);

impl HelperHost for Scripted {
    fn verify(&self, _spec: &HelperSpec) -> Result<String, &'static str> {
        Ok(String::new())
    }
    fn run(
        &self,
        _spec: &HelperSpec,
        mode: &str,
        request: Option<&Value>,
        _deadline_ms: f64,
    ) -> HelperOutcome {
        let tpl = self.0.as_object().unwrap();
        if mode == "--probe" {
            let p = tpl
                .get("$probe")
                .cloned()
                .unwrap_or(json!({ "v": 1, "available": true, "method": "scripted" }));
            return HelperOutcome::Reply(p.as_object().unwrap().clone());
        }
        let req = request.unwrap();
        let mut reply = Map::new();
        for (k, v) in tpl {
            if k.starts_with('$') {
                continue;
            }
            let filled = match v.as_str() {
                Some("$nonce") => req["nonce"].clone(),
                Some("$hash") => req["actionHash"].clone(),
                _ => v.clone(),
            };
            reply.insert(k.clone(), filled);
        }
        for k in tpl
            .get("$omit")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            reply.remove(k.as_str().unwrap());
        }
        HelperOutcome::Reply(reply)
    }
}

#[derive(Default)]
struct Lines(Vec<Value>);

impl AttestAudit for Lines {
    fn record(&mut self, action: &str, fields: &Value) -> Result<(), String> {
        self.0.push(json!({ "action": action, "fields": fields }));
        Ok(())
    }
}

fn input_of(v: &Value) -> AttestInput {
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned);
    AttestInput {
        action_hash: s("actionHash").unwrap(),
        text: s("text").unwrap(),
        person: s("person"),
        request_id: s("requestId"),
        agent_id: s("agentId"),
        scope: s("scope"),
        ttl_ms: v.get("ttlMs").and_then(Value::as_f64),
    }
}

#[test]
fn service_vectors_replay() {
    let f: Value = serde_json::from_str(include_str!(
        "../../../../fixtures/parity/attestation/service.json"
    ))
    .unwrap();
    let mut steps = 0;
    for sc in f.as_array().unwrap() {
        let host = Scripted(sc["template"].clone());
        let helper = (!sc["template"].is_null()).then(|| HelperSpec {
            path: "/opt/plur1bus/plur1bus-attest".into(),
            ..HelperSpec::default()
        });
        let now = sc["now"].as_f64().unwrap();
        let clock = move || now;
        let mut n = 0;
        let mut nonce = || {
            n += 1;
            format!("n{n}")
        };
        let mut lines = Lines::default();
        {
            let mut svc =
                AttestationService::new(helper, &host, Some(&mut lines), &clock, &mut nonce, None);
            for step in sc["steps"].as_array().unwrap() {
                let got = svc.attest(&input_of(&step["input"]));
                assert_eq!(
                    got.json(),
                    step["result"],
                    "{} {}",
                    sc["name"],
                    step["input"]
                );
                steps += 1;
            }
            if let Some(p) = sc.get("probe") {
                let want = match svc.probe() {
                    AttestProbe::Available(m) => json!({ "available": true, "method": m }),
                    AttestProbe::Unavailable => {
                        json!({ "available": false, "reason": "unavailable" })
                    }
                };
                assert_eq!(&want, p, "{}", sc["name"]);
            }
            assert_eq!(svc.pending(), 0, "every nonce is spent");
        }
        let want: Vec<Value> = sc["steps"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|s| s["audit"].as_array().unwrap().clone())
            .collect();
        assert_eq!(
            Value::from(lines.0),
            Value::from(want),
            "{} audit lines",
            sc["name"]
        );
    }
    assert!(steps > 30, "{steps}");
}
