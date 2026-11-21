#![forbid(unsafe_code)]
#![allow(clippy::unwrap_used, clippy::panic)]

use plur1bus_providers::router::{
    AttemptBudget, Candidate, Policy, Profile, RouteError, Router, Runtime, StreamAdapter, Target,
};
use plur1bus_providers::{reasoning, ErrorKind, Json, ProviderError};
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};

#[derive(Default)]
struct Script {
    now: Cell<u64>,
    delays: RefCell<Vec<u64>>,
    diagnostics: RefCell<Vec<Value>>,
    calls: RefCell<Vec<Value>>,
    settled: RefCell<Vec<Value>>,
    denied: Vec<Value>,
    cancelled: Cell<bool>,
}

struct Ticket<'a> {
    provider: String,
    log: &'a RefCell<Vec<Value>>,
}

impl AttemptBudget for Ticket<'_> {
    fn settle(self: Box<Self>, usage: Option<&Value>) {
        self.log
            .borrow_mut()
            .push(json!({"provider": self.provider, "usage": usage}));
    }
}

impl Runtime for Script {
    fn now_ms(&self) -> u64 {
        self.now.get()
    }
    fn sleep_ms(&self, delay: u64) -> Result<(), ProviderError> {
        self.now.set(self.now.get() + delay);
        self.delays.borrow_mut().push(delay);
        Ok(())
    }
    fn random(&self) -> f64 {
        0.5
    }

    fn cancelled(&self) -> bool {
        self.cancelled.get()
    }

    fn authorize(
        &self,
        _: &str,
        target: Target<'_>,
        _: u32,
        _: &Json,
    ) -> Result<Option<Box<dyn AttemptBudget + '_>>, String> {
        if self.denied.iter().any(|p| p == target.provider) {
            return Err("fixture limit".into());
        }
        Ok(Some(Box::new(Ticket {
            provider: target.provider.into(),
            log: &self.settled,
        })))
    }

    fn event(&self, event: Value) {
        self.diagnostics.borrow_mut().push(event);
    }
}

struct Probe<'a> {
    provider: &'a str,
    model: String,
    next: Cell<usize>,
    steps: &'a [Value],
    script: &'a Script,
}

impl StreamAdapter for Probe<'_> {
    fn stream(&self, request: &Json, emit: &mut dyn FnMut(Value)) -> Result<(), ProviderError> {
        let at = self.next.get();
        self.next.set(at + 1);
        let step = &self.steps[at];
        self.script.calls.borrow_mut().push(json!({
            "provider": self.provider, "model": request["model"].text(), "maxTokens": request["maxTokens"].number().unwrap() as u64
        }));
        for event in step["events"].as_array().into_iter().flatten() {
            emit(event.clone());
        }
        if step["cancel"] == true {
            self.script.cancelled.set(true);
        }
        let Some(kind) = step["error"].as_str() else {
            return Ok(());
        };
        let kind = match kind {
            "rate_limit" => ErrorKind::RateLimit,
            "network" => ErrorKind::Network,
            "auth" => ErrorKind::Auth,
            "overloaded" => ErrorKind::Overloaded,
            other => panic!("unknown fixture error {other}"),
        };
        let mut error = ProviderError::new(kind, "fixture failure");
        error.retry_after_ms = step["retryAfterMs"].as_u64();
        Err(error)
    }
}

#[test]
fn replay_fallback_retry_budget_and_commit_boundary() {
    let recording: Value = serde_json::from_str(include_str!(
        "../../../fixtures/parity/provider-router/routing.json"
    ))
    .unwrap();
    let request = Json::parse(&recording["input"].to_string()).unwrap();
    for case in recording["cases"].as_array().unwrap() {
        let script = Script {
            denied: case["denied"].as_array().cloned().unwrap_or_default(),
            ..Script::default()
        };
        let adapters: Vec<_> = case["script"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(provider, steps)| Probe {
                provider,
                model: format!("model-{provider}"),
                next: Cell::new(0),
                steps: steps.as_array().unwrap(),
                script: &script,
            })
            .collect();
        let candidates: Vec<_> = adapters
            .iter()
            .map(|a| Candidate {
                target: Target {
                    provider: a.provider,
                    model: &a.model,
                },
                adapter: a,
            })
            .collect();
        let profile = Profile {
            name: "chosen",
            candidates: &candidates,
            defaults: &Json::parse(r#"{"maxTokens":55}"#).unwrap(),
            unsupported: None,
        };
        let router = Router::new(Policy {
            max_retries: 1,
            ..Policy::default()
        });
        let mut events = Vec::new();
        let result = router.stream(&profile, &request, &script, &mut |event| events.push(event));
        let error = match result {
            Ok(()) => Value::Null,
            Err(RouteError::Provider(error)) => json!(error.kind),
            Err(error) => panic!("{error:?}"),
        };
        let expected = &case["expected"];
        assert_eq!(error, expected["error"], "{}", case["name"]);
        assert_eq!(json!(events), expected["routed"], "{}", case["name"]);
        assert_eq!(
            json!(script.diagnostics.into_inner()),
            expected["diagnostics"],
            "{}",
            case["name"]
        );
        assert_eq!(
            json!(script.delays.into_inner()),
            expected["delays"],
            "{}",
            case["name"]
        );
        assert_eq!(
            json!(script.calls.into_inner()),
            expected["calls"],
            "{}",
            case["name"]
        );
        assert_eq!(
            json!(script.settled.into_inner()),
            expected["settled"],
            "{}",
            case["name"]
        );
    }
}

#[test]
fn a_cancelled_failed_attempt_does_not_repeat_or_charge_the_breaker() {
    let script = Script::default();
    let steps = [json!({"error": "network", "cancel": true})];
    let adapter = Probe {
        provider: "fixture",
        model: "test-model".into(),
        next: Cell::new(0),
        steps: &steps,
        script: &script,
    };
    let target = Target {
        provider: adapter.provider,
        model: &adapter.model,
    };
    let candidates = [Candidate {
        target,
        adapter: &adapter,
    }];
    let request = Json::parse(r#"{"maxTokens":64,"messages":[]}"#).unwrap();
    let profile = Profile {
        name: "test",
        candidates: &candidates,
        defaults: &Json::parse("{}").unwrap(),
        unsupported: None,
    };
    let router = Router::new(Policy {
        failure_threshold: 1,
        ..Policy::default()
    });
    let result = router.stream(&profile, &request, &script, &mut |_| {});
    assert!(matches!(result, Err(RouteError::Provider(error)) if error.kind == ErrorKind::Aborted));
    assert!(script.delays.borrow().is_empty());
    assert_eq!(script.calls.borrow().len(), 1);
    assert_eq!(
        router.breaker_state(target, &script),
        plur1bus_providers::router::Health::Closed
    );
}

#[test]
fn replay_reasoning_levels_and_directives() {
    let recording: Value = serde_json::from_str(include_str!(
        "../../../fixtures/parity/provider-router/reasoning.json"
    ))
    .unwrap();
    for case in recording["cases"].as_array().unwrap() {
        let descriptor = &case["descriptor"];
        let supported: Vec<_> = descriptor["levels"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        let nearest = reasoning::nearest_level(case["requested"].as_str().unwrap(), &supported);
        let json = nearest.map_or(
            Value::Null,
            |(level, adjusted)| json!({"level":level,"adjusted":adjusted}),
        );
        assert_eq!(json, case["expected"]["nearest"]);
        let directive = nearest.and_then(|(level, _)| {
            reasoning::directive(level, &Json::parse(&descriptor.to_string()).unwrap()).unwrap()
        });
        let json = directive.map_or(Value::Null, |v| serde_json::from_str(&v.encode()).unwrap());
        assert_eq!(json, case["expected"]["directive"]);
    }
}
