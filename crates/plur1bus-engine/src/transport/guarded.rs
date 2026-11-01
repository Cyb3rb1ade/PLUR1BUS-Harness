//! The engine's only HTTP client.
use super::cancel::{CancelConnector, IoWatchdog};
use super::target::{address_allowed, parse_url};
use super::Resolver;
use crate::contract::{Cancel, CancelReason, Cancelled, Decision, EgressGate, Target};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use ureq::unversioned::resolver::{ResolvedSocketAddrs, Resolver as UreqResolver};
use ureq::unversioned::transport::{Connector, NextTimeout, RustlsConnector};
use ureq::RequestExt;

/// An HTTP request whose credential-bearing fields deliberately have no Debug implementation.
pub struct HttpRequest {
    /// HTTP method.
    pub method: String,
    /// Absolute HTTP(S) URL.
    pub url: String,
    /// HTTP headers, possibly including a secret-store credential.
    pub headers: Vec<(String, String)>,
    /// Encoded request body.
    pub body: Vec<u8>,
    /// Maximum decoded response bytes.
    pub max_response_bytes: usize,
    /// Independent bound on untrusted HTTP error diagnostics (Node uses 64 KiB).
    pub max_error_response_bytes: usize,
    /// Optional credential-cache generation advanced immediately on 401/403 headers.
    /// This carries only an atomic counter, never a credential value or callback.
    pub auth_rejection_counter: Option<Arc<std::sync::atomic::AtomicU64>>,
}
impl HttpRequest {
    /// Build a bodyless GET request.
    pub fn get(url: impl Into<String>) -> Self {
        Self {
            method: "GET".into(),
            url: url.into(),
            headers: vec![],
            body: vec![],
            max_response_bytes: 1024 * 1024,
            max_error_response_bytes: 64 * 1024,
            auth_rejection_counter: None,
        }
    }
}
/// A bounded HTTP response; body contents are never formatted by Debug.
#[derive(Eq, PartialEq)]
pub struct HttpResponse {
    /// Numeric HTTP status.
    pub status: u16,
    /// Response headers.
    pub headers: Vec<(String, String)>,
    /// Bounded response bytes.
    pub body: Vec<u8>,
}
impl std::fmt::Debug for HttpResponse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpResponse")
            .field("status", &self.status)
            .field("body_bytes", &self.body.len())
            .finish()
    }
}
/// Body-free transport error categories.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TransportError {
    /// Invalid HTTP request or URL.
    InvalidRequest,
    /// Target policy denied this hop.
    Denied,
    /// At least one resolved address is forbidden.
    AddressDenied,
    /// Explicit caller cancellation interrupted the request.
    Cancelled(Cancelled),
    /// Absolute call deadline expired.
    Timeout,
    /// DNS or connection failure.
    Network,
    /// Too many redirects or an invalid redirect target.
    Redirect,
    /// Decoded response body exceeds the configured bound.
    ResponseTooLarge,
    /// Error headers arrived, but their untrusted diagnostic body failed.
    ResponseBody {
        /// Numeric status received before the body failed.
        status: u16,
        /// Whether the diagnostic body failed through I/O or the absolute deadline.
        failure: ResponseBodyFailure,
    },
}
/// Log-safe failure categories for an HTTP error's diagnostic body.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResponseBodyFailure {
    /// The response body ended prematurely or its connection failed.
    Network,
    /// The same absolute request deadline elapsed while reading the body.
    Timeout,
}
impl TransportError {
    /// Retain known error-response headers even when their body could not be read.
    pub fn http_status(self) -> Option<u16> {
        match self {
            Self::ResponseBody { status, .. } => Some(status),
            _ => None,
        }
    }
}
impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for TransportError {}

/// Policy gate and resolver shared across calls; every connection pins a checked address.
pub struct GuardedClient<'a> {
    gate: GatePort<'a>,
    resolver: Arc<dyn Resolver>,
    decisions: Mutex<DecisionCache>,
}
enum GatePort<'a> {
    Borrowed(&'a dyn EgressGate),
    Owned(Arc<dyn EgressGate>),
}
impl GatePort<'_> {
    fn decide(
        &self,
        target: &Target,
        deadline: Instant,
        cancel: &Cancel,
    ) -> Result<Decision, TransportError> {
        match self {
            Self::Borrowed(gate) => {
                // A borrowed synchronous callback cannot outlive this call safely. Account its
                // elapsed time; production uses the owned port for a hard waiting-time bound.
                let decision = gate.decide(target);
                remaining_cancelled(deadline, cancel)?;
                Ok(decision)
            }
            Self::Owned(gate) => {
                let gate = gate.clone();
                let target = target.clone();
                bounded(deadline, cancel, move || gate.decide(&target))
            }
        }
    }
}
#[derive(Default)]
struct DecisionCache {
    generation: u64,
    entries: HashMap<Target, (Instant, Decision)>,
}

#[derive(Debug)]
struct PinnedResolver(SocketAddr);
impl UreqResolver for PinnedResolver {
    fn resolve(
        &self,
        _: &ureq::http::Uri,
        _: &ureq::config::Config,
        _: NextTimeout,
    ) -> Result<ResolvedSocketAddrs, ureq::Error> {
        let mut result = self.empty();
        result.push(self.0);
        Ok(result)
    }
}
impl<'a> GuardedClient<'a> {
    /// Construct a client with a borrowed synchronous gate, without I/O.
    /// Gate time consumes the deadline, but this compatibility path cannot interrupt
    /// a blocking borrowed callback on cancellation or expiry. Use new_owned in production.
    pub fn new(gate: &'a dyn EgressGate, resolver: Box<dyn Resolver>) -> Self {
        Self {
            gate: GatePort::Borrowed(gate),
            resolver: Arc::from(resolver),
            decisions: Mutex::new(DecisionCache::default()),
        }
    }
    /// Retain an owned gate adapter that forwards policy checks to a live host.
    pub fn new_owned(
        gate: Arc<dyn EgressGate>,
        resolver: Box<dyn Resolver>,
    ) -> GuardedClient<'static> {
        GuardedClient {
            gate: GatePort::Owned(gate),
            resolver: Arc::from(resolver),
            decisions: Mutex::new(DecisionCache::default()),
        }
    }
    /// Execute an HTTP request within one absolute deadline.
    pub fn request(
        &self,
        req: HttpRequest,
        deadline: Instant,
    ) -> Result<HttpResponse, TransportError> {
        self.request_cancelled(req, deadline, &Cancel::never())
    }
    /// Execute with caller cancellation during owned host callbacks and active socket I/O.
    /// Borrowed synchronous gate callbacks cannot be interrupted safely; their elapsed
    /// time counts and cancellation is checked immediately after they return.
    pub fn request_cancelled(
        &self,
        mut req: HttpRequest,
        deadline: Instant,
        cancel: &Cancel,
    ) -> Result<HttpResponse, TransportError> {
        for hop in 0..=10 {
            remaining_cancelled(deadline, cancel)?;
            let (url, target) = parse_url(&req.url)?;
            let decision = self.decision(&target, deadline, cancel)?;
            remaining_cancelled(deadline, cancel)?;
            let Decision::Allow { address_rules } = decision else {
                return Err(TransportError::Denied);
            };
            let resolver = self.resolver.clone();
            let host = target.host.clone();
            let port = target.port;
            let addresses = bounded(deadline, cancel, move || {
                resolver.resolve(&host, port, deadline)
            })??;
            remaining_cancelled(deadline, cancel)?;
            if addresses
                .iter()
                .any(|address| !address_allowed(*address, address_rules))
            {
                return Err(TransportError::AddressDenied);
            }
            let address = addresses.first().ok_or(TransportError::Network)?;
            // A fresh agent prevents pooled sockets from surviving policy changes or a DNS check.
            // URI remains the original name: ureq uses it for both Host and rustls SNI/certificate checks.
            let watchdog = IoWatchdog::new(cancel, deadline)?;
            let config = ureq::Agent::config_builder()
                .proxy(None)
                .max_redirects(0)
                .http_status_as_error(false)
                .timeout_global(Some(remaining_cancelled(deadline, cancel)?))
                .build();
            let agent = ureq::Agent::with_parts(
                config,
                CancelConnector {
                    address: SocketAddr::new(*address, target.port),
                    control: watchdog.control.clone(),
                }
                .chain(RustlsConnector::default()),
                PinnedResolver(SocketAddr::new(*address, target.port)),
            );
            let mut builder = ureq::http::Request::builder()
                .method(req.method.as_str())
                .uri(url.as_str());
            for (name, value) in &req.headers {
                if name.eq_ignore_ascii_case("host") {
                    return Err(TransportError::InvalidRequest);
                }
                let mut value = ureq::http::HeaderValue::from_str(value)
                    .map_err(|_| TransportError::InvalidRequest)?;
                value.set_sensitive(true);
                builder = builder.header(name.as_str(), value);
            }
            let request = builder
                .body(req.body.as_slice())
                .map_err(|_| TransportError::InvalidRequest)?;
            let mut response = request
                .with_agent(&agent)
                .configure()
                .timeout_global(Some(remaining_cancelled(deadline, cancel)?))
                .run()
                .map_err(|error| current_error(error, deadline, cancel))?;
            let status = response.status().as_u16();
            if matches!(status, 401 | 403) {
                if let Some(generation) = &req.auth_rejection_counter {
                    generation.fetch_add(1, std::sync::atomic::Ordering::AcqRel);
                }
            }
            remaining_cancelled(deadline, cancel).map_err(|error| response_error(status, error))?;
            if matches!(status, 301 | 302 | 303 | 307 | 308) {
                if hop == 10 {
                    return Err(TransportError::Redirect);
                }
                let location = response
                    .headers()
                    .get("location")
                    .and_then(|v| v.to_str().ok())
                    .ok_or(TransportError::Redirect)?;
                let next = url.join(location).map_err(|_| TransportError::Redirect)?;
                let (_, next_target) =
                    parse_url(next.as_str()).map_err(|_| TransportError::Redirect)?;
                if target != next_target {
                    req.headers.retain(|(name, _)| {
                        name.eq_ignore_ascii_case("accept")
                            || name.eq_ignore_ascii_case("content-type")
                    });
                }
                if status == 303 && req.method != "HEAD"
                    || matches!(status, 301 | 302) && req.method == "POST"
                {
                    req.method = "GET".into();
                    req.body.clear();
                    req.headers.retain(|(name, _)| {
                        !name.eq_ignore_ascii_case("content-type")
                            && !name.eq_ignore_ascii_case("content-length")
                    });
                }
                req.url = next.into();
                continue;
            }
            let headers = response
                .headers()
                .iter()
                .filter_map(|(name, value)| {
                    value
                        .to_str()
                        .ok()
                        .map(|v| (name.as_str().to_owned(), v.to_owned()))
                })
                .collect();
            let non_success = !(200..300).contains(&status);
            let body_limit = if non_success {
                req.max_error_response_bytes
            } else {
                req.max_response_bytes
            };
            let read = response
                .body_mut()
                .with_config()
                .limit(body_limit as u64)
                .read_to_vec();
            // Keep error status independent of diagnostic body validity: a refused key
            // must rotate even when the body is truncated, too large or times out.
            let body = match read {
                Ok(body) => body,
                Err(ureq::Error::BodyExceedsLimit(_)) if non_success => vec![],
                Err(error) => {
                    return Err(response_error(
                        status,
                        current_error(error, deadline, cancel),
                    ))
                }
            };
            remaining_cancelled(deadline, cancel).map_err(|error| response_error(status, error))?;
            return Ok(HttpResponse {
                status,
                headers,
                body,
            });
        }
        Err(TransportError::Redirect)
    }
    /// Clear cached egress decisions after a host policy update.
    pub fn invalidate(&self) {
        let mut cache = self
            .decisions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        cache.generation = cache.generation.wrapping_add(1);
        cache.entries.clear();
    }

    fn decision(
        &self,
        target: &Target,
        deadline: Instant,
        cancel: &Cancel,
    ) -> Result<Decision, TransportError> {
        let generation = {
            let cache = self
                .decisions
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some((expires, decision)) = cache.entries.get(target) {
                if Instant::now() < *expires {
                    return Ok(decision.clone());
                }
            }
            cache.generation
        };
        let decision = self.gate.decide(target, deadline, cancel)?;
        let mut cache = self
            .decisions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if cache.generation == generation {
            // Expired entries do not accumulate across changing destinations.
            cache
                .entries
                .retain(|_, (expires, _)| Instant::now() < *expires);
            cache.entries.insert(
                target.clone(),
                (Instant::now() + Duration::from_secs(60), decision.clone()),
            );
        }
        Ok(decision)
    }
}

fn remaining(deadline: Instant) -> Result<Duration, TransportError> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|v| !v.is_zero())
        .ok_or(TransportError::Timeout)
}

pub(crate) fn bounded<T: Send + 'static>(
    deadline: Instant,
    cancel: &Cancel,
    operation: impl FnOnce() -> T + Send + 'static,
) -> Result<T, TransportError> {
    remaining_cancelled(deadline, cancel)?;
    let (send, receive) = mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("engine-host-port".into())
        .spawn(move || {
            let _ = send.send(operation());
        })
        .map_err(|_| TransportError::Network)?;
    loop {
        let budget = remaining_cancelled(deadline, cancel)?;
        match receive.recv_timeout(budget.min(Duration::from_millis(10))) {
            Ok(result) => {
                remaining_cancelled(deadline, cancel)?;
                return Ok(result);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return Err(TransportError::Network),
        }
    }
}

pub(super) fn remaining_cancelled(
    deadline: Instant,
    cancel: &Cancel,
) -> Result<Duration, TransportError> {
    cancel.check().map_err(|error| match error.reason {
        CancelReason::Caller => TransportError::Cancelled(error),
        CancelReason::Deadline => TransportError::Timeout,
    })?;
    let budget = remaining(deadline)?;
    Ok(cancel
        .remaining()
        .map_or(budget, |remaining| budget.min(remaining)))
}

fn current_error(error: ureq::Error, deadline: Instant, cancel: &Cancel) -> TransportError {
    remaining_cancelled(deadline, cancel)
        .err()
        .unwrap_or_else(|| map_error(error))
}
fn map_error(error: ureq::Error) -> TransportError {
    match error {
        ureq::Error::Timeout(_) => TransportError::Timeout,
        ureq::Error::BodyExceedsLimit(_) => TransportError::ResponseTooLarge,
        ureq::Error::Io(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
            ) =>
        {
            TransportError::Timeout
        }
        _ => TransportError::Network,
    }
}

fn response_error(status: u16, error: TransportError) -> TransportError {
    if (200..300).contains(&status) || matches!(error, TransportError::Cancelled(_)) {
        return error;
    }
    TransportError::ResponseBody {
        status,
        failure: if error == TransportError::Timeout {
            ResponseBodyFailure::Timeout
        } else {
            ResponseBodyFailure::Network
        },
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use crate::contract::{AddressRules, Scheme};
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn an_expired_sixty_second_decision_is_rechecked() {
        struct Gate(AtomicUsize);
        impl EgressGate for Gate {
            fn decide(&self, _: &Target) -> Decision {
                if self.0.fetch_add(1, Ordering::SeqCst) == 0 {
                    Decision::Allow {
                        address_rules: AddressRules::default(),
                    }
                } else {
                    Decision::Deny {
                        reason: "changed".into(),
                    }
                }
            }
        }
        let gate = Gate(AtomicUsize::new(0));
        let client = GuardedClient::new(&gate, Box::new(super::super::SystemResolver));
        let target = Target {
            scheme: Scheme::Https,
            host: "provider.test".into(),
            port: 443,
        };
        let before = Instant::now();
        assert!(matches!(
            client
                .decision(
                    &target,
                    Instant::now() + Duration::from_secs(1),
                    &Cancel::never()
                )
                .unwrap(),
            Decision::Allow { .. }
        ));
        {
            let mut cache = client.decisions.lock().unwrap();
            let (expires, _) = cache.entries.get_mut(&target).unwrap();
            assert!(*expires >= before + Duration::from_secs(60));
            assert!(*expires <= Instant::now() + Duration::from_secs(60));
            *expires = Instant::now() - Duration::from_millis(1);
        }
        assert!(matches!(
            client
                .decision(
                    &target,
                    Instant::now() + Duration::from_secs(1),
                    &Cancel::never()
                )
                .unwrap(),
            Decision::Deny { .. }
        ));
        assert_eq!(gate.0.load(Ordering::SeqCst), 2);
    }
}
