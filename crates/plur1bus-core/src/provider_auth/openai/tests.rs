//! Ports of `packages/core/test/openai-auth/{loopback,audit-b10,federated}.test.ts` that the vectors do not hold: the plan's
//! loopback gate, the bookkeeping of pending logins, the federated supplier, and the secret rule of the package's types.
use super::super::login::CallbackRequest;
use super::super::ports::Clock;
use super::super::secret::Secret;
use super::super::testing::FakeClock;
use super::federated::{FederatedCredential, FederatedSource, Supplier};
use super::loopback::{PlanGate, PlanJudged};
use super::ports::{HttpRequest, OpenAIError};
use super::service::PendingLogins;
use std::sync::Mutex;

fn canary(tag: &str) -> String {
    ["CAN", "ARY-", tag].concat()
}

fn req(target: &str) -> CallbackRequest {
    CallbackRequest {
        method: "GET".into(),
        target: target.into(),
        host: Some("127.0.0.1:49152".into()),
        ..CallbackRequest::default()
    }
}

fn status(j: &PlanJudged) -> u16 {
    match j {
        PlanJudged::Refused(r) | PlanJudged::Genuine(r, _) => r.status,
    }
}

#[test]
fn the_plan_listener_refuses_foreign_requests_and_ends_only_on_its_state() {
    let st = canary("STATE");
    let mut g = PlanGate::new(
        "http://127.0.0.1:49152/auth/callback",
        Secret::new(st.clone()),
    )
    .unwrap();
    let mut origin = req("/auth/callback");
    origin.origin = Some("https://foreign.invalid".into());
    assert_eq!(status(&g.judge(&origin, 0.0)), 404);
    let mut site = req("/auth/callback");
    site.sec_fetch_site = Some("same-site".into());
    assert_eq!(status(&g.judge(&site, 0.0)), 404);
    let mut host = req("/auth/callback");
    host.host = Some("localhost:49152".into());
    assert_eq!(status(&g.judge(&host, 0.0)), 404);
    // Same length, other state; and an absolute request target naming another authority.
    let other = "x".repeat(st.len());
    assert_eq!(
        status(&g.judge(&req(&format!("/auth/callback?state={other}")), 0.0)),
        400
    );
    // The path matches, so it is judged as a forgery (400) and counts towards the window.
    assert_eq!(
        status(&g.judge(
            &req(&format!("http://evil.example/auth/callback?state={st}")),
            0.0
        )),
        400
    );
    for i in 0..8 {
        assert_eq!(
            status(&g.judge(&req(&format!("/auth/callback?state=f{i}")), 10.0)),
            400
        );
    }
    assert_eq!(status(&g.judge(&req("/auth/callback?state=f"), 10.0)), 429);
    // A new window, and the genuine callback is never throttled.
    match g.judge(&req(&format!("/auth/callback?code=c&state={st}")), 10.0) {
        PlanJudged::Genuine(r, url) => {
            assert_eq!(r.status, 200);
            assert!(url.contains("code=c"));
        }
        PlanJudged::Refused(r) => panic!("refused {}", r.status),
    }
    assert_eq!(
        status(&g.judge(&req(&format!("/auth/callback?state={st}")), 20.0)),
        410
    );
}

#[test]
fn pending_logins_evict_finished_ones_and_belong_to_their_person() {
    let mut p = PendingLogins::default();
    for i in 0..16 {
        p.start(&format!("l{i}"), "owner").unwrap();
    }
    assert_eq!(p.start("l16", "owner").unwrap_err().code, "invalid-request");
    for i in 0..16 {
        p.settle(&format!("l{i}"));
    }
    // Completed but never awaited logins do not exhaust the cap.
    for i in 16..40 {
        p.start(&format!("l{i}"), "owner").unwrap();
        p.settle(&format!("l{i}"));
    }
    assert!(p.count("owner") <= 16);
    assert_eq!(p.take("l39", "bob").unwrap_err().code, "owner-only");
    p.take("l39", "owner").unwrap();
}

struct Answer(Mutex<Vec<Result<String, OpenAIError>>>, Mutex<u32>);
impl Supplier for Answer {
    fn supply(&self, _s: &FederatedSource) -> Result<Secret, OpenAIError> {
        *self.1.lock().unwrap() += 1;
        let mut q = self.0.lock().unwrap();
        if q.is_empty() {
            return Err(OpenAIError::new("auth-required"));
        }
        q.remove(0).map(Secret::new)
    }
}

#[test]
fn a_federated_supplier_is_cached_until_the_skew_and_sanitised() {
    let clock = FakeClock::at(1_000_000.0);
    let tok = canary("FED");
    let answer = Answer(
        Mutex::new(vec![Ok(format!(
            "{{\"access_token\":\"{tok}\",\"expires_at\":2000}}"
        ))]),
        Mutex::new(0),
    );
    let source = FederatedSource {
        file: Some("/x".into()),
        ..FederatedSource::default()
    };
    let c = FederatedCredential::new(source.clone(), &clock, &answer, 120_000.0).unwrap();
    assert_eq!(c.lease().unwrap().expose(), tok);
    assert_eq!(c.lease().unwrap().expose(), tok);
    assert_eq!(*answer.1.lock().unwrap(), 1, "one supply while fresh");
    clock.advance(2_000_000.0 - 120_000.0 - clock.now());
    assert_eq!(
        c.lease().unwrap_err().code,
        "auth-required",
        "due at expiry minus skew; the supplier has nothing more"
    );
    // An answer that is already inside the skew, a missing token, junk: auth-required, nothing echoed.
    for raw in [
        "{\"access_token\":\"t\",\"expires_at\":1}",
        "{\"expires_at\":99999999}",
        "[]",
        "junk CANARY",
    ] {
        let a = Answer(Mutex::new(vec![Ok(raw.to_owned())]), Mutex::new(0));
        let e = FederatedCredential::new(source.clone(), &clock, &a, 0.0)
            .unwrap()
            .lease()
            .unwrap_err();
        assert_eq!(e.code, "auth-required");
        assert!(!format!("{e:?}{e}").contains("CANARY"));
    }
    for bad in [
        FederatedSource::default(),
        FederatedSource {
            file: Some("a".into()),
            command: Some("b".into()),
            ..FederatedSource::default()
        },
    ] {
        assert_eq!(
            FederatedCredential::new(bad, &clock, &answer, 0.0)
                .err()
                .unwrap()
                .code,
            "invalid-request"
        );
    }
    let mut env = FederatedSource {
        command: Some("/bin/x".into()),
        ..FederatedSource::default()
    };
    env.environment.insert("lower".into(), "v".into());
    assert_eq!(
        FederatedCredential::new(env, &clock, &answer, 0.0)
            .err()
            .unwrap()
            .code,
        "invalid-request"
    );
    c.close();
}

#[test]
fn requests_and_errors_print_without_credentials() {
    let mut r = HttpRequest::get("https://api.openai.com/v1/models");
    r.authorization = Some(Secret::new(canary("A")));
    assert!(!format!("{r:?}").contains("CANARY"));
    assert!(!r.redacted_json().to_string().contains("CANARY"));
    let e = OpenAIError::new("subscription_sharing_invalid_user");
    assert_eq!(
        e.message(),
        "OpenAI operation refused (subscription_sharing_invalid_user)."
    );
    assert_eq!(OpenAIError::new("anything else").code, "endpoint-rejected");
}
