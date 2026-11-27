//! Launch the configured Chromium binary in a private profile and connect to DevTools over private pipes.

use std::{
    fs::File,
    io::{self, Read as _},
    path::Path,
    process::{Child, Command, Stdio},
    sync::Arc,
    time::Duration,
};

use serde_json::Value;
#[cfg(windows)]
use std::{thread, time::Instant};

#[cfg(windows)]
use crate::chromium::Transport;
use crate::chromium::{Client, Control, Error, Result};

mod cleanup;
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
    cleanup_reporter: cleanup::Reporter,
}

pub struct Rendered {
    pub pdf: Vec<u8>,
    pub screenshot: Vec<u8>,
}

impl<'a> Chromium<'a> {
    /// The binary and private temporary directory are trusted host configuration.
    /// On Unix, use a short local path with room for Chromium’s socket filenames.
    pub fn new(binary: &'a Path, private_root: &'a Path) -> Self {
        Self {
            binary,
            private_root,
            paged_js: None,
            cleanup_reporter: Arc::new(|kind| {
                use std::io::Write as _;
                let _ = writeln!(
                    io::stderr().lock(),
                    "Chromium profile cleanup failed ({kind:?})"
                );
            }),
        }
    }

    /// Reports private-profile cleanup failures, including failures after cancellation.
    pub fn with_cleanup_reporter(
        mut self,
        report: Arc<dyn Fn(io::ErrorKind) + Send + Sync>,
    ) -> Self {
        self.cleanup_reporter = report;
        self
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
        let profile =
            cleanup::Profile::create(self.private_root, Arc::clone(&self.cleanup_reporter))?;
        let mut child = BrowserProcess::spawn(self.binary, profile.path());
        let result = match &mut child {
            Ok(browser) => self.with_profile(browser, html, control, run),
            Err(error) => Err(*error),
        };
        profile.finish(child.ok(), result, control)
    }

    fn with_profile<T>(
        &self,
        browser: &mut BrowserProcess,
        html: &str,
        control: Control<'_>,
        run: impl FnOnce(&mut Client<'_, Pipe>) -> Result<T>,
    ) -> Result<T> {
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
        #[cfg(windows)]
        browser.close_relay(wire, control);
        result
    }
}

fn profile_in_use(error: &io::Error) -> bool {
    // An open handle without FILE_SHARE_DELETE reports ERROR_SHARING_VIOLATION.
    #[cfg(windows)]
    if error.raw_os_error() == Some(32) {
        return true;
    }
    matches!(
        error.kind(),
        io::ErrorKind::DirectoryNotEmpty
            | io::ErrorKind::PermissionDenied
            | io::ErrorKind::ResourceBusy
    )
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
    // Paged.js reads break rules from stylesheets. Expose effective inline
    // breaks to its parser before it clones and divides the document.
    script.push_str(r#"
;(() => {
    const rules = new Set();
    for (const node of document.querySelectorAll("[style]")) {
        for (const property of ["break-before", "break-after"]) {
            if (!node.style.getPropertyValue(property)) continue;
            const value = getComputedStyle(node).getPropertyValue(property);
            if (!["page", "left", "right", "recto", "verso", "avoid", "avoid-page"].includes(value)) continue;
            const attribute = "data-plur1bus-" + property;
            node.setAttribute(attribute, value);
            rules.add("[" + attribute + "='" + value + "']{" + property + ":" + value + "}");
        }
    }
    if (rules.size) {
        const style = document.createElement("style");
        style.textContent = [...rules].join("\\n");
        document.head.append(style);
    }
    return window.PagedPolyfill.preview().then(flow => flow.total);
})()
"#);
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
        command.env_clear();
        // Windows needs its system directory to initialise Node's random source.
        #[cfg(windows)]
        {
            let system_root = std::env::var_os("SystemRoot")
                .filter(|root| Path::new(root).is_absolute())
                .ok_or(Error::BrowserUnavailable)?;
            command.env("SystemRoot", system_root);
        }
        command
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

    #[cfg(windows)]
    fn close_relay(&mut self, mut pipe: Pipe<'_>, control: Control<'_>) {
        let now = Instant::now();
        if control.check().is_ok() {
            let deadline = control.deadline.min(now + PROFILE_CLOSE_GRACE);
            let _ = pipe.send(r#"{"id":0,"method":"Browser.close"}"#, deadline);
        }
        // EOF tells the relay to terminate Chromium. The cleanup worker owns the wait.
        drop(pipe);
    }

    #[cfg(windows)]
    fn wait_for_relay(&mut self) {
        let deadline = Instant::now() + PROFILE_CLOSE_GRACE;
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

    #[cfg(windows)]
    #[test]
    fn profile_cleanup_waits_for_a_closing_windows_handle() -> std::io::Result<()> {
        use std::{fs::OpenOptions, os::windows::fs::OpenOptionsExt, thread, time::Duration};

        let directory = tempfile::tempdir()?;
        let profile = directory.path().to_owned();
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .share_mode(0)
            .open(profile.join("held"))?;
        thread::scope(|scope| {
            scope.spawn(move || {
                thread::sleep(Duration::from_millis(125));
                drop(file);
            });
            assert!(super::cleanup::remove_with_retry(directory.path()).is_ok());
        });
        assert!(!profile.exists());
        Ok(())
    }

    #[test]
    fn html_size_is_bounded_before_the_browser_starts() {
        assert_eq!(check_html_size(MAX_HTML), Ok(()));
        assert_eq!(check_html_size(MAX_HTML + 1), Err(Error::TooLarge));
    }
}
