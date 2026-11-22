//! Blocking DevTools document operations over a private, host-connected browser.

use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};

const TEXT_LIMIT: usize = 32 * 1024 * 1024;
const IMAGE_LIMIT: usize = 24 * 1024 * 1024;
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

/// The host launches a private browser profile, admits its loopback endpoint and
/// bounds messages while reading. It closes/reaps its browser on every exit.
pub trait Transport {
    fn send(&mut self, text: &str, deadline: Instant) -> Result<()>;
    fn receive(&mut self, deadline: Instant) -> Result<String>;
    fn wait(&mut self, delay: Duration, deadline: Instant) -> Result<()>;
}

pub struct Control<'a> {
    pub deadline: Instant,
    pub cancelled: &'a dyn Fn() -> bool,
}

impl Control<'_> {
    fn check(&self) -> Result<()> {
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
}

impl<'a, T: Transport> Client<'a, T> {
    pub fn new(port: &'a mut T, control: Control<'a>) -> Self {
        Self {
            port,
            control,
            sequence: 0,
        }
    }

    fn request(&mut self, method: &str, params: &Value) -> Result<Value> {
        self.control.check()?;
        self.sequence = self.sequence.checked_add(1).ok_or(Error::Protocol)?;
        let id = self.sequence;
        let text = json!({"id":id,"method":method,"params":params}).to_string();
        self.port.send(&text, self.control.deadline)?;
        for _ in 0..UNRELATED_LIMIT {
            self.control.check()?;
            let message = self.port.receive(self.control.deadline)?;
            self.control.check()?;
            if message.len() > TEXT_LIMIT {
                return Err(Error::TooLarge);
            }
            let value: Value = serde_json::from_str(&message).map_err(|_| Error::Protocol)?;
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

    fn pause(&mut self) -> Result<()> {
        self.control.check()?;
        self.port.wait(POLL, self.control.deadline)
    }

    /// Load the file URL of the host-owned staged document.
    pub fn navigate(&mut self, file_url: &str) -> Result<()> {
        if !file_url.starts_with("file:///") {
            return Err(Error::Protocol);
        }
        self.request("Page.enable", &json!({}))?;
        let response = self.request("Page.navigate", &json!({"url":file_url}))?;
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

fn decode(response: &Value, magic: &[u8]) -> Result<Vec<u8>> {
    let data = response["data"].as_str().ok_or(Error::InvalidOutput)?;
    if data.len() > IMAGE_LIMIT.div_ceil(3) * 4 {
        return Err(Error::TooLarge);
    }
    let bytes = STANDARD.decode(data).map_err(|_| Error::InvalidOutput)?;
    if bytes.len() > IMAGE_LIMIT {
        return Err(Error::TooLarge);
    }
    if !bytes.starts_with(magic) {
        return Err(Error::InvalidOutput);
    }
    Ok(bytes)
}
