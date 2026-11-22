//! `openai-auth/workload.ts`: workload identity federation (RFC 8693 token exchange at OpenAI). The subject token is read
//! from its source port on every exchange and never stored; the bearer lives in memory until `expiresAt - skew`, one exchange
//! at a time. An X.509 exchange goes through the mTLS port only and sends no subject token. A token that lives longer than an
//! hour, or whose absolute expiry has passed, is refused.
use super::super::ports::Clock;
use super::super::secret::Secret;
use super::ports::{call, fail, object, positive, text, HttpPort, HttpRequest, OpenAIError};
use crate::js::json_stringify;
use serde_json::{json, Value};
use std::sync::{Mutex, PoisonError};

const X509: &str = "urn:openai:params:oauth:token-type:x509";

/// `WorkloadProfile`.
#[derive(Clone, Debug, PartialEq)]
pub struct WorkloadProfile {
    /// `token_exchange_endpoint`
    pub token_exchange_endpoint: String,
    /// `file:…`, `env:…` or `metadata:…`.
    pub subject_token_source: String,
    /// `subject_token_type`
    pub subject_token_type: String,
    /// `audience`
    pub audience: String,
    /// `principal`
    pub principal: String,
    /// `identity_provider_id`
    pub identity_provider_id: String,
    /// `service_account_id`
    pub service_account_id: String,
    /// `refresh_skew_seconds`, 120 by default.
    pub refresh_skew_seconds: Option<f64>,
}

/// `SubjectPort`: reads the subject token from its source.
pub trait SubjectPort: Send + Sync {
    /// The token of `source`.
    fn read(&self, source: &str) -> Result<Secret, OpenAIError>;
}

/// `WorkloadIdentity`.
pub struct WorkloadIdentity<'a> {
    p: WorkloadProfile,
    http: &'a dyn HttpPort,
    clock: &'a dyn Clock,
    subject: &'a dyn SubjectPort,
    state: Mutex<Option<(Secret, f64)>>,
}

impl<'a> WorkloadIdentity<'a> {
    /// `new WorkloadIdentity(profile, { http, clock, subject, certificateHttp })`.
    pub fn new(
        mut profile: WorkloadProfile,
        http: &'a dyn HttpPort,
        clock: &'a dyn Clock,
        subject: &'a dyn SubjectPort,
        certificate_http: Option<&'a dyn HttpPort>,
    ) -> Result<WorkloadIdentity<'a>, OpenAIError> {
        let bad = || OpenAIError::new("invalid-request");
        let u = url::Url::parse(&profile.token_exchange_endpoint).map_err(|_| bad())?;
        let certificate = profile.subject_token_type == X509;
        if certificate && certificate_http.is_none() {
            return Err(bad());
        }
        let host = if certificate {
            "mtls.auth.openai.com"
        } else {
            "auth.openai.com"
        };
        let source_ok = ["file:", "env:", "metadata:"].iter().any(|p| {
            profile.subject_token_source.starts_with(p)
                && profile.subject_token_source.len() > p.len()
        });
        let skew = profile.refresh_skew_seconds.unwrap_or(120.0);
        if u.scheme() != "https"
            || u.host_str() != Some(host)
            || u.path() != "/oauth/token"
            || !u.username().is_empty()
            || u.password().is_some_and(|p| !p.is_empty())
            || u.query().is_some_and(|q| !q.is_empty())
            || u.fragment().is_some_and(|f| !f.is_empty())
            || !source_ok
            || !skew.is_finite()
            || skew < 0.0
        {
            return Err(bad());
        }
        for v in [
            &profile.identity_provider_id,
            &profile.service_account_id,
            &profile.audience,
            &profile.principal,
        ] {
            text(Some(&Value::String(v.clone())))?;
        }
        profile.token_exchange_endpoint = u.to_string();
        let http = match (certificate, certificate_http) {
            (true, Some(c)) => c,
            _ => http,
        };
        Ok(WorkloadIdentity {
            p: profile,
            http,
            clock,
            subject,
            state: Mutex::new(None),
        })
    }

    /// The body of the exchange, in TypeScript's member order.
    fn body(&self, subject: Option<&Secret>) -> Value {
        let mut text =
            String::from("{\"grant_type\":\"urn:ietf:params:oauth:grant-type:token-exchange\"");
        if let Some(s) = subject {
            text.push_str(",\"subject_token\":");
            text.push_str(&json_stringify(s.expose()));
        }
        text.push_str(&format!(
            ",\"subject_token_type\":{},\"identity_provider_id\":{},\"service_account_id\":{}}}",
            json_stringify(&self.p.subject_token_type),
            json_stringify(&self.p.identity_provider_id),
            json_stringify(&self.p.service_account_id)
        ));
        serde_json::from_str(&text).unwrap_or_else(|_| json!({}))
    }

    /// `lease()`.
    pub fn lease(&self) -> Result<Secret, OpenAIError> {
        // One exchange at a time: the lock is held across it, so a concurrent caller finds the fresh token.
        let mut st = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let skew = self.p.refresh_skew_seconds.unwrap_or(120.0) * 1000.0;
        if let Some((t, at)) = st.as_ref() {
            if at - skew > self.clock.now() {
                return Ok(t.clone());
            }
        }
        let certificate = self.p.subject_token_type == X509;
        let subject = if certificate {
            None
        } else {
            let s = self
                .subject
                .read(&self.p.subject_token_source)
                .map_err(|_| OpenAIError::new("auth-required"))?;
            Some(Secret::new(
                text(Some(&Value::String(s.expose().to_owned())))
                    .map_err(|_| OpenAIError::new("auth-required"))?,
            ))
        };
        let req = HttpRequest {
            method: "POST",
            url: self.p.token_exchange_endpoint.clone(),
            authorization: None,
            form: None,
            json: Some(self.body(subject.as_ref())),
        };
        let body = call(self.http, &req)?;
        let raw = object(&body)?;
        // `String(raw.token_type).toLowerCase()`: a missing type reads as "undefined".
        let tt = raw.get("token_type").map_or_else(
            || "undefined".to_owned(),
            |v| v.as_str().map_or_else(|| v.to_string(), str::to_owned),
        );
        if crate::js::to_lower_case(&tt) != "bearer" {
            return fail("endpoint-rejected");
        }
        let expires = positive(raw.get("expires_in"))?;
        let token = Secret::new(text(raw.get("access_token"))?);
        if expires > 3600.0 {
            return fail("endpoint-rejected");
        }
        let now = self.clock.now();
        let absolute = match raw.get("expires_at") {
            None => now + expires * 1000.0,
            v => positive(v)? * 1000.0,
        };
        let at = absolute.min(self.clock.now() + expires * 1000.0);
        if at <= self.clock.now() {
            *st = None;
            return fail("auth-required");
        }
        *st = Some((token.clone(), at));
        Ok(token)
    }
}
