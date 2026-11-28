//! Bounded delivery of A2A 0.3 task notifications. The host supplies egress
//! admission, cancellation and scheduling for each delivery.
use std::{
    net::SocketAddr,
    time::{Duration, Instant},
};

use serde_json::Value;
use ureq::http::{header, HeaderMap, Request};
use url::Url;

use crate::{
    client::{http, Error},
    endpoint::{PushConfig, Window},
};

const MAX_BODY: usize = 1024 * 1024;
const MAX_DIAGNOSTIC: usize = 64 * 1024;
const MAX_POST_TIME: Duration = Duration::from_secs(60);
const NOTIFICATION_TOKEN: &str = "x-a2a-notification-token";

pub trait Port {
    /// Admit the exact destination and return the authorized socket within
    /// the deadline. Apply the host's egress policy on initial delivery and on
    /// every redirect. Resolve the hostname, reject disallowed private,
    /// link-local and metadata addresses, and return only an approved pin.
    /// Apply the same admission policy when the push configuration is set.
    fn admit(&self, target: &Url, window: Window<'_>) -> Option<SocketAddr>;

    /// Wait within the given window. False cancels pending retry work.
    fn wait(&self, delay: Duration, window: Window<'_>) -> bool;
}

#[derive(Clone, Copy)]
pub struct Limits {
    pub attempts: u8,
    pub backoff: Duration,
    pub redirects: u8,
    pub post_timeout: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            attempts: 3,
            backoff: Duration::from_millis(100),
            redirects: 3,
            post_timeout: Duration::from_secs(15),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Delivery {
    Delivered,
    Rejected,
    Exhausted,
}

/// Deliver a public task object. Task ownership and the creation of the
/// PushConfig have already been authorized by the host.
pub fn deliver(
    port: &dyn Port,
    config: &PushConfig,
    task: &Value,
    window: Window<'_>,
    limits: Limits,
) -> Result<Delivery, Error> {
    deliver_with(port, config, task, window, limits, post)
}

fn deliver_with(
    port: &dyn Port,
    config: &PushConfig,
    task: &Value,
    window: Window<'_>,
    limits: Limits,
    send: impl Fn(&Url, SocketAddr, &HeaderMap, &[u8], Window<'_>) -> Result<Reply, Error>,
) -> Result<Delivery, Error> {
    http::check(window)?;
    if !valid_target(&config.url) || limits.post_timeout.is_zero() {
        return Err(Error::Denied);
    }
    let headers = delivery_headers(config)?;
    // Serialize through a bounded writer so the body never grows past its limit.
    let mut body = BodyBuffer::default();
    serde_json::to_writer(&mut body, task).map_err(|_| Error::TooLarge)?;
    for attempt in 0..limits.attempts {
        let context = HopContext {
            port,
            window,
            limits,
            body: &body.0,
        };
        match context.follow(&config.url, headers.clone(), &send)? {
            Some(outcome) => return Ok(outcome),
            None if attempt + 1 == limits.attempts => break,
            None => {}
        }
        http::check(window)?;
        let factor = 1u32.checked_shl(u32::from(attempt)).unwrap_or(u32::MAX);
        let delay = limits.backoff.saturating_mul(factor);
        if delay >= window.deadline.saturating_duration_since(Instant::now()) {
            return Err(Error::Deadline);
        }
        if !port.wait(delay, window) {
            return Err(Error::Aborted);
        }
    }
    Ok(Delivery::Exhausted)
}

#[derive(Default)]
struct BodyBuffer(Vec<u8>);

impl std::io::Write for BodyBuffer {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > MAX_BODY - self.0.len() {
            return Err(std::io::ErrorKind::FileTooLarge.into());
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

struct HopContext<'a> {
    port: &'a dyn Port,
    window: Window<'a>,
    limits: Limits,
    body: &'a [u8],
}

impl HopContext<'_> {
    fn follow(
        &self,
        original: &Url,
        mut headers: HeaderMap,
        send: impl Fn(&Url, SocketAddr, &HeaderMap, &[u8], Window<'_>) -> Result<Reply, Error>,
    ) -> Result<Option<Delivery>, Error> {
        let mut current = original.clone();
        for hop in 0..=self.limits.redirects {
            http::check(self.window)?;
            let Some(pin) = self
                .port
                .admit(&current, self.window)
                .filter(|pin| http::pin_matches(&current, *pin))
            else {
                return Ok(None);
            };
            http::check(self.window)?;
            let local = Instant::now() + self.limits.post_timeout.min(MAX_POST_TIME);
            let window = Window {
                deadline: local.min(self.window.deadline),
                ..self.window
            };
            let response = send(&current, pin, &headers, self.body, window);
            http::check(self.window)?;
            let Ok(reply) = response else { return Ok(None) };
            match reply.status {
                200..=299 => return Ok(Some(Delivery::Delivered)),
                301 | 302 | 303 | 307 | 308 if hop < self.limits.redirects => {
                    let Some(next) = reply
                        .location
                        .and_then(|location| current.join(&location).ok())
                        .filter(valid_target)
                    else {
                        return Ok(None);
                    };
                    if next.origin() != current.origin() {
                        headers.remove(header::AUTHORIZATION);
                        headers.remove(NOTIFICATION_TOKEN);
                    }
                    current = next;
                }
                400..=499 if !matches!(reply.status, 408 | 429) => {
                    return Ok(Some(Delivery::Rejected));
                }
                _ => return Ok(None),
            }
        }
        Ok(None)
    }
}

fn valid_target(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.host().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && url.as_str().len() <= 2048
}

fn delivery_headers(config: &PushConfig) -> Result<HeaderMap, Error> {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("application/json; charset=utf-8"),
    );
    if let Some(token) = &config.token {
        headers.insert(NOTIFICATION_TOKEN, sensitive_header(token, 512)?);
    }
    if let Some(credential) = config
        .authentication
        .as_ref()
        .filter(|auth| {
            auth.schemes
                .iter()
                .any(|s| s.eq_ignore_ascii_case("bearer"))
        })
        .and_then(|auth| auth.credential.as_ref())
    {
        if credential.len() > 2048 {
            return Err(Error::InvalidRequest);
        }
        headers.insert(
            header::AUTHORIZATION,
            sensitive_header(&format!("Bearer {credential}"), 2055)?,
        );
    }
    Ok(headers)
}

fn sensitive_header(text: &str, max: usize) -> Result<header::HeaderValue, Error> {
    if text.len() > max {
        return Err(Error::InvalidRequest);
    }
    let mut value = header::HeaderValue::from_str(text).map_err(|_| Error::InvalidRequest)?;
    value.set_sensitive(true);
    Ok(value)
}

struct Reply {
    status: u16,
    location: Option<String>,
}

fn post(
    target: &Url,
    pin: SocketAddr,
    headers: &HeaderMap,
    body: &[u8],
    window: Window<'_>,
) -> Result<Reply, Error> {
    http::check(window)?;
    let mut request = Request::post(target.as_str())
        .header(header::USER_AGENT, "PLUR1BUS-a2a-push")
        .header(header::CONNECTION, "close")
        .header(header::ACCEPT_ENCODING, "identity")
        .body(body)
        .map_err(|_| Error::InvalidRequest)?;
    request.headers_mut().extend(headers.clone());
    let (response, signal) = http::run(pin, window, request)?;
    let reply = Reply {
        status: response.status().as_u16(),
        location: response
            .headers()
            .get(header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned),
    };
    let content_length = response
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok());
    if !matches!(reply.status, 204 | 205) && content_length.is_none_or(|len| len <= MAX_DIAGNOSTIC)
    {
        // A receiver has already selected its status. A diagnostic failure
        // must not turn an accepted delivery into a second POST.
        let _ = http::read_json(
            response.into_body(),
            &signal,
            MAX_DIAGNOSTIC,
            window,
            || true,
        );
    }
    Ok(reply)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, reason = "fixture assertions")]
mod tests {
    use super::*;
    use crate::endpoint::PushAuthentication;
    use plur1bus_wire_fixtures::FakeServer;
    use serde_json::json;
    use std::cell::RefCell;

    fn window() -> Window<'static> {
        Window {
            deadline: Instant::now() + Duration::from_secs(30),
            canceled: &|| false,
        }
    }

    fn config(url: &str) -> PushConfig {
        PushConfig {
            url: Url::parse(url).unwrap(),
            id: None,
            token: Some("fixture".into()),
            authentication: Some(PushAuthentication {
                schemes: vec!["bearer".into()],
                credential: Some("fixture".into()),
            }),
        }
    }

    struct FixturePort<'a> {
        denied: &'a Value,
        resume: bool,
        admitted: RefCell<Vec<String>>,
        waits: RefCell<Vec<u128>>,
    }

    impl Port for FixturePort<'_> {
        fn admit(&self, target: &Url, _: Window<'_>) -> Option<SocketAddr> {
            self.admitted.borrow_mut().push(target.as_str().into());
            let denied = self
                .denied
                .as_array()?
                .iter()
                .any(|url| url == target.as_str());
            (!denied).then(|| {
                SocketAddr::from(([127, 0, 0, 1], target.port_or_known_default().unwrap()))
            })
        }

        fn wait(&self, delay: Duration, _: Window<'_>) -> bool {
            self.waits.borrow_mut().push(delay.as_millis());
            self.resume
        }
    }

    #[test]
    fn dispatcher_replays_the_typescript_admission_and_post_sequence() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../../fixtures/parity/a2a/push.json")).unwrap();
        let config = config(fixture["url"].as_str().unwrap());

        for case in fixture["cases"].as_array().unwrap() {
            let port = FixturePort {
                resume: true,
                denied: &case["denied"],
                admitted: Default::default(),
                waits: Default::default(),
            };
            let posts = RefCell::new(Vec::new());
            let limits = Limits::default();
            let expected = match case["name"].as_str().unwrap() {
                "denied-hop" => Delivery::Exhausted,
                "final-client-status" => Delivery::Rejected,
                _ => Delivery::Delivered,
            };
            let result = deliver_with(
                &port,
                &config,
                &fixture["task"],
                window(),
                limits,
                |target, pin, headers, body, span| {
                    assert_eq!(target.port_or_known_default(), Some(pin.port()));
                    assert!(span.active());
                    assert!(span.deadline <= Instant::now() + limits.post_timeout);
                    if let Some(field) = headers.get(header::AUTHORIZATION) {
                        assert!(field.is_sensitive());
                    }
                    if let Some(field) = headers.get(NOTIFICATION_TOKEN) {
                        assert!(field.is_sensitive());
                    }
                    let mut posts = posts.borrow_mut();
                    let response = &case["results"][posts.len()];
                    posts.push(json!({
                        "url": target.as_str(),
                        "task": serde_json::from_slice::<Value>(body).unwrap(),
                        "authorization": headers.contains_key(header::AUTHORIZATION),
                        "token": headers.contains_key(NOTIFICATION_TOKEN),
                    }));
                    Ok(Reply {
                        status: response["status"].as_u64().unwrap() as u16,
                        location: response["location"].as_str().map(str::to_owned),
                    })
                },
            );
            assert_eq!(result, Ok(expected), "{}", case["name"]);
            assert_eq!(json!(port.admitted.into_inner()), case["admissions"]);
            assert_eq!(json!(port.waits.into_inner()), case["waits"]);
            let posts = posts.into_inner();
            assert_eq!(
                case["deadlines"],
                json!(vec![limits.post_timeout.as_millis(); posts.len()])
            );
            assert_eq!(json!(posts), case["posts"]);
        }
    }

    #[test]
    fn accepted_push_is_not_repeated_for_an_oversized_diagnostic() {
        let server = FakeServer::start(&json!({"transport": "http", "exchanges": [{
            "request": {"method":"POST", "path":"/report"},
            "response": {"status":200, "body":{"message":"x".repeat(MAX_DIAGNOSTIC + 1)}}
        }]}));
        let config = config(&format!("http://{}/report", server.addr));
        let denied = json!([]);
        let port = FixturePort {
            resume: true,
            denied: &denied,
            admitted: Default::default(),
            waits: Default::default(),
        };
        assert_eq!(
            deliver(
                &port,
                &config,
                &json!({"id":"report"}),
                window(),
                Limits::default()
            ),
            Ok(Delivery::Delivered)
        );
        assert_eq!(server.received().len(), 1);
        assert!(port.waits.borrow().is_empty());
    }

    #[test]
    fn push_body_size_and_cancellation_are_checked_before_admission() {
        let config = config("https://callbacks.example.invalid/report");
        let denied = json!([]);
        let port = FixturePort {
            resume: true,
            denied: &denied,
            admitted: Default::default(),
            waits: Default::default(),
        };
        assert_eq!(
            deliver(
                &port,
                &config,
                &json!({"text":"x".repeat(MAX_BODY)}),
                window(),
                Limits::default()
            ),
            Err(Error::TooLarge)
        );
        assert_eq!(
            deliver(
                &port,
                &config,
                &json!({}),
                Window {
                    canceled: &|| true,
                    ..window()
                },
                Limits::default()
            ),
            Err(Error::Aborted)
        );
        assert!(port.admitted.borrow().is_empty());
    }
    #[test]
    fn push_checks_each_destination_before_admission_and_each_pin_before_send() {
        let denied = json!([]);
        let port = FixturePort {
            denied: &denied,
            resume: true,
            admitted: Default::default(),
            waits: Default::default(),
        };
        let limits = Limits {
            attempts: 1,
            ..Limits::default()
        };
        for url in [
            "ftp://callback.example/report",
            "https://user@callback.example/report",
            "https://:password@callback.example/report",
            "https://callback.example/report#part",
        ] {
            assert_eq!(
                deliver_with(
                    &port,
                    &config(url),
                    &json!({}),
                    window(),
                    limits,
                    |_, _, _, _, _| Err(Error::InvalidRequest)
                ),
                Err(Error::Denied)
            );
            assert!(port.admitted.borrow().is_empty());
            let original = config("https://callback.example/first");
            let result = deliver_with(
                &port,
                &original,
                &json!({}),
                window(),
                limits,
                |target, _, _, _, _| {
                    assert_eq!(target, &original.url);
                    Ok(Reply {
                        status: 307,
                        location: Some(url.into()),
                    })
                },
            );
            assert_eq!(result, Ok(Delivery::Exhausted));
            assert_eq!(port.admitted.take(), [original.url.as_str()]);
        }
        let sends = std::cell::Cell::new(0);
        assert_eq!(
            deliver_with(
                &port,
                &config("https://127.0.0.2/report"),
                &json!({}),
                window(),
                limits,
                |_, _, _, _, _| {
                    sends.set(sends.get() + 1);
                    Ok(Reply {
                        status: 200,
                        location: None,
                    })
                }
            ),
            Ok(Delivery::Exhausted)
        );
        assert_eq!(sends.get(), 0);
    }

    #[test]
    fn each_post_uses_the_earlier_deadline_and_only_bearer_authentication() {
        let denied = json!([]);
        let port = FixturePort {
            denied: &denied,
            resume: true,
            admitted: Default::default(),
            waits: Default::default(),
        };
        let mut target = config("https://callback.example/report");
        target.authentication.as_mut().unwrap().schemes = vec!["basic".into()];
        let limits = Limits {
            post_timeout: Duration::from_secs(120),
            ..Default::default()
        };
        for host_seconds in [5, 180] {
            let start = Instant::now();
            let host = Window {
                deadline: start + Duration::from_secs(host_seconds),
                ..window()
            };
            let result = deliver_with(
                &port,
                &target,
                &json!({}),
                host,
                limits,
                |_, _, headers, _, post| {
                    assert!(!headers.contains_key(header::AUTHORIZATION));
                    assert!(headers.contains_key(NOTIFICATION_TOKEN));
                    if host_seconds == 5 {
                        assert_eq!(post.deadline, host.deadline);
                    } else {
                        assert!(post.deadline >= start + Duration::from_secs(60));
                        assert!(post.deadline <= Instant::now() + Duration::from_secs(60));
                    }
                    Ok(Reply {
                        status: 204,
                        location: None,
                    })
                },
            );
            assert_eq!(result, Ok(Delivery::Delivered));
        }
    }

    #[test]
    fn push_stops_before_an_unaffordable_wait_and_when_the_host_cancels_the_wait() {
        let denied = json!([]);
        let port = FixturePort {
            denied: &denied,
            resume: false,
            admitted: Default::default(),
            waits: Default::default(),
        };
        let target = config("https://callback.example/report");
        let reject = |_: &Url, _: SocketAddr, _: &HeaderMap, _: &[u8], _: Window<'_>| {
            Ok(Reply {
                status: 503,
                location: None,
            })
        };
        let limits = Limits {
            backoff: Duration::from_secs(60),
            ..Default::default()
        };
        assert_eq!(
            deliver_with(&port, &target, &json!({}), window(), limits, reject),
            Err(Error::Deadline)
        );
        assert!(port.waits.borrow().is_empty());
        assert_eq!(
            deliver_with(
                &port,
                &target,
                &json!({}),
                window(),
                Limits::default(),
                reject
            ),
            Err(Error::Aborted)
        );
        assert_eq!(port.waits.take(), [100]);
        assert_eq!(port.admitted.take().len(), 2);
    }
}
