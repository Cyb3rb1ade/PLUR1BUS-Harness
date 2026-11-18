//! Replays `fixtures/parity/provider-auth/*.json` (`scripts/parity/export-provider-auth.ts`): mode V for the ladder, the
//! profiles, the pool, the redactor and the stored record; mode W (R-K-14) for the token POST, the refresh owner, the
//! credentials provider, the login flows and Google ADC, through the HTTP port double of [`super::testing::Wire`].
use super::adc::{AdcFiles, GoogleAdc, GoogleAdcOptions};
use super::credentials::{
    AdcLease, AdcTokenSource, CallResult, CredentialsProvider, CredentialsProviderOptions,
    ProfileCredentials,
};
use super::env::{can_open_graphical_browser, is_remote_session, EnvSnapshot};
use super::errors::AuthError;
use super::http::{client_fields, parse_token_response, HttpRefresher, OAuthHttp, TokenData};
use super::ladder::{plan_login, LoginMethod};
use super::login::{
    login, AuthorizationPrompt, CallbackRequest, CallbackResponse, DevicePrompt, Incoming,
    LoginOptions, LoginUi, LoopbackListener,
};
use super::pool::{
    classify_failure, CredentialPool, Failure, Hint, PoolEntry, PoolSnapshot, Strategy,
};
use super::ports::{Clock, PortFailure};
use super::profile::{load_profiles, parse_header_scheme, validate_profile, AuthProfile};
use super::record::OAuthRecord;
use super::redact::{safe_fields, scrub};
use super::refresh::{RefreshOwner, RefreshOwnerOptions};
use super::secret::Secret;
use super::testing::{
    assert_same, joined, same, Draws, FakeClock, Logs, MemStore, ScriptedBytes, Timers, Wire, World,
};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::sync::Mutex;

fn fixture(name: &str) -> Value {
    let raw = match name {
        "ladder" => include_str!("../../../../fixtures/parity/provider-auth/ladder.json"),
        "profile" => include_str!("../../../../fixtures/parity/provider-auth/profile.json"),
        "pool" => include_str!("../../../../fixtures/parity/provider-auth/pool.json"),
        "redact" => include_str!("../../../../fixtures/parity/provider-auth/redact.json"),
        "records" => include_str!("../../../../fixtures/parity/provider-auth/records.json"),
        "http" => include_str!("../../../../fixtures/parity/provider-auth/http.json"),
        "refresh" => include_str!("../../../../fixtures/parity/provider-auth/refresh.json"),
        "credentials" => include_str!("../../../../fixtures/parity/provider-auth/credentials.json"),
        "login" => include_str!("../../../../fixtures/parity/provider-auth/login.json"),
        "adc" => include_str!("../../../../fixtures/parity/provider-auth/adc.json"),
        other => panic!("no fixture {other}"),
    };
    joined(&serde_json::from_str(raw).unwrap())
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap()
}

fn err_json(e: &AuthError) -> Value {
    e.to_json()
}

fn profile(v: &Value) -> AuthProfile {
    validate_profile(v).unwrap()
}

fn env_of(v: &Value) -> EnvSnapshot {
    EnvSnapshot {
        env: v["env"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, x)| (k.clone(), s(x).to_owned()))
            .collect(),
        platform: s(&v["platform"]).to_owned(),
        stdout_is_tty: v["tty"]
            .as_bool()
            .or_else(|| v["stdoutIsTTY"].as_bool())
            .unwrap(),
    }
}

#[test]
fn ladder_and_environment_predicates_replay() {
    let f = fixture("ladder");
    let mut envs = BTreeMap::new();
    for e in f["envs"].as_array().unwrap() {
        let snap = env_of(e);
        assert_eq!(
            can_open_graphical_browser(&snap),
            e["graphical"].as_bool().unwrap(),
            "{}",
            e["name"]
        );
        assert_eq!(
            is_remote_session(&snap),
            e["remote"].as_bool().unwrap(),
            "{}",
            e["name"]
        );
        envs.insert(s(&e["name"]).to_owned(), snap);
    }
    let plans = f["plans"].as_array().unwrap();
    assert!(plans.len() > 1000);
    for c in plans {
        let p = profile(&f["profiles"][s(&c["profile"])]);
        let plan = plan_login(
            &p,
            &envs[s(&c["env"])],
            c["paste"].as_bool().unwrap_or(false),
        );
        let what = format!("{} {} {:?}", c["profile"], c["env"], c.get("paste"));
        assert_eq!(plan.method.as_str(), s(&c["method"]), "{what}");
        let fb: Vec<&str> = plan.fallbacks.iter().map(|m| m.as_str()).collect();
        let theirs: Vec<&str> = c["fallbacks"].as_array().unwrap().iter().map(s).collect();
        assert_eq!(fb, theirs, "{what}");
        assert_eq!(plan.headless, c["headless"].as_bool().unwrap(), "{what}");
        assert_eq!(
            plan.ssh_hint(47123)
                .map(Value::String)
                .unwrap_or(Value::Null),
            c["sshHint"],
            "{what}"
        );
    }
}

#[test]
fn profile_validation_replays() {
    let f = fixture("profile");
    let cases = f["cases"].as_array().unwrap();
    assert!(cases.len() > 150);
    for c in cases {
        let what = c["input"].to_string();
        match validate_profile(&c["input"]) {
            Ok(p) => {
                assert!(
                    c["ok"].as_bool().unwrap_or(false),
                    "accepted, TypeScript refused: {what}"
                );
                let d = &c["derived"];
                assert_same(&json!(p.refresh_skew_ms()), &d["refreshSkewMs"], &what);
                assert_eq!(json!(p.is_refreshable()), d["refreshable"], "{what}");
                assert_eq!(json!(p.authorize_url()), d["authorizeUrl"], "{what}");
                assert_eq!(json!(p.token_url()), d["tokenUrl"], "{what}");
                assert_eq!(json!(p.device_url()), d["deviceUrl"], "{what}");
            }
            Err(e) => {
                assert!(
                    c.get("error").is_some(),
                    "refused ({}), TypeScript accepted: {what}",
                    e.message
                );
                assert_same(&err_json(&e), &c["error"], &what);
            }
        }
    }
    for c in f["schemes"].as_array().unwrap() {
        let (name, template) = parse_header_scheme(s(&c["scheme"])).unwrap();
        assert_eq!(json!({ "name": name, "template": template }), c["parsed"]);
    }
    for c in f["catalogues"].as_array().unwrap() {
        match load_profiles(c["input"].as_array().unwrap()) {
            Ok(list) => assert_eq!(
                json!(list.iter().map(|p| p.id.clone()).collect::<Vec<_>>()),
                c["ids"]
            ),
            Err(e) => assert_same(&err_json(&e), &c["error"], "catalogue"),
        }
    }
}

fn failure(v: &Value) -> Failure {
    Failure {
        status: v["status"].as_u64().unwrap() as u16,
        model: v["model"].as_str().map(str::to_owned),
        retry_after_ms: v["retryAfterMs"].as_f64(),
        hint: match v["hint"].as_str() {
            Some("quota_exhausted") => Some(Hint::QuotaExhausted),
            Some("rate_limit") => Some(Hint::RateLimit),
            _ => None,
        },
    }
}

fn entry_json(e: &PoolEntry) -> Value {
    let mut m = Map::new();
    m.insert("id".into(), json!(e.id));
    m.insert("secretRef".into(), json!(e.secret_ref));
    if let Some(l) = &e.label {
        m.insert("label".into(), json!(l));
    }
    Value::Object(m)
}

fn strategy(v: &Value) -> Strategy {
    match v.as_str() {
        Some("round_robin") => Strategy::RoundRobin,
        Some("least_used") => Strategy::LeastUsed,
        _ => Strategy::FillFirst,
    }
}

#[test]
fn credential_pool_replays() {
    let f = fixture("pool");
    for c in f["classify"].as_array().unwrap() {
        let ours = classify_failure(&failure(&c["failure"])).map_or(Value::Null, |x| x.json());
        assert_eq!(ours, c["classification"], "{}", c["failure"]);
    }
    let start = f["start"].as_f64().unwrap();
    for sc in f["scenarios"].as_array().unwrap() {
        let name = s(&sc["name"]);
        let clock = FakeClock::at(start);
        let logs = Logs::default();
        let n = sc["n"].as_u64().unwrap() as usize;
        let entries: Vec<PoolEntry> = (0..n)
            .map(|i| PoolEntry {
                id: format!("c{}", i + 1),
                secret_ref: format!("ref/{}", i + 1),
                label: (i == 0).then(|| "first".to_owned()),
            })
            .collect();
        let mut pool = CredentialPool::new(
            "e:key",
            entries,
            strategy(&sc["strategy"]),
            &clock,
            Some(&logs),
        )
        .unwrap();
        assert_eq!(pool.strategy.as_str(), s(&sc["strategy"]));
        let mut last = PoolSnapshot::default();
        for (i, (op, step)) in sc["ops"]
            .as_array()
            .unwrap()
            .iter()
            .zip(sc["steps"].as_array().unwrap())
            .enumerate()
        {
            let what = format!("{name} step {i} {op}");
            let out: Result<Value, AuthError> = match s(&op["op"]) {
                "select" => pool.select(op["model"].as_str()).map(|e| entry_json(&e)),
                "fail" => Ok(pool
                    .report_failure(s(&op["id"]), &failure(&op["failure"]))
                    .map_or(Value::Null, |r| json!({ "classification": r.classification.json(), "cooldownMs": r.cooldown_ms }))),
                "success" => {
                    pool.report_success(s(&op["id"]), op["model"].as_str());
                    Ok(Value::Null)
                }
                "advance" => {
                    clock.advance(op["ms"].as_f64().unwrap());
                    Ok(Value::Null)
                }
                "status" => Ok(Value::Array(pool.status().iter().map(|x| x.json()).collect())),
                "snapshot" => {
                    last = pool.snapshot();
                    Ok(last.json())
                }
                "restore" => {
                    let snap = PoolSnapshot::from_json(&last.json());
                    pool.restore(&snap);
                    Ok(pool.snapshot().json())
                }
                "entry" => Ok(pool.entry(s(&op["id"])).map_or(Value::Null, entry_json)),
                other => panic!("{other}"),
            };
            match out {
                Ok(v) => {
                    assert!(
                        step.get("error").is_none(),
                        "{what}: TypeScript refused ({}), Rust did not",
                        step["error"]
                    );
                    assert_same(&v, &step["out"], &what);
                }
                Err(e) => assert_same(&err_json(&e), &step["error"], &what),
            }
        }
        assert_same(&logs.all(), &sc["logs"], &format!("{name} logs"));
    }
    let clock = FakeClock::at(0.0);
    let e = PoolEntry {
        id: "c1".into(),
        secret_ref: "ref/1".into(),
        label: Some("first".into()),
    };
    let dup = CredentialPool::new("p", vec![e.clone(), e], Strategy::FillFirst, &clock, None)
        .err()
        .unwrap();
    assert_same(&err_json(&dup), &f["duplicate"], "duplicate");
}

#[test]
fn redactor_replays() {
    let f = fixture("redact");
    for c in f["scrub"].as_array().unwrap() {
        let secrets: Vec<String> = c["secrets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| s(x).to_owned())
            .collect();
        assert_eq!(
            scrub(s(&c["text"]), &secrets),
            s(&c["out"]),
            "{}",
            c["text"]
        );
    }
    for c in f["safeFields"].as_array().unwrap() {
        let secrets: Vec<String> = c["secrets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|x| s(x).to_owned())
            .collect();
        let fields: Vec<(&str, Option<Value>)> = c["fields"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.as_str(), Some(v.clone())))
            .collect();
        let out: Map<String, Value> = safe_fields(&fields, &secrets).into_iter().collect();
        assert_eq!(Value::Object(out), c["out"]);
    }
}

#[test]
fn stored_record_replays() {
    let f = fixture("records");
    for c in f["encode"].as_array().unwrap() {
        let rec = OAuthRecord::decode(&c["record"].to_string(), "p").unwrap();
        assert_eq!(rec.encode().expose(), s(&c["text"]), "{}", c["record"]);
    }
    for c in f["decode"].as_array().unwrap() {
        let raw = s(&c["raw"]);
        match OAuthRecord::decode(raw, "p") {
            Ok(r) => {
                assert_eq!(r.encode().expose(), s(&c["text"]), "{raw}");
                let theirs: Value = serde_json::from_str(s(&c["json"])).unwrap();
                assert_same(&r.redacted_json(), &theirs, raw);
                assert!(!format!("{r:?}").contains("CANARY"));
            }
            Err(e) => {
                assert_same(&err_json(&e), &c["error"], raw);
                assert!(!e.message.contains("CANARY") && !format!("{e:?}").contains("CANARY"));
            }
        }
    }
}

fn form_of(v: &Value) -> Vec<(String, Secret)> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|p| (s(&p[0]).to_owned(), Secret::new(s(&p[1]))))
        .collect()
}

#[test]
fn token_post_boundary_replays() {
    let f = fixture("http");
    let posts = f["posts"].as_array().unwrap();
    for c in posts {
        let name = s(&c["name"]);
        let world = World::new(
            &c["egress"],
            &json!({ "private.example.test": "10.0.0.7" }),
            "93.184.216.34",
        );
        let egress = world.egress();
        let wire = Wire::new(&c["requests"], &c["script"]);
        let http = OAuthHttp::new(
            &egress,
            &wire,
            c["options"]["timeoutMs"].as_f64(),
            c["options"]["maxBytes"].as_f64(),
        );
        let result = http.post(s(&c["url"]), &form_of(&c["form"]));
        match result {
            Ok(data) => {
                assert_same(&Value::Object(data.0.clone()), &c["result"]["ok"], name);
                let theirs: Value = serde_json::from_str(s(&c["result"]["json"])).unwrap();
                assert_eq!(data.redacted_json(), theirs, "{name}");
                assert!(!format!("{data:?}").contains("CANARY"));
            }
            Err(e) => {
                assert_same(&e.to_json(), &c["result"]["error"], name);
                assert_eq!(c["result"]["leaks"], json!(false));
                assert!(!format!("{e:?}").contains("CANARY"));
            }
        }
        wire.finish(name);
    }
    for c in f["parse"].as_array().unwrap() {
        let data = TokenData(c["input"].as_object().unwrap().clone());
        match parse_token_response(&data) {
            Ok(t) => {
                let ours = json!({
                    "accessToken": t.access_token.expose(),
                    "refreshToken": t.refresh_token.as_ref().map(|x| x.expose().to_owned()),
                    "expiresInSeconds": t.expires_in_seconds,
                    "refreshExpiresInSeconds": t.refresh_expires_in_seconds,
                });
                assert_same(&ours, &c["ok"], &c["input"].to_string());
                assert!(!format!("{t:?}").contains("CANARY"));
            }
            Err(e) => assert_same(&e.to_json(), &c["error"], &c["input"].to_string()),
        }
    }
    for c in f["client"].as_array().unwrap() {
        let mut raw = f["base"].as_object().unwrap().clone();
        for (k, v) in c["profile"].as_object().unwrap() {
            raw.insert(k.clone(), v.clone());
        }
        let p = profile(&Value::Object(raw));
        match client_fields(&p) {
            Ok(fields) => {
                let m: Map<String, Value> = fields
                    .iter()
                    .map(|(k, v)| (k.clone(), json!(v.expose())))
                    .collect();
                assert_eq!(Value::Object(m), c["fields"]);
            }
            Err(e) => assert_same(&e.to_json(), &c["error"], "client"),
        }
    }
}

/// The record view of a refresh step: `{ refreshed, record: encodeRecord(...) }`.
fn lease_view(r: &super::refresh::FreshRecord) -> Value {
    json!({ "refreshed": r.refreshed, "record": r.record.encode().expose() })
}

#[test]
fn refresh_owner_replays() {
    let f = fixture("refresh");
    let scenarios = f["scenarios"].as_array().unwrap();
    assert!(scenarios.len() >= 30);
    for sc in scenarios {
        let name = s(&sc["name"]);
        let world = World::new(&f["egress"], &f["resolve"], s(&f["public"]));
        let egress = world.egress();
        let wire = Wire::new(&sc["requests"], &sc["script"]);
        let http = OAuthHttp::new(&egress, &wire, None, None);
        let refresher = HttpRefresher::new(&http);
        let clock = FakeClock::at(sc["start"].as_f64().unwrap());
        let store = MemStore::default();
        let timers = Timers::default();
        let draws = Draws::of(
            &sc["random"]
                .as_array()
                .unwrap()
                .iter()
                .map(|x| x.as_f64().unwrap())
                .collect::<Vec<_>>(),
        );
        let logs = Logs::default();
        let p = profile(&sc["profile"]);
        let r = s(&sc["ref"]);
        let make = || {
            RefreshOwner::new(RefreshOwnerOptions {
                store: &store,
                clock: &clock,
                refresher: &refresher,
                log: Some(&logs),
                timer: &timers,
                random: &draws,
            })
        };
        let mut owner = make();
        for (i, (op, step)) in sc["ops"]
            .as_array()
            .unwrap()
            .iter()
            .zip(sc["steps"].as_array().unwrap())
            .enumerate()
        {
            let what = format!("{name} step {i} {}", op["op"]);
            let out: Result<Value, AuthError> = match s(&op["op"]) {
                "seed" => {
                    store.put(r, s(&step["stored"]));
                    Ok(Value::Null)
                }
                "delete" => {
                    store.map.lock().unwrap().remove(r);
                    Ok(Value::Null)
                }
                "fresh" => owner.fresh(&p, r, "c1").map(|x| lease_view(&x)),
                "concurrent" => {
                    let n = op["n"].as_u64().unwrap() as usize;
                    wire.hold();
                    let results: Vec<Result<Value, AuthError>> = std::thread::scope(|scope| {
                        let handles: Vec<_> = (0..n)
                            .map(|_| {
                                scope.spawn(|| owner.fresh(&p, r, "c1").map(|x| lease_view(&x)))
                            })
                            .collect();
                        let t0 = std::time::Instant::now();
                        while owner.waiting(r) < n - 1
                            && t0.elapsed() < std::time::Duration::from_secs(10)
                        {
                            std::thread::sleep(std::time::Duration::from_millis(2));
                        }
                        assert_eq!(
                            owner.waiting(r),
                            n - 1,
                            "{what}: every other caller joins the one exchange"
                        );
                        wire.release();
                        handles.into_iter().map(|h| h.join().unwrap()).collect()
                    });
                    results
                        .into_iter()
                        .collect::<Result<Vec<_>, _>>()
                        .map(Value::Array)
                }
                "invalidate" => owner
                    .invalidate(&p, r, "c1", op["generation"].as_f64().unwrap())
                    .map(|()| Value::Null),
                "advance" => {
                    clock.advance(op["ms"].as_f64().unwrap());
                    Ok(Value::Null)
                }
                "fire" => Ok(match timers.take_last() {
                    Some((key, delay)) => {
                        clock.advance(delay);
                        owner.fire(&key);
                        json!({ "fired": delay })
                    }
                    None => json!({ "fired": null }),
                }),
                "close" => {
                    owner.close();
                    Ok(Value::Null)
                }
                "failSets" => {
                    *store.fail_sets.lock().unwrap() = op["n"].as_u64().unwrap() as u32;
                    Ok(Value::Null)
                }
                "failGets" => {
                    *store.fail_gets.lock().unwrap() = op["n"].as_u64().unwrap() as u32;
                    Ok(Value::Null)
                }
                "newOwner" => {
                    owner.close();
                    owner = make();
                    Ok(Value::Null)
                }
                other => panic!("{other}"),
            };
            match out {
                Ok(v) => {
                    assert!(
                        step.get("error").is_none(),
                        "{what}: TypeScript refused ({}), Rust did not",
                        step["error"]
                    );
                    assert_same(&v, &step["out"], &what);
                }
                Err(e) => {
                    assert!(
                        step.get("error").is_some(),
                        "{what}: Rust refused ({}), TypeScript did not",
                        e.message
                    );
                    assert_same(&err_json(&e), &step["error"], &what);
                    assert_eq!(step["leaks"], json!(false));
                    assert!(!format!("{e:?}").contains("CANARY"), "{what}");
                }
            }
            assert_same(&json!(clock.now()), &step["now"], &format!("{what} now"));
            let stored = store.read(r).map_or(Value::Null, Value::String);
            assert_same(&stored, &step["stored"], &format!("{what} stored"));
            assert_same(&timers.view(), &step["timers"], &format!("{what} timers"));
        }
        owner.close();
        wire.finish(name);
        assert_same(&logs.all(), &sc["logs"], &format!("{name} logs"));
        let all = logs.all().to_string();
        assert!(!all.contains("CANARY"), "{name}: a log line holds a token");
    }
}

struct ScriptedAdc(Mutex<Vec<Value>>);

impl AdcTokenSource for ScriptedAdc {
    fn token(&self, _profile: &AuthProfile) -> Result<AdcLease, AuthError> {
        let mut q = self.0.lock().unwrap();
        let next = if q.is_empty() {
            Value::Null
        } else {
            q.remove(0)
        };
        match next {
            Value::Object(t) => Ok(AdcLease {
                access_token: Secret::new(s(&t["accessToken"])),
                expires_at: t["expiresAt"].as_f64(),
            }),
            _ => Err(AuthError::new(
                super::errors::AuthErrorCode::AdcUnavailable,
                "scripted",
            )),
        }
    }
}

#[test]
fn credentials_provider_replays() {
    let f = fixture("credentials");
    for sc in f["scenarios"].as_array().unwrap() {
        let name = s(&sc["name"]);
        let world = World::new(&f["egress"], &f["resolve"], s(&f["public"]));
        let egress = world.egress();
        let wire = Wire::new(&sc["requests"], &sc["script"]);
        let http = OAuthHttp::new(&egress, &wire, None, None);
        let refresher = HttpRefresher::new(&http);
        let clock = FakeClock::at(sc["start"].as_f64().unwrap());
        let store = MemStore::default();
        let timers = Timers::default();
        let draws = Draws::of(&[0.5]);
        let logs = Logs::default();
        let adc = ScriptedAdc(Mutex::new(
            sc["adc"].as_array().cloned().unwrap_or_default(),
        ));
        let profiles = sc["profiles"]
            .as_array()
            .unwrap()
            .iter()
            .map(|pc| ProfileCredentials {
                profile: profile(&pc["profile"]),
                entries: pc["entries"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|e| PoolEntry {
                        id: s(&e["id"]).to_owned(),
                        secret_ref: s(&e["secretRef"]).to_owned(),
                        label: None,
                    })
                    .collect(),
                strategy: strategy(&pc["strategy"]),
            })
            .collect();
        let provider = CredentialsProvider::new(CredentialsProviderOptions {
            profiles,
            store: &store,
            clock: &clock,
            refresher: &refresher,
            adc: (!sc["adc"].is_null()).then_some(&adc as &dyn AdcTokenSource),
            log: Some(&logs),
            timer: &timers,
            random: &draws,
        })
        .unwrap();
        let mut leases = Vec::new();
        for (i, (op, step)) in sc["ops"]
            .as_array()
            .unwrap()
            .iter()
            .zip(sc["steps"].as_array().unwrap())
            .enumerate()
        {
            let what = format!("{name} step {i} {op}");
            let out: Result<Value, AuthError> = match s(&op["op"]) {
                "get" => provider.get_authorization(s(&op["profileId"]), op["model"].as_str()).map(|l| {
                    let (hn, hv) = l.header();
                    let extra = vec![("anthropic-version".to_owned(), "1".to_owned()), ("x-api-key".to_owned(), "shadowed".to_owned())];
                    let headers: Map<String, Value> = l.headers(&extra).into_iter().map(|(k, v)| (k, json!(v.expose()))).collect();
                    let v = json!({
                        "profileId": l.profile_id, "credentialId": l.credential_id, "header": { "name": hn, "value": hv.expose() },
                        "headers": headers, "expiresAt": l.expires_at, "refreshed": l.refreshed, "generation": l.generation,
                        "string": l.to_string(),
                    });
                    assert!(!format!("{l:?}").contains("CANARY") && !l.redacted_json().to_string().contains("CANARY"));
                    leases.push(l);
                    v
                }),
                "report" => {
                    let r = &op["result"];
                    let result = if r["ok"].as_bool().unwrap() {
                        CallResult::Ok { model: r["model"].as_str().map(str::to_owned) }
                    } else {
                        CallResult::Failed(failure(r))
                    };
                    provider.report_result(&leases[op["lease"].as_u64().unwrap() as usize], &result).map(|()| Value::Null)
                }
                "advance" => {
                    clock.advance(op["ms"].as_f64().unwrap());
                    Ok(Value::Null)
                }
                "seed" => {
                    store.put(s(&op["ref"]), s(&op["value"]));
                    Ok(Value::Null)
                }
                "status" => Ok(provider
                    .pool(s(&op["profileId"]))
                    .map_or(Value::Null, |p| Value::Array(p.status().iter().map(|x| x.json()).collect()))),
                "close" => {
                    provider.close();
                    Ok(Value::Null)
                }
                other => panic!("{other}"),
            };
            match out {
                Ok(mut v) => {
                    assert!(
                        step.get("error").is_none(),
                        "{what}: TypeScript refused ({}), Rust did not",
                        step["error"]
                    );
                    let mut theirs = step["out"].clone();
                    if let (Some(o), Some(t)) = (v.as_object_mut(), theirs.as_object_mut()) {
                        if let Some(j) = t.remove("json") {
                            let lease = leases.last().unwrap();
                            assert_same(
                                &lease.redacted_json(),
                                &serde_json::from_str(s(&j)).unwrap(),
                                &what,
                            );
                        }
                        assert_eq!(t.remove("leaks"), Some(json!(false)));
                        o.remove("leaks");
                    }
                    assert_same(&v, &theirs, &what);
                }
                Err(e) => {
                    assert!(
                        step.get("error").is_some(),
                        "{what}: Rust refused ({}), TypeScript did not",
                        e.message
                    );
                    assert_same(&err_json(&e), &step["error"], &what);
                }
            }
        }
        provider.close();
        wire.finish(name);
        assert_same(&logs.all(), &sc["logs"], &format!("{name} logs"));
    }
}

/// The person's side of a recorded login: what it was shown, the pasted URL, the device-code sleeps.
struct Ui<'a> {
    clock: &'a FakeClock,
    events: Mutex<Vec<Value>>,
    browser: &'a str,
    ui: &'a str,
    pasted: Option<String>,
}

impl LoginUi for Ui<'_> {
    fn open_browser(&self, url: &Secret) -> Option<Result<(), PortFailure>> {
        if self.browser == "absent" {
            return None;
        }
        self.events
            .lock()
            .unwrap()
            .push(json!({ "browser": url.expose() }));
        Some(if self.browser == "fail" {
            Err(PortFailure)
        } else {
            Ok(())
        })
    }
    fn on_authorization(&self, p: &AuthorizationPrompt) -> Option<Result<(), PortFailure>> {
        if self.ui == "absent" {
            return None;
        }
        self.events.lock().unwrap().push(json!({ "authorization": {
            "url": p.authorization_url().expose(), "redirect": p.redirect_uri(), "sshHint": p.ssh_hint, "json": p.redacted_json().to_string(),
        } }));
        Some(Ok(()))
    }
    fn has_read_callback(&self) -> bool {
        self.pasted.is_some()
    }
    fn read_callback(&self, _p: &AuthorizationPrompt) -> Option<Result<Secret, PortFailure>> {
        self.pasted.as_ref().map(|x| Ok(Secret::new(x.clone())))
    }
    fn on_device(&self, p: &DevicePrompt) -> Option<Result<(), PortFailure>> {
        self.events.lock().unwrap().push(json!({ "device": {
            "userCode": p.user_code.expose(), "verificationUri": p.verification_uri.expose(),
            "complete": p.verification_uri_complete.as_ref().map(|x| x.expose().to_owned()), "json": p.redacted_json().to_string(),
        } }));
        Some(Ok(()))
    }
    fn sleep(&self, ms: f64) -> Result<(), PortFailure> {
        self.events.lock().unwrap().push(json!({ "sleep": ms }));
        self.clock.advance(ms);
        Ok(())
    }
}

/// The listener of a recorded login: it binds `PORT`, delivers the recorded callbacks in order and checks every answer.
struct Listener {
    port: u16,
    callbacks: Vec<Value>,
    next: usize,
    bound: bool,
    closed: bool,
    mismatches: Vec<String>,
}

impl LoopbackListener for Listener {
    fn bind(&mut self) -> Result<u16, PortFailure> {
        self.bound = true;
        Ok(self.port)
    }
    fn next(&mut self, _wait_ms: f64) -> Incoming {
        assert!(!self.closed, "a closed listener was asked for a request");
        let Some(c) = self.callbacks.get(self.next) else {
            return Incoming::Timeout;
        };
        if c["response"].get("refused").is_some() {
            self.mismatches.push(format!(
                "callback {} was refused by TypeScript but delivered here",
                self.next
            ));
        }
        let r = &c["request"];
        Incoming::Request(CallbackRequest {
            method: s(&r["method"]).to_owned(),
            target: s(&r["target"]).to_owned(),
            host: r["host"].as_str().map(str::to_owned),
            ..CallbackRequest::default()
        })
    }
    fn respond(&mut self, r: &CallbackResponse) {
        let theirs = &self.callbacks[self.next]["response"];
        let headers: Map<String, Value> = r
            .headers
            .iter()
            .map(|(k, v)| ((*k).to_owned(), json!(v)))
            .collect();
        let ours = json!({ "status": r.status, "body": r.body, "headers": headers });
        if !same(&ours, theirs) {
            self.mismatches
                .push(format!("callback {}: rust {ours} ts {theirs}", self.next));
        }
        self.next += 1;
    }
    fn close(&mut self) {
        self.closed = true;
    }
}

const PORT: u16 = 41234;

fn with_port(v: &Value) -> Value {
    match v {
        Value::String(x) => Value::String(x.replace("$PORT", &PORT.to_string())),
        Value::Array(a) => Value::Array(a.iter().map(with_port).collect()),
        Value::Object(o) => {
            Value::Object(o.iter().map(|(k, x)| (k.clone(), with_port(x))).collect())
        }
        other => other.clone(),
    }
}

#[test]
fn login_flows_replay() {
    let f = fixture("login");
    let scenarios = f["scenarios"].as_array().unwrap();
    assert!(scenarios.len() > 50);
    for sc in scenarios {
        let sc = with_port(sc);
        let name = s(&sc["name"]);
        let world = World::new(&f["egress"], &f["resolve"], s(&f["public"]));
        let egress = world.egress();
        let wire = Wire::new(&sc["requests"], &sc["script"]);
        let http = OAuthHttp::new(&egress, &wire, None, None);
        let clock = FakeClock::at(sc["start"].as_f64().unwrap());
        let store = MemStore::default();
        *store.fail_sets.lock().unwrap() = sc["failSets"].as_u64().unwrap() as u32;
        let logs = Logs::default();
        let bytes = ScriptedBytes::default();
        let env_json = &f["envs"][s(&sc["env"])];
        let env = EnvSnapshot {
            env: env_json["env"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(k, x)| (k.clone(), s(x).to_owned()))
                .collect(),
            platform: s(&env_json["platform"]).to_owned(),
            stdout_is_tty: true,
        };
        let p = match validate_profile(&sc["profile"]) {
            Ok(p) => p,
            Err(e) => {
                assert_same(&err_json(&e), &sc["result"]["error"], name);
                continue;
            }
        };
        let ui = Ui {
            clock: &clock,
            events: Mutex::new(Vec::new()),
            browser: s(&sc["browser"]),
            ui: s(&sc["ui"]),
            pasted: sc["pasted"].as_str().map(str::to_owned),
        };
        let mut listener = Listener {
            port: PORT,
            callbacks: sc["callbacks"].as_array().cloned().unwrap_or_default(),
            next: 0,
            bound: false,
            closed: false,
            mismatches: Vec::new(),
        };
        let result = login(LoginOptions {
            profile: &p,
            store: &store,
            clock: &clock,
            http: &http,
            env: &env,
            paste_callback: sc["paste"].as_bool().unwrap(),
            method: sc["method"]
                .as_str()
                .map(|m| LoginMethod::parse(m).unwrap()),
            secret_ref: None,
            timeout_ms: sc["timeoutMs"].as_f64(),
            ui: &ui,
            listener: &mut listener,
            random: &bytes,
            log: Some(&logs),
        });
        match result {
            Ok(r) => assert_same(
                &json!({ "profileId": r.profile_id, "method": r.method.as_str(), "expiresAt": r.expires_at }),
                &sc["result"]["ok"],
                name,
            ),
            Err(e) => {
                assert!(
                    sc["result"].get("error").is_some(),
                    "{name}: Rust refused ({}), TypeScript did not",
                    e.message
                );
                assert_same(&err_json(&e), &sc["result"]["error"], name);
            }
        }
        assert!(
            listener.mismatches.is_empty(),
            "{name}: {:?}",
            listener.mismatches
        );
        // The callbacks TypeScript refused were sent after its listener closed.
        for c in &listener.callbacks[listener.next..] {
            assert!(
                c["response"].get("refused").is_some(),
                "{name}: a callback TypeScript answered was never delivered: {c}"
            );
        }
        assert!(
            !listener.bound || listener.closed,
            "{name}: the listener stays open"
        );
        assert_same(
            &Value::Array(ui.events.lock().unwrap().clone()),
            &sc["events"],
            &format!("{name} events"),
        );
        let r = p
            .secret_ref
            .clone()
            .unwrap_or_else(|| "auth/test".to_owned());
        assert_same(
            &store.read(&r).map_or(Value::Null, Value::String),
            &sc["stored"],
            &format!("{name} stored"),
        );
        wire.finish(name);
        assert_same(&logs.all(), &sc["logs"], &format!("{name} logs"));
        assert_same(&json!(clock.now()), &sc["clock"], &format!("{name} clock"));
    }
}

struct Files(BTreeMap<String, String>, Mutex<Vec<String>>);

impl AdcFiles for Files {
    fn read(&self, path: &str) -> Result<Secret, PortFailure> {
        self.1.lock().unwrap().push(path.to_owned());
        self.0
            .get(path)
            .map(|x| Secret::new(x.clone()))
            .ok_or(PortFailure)
    }
}

#[test]
fn google_adc_replays() {
    let f = fixture("adc");
    for sc in f["scenarios"].as_array().unwrap() {
        let name = s(&sc["name"]);
        let world = World::new(&f["egress"], &f["resolve"], s(&f["public"]));
        let egress = world.egress();
        let wire = Wire::new(&sc["requests"], &sc["script"]);
        let http = OAuthHttp::new(&egress, &wire, None, None);
        let clock = FakeClock::at(sc["start"].as_f64().unwrap());
        let files = Files(
            sc["files"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(k, v)| (k.clone(), s(v).to_owned()))
                .collect(),
            Mutex::new(Vec::new()),
        );
        let adc = GoogleAdc::new(GoogleAdcOptions {
            http: &http,
            clock: &clock,
            env: sc["env"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(k, v)| (k.clone(), s(v).to_owned()))
                .collect(),
            home: s(&sc["home"]).to_owned(),
            platform: s(&sc["platform"]).to_owned(),
            files: &files,
        });
        let p = validate_profile(&sc["profile"]);
        for (i, (op, step)) in sc["ops"]
            .as_array()
            .unwrap()
            .iter()
            .zip(sc["steps"].as_array().unwrap())
            .enumerate()
        {
            let what = format!("{name} step {i}");
            let view = |l: AdcLease| json!({ "accessToken": l.access_token.expose(), "expiresAt": l.expires_at });
            let out: Result<Value, AuthError> = match (s(&op["op"]), &p) {
                ("advance", _) => {
                    clock.advance(op["ms"].as_f64().unwrap());
                    Ok(Value::Null)
                }
                (_, Err(e)) => Err(e.clone()),
                ("concurrent", Ok(p)) => {
                    let n = op["n"].as_u64().unwrap() as usize;
                    let r: Vec<Result<Value, AuthError>> = std::thread::scope(|scope| {
                        let hs: Vec<_> = (0..n)
                            .map(|_| scope.spawn(|| adc.token(p).map(view)))
                            .collect();
                        hs.into_iter().map(|h| h.join().unwrap()).collect()
                    });
                    r.into_iter()
                        .collect::<Result<Vec<_>, _>>()
                        .map(Value::Array)
                }
                (_, Ok(p)) => adc.token(p).map(view),
            };
            match out {
                Ok(v) => {
                    assert!(
                        step.get("error").is_none(),
                        "{what}: TypeScript refused ({}), Rust did not",
                        step["error"]
                    );
                    let mut theirs = step["out"].clone();
                    let strip = |t: &mut Value| {
                        if let Some(o) = t.as_object_mut() {
                            let j = o.remove("json");
                            assert_eq!(o.remove("leaks"), Some(json!(false)));
                            if let Some(j) = j {
                                let parsed: Value = serde_json::from_str(s(&j)).unwrap();
                                assert_eq!(parsed["accessToken"], json!("[redacted]"));
                            }
                        }
                    };
                    match theirs.as_array_mut() {
                        Some(a) => a.iter_mut().for_each(strip),
                        None => strip(&mut theirs),
                    }
                    assert_same(&v, &theirs, &what);
                }
                Err(e) => assert_same(&err_json(&e), &step["error"], &what),
            }
        }
        assert_eq!(
            json!(files.1.lock().unwrap().clone()),
            sc["reads"],
            "{name} reads"
        );
        wire.finish(name);
    }
}
