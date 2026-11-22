use super::*;
use crate::collab::GuardrailReason;
use std::collections::HashMap;

fn field<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap()
}

fn report(id: &str) -> ChildOutput {
    ChildOutput {
        report: json!({
            "schema": "plur1bus.return/1", "id": format!("rt_{id}"), "inReplyTo": format!("ho_{id}"), "status": "partial",
            "summary": "fixture", "doneWhen": [], "changes": [], "artifacts": [], "concerns": [], "blockedBy": null,
            "needs": [], "assumptionsChecked": [], "learned": [], "suggestedNext": [], "usage": { "tokens": 0, "toolCalls": 0, "durationMs": 0 },
        }),
        provenance: None,
    }
}

#[test]
fn turn_delegation_vectors() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../fixtures/parity/collab/delegations.json"
    ))
    .unwrap();
    let mut turn = TurnDelegations::default();
    let mut children = HashMap::new();
    let mut claims = HashMap::new();
    for (step, expected) in fixture["ops"]
        .as_array()
        .unwrap()
        .iter()
        .zip(fixture["results"].as_array().unwrap())
    {
        let ids = || {
            step["ids"]
                .as_array()
                .unwrap()
                .iter()
                .map(|id| id.as_str().unwrap())
                .collect::<Vec<_>>()
        };
        let id = || field(step, "id");
        let run = match field(step, "op") {
            "start" => {
                let signal = AbortSignal::new();
                children.insert(id(), signal.clone());
                turn.start(
                    id(),
                    field(step, "project"),
                    step["card"].as_bool().unwrap(),
                    signal,
                    json!({ "fromAgent": "sender" }),
                )
                .map(|()| Value::Null)
            }
            "complete" => turn
                .complete(
                    id(),
                    if step["error"] == true {
                        Err(CollabError::guardrail(
                            "fixture-private",
                            GuardrailReason::Timeout,
                        ))
                    } else {
                        Ok(report(id()))
                    },
                )
                .map(|()| Value::Null),
            "collect" => turn
                .collect(&ids(), &AbortSignal::new(), step["claim"].is_string())
                .map(|mut c| {
                    if let Some(claim) = c.receipt.take() {
                        claims.insert(field(step, "claim"), claim);
                    }
                    c.to_value()
                }),
            "projects" => turn.projects(&ids()).map(|projects| json!(projects)),
            "settle" => {
                turn.settle(
                    &claims[field(step, "claim")],
                    step["accepted"].as_bool().unwrap(),
                );
                Ok(Value::Null)
            }
            "cancel-unbound" => {
                turn.cancel_unbound(id());
                Ok(Value::Null)
            }
            "aborted" => Ok(json!(children[id()].is_aborted())),
            "finish" => Ok(json!(
                turn.finish(step["cancel"].as_bool().unwrap(), false)
                    .results
            )),
            "closed" => Ok(json!(turn.is_closed())),
            op => panic!("unexpected op {op}"),
        };
        let result = match run {
            Ok(v) => json!({ "ok": v }),
            Err(e) => json!({ "err": { "code": e.code.as_str(), "message": e.message } }),
        };
        assert_eq!(&result, expected, "{step}");
    }
}
