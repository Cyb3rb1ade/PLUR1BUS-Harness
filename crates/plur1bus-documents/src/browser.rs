//! Launch the configured Chromium binary in a private profile and connect to DevTools over private pipes.

use std::{
    fs::{self, File},
    io::{self, Read as _},
    path::Path,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use serde_json::Value;

use crate::chromium::{Client, Control, Error, Result, Transport};

mod pipe;
use pipe::Pipe;

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
        run: impl FnOnce(&mut Client<'_, Pipe>) -> Result<T>,
    ) -> Result<T> {
        let control = control.capped();
        control.check()?;
        check_html_size(html.len())?;
        if !self.binary.is_absolute()
            || !self.private_root.is_absolute()
            || self.paged_js.is_some_and(|asset| !asset.is_absolute())
        {
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
        run: impl FnOnce(&mut Client<'_, Pipe>) -> Result<T>,
    ) -> Result<T> {
        let mut browser = BrowserProcess::spawn(self.binary, directory)?;
        let write_end = browser.0.stdin.take().ok_or(Error::BrowserUnavailable)?;
        let read_end = browser.0.stdout.take().ok_or(Error::BrowserUnavailable)?;
        let mut wire = Pipe::start(read_end, write_end, control)?;
        let result = (|| {
            let mut cdp = Client::new(&mut wire, control);
            cdp.load_document(html)?;
            if let Some(path) = self.paged_js {
                paginate(&mut cdp, path, control)?;
            }
            run(&mut cdp)
        })();
        if control.check().is_ok() {
            browser.close(&mut wire, control.deadline);
        }
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

fn paginate(cdp: &mut Client<'_, Pipe<'_>>, asset: &Path, control: Control<'_>) -> Result<()> {
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

fn check_html_size(bytes: usize) -> Result<()> {
    if bytes > MAX_HTML {
        return Err(Error::TooLarge);
    }
    Ok(())
}

struct BrowserProcess(Child);

impl BrowserProcess {
    fn spawn(binary: &Path, directory: &Path) -> Result<Self> {
        let mut profile_arg = std::ffi::OsString::from("--user-data-dir=");
        let root = directory
            .canonicalize()
            .map_err(|_| Error::BrowserUnavailable)?;
        profile_arg.push(root.join("profile"));
        let mut dumps = std::ffi::OsString::from("--crash-dumps-dir=");
        dumps.push(root.join("crashes"));
        let mut command = pipe_command(binary, &root)?;
        command
            .env_clear()
            .args([
                "--headless=new",
                "--remote-debugging-pipe",
                "--disable-gpu",
                "--disable-dev-shm-usage",
                "--hide-scrollbars",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-background-networking",
                "--disable-extensions",
                "--disable-component-update",
                #[cfg(target_os = "macos")]
                "--use-mock-keychain",
                "--disable-crash-reporter",
                "--disable-breakpad",
                // On Linux this testing switch crashes Chrome 141 renderers on navigation.
                #[cfg(not(target_os = "linux"))]
                "--disable-crashpad-for-testing",
                "--host-resolver-rules=MAP * ~NOTFOUND",
            ])
            .arg(dumps)
            .arg(profile_arg)
            .arg("about:blank")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map(Self)
            .map_err(|_| Error::BrowserUnavailable)
    }

    fn close(&mut self, pipe: &mut Pipe<'_>, deadline: Instant) {
        let deadline = deadline.min(Instant::now() + PROFILE_CLOSE_GRACE);
        let _ = pipe.send(
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

#[cfg(unix)]
fn pipe_command(binary: &Path, root: &Path) -> Result<Command> {
    // Only fixed descriptor actions are interpreted by the shell. The binary
    // and every argument are passed as distinct argv elements to exec.
    let mut command = Command::new("/bin/sh");
    command
        .args([
            "-c",
            "root=$1; shift; exec /usr/bin/env -i HOME=\"$root\" TMPDIR=\"$root\" MAC_CHROMIUM_TMPDIR=\"$root\" CFFIXED_USER_HOME=\"$root\" XDG_CONFIG_HOME=\"$root\" XDG_CACHE_HOME=\"$root\" CHROME_CONFIG_HOME=\"$root\" \"$@\" 3<&0 4>&1 </dev/null >/dev/null",
            "plur1bus-chromium",
        ])
        .arg(root)
        .arg(binary);
    Ok(command)
}

#[cfg(windows)]
fn pipe_command(binary: &Path, root: &Path) -> Result<Command> {
    // Node's native child-process launcher transfers the two Chromium pipe
    // descriptors on Windows. Chromium receives only the private directory paths.
    let node = std::env::var_os("PLUR1BUS_NODE")
        .map(std::path::PathBuf::from)
        .filter(|path| path.is_absolute() && path.is_file())
        .or_else(|| {
            let search = std::env::var_os("PATH")?;
            std::env::split_paths(&search)
                .filter(|path| path.is_absolute())
                .map(|path| path.join("node.exe"))
                .find(|path| path.is_file())
        })
        .ok_or(Error::BrowserUnavailable)?;
    let mut command = Command::new(node);
    command
        .args(["--eval", include_str!("browser/windows-pipe.cjs"), "--"])
        .arg(root)
        .arg(binary);
    Ok(command)
}

#[cfg(not(any(unix, windows)))]
fn pipe_command(_: &Path, _: &Path) -> Result<Command> {
    Err(Error::BrowserUnavailable)
}

impl Drop for BrowserProcess {
    fn drop(&mut self) {
        if self.0.try_wait().ok().flatten().is_none() {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{check_html_size, Error, MAX_HTML};

    #[test]
    fn html_size_is_bounded_before_the_browser_starts() {
        assert_eq!(check_html_size(MAX_HTML), Ok(()));
        assert_eq!(check_html_size(MAX_HTML + 1), Err(Error::TooLarge));
    }
}
