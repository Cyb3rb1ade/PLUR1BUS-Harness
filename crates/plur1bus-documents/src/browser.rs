//! Launch the configured Chromium binary in a private profile and connect to DevTools.

use std::{
    fs::{self, File},
    io::{self, Read as _},
    net::{Ipv4Addr, SocketAddr, TcpStream},
    path::Path,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use plur1bus_channels::websocket::{self, Limits, Peer, Socket, SocketPorts, TimedStream};
use plur1bus_providers::pinned_http_agent;
use serde_json::Value;
use url::Url;

use crate::chromium::{Client, Control, Error, Result, Transport};

const CONTROL_FILE_LIMIT: u64 = 4096;
const TARGETS_LIMIT: u64 = 64 * 1024;
const CDP_MESSAGE_LIMIT: usize = 32 * 1024 * 1024;
const MAX_HTML: usize = 20 * 1024 * 1024;
const MAX_PAGED_JS: u64 = 2 * 1024 * 1024;
const POLL: Duration = Duration::from_millis(25);
const PROFILE_CLOSE_GRACE: Duration = Duration::from_secs(1);

pub struct Chromium<'a> {
    binary: &'a Path,
    private_root: &'a Path,
    paged_js: Option<&'a Path>,
}

pub struct Rendered {
    pub pdf: Vec<u8>,
    pub screenshot: Vec<u8>,
}

impl<'a> Chromium<'a> {
    /// The binary and private temporary directory are trusted host configuration.
    pub fn new(binary: &'a Path, private_root: &'a Path) -> Self {
        Self {
            binary,
            private_root,
            paged_js: None,
        }
    }

    /// The application may supply its shipped Paged.js asset for paginated layout.
    pub fn with_paged_js(mut self, asset: &'a Path) -> Self {
        self.paged_js = Some(asset);
        self
    }

    pub fn layout_check(&self, html: &str, control: Control<'_>) -> Result<Value> {
        self.with_page(html, control, |cdp| {
            cdp.evaluate(crate::checks::LAYOUT_SCRIPT, false)
        })
    }

    pub fn render(&self, html: &str, control: Control<'_>) -> Result<Rendered> {
        self.with_page(html, control, |cdp| {
            Ok(Rendered {
                pdf: cdp.print_pdf()?,
                screenshot: cdp.screenshot_full()?,
            })
        })
    }

    pub fn print_pdf(&self, html: &str, control: Control<'_>) -> Result<Vec<u8>> {
        self.with_page(html, control, |cdp| cdp.print_pdf())
    }

    pub fn screenshot_full(&self, html: &str, control: Control<'_>) -> Result<Vec<u8>> {
        self.with_page(html, control, |cdp| cdp.screenshot_full())
    }

    fn with_page<T>(
        &self,
        html: &str,
        control: Control<'_>,
        run: impl FnOnce(&mut Client<'_, LocalWire>) -> Result<T>,
    ) -> Result<T> {
        control.check()?;
        if html.len() > MAX_HTML {
            return Err(Error::TooLarge);
        }
        if !self.binary.is_absolute() || !self.private_root.is_absolute() {
            return Err(Error::BrowserUnavailable);
        }
        let directory = tempfile::Builder::new()
            .prefix("plur1bus-doc-")
            .tempdir_in(self.private_root)
            .map_err(|_| Error::BrowserUnavailable)?;
        let result = self.with_profile(directory.path(), html, control, run);
        let cleanup = remove_profile(directory);
        result.and_then(|value| cleanup.map(|()| value))
    }

    fn with_profile<T>(
        &self,
        directory: &Path,
        html: &str,
        control: Control<'_>,
        run: impl FnOnce(&mut Client<'_, LocalWire>) -> Result<T>,
    ) -> Result<T> {
        let document = directory.join("document.html");
        fs::write(&document, html).map_err(|_| Error::BrowserUnavailable)?;
        let file_url = Url::from_file_path(&document).map_err(|()| Error::BrowserUnavailable)?;
        let profile = directory.join("profile");
        let mut browser = BrowserProcess::spawn(self.binary, &profile)?;
        let address = discover(&mut browser, &profile, control)?;
        let endpoint = find_page(address, control)?;
        let remaining = control.deadline.saturating_duration_since(Instant::now());
        control.check()?;
        let limits = Limits {
            message_bytes: CDP_MESSAGE_LIMIT,
            frame_bytes: CDP_MESSAGE_LIMIT,
            handshake: remaining,
            read: remaining,
            write: remaining,
        };
        let socket = Socket::connect(&endpoint, &[], &Loopback(address), limits, true)
            .map_err(|error| wire_error(error, control))?;
        let mut wire = LocalWire { socket, control };
        let result = (|| {
            let mut cdp = Client::new(&mut wire, control);
            cdp.navigate(file_url.as_str())?;
            while cdp.evaluate("document.URL", false)? != file_url.as_str() {
                pause(control, POLL, control.deadline)?;
            }
            if let Some(path) = self.paged_js {
                paginate(&mut cdp, path, control)?;
            }
            run(&mut cdp)
        })();
        browser.close(&mut wire.socket, control.deadline);
        result
    }
}

fn remove_profile(directory: tempfile::TempDir) -> Result<()> {
    let path = directory.path().to_owned();
    if directory.close().is_ok() {
        return Ok(());
    }
    // Chromium can close its final file handles during recursive removal.
    // Retry only the private directory this launch created.
    let deadline = Instant::now() + PROFILE_CLOSE_GRACE;
    loop {
        match fs::remove_dir_all(&path) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error)
                if Instant::now() < deadline
                    && matches!(
                        error.kind(),
                        io::ErrorKind::DirectoryNotEmpty
                            | io::ErrorKind::PermissionDenied
                            | io::ErrorKind::ResourceBusy
                    ) =>
            {
                thread::sleep(POLL.min(deadline.saturating_duration_since(Instant::now())));
            }
            Err(_) => return Err(Error::BrowserUnavailable),
        }
    }
}

fn paginate(cdp: &mut Client<'_, LocalWire<'_>>, asset: &Path, control: Control<'_>) -> Result<()> {
    if !asset.is_absolute() {
        return Err(Error::BrowserUnavailable);
    }
    let mut script = String::from("window.PagedConfig = { auto: false };\n");
    let start = script.len();
    File::open(asset)
        .and_then(|file| file.take(MAX_PAGED_JS + 1).read_to_string(&mut script))
        .map_err(|_| Error::BrowserUnavailable)?;
    if (script.len() - start) as u64 > MAX_PAGED_JS {
        return Err(Error::TooLarge);
    }
    control.check()?;
    script.push_str("\n;window.PagedPolyfill.preview().then(flow => flow.total)");
    let pages = cdp.evaluate(&script, true)?;
    if pages.as_u64().filter(|pages| *pages > 0).is_none() {
        return Err(Error::InvalidOutput);
    }
    Ok(())
}

struct BrowserProcess(Child);

impl BrowserProcess {
    fn spawn(binary: &Path, profile: &Path) -> Result<Self> {
        let mut profile_arg = std::ffi::OsString::from("--user-data-dir=");
        profile_arg.push(profile);
        Command::new(binary)
            .args([
                "--headless=new",
                "--remote-debugging-port=0",
                "--remote-debugging-address=127.0.0.1",
                "--disable-gpu",
                "--disable-dev-shm-usage",
                "--hide-scrollbars",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-background-networking",
                "--no-proxy-server",
            ])
            .arg(profile_arg)
            .arg("about:blank")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map(Self)
            .map_err(|_| Error::BrowserUnavailable)
    }

    fn close(&mut self, socket: &mut Socket, deadline: Instant) {
        let deadline = deadline.min(Instant::now() + PROFILE_CLOSE_GRACE);
        let _ = socket.send_text_until(
            r#"{"id":9007199254740991,"method":"Browser.close"}"#,
            deadline,
        );
        while Instant::now() < deadline {
            if !matches!(self.0.try_wait(), Ok(None)) {
                return;
            }
            thread::sleep(POLL.min(deadline.saturating_duration_since(Instant::now())));
        }
    }
}

impl Drop for BrowserProcess {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

fn discover(
    browser: &mut BrowserProcess,
    profile: &Path,
    control: Control<'_>,
) -> Result<SocketAddr> {
    let path = profile.join("DevToolsActivePort");
    loop {
        control.check()?;
        if !matches!(browser.0.try_wait(), Ok(None)) {
            return Err(Error::BrowserUnavailable);
        }
        match File::open(&path) {
            Ok(file) => {
                let mut value = String::new();
                file.take(CONTROL_FILE_LIMIT + 1)
                    .read_to_string(&mut value)
                    .map_err(|_| Error::Protocol)?;
                if value.len() as u64 > CONTROL_FILE_LIMIT {
                    return Err(Error::TooLarge);
                }
                // A partial first write is permitted until the deadline.
                if let Some((port, _)) = value.split_once('\n') {
                    let port = port
                        .trim_end_matches('\r')
                        .parse::<u16>()
                        .ok()
                        .filter(|port| *port != 0)
                        .ok_or(Error::Protocol)?;
                    return Ok(SocketAddr::from((Ipv4Addr::LOCALHOST, port)));
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(_) => return Err(Error::BrowserUnavailable),
        }
        pause(control, POLL, control.deadline)?;
    }
}

fn find_page(address: SocketAddr, control: Control<'_>) -> Result<Url> {
    control.check()?;
    let config = ureq::Agent::config_builder()
        .proxy(None)
        .max_redirects(0)
        .max_response_header_size(TARGETS_LIMIT as usize)
        .timeout_global(Some(
            control.deadline.saturating_duration_since(Instant::now()),
        ))
        .build();
    let agent = pinned_http_agent(config, address, control.deadline);
    let mut response = agent
        .get(format!("http://{address}/json/list"))
        .call()
        .map_err(|error| {
            control
                .check()
                .err()
                .unwrap_or(if matches!(error, ureq::Error::Timeout(_)) {
                    Error::Timeout
                } else {
                    Error::BrowserUnavailable
                })
        })?;
    if response.status() != 200 {
        return Err(Error::Protocol);
    }
    let mut bytes = Vec::new();
    let read = response
        .body_mut()
        .as_reader()
        .take(TARGETS_LIMIT + 1)
        .read_to_end(&mut bytes);
    control.check()?;
    read.map_err(|_| Error::Protocol)?;
    if bytes.len() as u64 > TARGETS_LIMIT {
        return Err(Error::TooLarge);
    }
    let targets: Vec<Value> = serde_json::from_slice(&bytes).map_err(|_| Error::Protocol)?;
    let endpoint = targets
        .iter()
        .find(|target| target["type"] == "page")
        .and_then(|target| target["webSocketDebuggerUrl"].as_str())
        .ok_or(Error::Protocol)?;
    let endpoint = Url::parse(endpoint).map_err(|_| Error::Protocol)?;
    if !permitted(&endpoint, address) {
        return Err(Error::Protocol);
    }
    Ok(endpoint)
}

fn permitted(endpoint: &Url, address: SocketAddr) -> bool {
    endpoint.scheme() == "ws"
        && endpoint.host_str() == Some("127.0.0.1")
        && endpoint.port_or_known_default() == Some(address.port())
        && endpoint.path().starts_with("/devtools/page/")
        && endpoint.query().is_none()
}

struct Loopback(SocketAddr);

impl SocketPorts for Loopback {
    fn pin(&self, endpoint: &Url, _: Instant) -> Option<SocketAddr> {
        permitted(endpoint, self.0).then_some(self.0)
    }

    fn dial(
        &self,
        _: &Url,
        pin: SocketAddr,
        deadline: Instant,
    ) -> io::Result<Box<dyn TimedStream>> {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if pin != self.0 || remaining.as_millis() == 0 {
            return Err(io::Error::from(io::ErrorKind::TimedOut));
        }
        TcpStream::connect_timeout(&pin, remaining)
            .map(|stream| Box::new(stream) as Box<dyn TimedStream>)
    }
}

struct LocalWire<'a> {
    socket: Socket,
    control: Control<'a>,
}

impl Transport for LocalWire<'_> {
    fn send(&mut self, text: &str, deadline: Instant) -> Result<()> {
        self.control.check()?;
        self.socket
            .send_text_until(text, deadline)
            .map_err(|error| wire_error(error, self.control))?;
        self.control.check()
    }

    fn receive(&mut self, deadline: Instant) -> Result<String> {
        for _ in 0..128 {
            self.control.check()?;
            let message = self
                .socket
                .receive_until(deadline)
                .map_err(|error| wire_error(error, self.control))?;
            self.control.check()?;
            match message {
                Peer::Text(text) => return Ok(text),
                Peer::Ping | Peer::Pong => {}
                Peer::Binary(_) | Peer::Closed(_) => return Err(Error::Protocol),
            }
        }
        Err(Error::Protocol)
    }

    fn wait(&mut self, delay: Duration, deadline: Instant) -> Result<()> {
        pause(self.control, delay, deadline)
    }
}

fn pause(control: Control<'_>, delay: Duration, deadline: Instant) -> Result<()> {
    control.check()?;
    thread::sleep(delay.min(deadline.saturating_duration_since(Instant::now())));
    control.check()
}

fn wire_error(error: websocket::Error, control: Control<'_>) -> Error {
    control.check().err().unwrap_or(match error {
        websocket::Error::Denied
        | websocket::Error::Protocol
        | websocket::Error::Closed
        | websocket::Error::Handshake { .. } => Error::Protocol,
        websocket::Error::Timeout => Error::Timeout,
        websocket::Error::Capacity => Error::TooLarge,
        websocket::Error::Network => Error::BrowserUnavailable,
    })
}
