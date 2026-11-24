#![allow(clippy::unwrap_used, reason = "recorded TypeScript catalogue actions")]

use base64::{engine::general_purpose::STANDARD, Engine as _};
use plur1bus_discovery::catalog::{
    Client, Config, Error, InstalledPackage, Port, Request, Response, Selection, State,
};
use serde_json::{json, Value};
use url::{Origin, Url};

struct Fixture {
    state: State,
    step: Value,
    requests: Vec<Value>,
    reports: Vec<Value>,
    installed: InstalledPackage,
    catalog_origin: Origin,
}
impl Port for Fixture {
    fn now_ms(&self) -> i64 {
        self.step["time"].as_i64().unwrap()
    }
    fn state(&self) -> Result<State, Error> {
        Ok(self.state.clone())
    }
    fn commit(&mut self, state: State) -> Result<(), Error> {
        self.state = state;
        Ok(())
    }
    fn fetch(&mut self, request: Request<'_>) -> Result<Response, Error> {
        let target = if request.url.origin() == self.catalog_origin {
            request.url.path()
        } else {
            request.url.as_str()
        };
        self.requests.push(json!({
            "target":target, "maxBytes":request.max_bytes, "timeoutMs":request.timeout_ms,
            "maxRedirects":request.max_redirects, "accept":request.accept, "userAgent":request.user_agent,
        }));
        let value = &self.step["routes"][target];
        let body = match value {
            Value::Null => return Err(Error::Transport),
            Value::String(encoded) => STANDARD.decode(encoded).unwrap(),
            value => serde_json::to_vec(value).unwrap(),
        };
        Ok(Response {
            url: request.url.clone(),
            redirected: self.step["redirected"].as_bool().unwrap_or(false),
            status: 200,
            body,
        })
    }
    fn installed(&self) -> Result<Vec<InstalledPackage>, Error> {
        Ok(vec![self.installed.clone()])
    }
    fn report(&mut self, report: Vec<Value>) -> Result<(), Error> {
        self.reports.push(json!(report));
        Ok(())
    }
}

#[test]
fn signed_catalogue_matches_typescript_sequences() {
    let vectors: Value = serde_json::from_str(include_str!(
        "../../../fixtures/parity/discovery/catalog.json"
    ))
    .unwrap();
    for case in vectors["cases"].as_array().unwrap() {
        let settings = &case["config"];
        let configured_url = |key: &str| settings[key].as_str().map(|url| Url::parse(url).unwrap());
        let url = configured_url("url").unwrap();
        let catalog_origin = url.origin();
        let root = case["rootText"]
            .as_str()
            .map_or_else(|| settings["root"].to_string(), str::to_owned);
        let mut config = Config::new(url, root);
        config.max_bytes = settings["maxBytes"].as_u64().unwrap() as usize;
        config.offline_grace_ms = settings["offlineGraceMs"].as_i64().unwrap();
        config.revocations_url = configured_url("revocationsUrl");
        config.rotations_url = configured_url("rotationsUrl");
        config.test_origin = configured_url("testOrigin").map(|url| url.origin());
        if let Some(timeout) = settings["timeoutMs"].as_u64() {
            config.timeout_ms = timeout;
        }
        if let Some(limit) = settings["maxArtifactBytes"].as_u64() {
            config.max_artifact_bytes = limit as usize;
        }
        let client = Client::new(config).unwrap();
        let selection: Selection = serde_json::from_value(vectors["selection"].clone()).unwrap();
        let mut port = Fixture {
            state: State {
                legacy_serial: case["legacySerial"].as_u64(),
                ..State::default()
            },
            step: Value::Null,
            requests: Vec::new(),
            reports: Vec::new(),
            installed: InstalledPackage {
                id: selection.id.clone(),
                version: selection.version.clone(),
            },
            catalog_origin,
        };
        for (i, step) in case["steps"].as_array().unwrap().iter().enumerate() {
            port.step = step.clone();
            port.requests.clear();
            port.reports.clear();
            let mut output = match step["op"].as_str().unwrap() {
                "refresh" => client.refresh(&mut port),
                "get" => client.get(&mut port),
                _ => {
                    let selection: Selection = step.get("selected").map_or_else(
                        || selection.clone(),
                        |value| serde_json::from_value(value.clone()).unwrap(),
                    );
                    client
                        .download(&mut port, &selection)
                        .map(|bytes| json!({"artifact":STANDARD.encode(bytes)}))
                }
            }
            .unwrap_or_else(|error| json!({"code":error.code()}));
            let label = format!("{} step {i}", case["name"]);
            if let Some(error) = output.get_mut("refreshError") {
                assert!(
                    error["message"]
                        .as_str()
                        .is_some_and(|message| !message.is_empty()),
                    "{label}"
                );
                *error = error["code"].clone();
            }
            assert_eq!(output, step["expected"], "{label}");
            port.requests.sort_by_cached_key(Value::to_string);
            assert_eq!(json!(port.requests), step["requests"], "{label}");
            assert_eq!(json!(port.reports), step["reports"], "{label}");
            assert_eq!(json!(port.state.checkpoint), step["checkpoint"], "{label}");
        }
    }
}

#[test]
fn an_engine_port_cannot_return_a_redirected_catalog_even_with_the_same_final_url() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../fixtures/parity/discovery/catalog.json"
    ))
    .unwrap();
    let case = &fixture["cases"][0];
    let settings = &case["config"];
    let url = Url::parse(settings["url"].as_str().unwrap()).unwrap();
    let origin = url.origin();
    let client = Client::new(Config::new(url, settings["root"].to_string())).unwrap();
    let mut valid = case["steps"][0].clone();
    let mut port = Fixture {
        state: State::default(),
        step: valid.clone(),
        requests: vec![],
        reports: vec![],
        installed: InstalledPackage {
            id: "fixture".into(),
            version: "1.0.0".into(),
        },
        catalog_origin: origin,
    };
    assert!(client.refresh(&mut port).is_ok());
    port.state = State::default();
    valid["redirected"] = json!(true);
    port.step = valid;
    assert!(matches!(client.refresh(&mut port), Err(Error::Transport)));
    assert!(port.requests.last().is_some());
}
