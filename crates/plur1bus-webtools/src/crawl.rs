//! Admit the first page and each redirect using the host's robots cache and pacer.

use std::{
    net::SocketAddr,
    sync::Arc,
    time::{Duration, Instant},
};

use ureq::http::{header, HeaderMap};
use url::Url;

use crate::{
    http::{self, Admission, Failure, Options},
    pacer::{Clock, Pacer},
    robots::{Robots, MAX_BYTES},
    text::decode_body,
};

const CACHE_TTL_MS: u64 = 24 * 60 * 60 * 1000;

pub trait RobotsCache {
    /// Expired entries are unusable, even if the previous policy was permissive.
    fn get(&self, origin: &str, now_ms: u64) -> Option<Arc<Robots>>;

    /// Replace the origin's policy with a complete, freshly admitted response.
    fn put(&self, origin: &str, robots: Arc<Robots>, expires_at_ms: u64);
}

pub struct Crawl<'a> {
    pub egress: &'a dyn Admission,
    pub clock: &'a dyn Clock,
    pub robots: &'a dyn RobotsCache,
    pub pace: &'a Pacer,
    pub agent: &'a str,
    pub max_redirects: usize,
    pub aborted: &'a dyn Fn() -> bool,
}

impl Crawl<'_> {
    fn policy(&self, url: &Url, deadline: Instant) -> Result<Arc<Robots>, Failure> {
        let origin = url.origin().ascii_serialization();
        let now = self.clock.now_ms();
        if let Some(cached) = self.robots.get(&origin, now) {
            return Ok(cached);
        }
        let headers = HeaderMap::new();
        let robots_deadline = deadline.min(Instant::now() + Duration::from_secs(5));
        let mut options = Options::get(
            &headers,
            self.agent,
            "text/plain,*/*;q=0.1",
            robots_deadline,
        );
        options.max_bytes = MAX_BYTES;
        options.max_redirects = self.max_redirects;
        options.accept_type = Some(&|content| {
            content.is_none_or(|value| value.to_ascii_lowercase().starts_with("text/"))
        });
        let response = match http::request(
            &format!("{origin}/robots.txt"),
            &options,
            self.egress,
            self.aborted,
        ) {
            Ok(response) => response,
            Err(error @ (Failure::PrivateAddress | Failure::EgressDenied)) => return Err(error),
            Err(_) if (self.aborted)() || Instant::now() >= deadline => {
                return Err(Failure::Timeout)
            }
            Err(_) => return Err(Failure::RobotsDisallowed),
        };
        let text = match response.status {
            200..=299 => {
                let content = response
                    .headers
                    .get(header::CONTENT_TYPE)
                    .and_then(|value| value.to_str().ok());
                decode_body(&response.body, content)
            }
            400..=499 => String::new(),
            _ => return Err(Failure::RobotsDisallowed),
        };
        let policy = Arc::new(Robots::parse(&text).map_err(|_| Failure::RobotsDisallowed)?);
        self.robots.put(
            &origin,
            Arc::clone(&policy),
            self.clock.now_ms().saturating_add(CACHE_TTL_MS),
        );
        Ok(policy)
    }

    pub fn station(&self, url: &Url, deadline: Instant) -> Result<(), Failure> {
        let cancelled = || (self.aborted)() || Instant::now() >= deadline;
        if cancelled() {
            return Err(Failure::Timeout);
        }
        let policy = self.policy(url, deadline)?;
        let path = url.query().map_or_else(
            || url.path().to_owned(),
            |query| format!("{}?{query}", url.path()),
        );
        if !policy.allows(self.agent, &path) {
            return Err(Failure::RobotsDisallowed);
        }
        let host = url[url::Position::BeforeHost..url::Position::AfterPort].to_owned();
        let delay_ms =
            (policy.crawl_delay_seconds(self.agent).unwrap_or(0.0) * 1000.0).ceil() as u64;
        self.pace
            .wait(&host, delay_ms, self.clock, &cancelled)
            .map_err(|_| Failure::Timeout)?;
        if cancelled() {
            return Err(Failure::Timeout);
        }
        Ok(())
    }
}

impl Admission for Crawl<'_> {
    fn pin(&self, target: &Url, deadline: Instant) -> Result<SocketAddr, Failure> {
        self.egress.pin(target, deadline)
    }

    fn before_redirect(&self, target: &Url, deadline: Instant) -> Result<(), Failure> {
        self.egress.before_redirect(target, deadline)?;
        self.station(target, deadline)
    }
}
