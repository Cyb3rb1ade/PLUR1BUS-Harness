//! `openai-auth/http.ts`: the [`HttpPort`] of the OpenAI routes over the auth package's HTTP port. The same egress
//! admission and address pin as inference (the dry run of [`crate::egress::service::Egress`] before anything is sent; in
//! TypeScript `providerFetch` does it), a bounded JSON answer (256 KiB by default), no redirects, one deadline. Any failure
//! of the transport, a body that is not JSON, or a refused URL is `transport-failed`; an answer that is JSON but not an object,
//! or too large, is `endpoint-rejected`.
//!
//! Not ported: the multipart SDP body of the realtime route (`voice`, P4-W); a request with one is refused.
use super::super::http::{form_body, HttpTransport, Limits, Pin, TransportError, WireRequest};
use super::ports::{fail, HttpPort, HttpRequest, HttpResponse, OpenAIError};
use crate::egress::service::{DryRun, Egress, Purpose};
use serde_json::Value;

/// `createOpenAIHttp({ egress, timeoutMs, maxBytes })`.
pub struct OpenAIHttp<'a> {
    egress: &'a Egress<'a>,
    transport: &'a dyn HttpTransport,
    timeout_ms: f64,
    max_bytes: f64,
}

impl<'a> OpenAIHttp<'a> {
    /// 30 s and 256 KiB by default.
    pub fn new(
        egress: &'a Egress<'a>,
        transport: &'a dyn HttpTransport,
        timeout_ms: Option<f64>,
        max_bytes: Option<f64>,
    ) -> OpenAIHttp<'a> {
        OpenAIHttp {
            egress,
            transport,
            timeout_ms: timeout_ms.unwrap_or(30_000.0),
            max_bytes: max_bytes.unwrap_or(256.0 * 1024.0),
        }
    }
}

impl HttpPort for OpenAIHttp<'_> {
    fn request(&self, r: &HttpRequest) -> Result<HttpResponse, OpenAIError> {
        let failed = || OpenAIError::new("transport-failed");
        let url = url::Url::parse(&r.url).map_err(|_| failed())?;
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some_and(|p| !p.is_empty())
        {
            return Err(failed());
        }
        let pin = match self.egress.decide(&r.url, Purpose::Ordinary) {
            DryRun::Allowed {
                host,
                port,
                address,
                family,
            } => Pin {
                host,
                address,
                family,
                port,
            },
            DryRun::Denied { .. } => return Err(failed()),
        };
        let mut headers = vec![("accept".to_owned(), "application/json".to_owned())];
        if let Some(a) = &r.authorization {
            headers.push(("authorization".to_owned(), format!("Bearer {}", a.expose())));
        }
        let body = match (&r.form, &r.json) {
            (Some(f), _) => {
                headers.push((
                    "content-type".to_owned(),
                    "application/x-www-form-urlencoded".to_owned(),
                ));
                form_body(f)
            }
            (None, Some(j)) => {
                headers.push(("content-type".to_owned(), "application/json".to_owned()));
                super::super::secret::Secret::new(j.to_string())
            }
            (None, None) => super::super::secret::Secret::new(""),
        };
        let request = WireRequest {
            method: r.method.to_owned(),
            url: r.url.clone(),
            headers,
            body,
            limits: Limits {
                max_bytes: Some(self.max_bytes),
                error_body_bytes: Some(self.max_bytes),
                timeout_ms: Some(self.timeout_ms),
                no_redirects: true,
            },
            pin,
        };
        let response = match self.transport.send(&request) {
            Ok(x) => x,
            Err(TransportError::TooLarge) => return fail("endpoint-rejected"),
            Err(_) => return Err(failed()),
        };
        // `redirect: "error"`: a 3xx is a transport failure, never followed.
        if (300..400).contains(&response.status) {
            return Err(failed());
        }
        if response.body.len() as f64 > self.max_bytes {
            return fail("endpoint-rejected");
        }
        let text = String::from_utf8_lossy(&response.body);
        let body: Value = serde_json::from_str(&text).map_err(|_| failed())?;
        if !body.is_object() {
            return fail("endpoint-rejected");
        }
        Ok(HttpResponse {
            status: response.status,
            body,
        })
    }
}
