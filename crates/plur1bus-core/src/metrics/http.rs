//! `metrics/http.ts`: `GET /metrics`, a read-only, loopback-only, token-protected HTTP endpoint for the Prometheus text
//! format.
//!
//! - Bound to a loopback address only (a non-loopback `host` is refused at construction).
//! - `GET`/`HEAD` on exactly `/metrics`; everything else is 404/405. Nothing is ever written or changed.
//! - `Authorization: Bearer <token>` only (never a query parameter: URLs end up in logs), compared in constant time.
//! - The Host header must be a loopback name (DNS-rebinding defence) and the peer must be a loopback address.
//! - Repeated failures lock the client out for a while (fake-clock testable).
//! - RBAC: the token is turned into a principal with scopes by the [`MetricsAccess`] port; `metrics.read` is required.
//!   The port's default grants one token exactly `metrics.read`.
//!
//! The TypeScript endpoint sits on `node:http`. This one has no HTTP library under it (P4-11 ruling 3): a strict reader
//! for one request head on `std::net`, one request per connection, every answer `connection: close`. Where it differs
//! from Node it is the stricter of the two, and a well-formed client sees the same statuses, headers and bodies:
//!
//! - no keep-alive (Node keeps a connection for 5 s);
//! - a head over 8192 bytes or with more than 50 header lines is answered 431 (Node drops the header lines past its count);
//! - a second `Host` or `Authorization` line, a bare LF, a folded header line or a control character is answered 400;
//! - at most [`MAX_CONNECTIONS`] connections are served at once, a further one is closed unanswered. Known limit: a
//!   local client that opens that many connections and sends nothing keeps the endpoint silent for the head deadline
//!   (5 s) each time; Node would carry the idle sockets instead;
//! - a request body is never read (the answer does not depend on it);
//! - the lockout check, the authorization and the failure count of one request are one critical section, so requests
//!   in flight cannot all pass the check before the first failure is counted;
//! - when the table of failing peers is full, entries that are neither locked nor inside their window are dropped
//!   before a new peer goes untracked (TypeScript never forgets a peer until it succeeds);
//! - a panic of the authorization port is logged without its message (it could carry the token).
use super::logger_port::MetricsLog;
use crate::auth::constant_time_eq;
use crate::logs::levels::{system_clock, Clock};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::any::Any;
use std::collections::HashMap;
use std::fmt;
use std::io::{self, Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, Shutdown, SocketAddr, TcpListener, TcpStream};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// The scope a principal needs to read the exposition.
pub const METRICS_SCOPE: &str = "metrics.read";
/// Connections served at the same time; a further one is closed unanswered.
pub const MAX_CONNECTIONS: usize = 32;
const MIN_TOKEN_CHARS: usize = 32;
const MAX_FAILURES: usize = 10;
const FAILURE_WINDOW_MS: i64 = 60_000;
const LOCKOUT_MS: i64 = 60_000;
/// Peers whose failures are tracked; bounded so a flood cannot grow the table.
const MAX_TRACKED_PEERS: usize = 1024;
const CONTENT_TYPE: &str = "text/plain; version=0.0.4; charset=utf-8";
const MAX_HEAD_BYTES: usize = 8192;
const MAX_HEADERS: usize = 50;
const HEADERS_TIMEOUT: Duration = Duration::from_secs(5);
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
/// What is still read from a client after the answer, so the close does not reset the connection under the answer.
const DRAIN_BYTES: usize = 64 * 1024;
const DRAIN_TIME: Duration = Duration::from_millis(250);

/// Who a token stands for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MetricsPrincipal {
    /// The principal's name.
    pub principal: String,
    /// Its scopes.
    pub scopes: Vec<String>,
}

/// The authorization port: a token to the principal it stands for, or `None` when it is unknown.
pub trait MetricsAccess: Send + Sync {
    /// Resolves `token`.
    fn authorize(&self, token: &str) -> Option<MetricsPrincipal>;
}

/// Renders the exposition.
pub type Render = Arc<dyn Fn() -> String + Send + Sync>;

/// What [`MetricsServer::new`] takes.
#[derive(Clone)]
pub struct MetricsServerOptions {
    /// The bearer token, at least 32 characters.
    pub token: String,
    /// TCP port; 0 picks a free one (tests).
    pub port: u16,
    /// Loopback address only; default `127.0.0.1`.
    pub host: Option<String>,
    /// The exposition.
    pub render: Render,
    /// Where the endpoint logs.
    pub logger: Arc<dyn MetricsLog>,
    /// The authorization port; default: the one token, with exactly `metrics.read`.
    pub access: Option<Arc<dyn MetricsAccess>>,
    /// The clock of the lockout; default the system clock.
    pub clock: Option<Clock>,
    /// How long a client may take to send its request head; default 5 s.
    pub headers_timeout: Option<Duration>,
}

/// Why the endpoint could not be built or started.
#[derive(Debug)]
pub enum MetricsHttpError {
    /// The host is not a loopback address.
    NotLoopback(String),
    /// The token is shorter than 32 characters.
    ShortToken,
    /// `listen` on an endpoint that is listening.
    AlreadyListening,
    /// The socket could not be bound or the accept thread not started.
    Io(io::Error),
}

impl fmt::Display for MetricsHttpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MetricsHttpError::NotLoopback(host) => write!(
                f,
                "metrics endpoint must bind a loopback address, not {}",
                Value::String(host.clone())
            ),
            MetricsHttpError::ShortToken => write!(
                f,
                "metrics token must be at least {MIN_TOKEN_CHARS} characters"
            ),
            MetricsHttpError::AlreadyListening => {
                write!(f, "metrics endpoint is already listening")
            }
            MetricsHttpError::Io(e) => write!(f, "metrics endpoint: {e}"),
        }
    }
}

impl std::error::Error for MetricsHttpError {}

impl From<io::Error> for MetricsHttpError {
    fn from(e: io::Error) -> Self {
        MetricsHttpError::Io(e)
    }
}

fn sha(text: &str) -> [u8; 32] {
    Sha256::digest(text.as_bytes()).into()
}

struct TokenAccess {
    digest: [u8; 32],
}

impl MetricsAccess for TokenAccess {
    fn authorize(&self, token: &str) -> Option<MetricsPrincipal> {
        constant_time_eq(&sha(token), &self.digest).then(|| MetricsPrincipal {
            principal: "metrics-reader".into(),
            scopes: vec![METRICS_SCOPE.into()],
        })
    }
}

/// A loopback address: `127.0.0.0/8`, its IPv4-mapped form, or `::1`.
fn is_loopback_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(a) => a.octets()[0] == 127,
        IpAddr::V6(a) => match a.to_ipv4_mapped() {
            Some(mapped) => mapped.octets()[0] == 127,
            None => a == Ipv6Addr::LOCALHOST,
        },
    }
}

/// The key a peer's failures are counted under: its address, an IPv4-mapped one as IPv4.
fn peer_key(ip: IpAddr) -> String {
    match ip {
        IpAddr::V6(a) => a
            .to_ipv4_mapped()
            .map_or_else(|| a.to_string(), |m| m.to_string()),
        IpAddr::V4(a) => a.to_string(),
    }
}

/// JavaScript's `\s` (also what `trim()` removes).
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// Host header → loopback name? `127.0.0.1[:p]`, `localhost[:p]`, `[::1][:p]`. The TypeScript check is the pattern
/// `^(\[[0-9a-fA-F:]+\]|[^:]+)(?::\d{1,5})?$` on the trimmed value, then a comparison of the lower-cased name.
fn loopback_host(header: Option<&str>) -> bool {
    let Some(header) = header else { return false };
    let host = header.trim_matches(is_js_space);
    let (name, port) = if host.starts_with('[') {
        match host.find(']') {
            Some(end) => host.split_at(end + 1),
            None => return false,
        }
    } else {
        match host.find(':') {
            Some(colon) => host.split_at(colon),
            None => (host, ""),
        }
    };
    let port_ok = match port.strip_prefix(':') {
        Some(digits) => {
            (1..=5).contains(&digits.len()) && digits.bytes().all(|b| b.is_ascii_digit())
        }
        None => port.is_empty(),
    };
    if !port_ok || name.is_empty() {
        return false;
    }
    let name = name.to_lowercase();
    name == "localhost"
        || name == "[::1]"
        || (name.starts_with("127.") && name.parse::<Ipv4Addr>().is_ok())
}

/// `/^Bearer ([^\s]+)$/` on the Authorization value.
fn bearer(value: Option<&str>) -> Option<&str> {
    let token = value?.strip_prefix("Bearer ")?;
    (!token.is_empty() && !token.chars().any(is_js_space)).then_some(token)
}

/// One request head, as far as the endpoint looks at it. Header values are the bytes of the line read as Latin-1, the
/// way Node hands them to the handler.
#[derive(Debug, PartialEq, Eq)]
struct Request {
    method: String,
    target: String,
    host: Option<String>,
    authorization: Option<String>,
}

struct Response {
    status: u16,
    body: &'static str,
    /// The exposition of a 200 (owned; every other body is fixed text).
    exposition: Option<String>,
    extra: Vec<(&'static str, String)>,
    head: bool,
}

impl Response {
    fn plain(status: u16, body: &'static str) -> Response {
        Response {
            status,
            body,
            exposition: None,
            extra: Vec::new(),
            head: false,
        }
    }

    fn with(mut self, name: &'static str, value: impl Into<String>) -> Response {
        self.extra.push((name, value.into()));
        self
    }

    fn body(&self) -> &str {
        self.exposition.as_deref().unwrap_or(self.body)
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        408 => "Request Timeout",
        429 => "Too Many Requests",
        431 => "Request Header Fields Too Large",
        _ => "Internal Server Error",
    }
}

fn is_token_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b)
}

fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|&b| char::from(b)).collect()
}

/// Parses a request head (everything before the empty line). The error is the status to answer with.
fn parse_head(head: &[u8]) -> Result<Request, u16> {
    // Every line but the last ends in CR LF; a bare LF, or a CR anywhere else, is refused.
    let newlines = head.iter().filter(|&&b| b == b'\n').count();
    let mut lines: Vec<&[u8]> = Vec::new();
    for (at, line) in head.split(|&b| b == b'\n').enumerate() {
        let line = if at < newlines {
            line.strip_suffix(b"\r").ok_or(400u16)?
        } else {
            line
        };
        if line.contains(&b'\r') {
            return Err(400);
        }
        lines.push(line);
    }
    let (request_line, headers) = lines.split_first().ok_or(400u16)?;
    let mut parts = request_line.split(|&b| b == b' ');
    let (method, target, version) = match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(m), Some(t), Some(v), None) => (m, t, v),
        _ => return Err(400),
    };
    if method.is_empty() || !method.iter().all(|&b| is_token_byte(b)) {
        return Err(400);
    }
    if target.is_empty() || !target.iter().all(|b| (0x21..=0x7e).contains(b)) {
        return Err(400);
    }
    if version != b"HTTP/1.1" && version != b"HTTP/1.0" {
        return Err(400);
    }
    if headers.len() > MAX_HEADERS {
        return Err(431);
    }
    let mut host = None;
    let mut authorization = None;
    for line in headers {
        let colon = line.iter().position(|&b| b == b':').ok_or(400u16)?;
        let (name, rest) = line.split_at(colon);
        // A name is a token: a line that starts with a space (a folded header) or has one before the colon is refused.
        if name.is_empty() || !name.iter().all(|&b| is_token_byte(b)) {
            return Err(400);
        }
        let value = rest.get(1..).unwrap_or_default();
        if value.iter().any(|&b| (b < 0x20 && b != b'\t') || b == 0x7f) {
            return Err(400);
        }
        let slot = if name.eq_ignore_ascii_case(b"host") {
            &mut host
        } else if name.eq_ignore_ascii_case(b"authorization") {
            &mut authorization
        } else {
            continue;
        };
        if slot.is_some() {
            return Err(400);
        }
        *slot = Some(latin1(value).trim_matches([' ', '\t']).to_string());
    }
    Ok(Request {
        method: latin1(method),
        target: latin1(target),
        host,
        authorization,
    })
}

#[derive(Default)]
struct Failures {
    times: Vec<i64>,
    locked_until: i64,
}

fn panic_text(payload: &(dyn Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|s| (*s).to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "panic".to_string())
}

fn fields(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// The request handler of `http.ts`, without the socket.
struct Handler {
    render: Render,
    logger: Arc<dyn MetricsLog>,
    access: Arc<dyn MetricsAccess>,
    clock: Clock,
    /// Failures per peer address (loopback has few of them).
    failures: Mutex<HashMap<String, Failures>>,
}

impl Handler {
    fn failures(&self) -> MutexGuard<'_, HashMap<String, Failures>> {
        self.failures.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn handle(&self, peer: IpAddr, request: &Request) -> Response {
        if !is_loopback_ip(peer) || !loopback_host(request.host.as_deref()) {
            return Response::plain(403, "forbidden\n");
        }
        let path = request.target.split('?').next().unwrap_or_default();
        if path != "/metrics" {
            return Response::plain(404, "not found\n");
        }
        let head = request.method == "HEAD";
        if request.method != "GET" && !head {
            return Response::plain(405, "method not allowed\n").with("allow", "GET, HEAD");
        }
        let now = (self.clock)();
        let key = peer_key(peer);
        // One critical section from the lockout check to the failure count, as one turn of the TypeScript event loop.
        let mut failures = self.failures();
        let locked_until = failures.get(&key).map_or(0, |f| f.locked_until);
        if locked_until > now {
            // Math.ceil((lockedUntil - now) / 1000)
            let retry = (locked_until - now + 999) / 1000;
            return Response::plain(429, "too many failed attempts\n")
                .with("retry-after", retry.to_string());
        }
        // The port is foreign code: a panic must not take the endpoint down, and its message is not logged (it may
        // carry the token).
        let granted = match bearer(request.authorization.as_deref()) {
            Some(token) => match catch_unwind(AssertUnwindSafe(|| self.access.authorize(token))) {
                Ok(granted) => granted,
                Err(_) => {
                    drop(failures);
                    self.logger.error(
                        "metrics authorization failed",
                        &fields(json!({ "err": "panic" })),
                    );
                    return Response::plain(500, "internal error\n");
                }
            },
            None => None,
        };
        let Some(granted) = granted else {
            if !failures.contains_key(&key) && failures.len() >= MAX_TRACKED_PEERS {
                // Peers that are neither locked nor inside their window make room first.
                failures.retain(|_, f| {
                    f.locked_until > now || f.times.iter().any(|t| now - t < FAILURE_WINDOW_MS)
                });
            }
            let mut locked = false;
            if failures.contains_key(&key) || failures.len() < MAX_TRACKED_PEERS {
                let entry = failures.entry(key).or_default();
                entry.times.retain(|t| now - t < FAILURE_WINDOW_MS);
                entry.times.push(now);
                if entry.times.len() >= MAX_FAILURES {
                    entry.locked_until = now + LOCKOUT_MS;
                    entry.times.clear();
                    locked = true;
                }
            }
            drop(failures);
            if locked {
                self.logger.warn(
                    "metrics endpoint locked after repeated failures",
                    &Map::new(),
                );
            }
            return Response::plain(401, "unauthorized\n")
                .with("www-authenticate", "Bearer realm=\"plur1bus-metrics\"");
        };
        failures.remove(&key);
        drop(failures);
        if !granted.scopes.iter().any(|s| s == METRICS_SCOPE) {
            return Response::plain(403, "forbidden\n");
        }
        match catch_unwind(AssertUnwindSafe(|| (self.render)())) {
            Ok(body) => Response {
                status: 200,
                body: "",
                exposition: Some(body),
                extra: Vec::new(),
                head,
            },
            Err(payload) => {
                self.logger.error(
                    "metrics render failed",
                    &fields(json!({ "err": panic_text(payload.as_ref()) })),
                );
                Response::plain(500, "internal error\n")
            }
        }
    }
}

/// An HTTP date (`Sun, 06 Nov 1994 08:49:37 GMT`) for seconds since the epoch.
fn http_date(secs: u64) -> String {
    const DAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let days = secs / 86_400;
    let in_day = secs % 86_400;
    // Howard Hinnant's civil_from_days, for days at or after the epoch.
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z % 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + u64::from(month <= 2);
    let weekday = usize::try_from(days % 7).ok().and_then(|d| DAYS.get(d));
    let month_name = usize::try_from(month - 1).ok().and_then(|m| MONTHS.get(m));
    format!(
        "{}, {day:02} {} {year:04} {:02}:{:02}:{:02} GMT",
        weekday.copied().unwrap_or("Thu"),
        month_name.copied().unwrap_or("Jan"),
        in_day / 3600,
        in_day / 60 % 60,
        in_day % 60
    )
}

fn serialize(response: &Response) -> Vec<u8> {
    let body = response.body();
    let content_type = if response.status == 200 {
        CONTENT_TYPE
    } else {
        "text/plain; charset=utf-8"
    };
    let mut out = format!(
        "HTTP/1.1 {} {}\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\ncache-control: no-store\r\nx-content-type-options: nosniff\r\n",
        response.status,
        reason(response.status),
        body.len()
    );
    for (name, value) in &response.extra {
        out.push_str(&format!("{name}: {value}\r\n"));
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    out.push_str(&format!(
        "date: {}\r\nconnection: close\r\n\r\n",
        http_date(now)
    ));
    if !response.head {
        out.push_str(body);
    }
    out.into_bytes()
}

enum HeadEnd {
    /// The client closed (or failed) before a complete head: nothing to answer.
    Closed,
    /// The head did not arrive in time.
    Timeout,
    /// The head is longer than [`MAX_HEAD_BYTES`].
    TooLarge,
}

/// Reads up to and including the empty line; returns the head without it.
fn read_head(stream: &mut TcpStream, deadline: Instant) -> Result<Vec<u8>, HeadEnd> {
    let mut head: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(HeadEnd::Timeout);
        }
        if stream.set_read_timeout(Some(left)).is_err() {
            return Err(HeadEnd::Closed);
        }
        let n = match stream.read(&mut chunk) {
            Ok(0) => return Err(HeadEnd::Closed),
            Ok(n) => n,
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                return Err(HeadEnd::Timeout)
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return Err(HeadEnd::Closed),
        };
        // The terminator may straddle two reads: look again from three bytes before the new data.
        let from = head.len().saturating_sub(3);
        head.extend_from_slice(chunk.get(..n).unwrap_or_default());
        let found = head
            .get(from..)
            .and_then(|tail| tail.windows(4).position(|w| w == b"\r\n\r\n"));
        if let Some(at) = found {
            head.truncate(from + at);
            return if head.len() > MAX_HEAD_BYTES {
                Err(HeadEnd::TooLarge)
            } else {
                Ok(head)
            };
        }
        if head.len() > MAX_HEAD_BYTES {
            return Err(HeadEnd::TooLarge);
        }
    }
}

/// Reads and discards what the client still sends, bounded in size and time, so the close after the answer is orderly.
fn drain(stream: &mut TcpStream) {
    let deadline = Instant::now() + DRAIN_TIME;
    let mut chunk = [0u8; 4096];
    let mut total = 0;
    while total < DRAIN_BYTES {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() || stream.set_read_timeout(Some(left)).is_err() {
            return;
        }
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => total += n,
        }
    }
}

struct Shared {
    handler: Handler,
    headers_timeout: Duration,
    active: AtomicUsize,
    next: AtomicU64,
    /// The connections being served, so `close` can end them.
    streams: Mutex<HashMap<u64, TcpStream>>,
}

impl Shared {
    fn streams(&self) -> MutexGuard<'_, HashMap<u64, TcpStream>> {
        self.streams.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn serve(&self, mut stream: TcpStream, peer: IpAddr) {
        let _ = stream.set_write_timeout(Some(WRITE_TIMEOUT));
        let response = match read_head(&mut stream, Instant::now() + self.headers_timeout) {
            Ok(head) => match parse_head(&head) {
                Ok(request) => self.handler.handle(peer, &request),
                Err(431) => Response::plain(431, "request header fields too large\n"),
                Err(_) => Response::plain(400, "bad request\n"),
            },
            Err(HeadEnd::TooLarge) => Response::plain(431, "request header fields too large\n"),
            Err(HeadEnd::Timeout) => Response::plain(408, "request timeout\n"),
            Err(HeadEnd::Closed) => return,
        };
        if stream.write_all(&serialize(&response)).is_ok() {
            let _ = stream.shutdown(Shutdown::Write);
            drain(&mut stream);
        }
    }

    fn accept(self: &Arc<Self>, stream: TcpStream) {
        let Ok(peer) = stream.peer_addr() else { return };
        if self.active.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
            self.active.fetch_sub(1, Ordering::SeqCst);
            return;
        }
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        if let Ok(copy) = stream.try_clone() {
            self.streams().insert(id, copy);
        }
        let shared = Arc::clone(self);
        let spawned = std::thread::Builder::new()
            .name("plur1bus-metrics-conn".into())
            .spawn(move || {
                // A panic in the handler's foreign code is caught there; this guards the bookkeeping against any other.
                let _ = catch_unwind(AssertUnwindSafe(|| shared.serve(stream, peer.ip())));
                shared.streams().remove(&id);
                shared.active.fetch_sub(1, Ordering::SeqCst);
            });
        if spawned.is_err() {
            self.streams().remove(&id);
            self.active.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

struct Running {
    addr: SocketAddr,
    thread: JoinHandle<()>,
    /// This run's own stop flag: a later `listen` can never clear it.
    stop: Arc<AtomicBool>,
}

/// The endpoint. [`listen`](Self::listen) starts it, [`close`](Self::close) ends it; dropping it closes it.
pub struct MetricsServer {
    shared: Arc<Shared>,
    host: IpAddr,
    port: u16,
    logger: Arc<dyn MetricsLog>,
    running: Mutex<Option<Running>>,
}

impl MetricsServer {
    /// Checks the host and the token; binds nothing yet.
    pub fn new(o: MetricsServerOptions) -> Result<MetricsServer, MetricsHttpError> {
        let MetricsServerOptions {
            token,
            port,
            host,
            render,
            logger,
            access,
            clock,
            headers_timeout,
        } = o;
        let host_text = host.unwrap_or_else(|| "127.0.0.1".to_string());
        let host = host_text
            .parse::<IpAddr>()
            .ok()
            .filter(|ip| is_loopback_ip(*ip))
            .ok_or(MetricsHttpError::NotLoopback(host_text))?;
        if token.encode_utf16().count() < MIN_TOKEN_CHARS {
            return Err(MetricsHttpError::ShortToken);
        }
        let access = access.unwrap_or_else(|| {
            Arc::new(TokenAccess {
                digest: sha(&token),
            })
        });
        Ok(MetricsServer {
            shared: Arc::new(Shared {
                handler: Handler {
                    render,
                    logger: logger.clone(),
                    access,
                    clock: clock.unwrap_or_else(system_clock),
                    failures: Mutex::new(HashMap::new()),
                },
                headers_timeout: headers_timeout.unwrap_or(HEADERS_TIMEOUT),
                active: AtomicUsize::new(0),
                next: AtomicU64::new(0),
                streams: Mutex::new(HashMap::new()),
            }),
            host,
            port,
            logger,
            running: Mutex::new(None),
        })
    }

    fn running(&self) -> MutexGuard<'_, Option<Running>> {
        self.running.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Binds the socket and starts accepting; returns the bound address (the port chosen when the option was 0).
    pub fn listen(&self) -> Result<SocketAddr, MetricsHttpError> {
        let mut running = self.running();
        if running.is_some() {
            return Err(MetricsHttpError::AlreadyListening);
        }
        let listener = TcpListener::bind((self.host, self.port))?;
        let addr = listener.local_addr()?;
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = Arc::clone(&stop);
        let shared = Arc::clone(&self.shared);
        let thread = std::thread::Builder::new()
            .name("plur1bus-metrics".into())
            .spawn(move || {
                for connection in listener.incoming() {
                    if stopped.load(Ordering::SeqCst) {
                        break;
                    }
                    match connection {
                        Ok(stream) => shared.accept(stream),
                        // Out of descriptors or a reset in the queue: do not spin on it.
                        Err(_) => std::thread::sleep(Duration::from_millis(50)),
                    }
                }
            })?;
        *running = Some(Running { addr, thread, stop });
        self.logger.info(
            "metrics endpoint listening",
            &fields(json!({ "host": self.host.to_string(), "port": addr.port() })),
        );
        Ok(addr)
    }

    /// Stops accepting and ends every connection. Idempotent.
    pub fn close(&self) {
        let Some(running) = self.running().take() else {
            return;
        };
        running.stop.store(true, Ordering::SeqCst);
        // The accept loop blocks in `accept`; one connection of our own wakes it to see its flag. Should every attempt
        // fail (a full backlog), the thread is not waited for: it ends at the next connection it accepts, whatever
        // `listen` does meanwhile, because the flag is this run's own.
        let woken = (0..3)
            .any(|_| TcpStream::connect_timeout(&running.addr, Duration::from_secs(1)).is_ok());
        if woken {
            let _ = running.thread.join();
        }
        for (_, stream) in self.shared.streams().drain() {
            let _ = stream.shutdown(Shutdown::Both);
        }
    }
}

impl Drop for MetricsServer {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicI64;

    const TOKEN: &str = "tttttttttttttttttttttttttttttttttttttttttttttttt";
    const EXPOSITION: &str = "# HELP a b\n# TYPE a gauge\na 1\n";

    #[derive(Default)]
    struct Log(Mutex<Vec<String>>);

    impl Log {
        fn lines(&self) -> Vec<String> {
            self.0.lock().unwrap().clone()
        }
    }

    impl MetricsLog for Log {
        fn info(&self, message: &str, _: &Map<String, Value>) {
            self.0.lock().unwrap().push(format!("info {message}"));
        }
        fn warn(&self, message: &str, _: &Map<String, Value>) {
            self.0.lock().unwrap().push(format!("warn {message}"));
        }
        fn error(&self, message: &str, fields: &Map<String, Value>) {
            self.0
                .lock()
                .unwrap()
                .push(format!("error {message} {}", Value::Object(fields.clone())));
        }
    }

    struct Answer {
        status: u16,
        headers: HashMap<String, String>,
        body: String,
    }

    /// Sends `raw`, half-closes, and reads the answer; `None` when the server closed without one.
    fn exchange(addr: SocketAddr, raw: &[u8]) -> Option<Answer> {
        let mut stream = TcpStream::connect(addr).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        stream.write_all(raw).unwrap();
        stream.shutdown(Shutdown::Write).unwrap();
        let mut text = String::new();
        stream.read_to_string(&mut text).unwrap();
        if text.is_empty() {
            return None;
        }
        let (head, body) = text.split_once("\r\n\r\n").unwrap();
        let mut lines = head.split("\r\n");
        let status = lines
            .next()
            .unwrap()
            .split(' ')
            .nth(1)
            .unwrap()
            .parse()
            .unwrap();
        let headers = lines
            .map(|l| {
                let (k, v) = l.split_once(": ").unwrap();
                (k.to_string(), v.to_string())
            })
            .collect();
        Some(Answer {
            status,
            headers,
            body: body.to_string(),
        })
    }

    struct Get<'a> {
        method: &'a str,
        path: &'a str,
        host: Option<&'a str>,
        authorization: Option<String>,
    }

    impl Default for Get<'_> {
        fn default() -> Self {
            Get {
                method: "GET",
                path: "/metrics",
                host: None,
                authorization: None,
            }
        }
    }

    fn get(addr: SocketAddr, g: &Get<'_>) -> Answer {
        let host = g
            .host
            .map_or_else(|| format!("127.0.0.1:{}", addr.port()), str::to_string);
        let mut raw = format!("{} {} HTTP/1.1\r\nHost: {host}\r\n", g.method, g.path);
        if let Some(a) = &g.authorization {
            raw.push_str(&format!("Authorization: {a}\r\n"));
        }
        raw.push_str("\r\n");
        exchange(addr, raw.as_bytes()).unwrap()
    }

    fn auth() -> Get<'static> {
        Get {
            authorization: Some(format!("Bearer {TOKEN}")),
            ..Get::default()
        }
    }

    fn bad() -> Get<'static> {
        Get {
            authorization: Some("Bearer bad".into()),
            ..Get::default()
        }
    }

    struct Fixture {
        server: MetricsServer,
        addr: SocketAddr,
        now: Arc<AtomicI64>,
        log: Arc<Log>,
    }

    fn fixture(change: impl FnOnce(&mut MetricsServerOptions)) -> Fixture {
        let now = Arc::new(AtomicI64::new(1_000_000));
        let log = Arc::new(Log::default());
        let clock = now.clone();
        let mut options = MetricsServerOptions {
            token: TOKEN.into(),
            port: 0,
            host: None,
            render: Arc::new(|| EXPOSITION.to_string()),
            logger: log.clone(),
            access: None,
            clock: Some(Arc::new(move || clock.load(Ordering::SeqCst))),
            headers_timeout: None,
        };
        change(&mut options);
        let server = MetricsServer::new(options).unwrap();
        let addr = server.listen().unwrap();
        Fixture {
            server,
            addr,
            now,
            log,
        }
    }

    #[test]
    fn serves_the_exposition_for_a_valid_bearer_token() {
        let f = fixture(|_| {});
        let r = get(f.addr, &auth());
        assert_eq!(r.status, 200);
        assert_eq!(
            r.headers["content-type"],
            "text/plain; version=0.0.4; charset=utf-8"
        );
        assert_eq!(r.headers["cache-control"], "no-store");
        assert_eq!(r.headers["x-content-type-options"], "nosniff");
        assert_eq!(r.headers["content-length"], EXPOSITION.len().to_string());
        assert_eq!(r.headers["connection"], "close");
        assert_eq!(r.body, EXPOSITION);
        assert_eq!(f.log.lines(), ["info metrics endpoint listening"]);
    }

    #[test]
    fn answers_401_without_or_with_a_wrong_token_and_never_echoes_a_token() {
        let f = fixture(|_| {});
        for authorization in [
            None,
            Some("Bearer nope".to_string()),
            Some(format!("Basic {TOKEN}")),
            Some(TOKEN.to_string()),
            Some(format!("bearer {TOKEN}")),
            Some(format!("Bearer  {TOKEN}")),
            Some(format!("Bearer {TOKEN} x")),
        ] {
            let r = get(
                f.addr,
                &Get {
                    authorization,
                    ..Get::default()
                },
            );
            assert_eq!(r.status, 401);
            assert!(r.headers["www-authenticate"].starts_with("Bearer"));
            assert_eq!(r.headers["content-type"], "text/plain; charset=utf-8");
            assert_eq!(r.body, "unauthorized\n");
        }
    }

    #[test]
    fn does_not_accept_the_token_in_the_query_string() {
        let f = fixture(|_| {});
        let path = format!("/metrics?token={TOKEN}");
        let r = get(
            f.addr,
            &Get {
                path: &path,
                ..Get::default()
            },
        );
        assert_eq!(r.status, 401);
    }

    #[test]
    fn is_read_only_only_get_and_head_only_metrics() {
        let f = fixture(|_| {});
        for method in ["POST", "PUT", "DELETE", "PATCH"] {
            let r = get(f.addr, &Get { method, ..auth() });
            assert_eq!(r.status, 405);
            assert_eq!(r.headers["allow"], "GET, HEAD");
        }
        let at = |path: &str| get(f.addr, &Get { path, ..auth() }).status;
        assert_eq!(at("/"), 404);
        assert_eq!(at("/metrics/extra"), 404);
        assert_eq!(at("/metrics?x=1"), 200);
        let head = get(
            f.addr,
            &Get {
                method: "HEAD",
                ..auth()
            },
        );
        assert_eq!(head.status, 200);
        assert_eq!(head.body, "");
        assert_eq!(head.headers["content-length"], EXPOSITION.len().to_string());
    }

    #[test]
    fn a_post_is_refused_without_reading_its_body() {
        let f = fixture(|_| {});
        let raw = format!(
            "POST /metrics HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {TOKEN}\r\nContent-Length: 5\r\n\r\nhello"
        );
        assert_eq!(exchange(f.addr, raw.as_bytes()).unwrap().status, 405);
    }

    #[test]
    fn refuses_a_non_loopback_host_header() {
        let f = fixture(|_| {});
        let evil = get(
            f.addr,
            &Get {
                host: Some("evil.example"),
                ..auth()
            },
        );
        assert_eq!((evil.status, evil.body.as_str()), (403, "forbidden\n"));
        let local = format!("localhost:{}", f.addr.port());
        let named = get(
            f.addr,
            &Get {
                host: Some(&local),
                ..auth()
            },
        );
        assert_eq!(named.status, 200);
        // No Host header at all.
        let raw = format!("GET /metrics HTTP/1.1\r\nAuthorization: Bearer {TOKEN}\r\n\r\n");
        assert_eq!(exchange(f.addr, raw.as_bytes()).unwrap().status, 403);
    }

    #[test]
    fn locks_out_a_client_after_repeated_failures_then_recovers() {
        let f = fixture(|_| {});
        for _ in 0..10 {
            assert_eq!(get(f.addr, &bad()).status, 401);
        }
        let locked = get(f.addr, &auth());
        assert_eq!(locked.status, 429);
        assert_eq!(locked.headers["retry-after"], "60");
        assert_eq!(locked.body, "too many failed attempts\n");
        assert!(f
            .log
            .lines()
            .contains(&"warn metrics endpoint locked after repeated failures".to_string()));
        f.now.fetch_add(59_001, Ordering::SeqCst);
        assert_eq!(get(f.addr, &auth()).headers["retry-after"], "1");
        f.now.fetch_add(120_000, Ordering::SeqCst);
        assert_eq!(get(f.addr, &auth()).status, 200);
    }

    #[test]
    fn failures_outside_the_window_do_not_add_up_and_a_success_clears_them() {
        let f = fixture(|_| {});
        for _ in 0..9 {
            get(f.addr, &bad());
        }
        f.now.fetch_add(60_000, Ordering::SeqCst);
        assert_eq!(get(f.addr, &bad()).status, 401);
        assert_eq!(get(f.addr, &auth()).status, 200);
        for _ in 0..9 {
            get(f.addr, &bad());
        }
        assert_eq!(get(f.addr, &auth()).status, 200);
    }

    struct Scoped {
        calls: Mutex<Vec<String>>,
        scopes: Vec<String>,
        fails: bool,
    }

    impl MetricsAccess for Scoped {
        fn authorize(&self, token: &str) -> Option<MetricsPrincipal> {
            self.calls.lock().unwrap().push(token.to_string());
            assert!(!self.fails, "port failure");
            (token == TOKEN).then(|| MetricsPrincipal {
                principal: "reader".into(),
                scopes: self.scopes.clone(),
            })
        }
    }

    #[test]
    fn requires_the_metrics_read_scope_from_the_access_port() {
        let access = Arc::new(Scoped {
            calls: Mutex::default(),
            scopes: vec!["something.else".into()],
            fails: false,
        });
        let port = access.clone();
        let f = fixture(move |o| o.access = Some(port));
        assert_eq!(get(f.addr, &auth()).status, 403);
        assert_eq!(*access.calls.lock().unwrap(), [TOKEN]);
    }

    #[test]
    fn a_failing_port_or_render_is_a_500_and_the_endpoint_keeps_serving() {
        let access = Arc::new(Scoped {
            calls: Mutex::default(),
            scopes: vec![],
            fails: true,
        });
        let f = fixture(move |o| o.access = Some(access));
        let r = get(f.addr, &auth());
        assert_eq!((r.status, r.body.as_str()), (500, "internal error\n"));
        assert!(f.log.lines()[1].starts_with("error metrics authorization failed"));

        let f = fixture(|o| o.render = Arc::new(|| unreachable!("render failure")));
        assert_eq!(get(f.addr, &auth()).status, 500);
        assert_eq!(get(f.addr, &auth()).status, 500);
        assert!(f.log.lines()[1].starts_with("error metrics render failed"));
    }

    fn options(host: Option<&str>, token: &str) -> MetricsServerOptions {
        MetricsServerOptions {
            token: token.into(),
            port: 0,
            host: host.map(str::to_string),
            render: Arc::new(String::new),
            logger: Arc::new(Log::default()),
            access: None,
            clock: None,
            headers_timeout: None,
        }
    }

    fn refusal(host: Option<&str>, token: &str) -> String {
        MetricsServer::new(options(host, token))
            .err()
            .map(|e| e.to_string())
            .unwrap_or_default()
    }

    #[test]
    fn refuses_to_bind_a_non_loopback_address() {
        for host in ["0.0.0.0", "::", "192.168.1.5", "example.com"] {
            assert!(refusal(Some(host), TOKEN).contains("loopback"), "{host}");
        }
        assert_eq!(
            refusal(Some("example.com"), TOKEN),
            "metrics endpoint must bind a loopback address, not \"example.com\""
        );
        assert_eq!(refusal(Some("127.0.0.2"), TOKEN), "");
        assert_eq!(refusal(Some("::1"), TOKEN), "");
    }

    #[test]
    fn refuses_a_short_token() {
        assert_eq!(
            refusal(None, "short"),
            "metrics token must be at least 32 characters"
        );
        assert_ne!(refusal(None, &"t".repeat(31)), "");
        assert_eq!(refusal(None, &"t".repeat(32)), "");
    }

    #[test]
    fn listens_once_and_again_after_close() {
        let f = fixture(|_| {});
        assert!(matches!(
            f.server.listen(),
            Err(MetricsHttpError::AlreadyListening)
        ));
        f.server.close();
        f.server.close();
        let again = f.server.listen().unwrap();
        assert_eq!(get(again, &auth()).status, 200);
    }

    #[test]
    fn a_malformed_or_oversized_head_is_refused() {
        let f = fixture(|_| {});
        let ok = format!("Host: localhost\r\nAuthorization: Bearer {TOKEN}\r\n");
        let status = |raw: String| exchange(f.addr, raw.as_bytes()).map(|a| a.status);
        let line = "GET /metrics HTTP/1.1\r\n";
        assert_eq!(status(format!("{line}{ok}\r\n")), Some(200));
        // a bare LF
        assert_eq!(
            status(format!("GET /metrics HTTP/1.1\n{ok}\r\n")),
            Some(400)
        );
        // a second Authorization or Host line
        assert_eq!(
            status(format!("{line}{ok}Authorization: Bearer x\r\n\r\n")),
            Some(400)
        );
        assert_eq!(
            status(format!("{line}{ok}host: evil.example\r\n\r\n")),
            Some(400)
        );
        // a folded line, a space before the colon, no colon
        assert_eq!(status(format!("{line}{ok} folded\r\n\r\n")), Some(400));
        assert_eq!(status(format!("{line}Host : localhost\r\n\r\n")), Some(400));
        assert_eq!(status(format!("{line}{ok}nocolon\r\n\r\n")), Some(400));
        // the request line
        assert_eq!(
            status(format!("GET  /metrics HTTP/1.1\r\n{ok}\r\n")),
            Some(400)
        );
        assert_eq!(
            status(format!("GET /metrics HTTP/2.0\r\n{ok}\r\n")),
            Some(400)
        );
        assert_eq!(status(format!("GET /metrics\r\n{ok}\r\n")), Some(400));
        assert_eq!(status("\r\n\r\n".to_string()), Some(400));
        // a control character in a value
        assert_eq!(status(format!("{line}{ok}X-A: a\u{0}b\r\n\r\n")), Some(400));
        // too many header lines, too many bytes
        let many = "X-A: 1\r\n".repeat(MAX_HEADERS - 1);
        assert_eq!(status(format!("{line}{ok}{many}\r\n")), Some(431));
        let fits = "X-A: 1\r\n".repeat(MAX_HEADERS - 2);
        assert_eq!(status(format!("{line}{ok}{fits}\r\n")), Some(200));
        let long = "a".repeat(MAX_HEAD_BYTES);
        assert_eq!(status(format!("{line}{ok}X-A: {long}\r\n\r\n")), Some(431));
        // a client that connects and leaves gets no answer
        assert_eq!(status(String::new()), None);
    }

    #[test]
    fn a_head_that_does_not_arrive_in_time_is_a_408() {
        let f = fixture(|o| o.headers_timeout = Some(Duration::from_millis(150)));
        let mut stream = TcpStream::connect(f.addr).unwrap();
        stream
            .write_all(b"GET /metrics HTTP/1.1\r\nHost: localhost\r\n")
            .unwrap();
        let mut text = String::new();
        stream.read_to_string(&mut text).unwrap();
        assert!(
            text.starts_with("HTTP/1.1 408 Request Timeout\r\n"),
            "{text}"
        );
    }

    #[test]
    fn the_head_may_arrive_in_pieces() {
        let f = fixture(|_| {});
        let raw = format!(
            "GET /metrics HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {TOKEN}\r\n\r\n"
        );
        let mut stream = TcpStream::connect(f.addr).unwrap();
        stream.set_nodelay(true).unwrap();
        let (a, b) = raw.as_bytes().split_at(raw.len() - 2);
        stream.write_all(a).unwrap();
        std::thread::sleep(Duration::from_millis(30));
        stream.write_all(b).unwrap();
        let mut text = String::new();
        stream.read_to_string(&mut text).unwrap();
        assert!(text.starts_with("HTTP/1.1 200 OK\r\n"), "{text}");
    }

    #[test]
    fn loopback_host_follows_the_typescript_pattern() {
        for ok in [
            "127.0.0.1",
            "127.0.0.1:9100",
            "127.9.8.7:1",
            "localhost",
            "LOCALHOST:65535",
            "[::1]",
            "[::1]:80",
            " localhost ",
        ] {
            assert!(loopback_host(Some(ok)), "{ok}");
        }
        for no in [
            "",
            "evil.example",
            "localhost:",
            "localhost:123456",
            "localhost:12a",
            "localhost:1:2",
            "127.0.0.1.evil.example",
            "127.1",
            "127.0.0.01",
            "128.0.0.1",
            "[::1",
            "[::1]x",
            "[0:0:0:0:0:0:0:1]",
            "[::ffff:127.0.0.1]",
            "::1",
            ":80",
        ] {
            assert!(!loopback_host(Some(no)), "{no}");
        }
        assert!(!loopback_host(None));
    }

    #[test]
    fn bearer_follows_the_typescript_pattern() {
        assert_eq!(bearer(Some("Bearer abc")), Some("abc"));
        assert_eq!(bearer(Some("Bearer a\u{e9}")), Some("a\u{e9}"));
        for no in [
            "",
            "Bearer",
            "Bearer ",
            "Bearer  abc",
            "Bearer abc ",
            "Bearer a b",
            "Bearer a\u{a0}b",
            "bearer abc",
            " Bearer abc",
            "Basic abc",
        ] {
            assert_eq!(bearer(Some(no)), None, "{no:?}");
        }
        assert_eq!(bearer(None), None);
    }

    #[test]
    fn loopback_addresses() {
        for ok in ["127.0.0.1", "127.255.0.3", "::1", "::ffff:127.0.0.1"] {
            assert!(is_loopback_ip(ok.parse().unwrap()), "{ok}");
        }
        for no in ["0.0.0.0", "10.0.0.1", "::", "::ffff:10.0.0.1", "fe80::1"] {
            assert!(!is_loopback_ip(no.parse().unwrap()), "{no}");
        }
        assert_eq!(peer_key("::ffff:127.0.0.1".parse().unwrap()), "127.0.0.1");
    }

    #[test]
    fn the_table_of_failing_peers_is_bounded() {
        let f = fixture(|_| {});
        let handler = &f.server.shared.handler;
        let request = Request {
            method: "GET".into(),
            target: "/metrics".into(),
            host: Some("localhost".into()),
            authorization: Some("Bearer bad".into()),
        };
        let peer = |n: usize| {
            IpAddr::V4(Ipv4Addr::new(
                127,
                1,
                u8::try_from(n / 256).unwrap(),
                u8::try_from(n % 256).unwrap(),
            ))
        };
        for n in 0..(MAX_TRACKED_PEERS + 50) {
            assert_eq!(handler.handle(peer(n), &request).status, 401);
        }
        assert_eq!(handler.failures().len(), MAX_TRACKED_PEERS);
        // A tracked peer is still counted and locked out; an untracked one never is.
        let (tracked, untracked) = (peer(0), peer(MAX_TRACKED_PEERS + 49));
        for _ in 0..MAX_FAILURES {
            handler.handle(tracked, &request);
            handler.handle(untracked, &request);
        }
        assert_eq!(handler.handle(tracked, &request).status, 429);
        assert_eq!(handler.handle(untracked, &request).status, 401);
    }

    fn request(target: &str, host: Option<&str>, authorization: Option<&str>) -> Request {
        Request {
            method: "GET".into(),
            target: target.into(),
            host: host.map(str::to_string),
            authorization: authorization.map(str::to_string),
        }
    }

    #[test]
    fn a_peer_that_is_not_loopback_is_refused_whatever_it_sends() {
        let f = fixture(|_| {});
        let handler = &f.server.shared.handler;
        let good = request(
            "/metrics",
            Some("localhost"),
            Some(&format!("Bearer {TOKEN}")),
        );
        for peer in [
            "10.0.0.1",
            "192.168.1.5",
            "::ffff:10.0.0.1",
            "fe80::1",
            "::",
        ] {
            let answer = handler.handle(peer.parse().unwrap(), &good);
            assert_eq!(
                (answer.status, answer.body()),
                (403, "forbidden\n"),
                "{peer}"
            );
        }
        for peer in ["127.0.0.1", "127.8.9.1", "::1", "::ffff:127.0.0.1"] {
            assert_eq!(
                handler.handle(peer.parse().unwrap(), &good).status,
                200,
                "{peer}"
            );
        }
    }

    #[test]
    fn the_checks_run_in_the_order_of_the_typescript_handler() {
        let f = fixture(|_| {});
        let handler = &f.server.shared.handler;
        let local: IpAddr = "127.0.0.1".parse().unwrap();
        // a foreign Host is refused before the path is looked at
        let foreign = request("/", Some("evil.example"), None);
        assert_eq!(handler.handle(local, &foreign).status, 403);
        // the path before the method, the method before the lockout
        let mut post = request("/other", Some("localhost"), None);
        post.method = "POST".into();
        assert_eq!(handler.handle(local, &post).status, 404);
        post.target = "/metrics".into();
        assert_eq!(handler.handle(local, &post).status, 405);
        // a locked-out peer is told so before its credentials are looked at, with or without them
        let bad = request("/metrics", Some("localhost"), Some("Bearer bad"));
        for _ in 0..MAX_FAILURES {
            assert_eq!(handler.handle(local, &bad).status, 401);
        }
        let none = request("/metrics", Some("localhost"), None);
        assert_eq!(handler.handle(local, &none).status, 429);
        assert_eq!(handler.handle(local, &post).status, 405);
    }

    #[test]
    fn a_full_table_drops_peers_that_are_neither_locked_nor_inside_their_window() {
        let f = fixture(|_| {});
        let handler = &f.server.shared.handler;
        let bad = request("/metrics", Some("localhost"), Some("Bearer bad"));
        let peer = |n: usize| {
            IpAddr::V4(Ipv4Addr::new(
                127,
                2,
                u8::try_from(n / 256).unwrap(),
                u8::try_from(n % 256).unwrap(),
            ))
        };
        // One peer locks itself out, the others fail once.
        for _ in 0..MAX_FAILURES {
            handler.handle(peer(0), &bad);
        }
        for n in 1..MAX_TRACKED_PEERS {
            handler.handle(peer(n), &bad);
        }
        assert_eq!(handler.failures().len(), MAX_TRACKED_PEERS);
        // Inside the window nothing is dropped: a new peer goes untracked.
        handler.handle(peer(5000), &bad);
        assert_eq!(handler.failures().len(), MAX_TRACKED_PEERS);
        assert!(!handler.failures().contains_key(&peer_key(peer(5000))));
        // After the window the single failures are forgotten, and so is the lock once it has run out.
        f.now.fetch_add(FAILURE_WINDOW_MS - 1, Ordering::SeqCst);
        handler.handle(peer(0), &bad); // refreshes nothing: it is locked
        f.now.fetch_add(2, Ordering::SeqCst);
        handler.handle(peer(5000), &bad);
        let failures = handler.failures();
        assert!(failures.contains_key(&peer_key(peer(5000))));
        assert_eq!(
            failures.len(),
            1,
            "only the new peer: the lock of peer 0 ran out with the window"
        );
    }

    #[test]
    fn a_panic_of_the_access_port_is_logged_without_its_message() {
        struct Leaky;
        impl MetricsAccess for Leaky {
            fn authorize(&self, token: &str) -> Option<MetricsPrincipal> {
                unreachable!("unknown token {token}")
            }
        }
        let f = fixture(|o| o.access = Some(Arc::new(Leaky)));
        assert_eq!(get(f.addr, &auth()).status, 500);
        let lines = f.log.lines();
        assert_eq!(
            lines[1],
            "error metrics authorization failed {\"err\":\"panic\"}"
        );
        assert!(lines.iter().all(|l| !l.contains(TOKEN)));
        // The failure table is usable afterwards (its lock was held across the port).
        assert_eq!(get(f.addr, &bad()).status, 500);
    }

    #[test]
    fn close_and_listen_from_two_threads_never_leave_a_run_behind() {
        let f = fixture(|_| {});
        let server = Arc::new(f.server);
        for _ in 0..20 {
            let closer = {
                let server = Arc::clone(&server);
                std::thread::spawn(move || server.close())
            };
            let _ = server.listen();
            closer.join().unwrap();
            // Whatever the interleaving was: after a close the endpoint can be started and stopped again.
            server.close();
            let addr = server.listen().unwrap();
            assert_eq!(get(addr, &auth()).status, 200);
        }
        server.close();
    }

    #[test]
    fn http_dates() {
        assert_eq!(http_date(784_111_777), "Sun, 06 Nov 1994 08:49:37 GMT");
        assert_eq!(http_date(0), "Thu, 01 Jan 1970 00:00:00 GMT");
        assert_eq!(http_date(1_709_164_800), "Thu, 29 Feb 2024 00:00:00 GMT");
    }
}
