//! Replays `fixtures/parity/openai-auth/*.json` (`scripts/parity/export-openai-auth.ts`): mode V for the pure rules and ID
//! tokens, mode W at the `HttpPort` for the plan, the service and the workload exchange (every request compared, every answer
//! from the transcript, the PKCE port's calls compared in order), and W at the transport for `OpenAIHttp`.
use super::super::errors::{AuthError, AuthErrorCode};
use super::super::http::{HttpTransport, TransportError, WireRequest, WireResponse};
use super::super::ports::PortFailure;
use super::super::record::SecretStore;
use super::super::secret::Secret;
use super::super::testing::{assert_same, joined, same, Draws, FakeClock, ScriptedBytes, World};
use super::http::OpenAIHttp;
use super::identity::{Discovery, HostIdentity, JwksVerifier};
use super::plan::{ChatGPTPlan, PlanPorts};
use super::ports::{
    AuditPort, HttpPort, HttpRequest, HttpResponse, OpenAIError, PkcePort, SerialOwner,
};
use super::profiles::{
    choose_failover, credential_access, endpoint, foreign_credential_stores, imported_profile,
    key_status, require_owner, safety_identifier, DenyList, PlanPrincipal,
};
use super::service::{AuthService, AuthServiceOptions};
use super::wire::guard_siwc;
use super::workload::{SubjectPort, WorkloadIdentity, WorkloadProfile};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::sync::Mutex;

fn fixture(name: &str) -> Value {
    let raw = match name {
        "pure" => include_str!("../../../../../fixtures/parity/openai-auth/pure.json"),
        "jwks" => include_str!("../../../../../fixtures/parity/openai-auth/jwks.json"),
        "plan" => include_str!("../../../../../fixtures/parity/openai-auth/plan.json"),
        "service" => include_str!("../../../../../fixtures/parity/openai-auth/service.json"),
        "workload" => include_str!("../../../../../fixtures/parity/openai-auth/workload.json"),
        "http" => include_str!("../../../../../fixtures/parity/openai-auth/http.json"),
        other => panic!("no fixture {other}"),
    };
    joined(&serde_json::from_str(raw).unwrap())
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap()
}

fn err(e: &OpenAIError) -> Value {
    json!({ "code": e.code, "message": e.message() })
}

fn principal(v: &Value) -> PlanPrincipal {
    PlanPrincipal {
        owner: s(&v["owner"]).into(),
        user: s(&v["user"]).into(),
        agent_owner: s(&v["agentOwner"]).into(),
        deployment: s(&v["deployment"]).into(),
    }
}

struct Audit(Mutex<Vec<Value>>, Mutex<Option<String>>);
impl AuditPort for Audit {
    fn audit(&self, e: &Value) -> Result<(), PortFailure> {
        if self.1.lock().unwrap().as_deref() == e["kind"].as_str() {
            return Err(PortFailure);
        }
        self.0.lock().unwrap().push(e.clone());
        Ok(())
    }
}

/// The store of the plan vectors: every `set` counted, the `n`-th one failing.
#[derive(Default)]
struct PlanStore(Mutex<BTreeMap<String, String>>, Mutex<(u32, u32)>);
impl SecretStore for PlanStore {
    fn get(&self, r: &str) -> Result<Option<Secret>, AuthError> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .get(r)
            .map(|v| Secret::new(v.clone())))
    }
    fn set(&self, r: &str, v: &Secret) -> Result<(), AuthError> {
        let mut c = self.1.lock().unwrap();
        c.0 += 1;
        if c.0 == c.1 {
            return Err(AuthError::new(
                AuthErrorCode::PersistFailed,
                "store unavailable",
            ));
        }
        self.0
            .lock()
            .unwrap()
            .insert(r.to_owned(), v.expose().to_owned());
        Ok(())
    }
    fn delete(&self, r: &str) -> Result<(), AuthError> {
        self.0.lock().unwrap().remove(r);
        Ok(())
    }
}
impl PlanStore {
    fn view(&self) -> Value {
        Value::Object(
            self.0
                .lock()
                .unwrap()
                .iter()
                .map(|(k, v)| (k.clone(), json!(v)))
                .collect(),
        )
    }
}

/// The HTTP port double: request `i` must equal transcript entry `i`; the answer is the recorded one.
struct Transcript(Vec<Value>, Mutex<usize>, Mutex<Vec<String>>);
impl Transcript {
    fn new(v: &Value) -> Transcript {
        Transcript(
            v.as_array().cloned().unwrap_or_default(),
            Mutex::new(0),
            Mutex::new(Vec::new()),
        )
    }
    #[track_caller]
    fn finish(&self, what: &str) {
        assert!(
            self.2.lock().unwrap().is_empty(),
            "{what}: {:?}",
            self.2.lock().unwrap()
        );
        assert_eq!(
            *self.1.lock().unwrap(),
            self.0.len(),
            "{what}: number of requests"
        );
    }
}
impl HttpPort for Transcript {
    fn request(&self, r: &HttpRequest) -> Result<HttpResponse, OpenAIError> {
        let i = {
            let mut n = self.1.lock().unwrap();
            *n += 1;
            *n - 1
        };
        let ours = json!({
            "method": r.method, "url": r.url, "authorization": r.authorization.as_ref().map(|a| a.expose().to_owned()),
            "form": r.form.as_ref().map(|f| f.iter().map(|(k, v)| json!([k, v.expose()])).collect::<Vec<_>>()), "json": r.json,
        });
        let Some(t) = self.0.get(i) else {
            self.2
                .lock()
                .unwrap()
                .push(format!("#{i} not recorded: {ours}"));
            return Err(OpenAIError::new("transport-failed"));
        };
        if !same(&ours, &t["request"]) {
            self.2
                .lock()
                .unwrap()
                .push(format!("#{i}\n  rust: {ours}\n  ts:   {}", t["request"]));
        }
        if t["response"].get("throws").is_some() {
            return Err(OpenAIError::new("transport-failed"));
        }
        Ok(HttpResponse {
            status: t["response"]["status"].as_u64().unwrap() as u16,
            body: t["response"]["body"].clone(),
        })
    }
}

/// The PKCE port double: the calls in TypeScript's order, the recorded answers.
struct Pkce(Vec<Value>, usize, Vec<String>);
impl Pkce {
    fn next(&mut self, call: &str) -> Value {
        let v = self.0.get(self.1).cloned().unwrap_or(Value::Null);
        if v["call"].as_str() != Some(call) {
            self.2
                .push(format!("call {}: rust {call}, ts {}", self.1, v["call"]));
        }
        self.1 += 1;
        v
    }
}
impl PkcePort for Pkce {
    fn redirect(&mut self) -> Result<String, OpenAIError> {
        Ok(s(&self.next("redirect")["out"]).to_owned())
    }
    fn close(&mut self) {
        self.next("close");
    }
    fn authorize(
        &mut self,
        url: &Secret,
        redirect_uri: &str,
        _deadline: f64,
    ) -> Result<Secret, OpenAIError> {
        let v = self.next("authorize");
        if v["url"].as_str() != Some(url.expose())
            || v["redirectUri"].as_str() != Some(redirect_uri)
        {
            self.2.push(format!(
                "authorize\n  rust: {}\n  ts:   {}",
                url.expose(),
                v["url"]
            ));
        }
        if v.get("throws").is_some() {
            return Err(OpenAIError::new("transport-failed"));
        }
        Ok(Secret::new(s(&v["out"])))
    }
}

fn leak<T>(t: T) -> &'static T {
    Box::leak(Box::new(t))
}

#[test]
fn plan_replays() {
    let f = fixture("plan");
    let scenarios = f["scenarios"].as_array().unwrap();
    assert!(scenarios.len() >= 25);
    for sc in scenarios {
        let name = s(&sc["name"]);
        let http: &'static Transcript = leak(Transcript::new(&sc["transcript"]));
        let clock: &'static FakeClock = leak(FakeClock::at(sc["start"].as_f64().unwrap()));
        let store: &'static PlanStore = leak(PlanStore::default());
        let owner: &'static SerialOwner = leak(SerialOwner::default());
        let bytes: &'static ScriptedBytes = leak(ScriptedBytes::default());
        let draws: &'static Draws = leak(Draws::of(&[0.5]));
        let audit: &'static Audit = leak(Audit(Mutex::new(Vec::new()), Mutex::new(None)));
        let make = || {
            let host: &'static HostIdentity<'static> = leak(HostIdentity::new(store, owner, bytes));
            let verifier: &'static JwksVerifier<'static> = leak(JwksVerifier::new(http, clock));
            let plan = ChatGPTPlan::new(PlanPorts {
                store,
                owner,
                http,
                clock,
                host,
                verifier,
                audit,
                random_bytes: bytes,
                random: draws,
                timeout_ms: None,
                refresh_skew_ms: None,
            });
            (host, plan)
        };
        let (mut host, mut plan) = make();
        let mut pkce = Pkce(
            sc["pkce"].as_array().cloned().unwrap_or_default(),
            0,
            Vec::new(),
        );
        let default = json!({ "owner": "owner", "user": "owner", "agentOwner": "owner", "deployment": "local" });
        for (i, (op, step)) in sc["ops"]
            .as_array()
            .unwrap()
            .iter()
            .zip(sc["steps"].as_array().unwrap())
            .enumerate()
        {
            let what = format!("{name} step {i} {}", op["op"]);
            let p = principal(op.get("principal").unwrap_or(&default));
            let account = op["account"].as_str().unwrap_or("");
            let out: Result<Value, OpenAIError> = match s(&op["op"]) {
                "login" => plan
                    .login(account, &p, &mut pkce)
                    .map(|(id, at)| json!({ "profileId": id, "expiresAt": at })),
                "lease" => plan.lease(account, &p).map(|t| json!(t.expose())),
                "metadata" => plan.metadata(account).map(|m| {
                    m.map_or(
                        Value::Null,
                        |(w, e, n)| json!({ "workspace": w, "expiresAt": e, "needsLogin": n }),
                    )
                }),
                "models" => plan.models(account, &p).map(|m| json!(m)),
                "responses" => plan.responses(account, &p, &op["request"]),
                "logout" => plan.logout(account).map(|()| Value::Null),
                "transfer" => {
                    let got = Mutex::new(Vec::new());
                    plan.transfer(
                        account,
                        &|r: &Secret| {
                            got.lock().unwrap().push(r.expose().to_owned());
                            Ok(())
                        },
                        &p,
                    )
                    .map(|()| json!(got.into_inner().unwrap()))
                }
                "hostId" => host.id().map(Value::String),
                "advance" => {
                    clock.advance(op["ms"].as_f64().unwrap());
                    Ok(Value::Null)
                }
                "newPlan" => {
                    (host, plan) = make();
                    Ok(Value::Null)
                }
                "failSetAt" => {
                    let mut c = store.1.lock().unwrap();
                    c.1 = c.0 + op["n"].as_u64().unwrap() as u32;
                    Ok(Value::Null)
                }
                "auditFail" => {
                    *audit.1.lock().unwrap() = Some(s(&op["kind"]).to_owned());
                    Ok(Value::Null)
                }
                "storePut" => {
                    store
                        .0
                        .lock()
                        .unwrap()
                        .insert(s(&op["ref"]).to_owned(), s(&op["value"]).to_owned());
                    Ok(Value::Null)
                }
                "set" => Ok(Value::Null),
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
                    assert_same(&err(&e), &step["error"], &what);
                    assert_eq!(step["leaks"], json!(false));
                }
            }
            assert_same(&store.view(), &step["store"], &format!("{what} store"));
            assert_eq!(
                audit.0.lock().unwrap().len() as u64,
                step["audit"].as_u64().unwrap(),
                "{what} audit"
            );
        }
        assert!(pkce.2.is_empty(), "{name}: {:?}", pkce.2);
        assert_eq!(pkce.1, pkce.0.len(), "{name}: PKCE calls");
        http.finish(name);
        assert_same(
            &json!(audit.0.lock().unwrap().clone()),
            &sc["audit"],
            &format!("{name} audit events"),
        );
    }
}

/// `randomUUID` of `k3b-support.ts`: the first 16 bytes of SHA-256 of `uuid:k`, as a UUID.
fn scripted_uuid() -> impl Fn() -> String {
    let k = Mutex::new(0u32);
    move || {
        let mut n = k.lock().unwrap();
        *n += 1;
        let h: String = Sha256::digest(format!("uuid:{n}").as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        format!(
            "{}-{}-{}-{}-{}",
            &h[0..8],
            &h[8..12],
            &h[12..16],
            &h[16..20],
            &h[20..32]
        )
    }
}

#[test]
fn service_replays() {
    let f = fixture("service");
    let http: &'static Transcript = leak(Transcript::new(&f["transcript"]));
    let clock: &'static FakeClock = leak(FakeClock::at(f["start"].as_f64().unwrap()));
    let store: &'static PlanStore = leak(PlanStore::default());
    let owner: &'static SerialOwner = leak(SerialOwner::default());
    let bytes: &'static ScriptedBytes = leak(ScriptedBytes::default());
    let draws: &'static Draws = leak(Draws::of(&[0.5]));
    let audit: &'static Audit = leak(Audit(Mutex::new(Vec::new()), Mutex::new(None)));
    let host: &'static HostIdentity<'static> = leak(HostIdentity::new(store, owner, bytes));
    let uuid: &'static dyn Fn() -> String = leak(scripted_uuid());
    let svc = AuthService::new(AuthServiceOptions {
        store,
        owner,
        http,
        clock,
        audit,
        host,
        random_bytes: bytes,
        random: draws,
        uuid,
        timeout_ms: None,
        refresh_skew_ms: None,
    });
    let mut pkce = Pkce(
        f["pkce"].as_array().cloned().unwrap_or_default(),
        0,
        Vec::new(),
    );
    let owner_p =
        json!({ "owner": "owner", "user": "owner", "agentOwner": "owner", "deployment": "local" });
    let bob = json!({ "owner": "bob", "user": "bob", "agentOwner": "bob", "deployment": "local" });
    let mut id = String::new();
    let info = |c: &super::service::CredentialInfo| json!({ "id": c.id, "person": c.person, "workspace": c.workspace, "kind": "oauth_pkce", "billingPath": "plan", "expiresAt": c.expires_at, "needsLogin": c.needs_login });
    for (i, (op, step)) in f["ops"]
        .as_array()
        .unwrap()
        .iter()
        .zip(f["steps"].as_array().unwrap())
        .enumerate()
    {
        let what = format!("service step {i} {op}");
        let p = principal(if op["who"].as_str() == Some("bob") {
            &bob
        } else {
            &owner_p
        });
        let out: Result<Value, OpenAIError> = match s(&op["op"]) {
            "login" => svc
                .login(
                    &p,
                    op["again"]
                        .as_bool()
                        .unwrap_or(false)
                        .then_some(id.as_str()),
                    &mut pkce,
                )
                .map(|c| {
                    id = c.id.clone();
                    info(&c)
                }),
            "list" | "status" => svc
                .list_credentials(&p)
                .map(|l| json!(l.iter().map(info).collect::<Vec<_>>())),
            "lease" => svc.lease(&id, &p).map(|t| json!(t.expose())),
            "models" => svc.models(&id, &p).map(|m| json!(m)),
            "logout" => svc.logout(&id, &p).map(|()| Value::Null),
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
            Err(e) => assert_same(&err(&e), &step["error"], &what),
        }
        assert_same(&store.view(), &step["store"], &format!("{what} store"));
    }
    assert!(pkce.2.is_empty(), "{:?}", pkce.2);
    http.finish("service");
}

#[test]
fn pure_rules_replay() {
    let f = fixture("pure");
    for c in f["siwc"].as_array().unwrap() {
        match guard_siwc(&c["request"]) {
            Ok(v) => assert_same(&v, &c["out"], &c["request"].to_string()),
            Err(e) => assert_same(&err(&e), &c["error"], &c["request"].to_string()),
        }
    }
    for c in f["keys"].as_array().unwrap() {
        assert_eq!(
            key_status(c["expiresAt"].as_f64(), c["now"].as_f64().unwrap()).unwrap(),
            s(&c["out"]),
            "{c}"
        );
    }
    assert_same(
        &err(&key_status(Some(f64::INFINITY), 0.0).unwrap_err()),
        &f["infinite"],
        "infinite",
    );
    for c in f["regions"].as_array().unwrap() {
        match endpoint(s(&c["region"])) {
            Ok(u) => assert_eq!(u, s(&c["out"])),
            Err(e) => assert_same(&err(&e), &c["error"], "region"),
        }
    }
    for c in f["owners"].as_array().unwrap() {
        match require_owner(&principal(&c["principal"])) {
            Ok(()) => assert_eq!(c["ok"], json!(true), "{c}"),
            Err(e) => assert_same(&err(&e), &c["error"], "owner"),
        }
    }
    for c in f["failovers"].as_array().unwrap() {
        let pairs = |v: &Value| -> Vec<(String, String)> {
            v.as_array()
                .unwrap()
                .iter()
                .map(|p| (s(&p[0]).to_owned(), s(&p[1]).to_owned()))
                .collect()
        };
        let audit = Audit(Mutex::new(Vec::new()), Mutex::new(None));
        let out = choose_failover(
            s(&c["from"]),
            &pairs(&c["candidates"]),
            &pairs(&c["cross"]),
            c["code"].as_str(),
            Some(&audit),
        )
        .unwrap();
        assert_eq!(json!(out), c["out"], "{c}");
        assert_same(
            &json!(audit.0.into_inner().unwrap()),
            &c["events"],
            "failover events",
        );
    }
    let foreign = ["open", "claw"].concat();
    let named = |t: &str| {
        t.replace("@foreign-2@", &foreign)
            .replace("@FOREIGN-2@", &foreign.to_uppercase())
    };
    for c in f["deny"].as_array().unwrap() {
        let roots: Vec<String> = c["roots"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| named(s(r)))
            .collect();
        let first = roots[0].clone();
        let canon = move |p: &str| -> Result<String, PortFailure> {
            Ok(if p == "alias" {
                format!("{first}/auth.json")
            } else {
                p.to_owned()
            })
        };
        let foreign =
            |p: &str| -> Result<bool, PortFailure> { Ok(p.ends_with("/foreign-registration")) };
        let deny = DenyList::new(
            &canon,
            &roots,
            &["keychain:codex".to_owned()],
            Some(&foreign),
        );
        let mut opened = false;
        let r = credential_access(&deny, &named(s(&c["path"])), || {
            opened = true;
            Ok(())
        });
        assert_eq!(
            r.err().map_or(Value::Null, |e| err(&e)),
            c["denied"],
            "{}",
            c["path"]
        );
        assert_eq!(json!(opened), c["opened"]);
    }
    assert_eq!(foreign_credential_stores().len(), 3);
    assert_same(
        &imported_profile("openai:chatgpt-oauth-restricted").unwrap(),
        &f["imported"],
        "imported",
    );
    for c in f["safety"].as_array().unwrap() {
        assert_eq!(safety_identifier(s(&c["principal"])), s(&c["out"]));
    }
    for c in f["codes"].as_array().unwrap() {
        let e = OpenAIError::new(s(&c["code"]));
        assert_eq!(e.code, s(&c["out"]));
        assert_eq!(e.message(), s(&c["message"]));
        assert_eq!(
            e.to_json(),
            serde_json::from_str::<Value>(s(&c["json"])).unwrap()
        );
    }
}

struct Keys(Value, Mutex<u32>);
impl HttpPort for Keys {
    fn request(&self, _r: &HttpRequest) -> Result<HttpResponse, OpenAIError> {
        *self.1.lock().unwrap() += 1;
        Ok(HttpResponse {
            status: 200,
            body: json!({ "keys": self.0 }),
        })
    }
}

#[test]
fn id_token_verification_replays() {
    let f = fixture("jwks");
    let d: Discovery = Discovery {
        issuer: s(&f["discovery"]["issuer"]).into(),
        authorization_endpoint: s(&f["discovery"]["authorization_endpoint"]).into(),
        token_endpoint: s(&f["discovery"]["token_endpoint"]).into(),
        revocation_endpoint: s(&f["discovery"]["revocation_endpoint"]).into(),
        jwks_uri: s(&f["discovery"]["jwks_uri"]).into(),
    };
    let clock = FakeClock::at(f["now"].as_f64().unwrap());
    let nonce = Secret::new(s(&f["nonce"]));
    for c in f["cases"].as_array().unwrap() {
        let http = Keys(f["keysets"][s(&c["keyset"])].clone(), Mutex::new(0));
        let v = JwksVerifier::new(&http, &clock);
        let what = s(&c["name"]);
        match v.validate(&Secret::new(s(&c["token"])), &d, s(&f["audience"]), &nonce) {
            Ok(id) => assert_same(
                &json!({ "sub": id.sub, "workspace": id.workspace }),
                &c["out"],
                what,
            ),
            Err(e) => assert_same(&err(&e), &c["error"], what),
        }
        assert_eq!(
            *http.1.lock().unwrap() as usize,
            c["requests"].as_array().unwrap().len(),
            "{what} fetches"
        );
    }
}

#[test]
fn workload_identity_replays() {
    let f = fixture("workload");
    let profile = |v: &Value| WorkloadProfile {
        token_exchange_endpoint: s(&v["token_exchange_endpoint"]).into(),
        subject_token_source: s(&v["subject_token_source"]).into(),
        subject_token_type: s(&v["subject_token_type"]).into(),
        audience: s(&v["audience"]).into(),
        principal: s(&v["principal"]).into(),
        identity_provider_id: s(&v["identity_provider_id"]).into(),
        service_account_id: s(&v["service_account_id"]).into(),
        refresh_skew_seconds: v["refresh_skew_seconds"].as_f64(),
    };
    struct Subject(&'static str);
    impl SubjectPort for Subject {
        fn read(&self, _s: &str) -> Result<Secret, OpenAIError> {
            Ok(Secret::new(self.0))
        }
    }
    let none = Keys(json!([]), Mutex::new(0));
    let clock = FakeClock::at(0.0);
    for c in f["constructs"].as_array().unwrap() {
        let p = profile(&c["profile"]);
        let mtls = p.token_exchange_endpoint.contains("mtls");
        match WorkloadIdentity::new(
            p,
            &none,
            &clock,
            &Subject("s"),
            mtls.then_some(&none as &dyn HttpPort),
        ) {
            Ok(_) => assert_eq!(c["ok"], json!(true), "{c}"),
            Err(e) => assert_same(&err(&e), &c["error"], &c["profile"].to_string()),
        }
    }
    struct Scripted(Mutex<Vec<Value>>, Mutex<Vec<Value>>);
    impl HttpPort for Scripted {
        fn request(&self, r: &HttpRequest) -> Result<HttpResponse, OpenAIError> {
            self.1
                .lock()
                .unwrap()
                .push(json!({ "method": r.method, "url": r.url, "json": r.json }));
            let mut q = self.0.lock().unwrap();
            if q.is_empty() {
                return Err(OpenAIError::new("transport-failed"));
            }
            let a = q.remove(0);
            Ok(HttpResponse {
                status: a["status"].as_u64().unwrap() as u16,
                body: a["body"].clone(),
            })
        }
    }
    for c in f["leases"].as_array().unwrap() {
        let http = Scripted(
            Mutex::new(c["script"].as_array().unwrap().clone()),
            Mutex::new(Vec::new()),
        );
        let clock = FakeClock::at(f["start"].as_f64().unwrap());
        let w = WorkloadIdentity::new(
            profile(&f["base"]),
            &http,
            &clock,
            &Subject("CANARY-SUBJECT-1"),
            None,
        )
        .unwrap();
        for st in c["steps"].as_array().unwrap() {
            clock.advance(st["advance"].as_f64().unwrap());
            match w.lease() {
                Ok(t) => assert_eq!(t.expose(), s(&st["out"]), "{}", c["name"]),
                Err(e) => assert_same(&err(&e), &st["error"], s(&c["name"])),
            }
        }
        assert_same(
            &json!(http.1.into_inner().unwrap()),
            &c["requests"],
            s(&c["name"]),
        );
    }
}

struct Fetch(Value, Mutex<Vec<Value>>);
impl HttpTransport for Fetch {
    fn send(&self, r: &WireRequest) -> Result<WireResponse, TransportError> {
        let headers: Map<String, Value> = r
            .headers
            .iter()
            .map(|(k, v)| (k.clone(), json!(v)))
            .collect();
        self.1.lock().unwrap().push(json!({ "url": r.url, "method": r.method, "headers": headers, "body": r.body.expose() }));
        let a = &self.0;
        if a.as_str() == Some("throw") {
            return Err(TransportError::Failed);
        }
        // A long answer is recorded by its length only.
        let long = a.get("bodyLength").or_else(|| a["body"].get("repeat"));
        let body = match long {
            Some(n) => vec![b'x'; n.as_u64().unwrap() as usize],
            None => s(&a["body"]).as_bytes().to_vec(),
        };
        Ok(WireResponse {
            status: a["status"].as_u64().unwrap() as u16,
            headers: vec![],
            body,
        })
    }
}

#[test]
fn openai_http_replays() {
    let f = fixture("http");
    let world = World::new(
        &json!({ "allowHosts": ["auth.openai.com", "api.openai.com"], "allowPorts": [443], "allowLoopback": false }),
        &json!({}),
        "93.184.216.34",
    );
    let egress = world.egress();
    for c in f.as_array().unwrap() {
        let r = &c["request"];
        let req = HttpRequest {
            method: if s(&r["method"]) == "GET" {
                "GET"
            } else {
                "POST"
            },
            url: s(&r["url"]).into(),
            authorization: r["authorization"].as_str().map(Secret::new),
            form: r["form"].as_array().map(|f| {
                f.iter()
                    .map(|p| (s(&p[0]).to_owned(), Secret::new(s(&p[1]))))
                    .collect()
            }),
            json: (!r["json"].is_null()).then(|| r["json"].clone()),
        };
        let transport = Fetch(c["answer"].clone(), Mutex::new(Vec::new()));
        let http = OpenAIHttp::new(&egress, &transport, None, None);
        let what = format!("{} {}", c["name"], r["url"]);
        match http.request(&req) {
            Ok(res) => assert_same(
                &json!({ "status": res.status, "body": res.body }),
                &c["out"],
                &what,
            ),
            Err(e) => assert_same(&err(&e), &c["error"], &what),
        }
        // The request on the wire: method, URL, the header set, the body (a JSON body's members in key order here).
        let ours = transport.1.into_inner().unwrap();
        let theirs = c["seen"].as_array().unwrap();
        assert_eq!(ours.len(), theirs.len(), "{what}");
        for (o, t) in ours.iter().zip(theirs) {
            assert_eq!(o["url"], t["url"]);
            assert_eq!(o["method"], t["method"]);
            assert_same(&o["headers"], &t["headers"], &what);
            if t["headers"]["content-type"] == json!("application/json") {
                let a: Value = serde_json::from_str(s(&o["body"])).unwrap();
                let b: Value = serde_json::from_str(s(&t["body"])).unwrap();
                assert_eq!(a, b, "{what}");
            } else {
                assert_eq!(o["body"], t["body"], "{what}");
            }
        }
    }
}
