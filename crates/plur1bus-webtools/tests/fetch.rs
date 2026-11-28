#![allow(clippy::unwrap_used, reason = "recorded local web fetch fixtures")]

use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use plur1bus_webtools::{
    crawl::{Crawl, RobotsCache},
    fetch::{Args, Client, Context, Document, Documents, Error, Mode},
    http::{self, Admission, Failure},
    pacer::{self, Clock, Pacer},
    robots::Robots,
};
use plur1bus_wire_fixtures::FakeServer;
use serde_json::{json, Value};
use url::Url;

struct Port(SocketAddr);
impl Admission for Port {
    fn resolver(
        &self,
    ) -> plur1bus_providers::resolution::Resolver<Url, Result<SocketAddr, Failure>> {
        let address = self.0;
        Arc::new(move |_, _, _| Ok(address))
    }
}

struct FixedClock(u64);
impl Clock for FixedClock {
    fn now_ms(&self) -> u64 {
        self.0
    }
    fn sleep_ms(&self, _: u64, cancelled: &dyn Fn() -> bool) -> Result<(), pacer::Error> {
        if cancelled() {
            Err(pacer::Error::Cancelled)
        } else {
            Ok(())
        }
    }
}

#[derive(Default)]
struct Docs(Mutex<Option<Document>>);
impl Documents for Docs {
    fn put(&self, document: Document) -> Result<[u8; 6], Error> {
        *self.0.lock().unwrap() = Some(document);
        Ok([1, 2, 3, 4, 5, 6])
    }

    fn get(&self, id: [u8; 6], _: u64) -> Option<Document> {
        (id == [1, 2, 3, 4, 5, 6])
            .then(|| self.0.lock().unwrap().clone())
            .flatten()
    }
}

#[derive(Default)]
struct Cache(Mutex<HashMap<String, (Arc<Robots>, u64)>>);
impl RobotsCache for Cache {
    fn get(&self, origin: &str, now_ms: u64) -> Option<Arc<Robots>> {
        let entries = self.0.lock().unwrap();
        entries
            .get(origin)
            .filter(|(_, until)| *until > now_ms)
            .map(|(robots, _)| Arc::clone(robots))
    }

    fn put(&self, origin: &str, robots: Arc<Robots>, expires_at_ms: u64) {
        self.0
            .lock()
            .unwrap()
            .insert(origin.to_owned(), (robots, expires_at_ms));
    }
}

#[test]
fn web_fetch_replays_documents_cursors_and_crawl_stations() {
    let fixtures: Value =
        serde_json::from_str(include_str!("../../../fixtures/parity/web/fetch.json")).unwrap();
    let agent = fixtures["agent"].as_str().unwrap();
    let clock = FixedClock(fixtures["nowMs"].as_u64().unwrap());
    for case in fixtures["cases"].as_array().unwrap() {
        let server = FakeServer::start(case);
        let origin = format!("http://{}", server.addr);
        let port = Port(server.addr);
        let docs = Docs::default();
        let robots = Cache::default();
        let pace = Pacer::new(0);
        let crawl = Crawl {
            egress: &port,
            clock: &clock,
            robots: &robots,
            pace: &pace,
            agent,
            max_redirects: 10,
            aborted: &|| false,
        };
        let fetch = Client {
            admission: &port,
            crawl: Some(&crawl),
            store: &docs,
            clock: &clock,
            user_agent: agent,
            max_bytes: http::DEFAULT_BODY_BYTES,
            max_redirects: 10,
            default_max_tokens: 6_000,
            max_extracted_tokens: case["maxExtractedTokens"].as_u64().unwrap_or(200_000) as usize,
        };
        for (i, step) in case["steps"].as_array().unwrap().iter().enumerate() {
            let url = origin.clone() + step["path"].as_str().unwrap();
            let options = &step["options"];
            let args = Args {
                url: &url,
                mode: if options["mode"] == "raw" {
                    Mode::Raw
                } else {
                    Mode::Auto
                },
                section: options["section"].as_str(),
                cursor: options["cursor"].as_str(),
                max_tokens: options["maxTokens"].as_u64().map(|n| n as usize),
                crawl: options["crawl"] == true,
            };
            let context = Context {
                agent_id: step["agentId"].as_str().unwrap(),
                matcher: None,
                aborted: &|| false,
            };
            let actual = fetch.fetch(&args, &context, Instant::now() + Duration::from_secs(4));
            let actual = match actual {
                Ok(value) => {
                    serde_json::from_str(&value.to_string().replace(&origin, "<origin>")).unwrap()
                }
                Err(error) => {
                    let mut value = json!({"code":error.code});
                    if let Some(status) = error.status {
                        value["status"] = json!(status);
                    }
                    if let Some(delay) = error.retry_after_seconds {
                        value["retryAfterSeconds"] = json!(delay);
                    }
                    value
                }
            };
            assert_eq!(actual, step["expected"], "{} step {i}", case["name"]);
        }
        let expected = case["exchanges"].as_array().unwrap();
        let observed = server.received();
        assert_eq!(observed.len(), expected.len(), "{}", case["name"]);
        for (actual, step) in observed.iter().zip(expected) {
            for field in ["method", "path"] {
                assert_eq!(actual[field], step["request"][field], "{}", case["name"]);
            }
        }
    }
}

#[test]
fn a_cached_cursor_rechecks_the_current_secret_matcher_without_fetching_again() {
    use plur1bus_log_schema::redact::matcher::{mask, SecretMatcher};

    let marker = "synthetic-document-cursor-marker";
    let text = format!(
        "{}\n\nHere is {marker} in a later paragraph. Notes continue.",
        "a".repeat(360)
    );
    let encoded = {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        STANDARD.encode(text.as_bytes())
    };
    let route = format!("/notes?section={marker}");
    let server = FakeServer::start(&json!({"transport":"http","exchanges":[{
        "request":{"method":"GET","path": route},
        "response":{"status":200,"headers":{"content-type":"text/plain"},"chunksBase64":[encoded]}
    }]}));
    let port = Port(server.addr);
    let docs = Docs::default();
    let clock = FixedClock(1_764_000_000_000);
    let fetch = Client {
        admission: &port,
        crawl: None,
        store: &docs,
        clock: &clock,
        user_agent: "fixture-web-fetch/1",
        max_bytes: http::DEFAULT_BODY_BYTES,
        max_redirects: 10,
        default_max_tokens: 100,
        max_extracted_tokens: 200_000,
    };
    let url = format!("http://{}{route}", server.addr);
    let mut args = Args {
        url: &url,
        mode: Mode::Auto,
        section: None,
        cursor: None,
        max_tokens: None,
        crawl: false,
    };
    let mut ctx = Context {
        agent_id: "reader-a",
        matcher: None,
        aborted: &|| false,
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    let first = fetch.fetch(&args, &ctx, deadline).unwrap();
    assert!(!first["markdown"].as_str().unwrap().contains(marker));
    args.cursor = first["cursor"].as_str();
    assert!(args.cursor.is_some());
    let latest = SecretMatcher::from_strs([marker]);
    ctx.matcher = Some(&latest);
    let second = fetch.fetch(&args, &ctx, deadline).unwrap();
    assert_eq!(
        second["markdown"],
        format!("Here is {} in a later paragraph. Notes continue.", mask())
    );
    assert_eq!(second["fromCache"], true);
    assert!(first["finalUrl"].as_str().unwrap().contains(marker));
    assert!(!second["finalUrl"].as_str().unwrap().contains(marker));
    assert!(!second["provenance"]["url"]
        .as_str()
        .unwrap()
        .contains(marker));
    assert!(!second.to_string().contains(marker));
    assert_eq!(server.received().len(), 1);
}

#[test]
fn cancellation_after_read_interrupts_html_extraction() {
    use std::cell::Cell;
    struct CancelOnTimestamp(Cell<bool>);

    impl Clock for CancelOnTimestamp {
        fn now_ms(&self) -> u64 {
            self.0.set(true);
            1_764_000_000_000
        }
        fn sleep_ms(&self, _: u64, _: &dyn Fn() -> bool) -> Result<(), pacer::Error> {
            Ok(())
        }
    }

    for status in [200, 403] {
        let html = "<article><h1>Fixture edition</h1><p>Today’s ordinary summary.</p></article>";
        let wire = {
            use base64::{engine::general_purpose::STANDARD, Engine as _};
            STANDARD.encode(html)
        };
        let server = FakeServer::start(&json!({"transport":"http","exchanges":[{
            "request":{"method":"GET","path":"/edition"},
            "response":{"status":status,"headers":{"content-type":"text/html"},"chunksBase64":[wire]}
        }]}));
        let clock = CancelOnTimestamp(Cell::new(false));
        let port = Port(server.addr);
        let docs = Docs::default();
        let fetch = Client {
            admission: &port,
            crawl: None,
            store: &docs,
            clock: &clock,
            user_agent: "fixture-browser",
            max_bytes: http::DEFAULT_BODY_BYTES,
            max_redirects: 10,
            default_max_tokens: 100,
            max_extracted_tokens: 1000,
        };
        let url = format!("http://{}/edition", server.addr);
        let args = Args {
            url: &url,
            mode: Mode::Auto,
            section: None,
            cursor: None,
            max_tokens: None,
            crawl: false,
        };
        let ctx = Context {
            agent_id: "reader",
            matcher: None,
            aborted: &|| clock.0.get(),
        };
        let result = fetch.fetch(&args, &ctx, Instant::now() + Duration::from_secs(2));
        assert_eq!(
            result.err().map(|error| error.code),
            Some("timeout"),
            "HTTP {status}"
        );
        assert_eq!(server.received().len(), 1);
    }
}

#[test]
fn the_fetch_budget_and_cancellation_reach_document_processing() {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use std::cell::Cell;

    struct TestClock(Cell<Option<usize>>);
    impl Clock for TestClock {
        fn now_ms(&self) -> u64 {
            if self.0.get().is_none() {
                self.0.set(Some(0));
            }
            1_764_000_000_000
        }
        fn sleep_ms(&self, _: u64, _: &dyn Fn() -> bool) -> Result<(), pacer::Error> {
            Ok(())
        }
    }

    let array =
        serde_json::to_string(&vec!["The printed edition is available today."; 128]).unwrap();
    let levels = "<div>".repeat(201) + "Local news";
    let article = format!("<p>{}</p>", "Archived newspapers. ".repeat(2500));
    for (status, content_type, input, tokens, polls, expected) in [
        (200, "text/html", levels.as_str(), 1000, 40, "timeout"),
        (403, "text/html", levels.as_str(), 1000, 40, "timeout"),
        (200, "application/json", array.as_str(), 1000, 40, "timeout"),
        (
            200,
            "application/json",
            array.as_str(),
            128,
            40,
            "too-large",
        ),
        (200, "text/html", article.as_str(), 128, 40, "too-large"),
        (
            403,
            "text/html",
            article.as_str(),
            1000,
            40,
            "auth-required",
        ),
    ] {
        let server = FakeServer::start(&json!({
            "transport": "http",
            "exchanges": [{
                "request": {"method":"GET", "path":"/edition"},
                "response": {"status":status, "headers":{"content-type":content_type},
                    "chunksBase64":[STANDARD.encode(input)]}
            }]
        }));
        let clock = TestClock(Cell::new(None));
        let port = Port(server.addr);
        let docs = Docs::default();
        let fetch = Client {
            admission: &port,
            crawl: None,
            store: &docs,
            clock: &clock,
            user_agent: "fixture-browser",
            max_bytes: http::DEFAULT_BODY_BYTES,
            max_redirects: 10,
            default_max_tokens: 100,
            max_extracted_tokens: tokens,
        };
        let url = format!("http://{}/edition", server.addr);
        let args = Args {
            url: &url,
            mode: Mode::Auto,
            section: None,
            cursor: None,
            max_tokens: None,
            crawl: false,
        };
        let ctx = Context {
            agent_id: "reader",
            matcher: None,
            aborted: &|| {
                let Some(count) = clock.0.get() else {
                    return false;
                };
                clock.0.set(Some(count + 1));
                count >= polls
            },
        };
        let result = fetch.fetch(&args, &ctx, Instant::now() + Duration::from_secs(2));
        assert_eq!(
            result.unwrap_err().code,
            expected,
            "HTTP {status} {content_type} {tokens}"
        );
        assert!(docs.0.lock().unwrap().is_none());
        assert_eq!(server.received().len(), 1);
    }
}

// The independent review fixture now shares its resolver with the worker. The input and delay are unchanged.
#[test]
fn cancelled_during_slow_admission() {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    };
    struct Slow(mpsc::Sender<()>);
    impl Admission for Slow {
        fn resolver(
            &self,
        ) -> plur1bus_providers::resolution::Resolver<Url, Result<SocketAddr, Failure>> {
            let entered = self.0.clone();
            Arc::new(move |_, _, _| {
                let _ = entered.send(());
                std::thread::sleep(Duration::from_millis(750));
                Err(Failure::EgressDenied)
            })
        }
    }
    let (entered, rx) = mpsc::channel();
    let port = Slow(entered);
    let stopped = AtomicBool::new(false);
    std::thread::scope(|scope| {
        let flag = &stopped;
        let waiter = scope.spawn(move || {
            rx.recv_timeout(Duration::from_secs(2)).unwrap();
            let at = Instant::now();
            flag.store(true, Ordering::Release);
            at
        });
        let docs = Docs::default();
        let clock = FixedClock(0);
        let client = Client {
            admission: &port,
            crawl: None,
            store: &docs,
            clock: &clock,
            user_agent: "fixture",
            max_bytes: 32768,
            max_redirects: 0,
            default_max_tokens: 128,
            max_extracted_tokens: 128,
        };
        let args = Args {
            url: "http://127.0.0.1:1/edition",
            mode: Mode::Auto,
            section: None,
            cursor: None,
            max_tokens: None,
            crawl: false,
        };
        let context = Context {
            agent_id: "review",
            matcher: None,
            aborted: &|| stopped.load(Ordering::Acquire),
        };
        let reason = client
            .fetch(&args, &context, Instant::now() + Duration::from_secs(3))
            .err()
            .unwrap()
            .code;
        let end = Instant::now();
        let elapsed = end.duration_since(waiter.join().unwrap());
        eprintln!("address cancellation {elapsed:?}");
        assert!(elapsed < Duration::from_millis(500));
        assert_eq!(reason, "aborted");
    });
}

#[test]
fn inline_code_charges_only_emitted_whitespace() {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let html = format!("<p>Edition <code>local{}copy</code></p>", " ".repeat(5000));
    let server = FakeServer::start(&json!({
        "transport": "http", "exchanges": [{
            "request": {"method":"GET","path":"/edition"},
            "response":{"status":200,"headers":{"content-type":"text/html"},"chunksBase64":[STANDARD.encode(html)]}
        }]
    }));
    let port = Port(server.addr);
    let docs = Docs::default();
    let clock = FixedClock(0);
    let client = Client {
        admission: &port,
        crawl: None,
        store: &docs,
        clock: &clock,
        user_agent: "fixture",
        max_bytes: 32768,
        max_redirects: 0,
        default_max_tokens: 128,
        max_extracted_tokens: 128,
    };
    let url = format!("http://{}/edition", server.addr);
    let args = Args {
        url: &url,
        mode: Mode::Auto,
        section: None,
        cursor: None,
        max_tokens: None,
        crawl: false,
    };
    let ctx = Context {
        agent_id: "review",
        matcher: None,
        aborted: &|| false,
    };
    let result = client
        .fetch(&args, &ctx, Instant::now() + Duration::from_secs(2))
        .unwrap();
    assert_eq!(result["markdown"], "Edition `local copy`");
    assert_eq!(result["sections"][0]["tokens"], 5);
}
