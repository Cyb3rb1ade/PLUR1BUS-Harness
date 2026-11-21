//! `openai-auth/loopback.ts`: the one-shot loopback listener of the plan login, as a [`PkcePort`]. It binds 127.0.0.1 only
//! (never a wildcard, `localhost` or IPv6), through the [`LoopbackListener`] port of the auth package. It is ended only by a
//! callback that carries the exact `state` of the authorize URL it was given (SHA-256 of both sides, compared in constant
//! time); a request with another method, a foreign `Host`, a foreign `Origin`, an unexpected `Sec-Fetch-Site` or another path
//! gets a bare 404; any other request to the callback path a constant 400, and more than ten of those within a one-second
//! window a bare 429. The plan re-checks `state`, nonce and PKCE.
use super::super::login::{CallbackRequest, CallbackResponse, Incoming, LoopbackListener};
use super::super::ports::Clock;
use super::super::secret::{digest_equal, Secret};
use super::ports::{fail, OpenAIError, PkcePort};

/// Forged callbacks answered with 400 per window before 429.
pub const FORGED_PER_WINDOW: u32 = 10;
/// The window.
pub const FORGED_WINDOW_MS: f64 = 1000.0;

const HEADERS: [(&str, &str); 3] = [
    ("cache-control", "no-store"),
    ("referrer-policy", "no-referrer"),
    ("content-security-policy", "default-src 'none'"),
];

fn respond(status: u16, body: &'static str, retry: bool) -> CallbackResponse {
    let mut headers = HEADERS.to_vec();
    if retry {
        headers.push(("retry-after", "1"));
    }
    CallbackResponse {
        status,
        headers,
        body,
    }
}

/// The handler's state for one authorize.
pub struct PlanGate {
    redirect: url::Url,
    expected: Secret,
    consumed: bool,
    window_start: f64,
    forged: u32,
}

/// What the handler decided.
pub enum PlanJudged {
    /// Answer and keep listening.
    Refused(CallbackResponse),
    /// The genuine callback: answer, and hand its URL to the plan.
    Genuine(CallbackResponse, String),
}

impl PlanGate {
    /// A gate for `redirect` and the authorize URL's `state`.
    pub fn new(redirect: &str, state: Secret) -> Option<PlanGate> {
        Some(PlanGate {
            redirect: url::Url::parse(redirect).ok()?,
            expected: state,
            consumed: false,
            window_start: 0.0,
            forged: 0,
        })
    }

    /// The handler for one request at `now`.
    pub fn judge(&mut self, req: &CallbackRequest, now: f64) -> PlanJudged {
        let host = match self.redirect.port() {
            Some(p) => format!("{}:{p}", self.redirect.host_str().unwrap_or("")),
            None => self.redirect.host_str().unwrap_or("").to_owned(),
        };
        let origin = self.redirect.origin().ascii_serialization();
        let url = self.redirect.join(&req.target).ok();
        let path_ok = url.as_ref().is_some_and(|u| u.path() == "/auth/callback");
        let site_ok = req
            .sec_fetch_site
            .as_deref()
            .is_none_or(|s| matches!(s, "none" | "same-origin" | "cross-site"));
        if req.method != "GET"
            || req.host.as_deref() != Some(host.as_str())
            || req.origin.as_deref().is_some_and(|o| o != origin)
            || !site_ok
            || !path_ok
        {
            return PlanJudged::Refused(respond(404, "", false));
        }
        if self.consumed {
            return PlanJudged::Refused(respond(410, "", false));
        }
        let Some(url) = url else {
            return PlanJudged::Refused(respond(404, "", false));
        };
        let supplied: Vec<String> = url
            .query_pairs()
            .filter(|(k, _)| k == "state")
            .map(|(_, v)| v.into_owned())
            .collect();
        // Both sides hashed so the compare is constant-time whatever the length; always evaluated.
        let same = digest_equal(
            supplied.first().map_or("", String::as_str),
            self.expected.expose(),
        );
        if supplied.len() != 1 || !same || url.origin() != self.redirect.origin() {
            if now - self.window_start >= FORGED_WINDOW_MS {
                self.window_start = now;
                self.forged = 0;
            }
            self.forged += 1;
            if self.forged > FORGED_PER_WINDOW {
                return PlanJudged::Refused(respond(429, "", true));
            }
            return PlanJudged::Refused(respond(400, "Invalid sign-in callback.", false));
        }
        self.consumed = true;
        PlanJudged::Genuine(
            respond(200, "You may close this window.", false),
            url.to_string(),
        )
    }
}

/// `LoopbackPkce`.
pub struct LoopbackPkce<'a> {
    open: &'a dyn Fn(&Secret) -> Result<(), OpenAIError>,
    listener: &'a mut dyn LoopbackListener,
    clock: &'a dyn Clock,
    redirect: Option<String>,
}

impl<'a> LoopbackPkce<'a> {
    /// Over a browser opener, a listener and the clock of the rate limit and the deadline.
    pub fn new(
        open: &'a dyn Fn(&Secret) -> Result<(), OpenAIError>,
        listener: &'a mut dyn LoopbackListener,
        clock: &'a dyn Clock,
    ) -> LoopbackPkce<'a> {
        LoopbackPkce {
            open,
            listener,
            clock,
            redirect: None,
        }
    }
}

impl PkcePort for LoopbackPkce<'_> {
    fn redirect(&mut self) -> Result<String, OpenAIError> {
        if self.redirect.is_some() {
            return fail("invalid-request");
        }
        let Ok(port) = self.listener.bind() else {
            self.close();
            return fail("port-in-use");
        };
        let r = format!("http://127.0.0.1:{port}/auth/callback");
        self.redirect = Some(r.clone());
        Ok(r)
    }

    fn close(&mut self) {
        if self.redirect.take().is_some() {
            self.listener.close();
        }
    }

    fn authorize(
        &mut self,
        url: &Secret,
        redirect_uri: &str,
        deadline_ms: f64,
    ) -> Result<Secret, OpenAIError> {
        let result = (|| {
            let Some(redirect) = self.redirect.clone().filter(|r| r == redirect_uri) else {
                return fail("invalid-request");
            };
            // The listener is bound only to an authorize URL that carries exactly one non-empty state.
            let u =
                url::Url::parse(url.expose()).map_err(|_| OpenAIError::new("invalid-request"))?;
            let states: Vec<String> = u
                .query_pairs()
                .filter(|(k, _)| k == "state")
                .map(|(_, v)| v.into_owned())
                .collect();
            let [state] = states.as_slice() else {
                return fail("invalid-request");
            };
            if state.is_empty() {
                return fail("invalid-request");
            }
            let mut gate = PlanGate::new(&redirect, Secret::new(state.clone()))
                .ok_or_else(|| OpenAIError::new("invalid-request"))?;
            (self.open)(url).map_err(|_| OpenAIError::new("login-cancelled"))?;
            loop {
                let wait = deadline_ms - self.clock.now();
                if wait <= 0.0 {
                    return fail("login-timeout");
                }
                match self.listener.next(wait) {
                    Incoming::Timeout => return fail("login-timeout"),
                    Incoming::Request(req) => match gate.judge(&req, self.clock.now()) {
                        PlanJudged::Refused(r) => self.listener.respond(&r),
                        PlanJudged::Genuine(r, callback) => {
                            self.listener.respond(&r);
                            return Ok(Secret::new(callback));
                        }
                    },
                }
            }
        })();
        self.close();
        result
    }
}
