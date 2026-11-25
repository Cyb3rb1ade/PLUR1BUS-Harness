//! Blocking DevTools document operations over a private, host-connected browser.

use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};

pub(crate) const TEXT_LIMIT: usize = 32 * 1024 * 1024;
const IMAGE_LIMIT: usize = 24 * 1024 * 1024;
const DOCUMENT_URL: &str = "https://render.invalid/document";
const MAX_DURATION: Duration = Duration::from_secs(600);
const UNRELATED_LIMIT: usize = 512;
const POLL: Duration = Duration::from_millis(50);
const WIDTH: u32 = 794;
const HEIGHT: u32 = 1123;
const SETTLE: &str = "document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(Math.ceil(Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)))))))";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    BrowserUnavailable,
    Cancelled,
    InvalidOutput,
    Protocol,
    Timeout,
    TooLarge,
}

pub type Result<T> = std::result::Result<T, Error>;

/// A private browser transport bounds messages and checks cancellation during IO.
pub trait Transport {
    fn send(&mut self, text: &str, deadline: Instant) -> Result<()>;
    fn receive(&mut self, deadline: Instant) -> Result<String>;
    fn wait(&mut self, delay: Duration, deadline: Instant) -> Result<()>;
}

#[derive(Clone, Copy)]
pub struct Control<'a> {
    pub deadline: Instant,
    pub cancelled: &'a dyn Fn() -> bool,
}

impl Control<'_> {
    pub(crate) fn capped(self) -> Self {
        Self {
            deadline: self.deadline.min(Instant::now() + MAX_DURATION),
            ..self
        }
    }

    pub(crate) fn check(&self) -> Result<()> {
        if (self.cancelled)() {
            Err(Error::Cancelled)
        } else if Instant::now() >= self.deadline {
            Err(Error::Timeout)
        } else {
            Ok(())
        }
    }
}

pub struct Client<'a, T> {
    port: &'a mut T,
    control: Control<'a>,
    sequence: u64,
    session: Option<String>,
    document: Option<String>,
}

impl<'a, T: Transport> Client<'a, T> {
    pub fn new(port: &'a mut T, control: Control<'a>) -> Self {
        Self {
            port,
            control: control.capped(),
            sequence: 0,
            session: None,
            document: None,
        }
    }

    fn send(&mut self, method: &str, params: &Value) -> Result<u64> {
        self.control.check()?;
        self.sequence = self.sequence.checked_add(1).ok_or(Error::Protocol)?;
        let id = self.sequence;
        let mut command = json!({"id":id,"method":method,"params":params});
        if let Some(session) = &self.session {
            command["sessionId"] = json!(session);
        }
        self.port
            .send(&command.to_string(), self.control.deadline)?;
        Ok(id)
    }

    fn request(&mut self, method: &str, params: &Value) -> Result<Value> {
        let id = self.send(method, params)?;
        for _ in 0..UNRELATED_LIMIT {
            self.control.check()?;
            let message = self.port.receive(self.control.deadline)?;
            self.control.check()?;
            let value = parse_frame(&message, TEXT_LIMIT)?;
            let session = value["sessionId"].as_str();
            if session != self.session.as_deref() {
                if value["id"].as_u64() == Some(id) {
                    return Err(Error::Protocol);
                }
                continue;
            }
            if session.is_some() && value["method"] == "Fetch.requestPaused" {
                self.intercept(&value["params"])?;
                continue;
            }
            if value["id"].as_u64() != Some(id) {
                continue;
            }
            return value
                .get("result")
                .filter(|_| value.get("error").is_none())
                .cloned()
                .ok_or(Error::Protocol);
        }
        Err(Error::Protocol)
    }

    pub(crate) fn load_document(&mut self, html: &str) -> Result<()> {
        self.request("Browser.setDownloadBehavior", &json!({"behavior":"deny"}))?;
        let target = self.request("Target.createTarget", &json!({"url":"about:blank"}))?;
        let target = identifier(&target["targetId"])?;
        let attached = self.request(
            "Target.attachToTarget",
            &json!({"targetId":target,"flatten":true}),
        )?;
        self.session = Some(identifier(&attached["sessionId"])?.to_owned());
        self.document = Some(STANDARD.encode(html));
        self.request("Network.setBypassServiceWorker", &json!({"bypass":true}))?;
        self.request(
            "Fetch.enable",
            &json!({"patterns":[{"urlPattern":"*","requestStage":"Request"}]}),
        )?;
        self.navigate_page(DOCUMENT_URL)?;
        if self.document.is_some() {
            return Err(Error::Protocol);
        }
        Ok(())
    }

    fn intercept(&mut self, event: &Value) -> Result<()> {
        let request = identifier(&event["requestId"])?;
        match resource(event) {
            Resource::Document => {
                if let Some(body) = self.document.take() {
                    self.send("Fetch.fulfillRequest", &json!({
                        "requestId":request, "responseCode":200, "body":body,
                        "responseHeaders":[
                            {"name":"content-type","value":"text/html; charset=utf-8"},
                            {"name":"content-security-policy","value":crate::templates::DOCUMENT_CSP},
                            {"name":"cache-control","value":"no-store"}
                        ]
                    }))?;
                    return Ok(());
                }
            }
            Resource::Inline => {
                self.send("Fetch.continueRequest", &json!({"requestId":request}))?;
                return Ok(());
            }
            Resource::Denied => {}
        }
        self.send(
            "Fetch.failRequest",
            &json!({"requestId":request,"errorReason":"BlockedByClient"}),
        )?;
        Ok(())
    }

    fn pause(&mut self) -> Result<()> {
        self.control.check()?;
        self.port.wait(POLL, self.control.deadline)
    }

    /// Load the file URL of the host-owned staged document.
    pub fn navigate(&mut self, file_url: &str) -> Result<()> {
        if !file_url.starts_with("file:///") {
            return Err(Error::Protocol);
        }
        self.navigate_page(file_url)
    }

    fn navigate_page(&mut self, url: &str) -> Result<()> {
        self.request("Page.enable", &json!({}))?;
        let response = self.request("Page.navigate", &json!({"url":url}))?;
        if response.get("errorText").is_some() {
            return Err(Error::Protocol);
        }
        loop {
            let ready = self.request(
                "Runtime.evaluate",
                &json!({"expression":"document.readyState"}),
            )?;
            if ready["result"]["value"] == "complete" {
                break;
            }
            self.pause()?;
        }
        self.request("Runtime.evaluate", &json!({
            "expression":"document.fonts ? document.fonts.ready.then(() => 'loaded') : Promise.resolve('no-fonts')",
            "awaitPromise":true
        }))?;
        Ok(())
    }

    pub fn print_pdf(&mut self) -> Result<Vec<u8>> {
        let response = self.request(
            "Page.printToPDF",
            &json!({
                "printBackground":true,
                "preferCSSPageSize":true,
                "displayHeaderFooter":false,
                "transferMode":"ReturnAsBase64"
            }),
        )?;
        decode(&response, b"%PDF-")
    }

    pub(crate) fn evaluate(&mut self, expression: &str, await_promise: bool) -> Result<Value> {
        let response = self.request(
            "Runtime.evaluate",
            &json!({
                "expression": expression,
                "awaitPromise": await_promise,
                "returnByValue": true,
            }),
        )?;
        if response.get("exceptionDetails").is_some() {
            return Err(Error::Protocol);
        }
        response
            .get("result")
            .and_then(|result| result.get("value"))
            .cloned()
            .ok_or(Error::Protocol)
    }

    pub fn screenshot(&mut self) -> Result<Vec<u8>> {
        self.capture(&json!({"format":"png","fromSurface":true}))
    }

    pub fn screenshot_full(&mut self) -> Result<Vec<u8>> {
        self.request(
            "Emulation.setDeviceMetricsOverride",
            &json!({
                "width":WIDTH, "height":HEIGHT, "deviceScaleFactor":1, "mobile":false
            }),
        )?;
        let mut height = 0;
        let mut stable = 0;
        for _ in 0..40 {
            let response = self.request(
                "Runtime.evaluate",
                &json!({
                    "expression":SETTLE, "awaitPromise":true, "returnByValue":true
                }),
            )?;
            let current = response["result"]["value"].as_u64().unwrap_or(0);
            stable = if current == height && current > 0 {
                stable + 1
            } else {
                0
            };
            height = current;
            self.pause()?;
            if stable == 3 {
                break;
            }
        }
        self.capture(&json!({
            "format":"png", "captureBeyondViewport":true,
            "clip":{"x":0, "y":0, "width":WIDTH, "height":height.max(1), "scale":1}
        }))
    }

    fn capture(&mut self, params: &Value) -> Result<Vec<u8>> {
        let response = self.request("Page.captureScreenshot", params)?;
        decode(&response, &[137, 80, 78, 71, 13, 10, 26, 10])
    }
}

fn identifier(value: &Value) -> Result<&str> {
    value
        .as_str()
        .filter(|id| {
            !id.is_empty() && id.len() <= 128 && id.bytes().all(|byte| byte.is_ascii_graphic())
        })
        .ok_or(Error::Protocol)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Resource {
    Document,
    Inline,
    Denied,
}

fn resource(event: &Value) -> Resource {
    if event.get("redirectedRequestId").is_some()
        || event.get("responseStatusCode").is_some()
        || event["request"]["method"] != "GET"
    {
        return Resource::Denied;
    }
    let url = event["request"]["url"].as_str().unwrap_or_default();
    if event["resourceType"] == "Document" {
        if url == DOCUMENT_URL {
            Resource::Document
        } else {
            Resource::Denied
        }
    } else if url.starts_with("data:") {
        Resource::Inline
    } else {
        Resource::Denied
    }
}

fn parse_frame(message: &str, limit: usize) -> Result<Value> {
    if message.len() > limit {
        return Err(Error::TooLarge);
    }
    serde_json::from_str(message).map_err(|_| Error::Protocol)
}

fn decode(response: &Value, magic: &[u8]) -> Result<Vec<u8>> {
    decode_bounded(response, magic, IMAGE_LIMIT)
}

fn decode_bounded(response: &Value, magic: &[u8], limit: usize) -> Result<Vec<u8>> {
    let data = response["data"].as_str().ok_or(Error::InvalidOutput)?;
    if data.len() > limit.div_ceil(3) * 4 {
        return Err(Error::TooLarge);
    }
    let bytes = STANDARD.decode(data).map_err(|_| Error::InvalidOutput)?;
    if bytes.len() > limit {
        return Err(Error::TooLarge);
    }
    if !bytes.starts_with(magic) {
        return Err(Error::InvalidOutput);
    }
    Ok(bytes)
}

#[cfg(test)]
mod policy_tests {
    use super::{resource, Control, Duration, Instant, Resource, DOCUMENT_URL};
    use serde_json::json;

    #[test]
    fn cdp_frames_and_base64_have_independent_preflight_limits() {
        assert_eq!(super::parse_frame("{}", 2), Ok(json!({})));
        assert_eq!(super::parse_frame("{} ", 2), Err(super::Error::TooLarge));
        assert_eq!(
            super::decode_bounded(&json!({"data":"YGFi"}), b"`", 3),
            Ok(b"`ab".to_vec())
        );
        assert_eq!(
            super::decode_bounded(&json!({"data":"value"}), b"`", 3),
            Err(super::Error::TooLarge)
        );
    }

    #[test]
    fn replies_from_other_sessions_and_excess_unrelated_messages_are_refused() {
        use super::{Client, Error, Result, Transport, UNRELATED_LIMIT};
        struct Inbox {
            pending: usize,
            session: &'static str,
            reads: usize,
        }
        impl Transport for Inbox {
            fn send(&mut self, _: &str, _: Instant) -> Result<()> {
                Ok(())
            }
            fn receive(&mut self, _: Instant) -> Result<String> {
                self.reads += 1;
                if self.pending > 0 {
                    self.pending -= 1;
                    Ok(
                        json!({"sessionId":self.session,"method":"Page.lifecycleEvent"})
                            .to_string(),
                    )
                } else {
                    Ok(json!({"id":1,"sessionId":self.session,"result":{}}).to_string())
                }
            }
            fn wait(&mut self, _: Duration, _: Instant) -> Result<()> {
                Ok(())
            }
        }
        let control = Control {
            deadline: Instant::now() + Duration::from_secs(2),
            cancelled: &|| false,
        };
        let mut other = Inbox {
            pending: 0,
            session: "other",
            reads: 0,
        };
        let mut client = Client::new(&mut other, control);
        client.session = Some("fixture".into());
        assert_eq!(
            client.request("Page.enable", &json!({})),
            Err(Error::Protocol)
        );

        assert_eq!(other.reads, 1);
        let mut busy = Inbox {
            reads: 0,
            pending: UNRELATED_LIMIT,
            session: "fixture",
        };
        let mut client = Client::new(&mut busy, control);
        client.session = Some("fixture".into());
        assert_eq!(
            client.request("Page.enable", &json!({})),
            Err(Error::Protocol)
        );
    }

    #[test]
    fn the_browser_policy_admits_the_single_document_and_inline_subresources() {
        let request = |url: &str, kind: &str| {
            json!({
                "resourceType":kind, "request":{"method":"GET","url":url}
            })
        };
        assert_eq!(
            resource(&request(DOCUMENT_URL, "Document")),
            Resource::Document
        );
        assert_eq!(
            resource(&request("data:image/png;base64,AA==", "Image")),
            Resource::Inline
        );
        assert_eq!(
            resource(&request("data:text/html,ordinary", "Document")),
            Resource::Denied
        );
        let outsider = "https://example.invalid/resource";
        for kind in [
            "Stylesheet",
            "Image",
            "Fetch",
            "Ping",
            "WebSocket",
            "Script",
            "Document",
        ] {
            assert_eq!(resource(&request(outsider, kind)), Resource::Denied);
        }
        let mut redirect = request(DOCUMENT_URL, "Document");
        redirect["redirectedRequestId"] = json!("prior");
        assert_eq!(resource(&redirect), Resource::Denied);
    }

    #[test]
    fn browser_control_caps_a_longer_host_deadline() {
        let now = Instant::now();
        let control = Control {
            deadline: now + Duration::from_secs(900),
            cancelled: &|| false,
        }
        .capped();
        assert!(control.deadline >= now + Duration::from_secs(600));
        assert!(control.deadline <= Instant::now() + Duration::from_secs(600));
    }
}
