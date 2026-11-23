#![allow(clippy::unwrap_used, reason = "synthetic recorded provider exchanges")]

use plur1bus_webtools::{
    fetch::Error,
    http::{Admission, Failure},
    pacer::{self, Clock},
    search::{
        providers::{Configured, Credential, Credentials, RateLimit, Vendor},
        Client, Freshness, Provider, Query, Trace,
    },
};
use plur1bus_wire_fixtures::FakeServer;
use serde_json::{json, Value};
use std::{
    cell::{Cell, RefCell},
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use url::{Origin, Url};

const MARKER: &str = "fixture-web-provider-credential";
const CONTROL: &str = "synthetic search logger control";

struct Records(Arc<Mutex<Vec<String>>>);
impl log::Log for Records {
    fn enabled(&self, _: &log::Metadata<'_>) -> bool {
        true
    }
    fn log(&self, record: &log::Record<'_>) {
        self.0.lock().unwrap().push(record.args().to_string());
    }
    fn flush(&self) {}
}

struct Port(SocketAddr);
impl Admission for Port {
    fn pin(&self, _: &Url, _: Instant) -> Result<SocketAddr, Failure> {
        Ok(self.0)
    }
}

struct FixedClock {
    now: Cell<u64>,
    sleeps: RefCell<Vec<u64>>,
}
impl Clock for FixedClock {
    fn now_ms(&self) -> u64 {
        self.now.get()
    }
    fn sleep_ms(&self, delay: u64, cancelled: &dyn Fn() -> bool) -> Result<(), pacer::Error> {
        if cancelled() {
            return Err(pacer::Error::Cancelled);
        }
        self.sleeps.borrow_mut().push(delay);
        self.now.set(self.now.get() + delay);
        Ok(())
    }
}

struct Keys {
    origin: Origin,
    missing: bool,
}
impl Credentials for Keys {
    fn lease(&self, _: Vendor) -> Result<Option<Credential>, Error> {
        Ok((!self.missing).then(|| Credential {
            origin: self.origin.clone(),
            value: MARKER.to_owned(),
        }))
    }
}

fn failure_json(error: Error) -> Value {
    let mut value = json!({"code": error.code});
    if let Some(status) = error.status {
        value["status"] = json!(status);
    }
    if let Some(seconds) = error.retry_after_seconds {
        value["retryAfterSeconds"] = json!(seconds);
    }
    value
}

fn provider(name: &str) -> Option<Vendor> {
    match name {
        "brave" => Some(Vendor::Brave),
        "tavily" => Some(Vendor::Tavily),
        "exa" => Some(Vendor::Exa),
        "searxng" => Some(Vendor::Searxng),
        _ => None,
    }
}

#[test]
fn vendor_requests_retry_fallback_and_results_match_typescript() {
    let records = Arc::new(Mutex::new(Vec::new()));
    plur1bus_wire_log::install(Records(Arc::clone(&records))).unwrap();
    log::set_max_level(log::LevelFilter::Debug);
    log::debug!(target: "plur1bus_webtools", "{CONTROL}");

    let fixtures: Value =
        serde_json::from_str(include_str!("../../../fixtures/parity/web/search.json")).unwrap();
    let input = &fixtures["query"];
    let query = Query {
        query: input["query"].as_str().unwrap().to_owned(),
        count: input["count"].as_u64().unwrap() as usize,
        freshness: Some(Freshness::Week),
        site: input["site"].as_str().map(str::to_owned),
        lang: input["lang"].as_str().map(str::to_owned),
    };
    let agent = fixtures["agent"].as_str().unwrap();
    for case in fixtures["cases"].as_array().unwrap() {
        let server = FakeServer::start(case);
        let port = Port(server.addr);
        let origin = Url::parse(&format!("http://{}/", server.addr)).unwrap();
        let keys = Keys {
            origin: origin.origin(),
            missing: case["missingKey"] == true,
        };
        let clock = FixedClock {
            now: Cell::new(fixtures["nowMs"].as_u64().unwrap()),
            sleeps: RefCell::default(),
        };
        let outcomes = RefCell::new(Vec::new());
        let traces = RefCell::new(Vec::new());
        let vendors = case["vendors"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| provider(value.as_str().unwrap()).unwrap())
            .collect::<Vec<_>>();
        let endpoints = vendors
            .iter()
            .map(|vendor| origin.join(vendor.id()).unwrap())
            .collect::<Vec<_>>();
        let limiters = vendors
            .iter()
            .map(|_| RateLimit::new(0))
            .collect::<Vec<_>>();
        let callbacks = vendors
            .iter()
            .map(|&vendor| {
                let outcomes = &outcomes;
                move |result: Option<Error>| {
                    outcomes
                        .borrow_mut()
                        .push(json!({"vendor":vendor.id(),"failure":result.map(failure_json)}));
                }
            })
            .collect::<Vec<_>>();
        let providers = vendors
            .iter()
            .enumerate()
            .map(|(index, &vendor)| Configured {
                vendor,
                endpoint: &endpoints[index],
                admission: &port,
                credentials: Some(&keys),
                clock: &clock,
                limiter: &limiters[index],
                user_agent: agent,
                max_inline_wait_ms: 2_000,
                default_cooldown_seconds: 30,
                outcome: Some(&callbacks[index]),
            })
            .collect::<Vec<_>>();
        let providers = providers
            .iter()
            .map(|provider| provider as &dyn Provider)
            .collect::<Vec<_>>();
        let sink = |event: Trace<'_>| {
            let mut trace = json!({"tool":"web.search", "queryChars":event.query_chars,"skipped":event.skipped,"ms":event.ms});
            if let Some(provider) = event.provider {
                trace["provider"] = json!(provider);
            }
            if let Some(count) = event.results {
                trace["results"] = json!(count);
            }
            if let Some(error) = event.error {
                trace["error"] = json!(error);
            }
            traces.borrow_mut().push(trace);
        };
        let search = Client {
            providers: &providers,
            clock: &clock,
            provider_timeout: Duration::from_secs(4),
            trace: Some(&sink),
        };
        let name = case["name"].as_str().unwrap();
        for expected in case["steps"].as_array().unwrap() {
            let output = search
                .search(&query, &|| false)
                .unwrap_or_else(|error| json!({"code":error.code}));
            assert_eq!(&output, expected, "{name}");
            assert!(!output.to_string().contains(MARKER), "{name}");
        }
        let traces = json!(&*traces.borrow());
        assert_eq!(traces, case["traces"], "{name}");
        assert!(!traces.to_string().contains(MARKER), "{name}");
        assert_eq!(json!(&*outcomes.borrow()), case["outcomes"], "{name}");
        assert_eq!(json!(&*clock.sleeps.borrow()), case["sleeps"], "{name}");
        let wire = server.received();
        let expected = case["exchanges"].as_array().unwrap();
        assert_eq!(wire.len(), expected.len(), "{name}");
        for (actual, exchange) in wire.iter().zip(expected) {
            let request = &exchange["request"];
            for key in ["method", "path", "bodyBase64"] {
                assert_eq!(actual[key], request[key], "{name}: {key}");
            }
            for (key, value) in request["headers"].as_object().unwrap() {
                let value = value.as_str().unwrap().replace("<credential>", MARKER);
                assert_eq!(actual["headers"][key], value, "{name}: {key}");
            }
        }
    }
    let records = records.lock().unwrap();
    assert!(records.iter().any(|record| record == CONTROL));
    assert!(records.iter().all(|record| !record.contains(MARKER)));
}

#[test]
fn a_vendor_reply_cannot_copy_the_bound_lease_into_a_search_result() {
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, MARKER);
    let server = FakeServer::start(&json!({
        "transport":"http", "exchanges":[
            { "request":{ "method":"POST", "path":"/search" },
              "response":{ "status":200, "body": { "results":[
                  { "title": format!("Catalog {MARKER}"), "url":"https://books.example.invalid/catalog",
                    "content": format!("Description {encoded}") },
                  { "title":"About", "url":format!("https://books.example.invalid/{MARKER}") },
              ] } }},
        ],
    }));
    let endpoint = Url::parse(&format!("http://{}/search", server.addr)).unwrap();
    let clock = FixedClock {
        now: Cell::new(1_700_000_000_000),
        sleeps: RefCell::new(Vec::new()),
    };
    let keys = Keys {
        origin: endpoint.origin(),
        missing: false,
    };
    let vendor = Configured {
        vendor: Vendor::Tavily,
        endpoint: &endpoint,
        admission: &Port(server.addr),
        credentials: Some(&keys),
        clock: &clock,
        limiter: &RateLimit::new(0),
        user_agent: "fixture-web",
        max_inline_wait_ms: 10,
        default_cooldown_seconds: 1,
        outcome: None,
    };
    let query = Query {
        query: "Catalog".into(),
        count: 2,
        freshness: None,
        site: None,
        lang: None,
    };
    let actual = vendor
        .search(&query, Instant::now() + Duration::from_secs(2), &|| false)
        .unwrap();
    let result = serde_json::to_string(&actual).unwrap();
    assert_eq!(actual.len(), 1);
    assert!(result.contains("Catalog"));
    assert!(!result.contains(MARKER));
    assert!(!result.contains(&encoded));
}
