//! `plur1bus login <provider>`, `login status|list|logout` (M2, D16, D110): provider sign-in over the core's `auth.*` RPC
//! and API-key storage over `secret.set`.
//!
//! Nothing here prints, logs or journals a token, an API key, a refresh token, a code verifier or an authorization code.
//! An API key is read from stdin only (a value in an argument is refused without echoing it). The OAuth authorize URL
//! carries a PKCE challenge and a state, no secret; the redirected callback URL a person pastes carries the authorization
//! code, so it is replayed to the core's own loopback listener and never printed, stored or put in an error.
use crate::commands::memory::connect;
use crate::output::{say_err, Out};
use crate::paths::Layout;
use clap::{Args, Subcommand};
use plur1bus_rpc::{is_unavailable, Client, RpcError};
use serde_json::{json, Value};
use std::io::{BufRead, IsTerminal, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// The core's own login deadline (`auth.openai.loopbackTimeoutMs`) unless `--timeout` says otherwise.
const DEFAULT_TIMEOUT_SECS: u64 = 600;
/// Same bound `secret set` applies to a value.
const MAX_KEY_BYTES: u64 = 64 * 1024;
const LOGIN_METHODS: [&str; 6] = [
    "auth.login.start",
    "auth.login.await",
    "auth.login.cancel",
    "auth.credentials.list",
    "auth.logout",
    "auth.status",
];

/// `plur1bus login <provider>` or one of its subcommands.
#[derive(Args, Debug)]
#[command(args_conflicts_with_subcommands = true)]
pub struct LoginArgs {
    #[command(subcommand)]
    pub sub: Option<LoginCmd>,
    /// the provider to sign in to: openai (ChatGPT sign-in, or an API key), anthropic, google, gemini, xai, openrouter, together, fal, replicate, elevenlabs
    pub provider: Option<String>,
    /// store an API key for the provider: the key is read from stdin and this flag takes no value (a value is refused)
    #[arg(long, num_args = 0..=1, require_equals = true, default_missing_value = "", value_name = "VALUE")]
    pub api_key: Option<String>,
    /// sign in with the provider's OAuth flow (the default for providers that have one)
    #[arg(long, conflicts_with = "api_key")]
    pub oauth: bool,
    /// do not try to open a browser; print the URL only
    #[arg(long)]
    pub no_browser: bool,
    /// on a machine without a browser: after signing in elsewhere, paste the address the browser was sent to
    #[arg(long)]
    pub paste: bool,
    /// give up after this many seconds (default 600)
    #[arg(long, value_name = "SECONDS", value_parser = clap::value_parser!(u64).range(1..=3600))]
    pub timeout: Option<u64>,
    /// the secret name for an API key (default <provider>/api-key)
    #[arg(long, value_name = "NAME")]
    pub name: Option<String>,
    /// refused: a key never goes in an argument (kept only so the refusal does not echo it)
    #[arg(long, hide = true, num_args = 0..=1, allow_hyphen_values = true)]
    pub key: Option<String>,
    /// refused: a key never goes in an argument (kept only so the refusal does not echo it)
    #[arg(hide = true, num_args = 0.., allow_hyphen_values = true)]
    pub rest: Vec<String>,
}

#[derive(Debug, Subcommand)]
pub enum LoginCmd {
    /// [experimental] Saved sign-ins and logins in progress
    Status,
    /// [experimental] List saved sign-ins (ids, workspace, expiry; never a token)
    List,
    /// [experimental] Remove a saved sign-in and its local token state; the id may be a unique prefix
    Logout { id: String },
}

/// Providers with a sign-in route here. `oauth` is true where the core has a login flow for it. Device code is not
/// offered by any of them (OpenAI's plan sign-in is loopback PKCE only), so the headless route is `ssh -L` or `--paste`.
const PROVIDERS: &[(&str, bool)] = &[
    ("openai", true),
    ("anthropic", false),
    ("google", false),
    ("gemini", false),
    ("xai", false),
    ("openrouter", false),
    ("together", false),
    ("fal", false),
    ("replicate", false),
    ("elevenlabs", false),
];

fn known_providers() -> String {
    PROVIDERS
        .iter()
        .map(|(p, _)| *p)
        .collect::<Vec<_>>()
        .join(", ")
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Route {
    ApiKey { provider: String, secret: String },
    Oauth { provider: String },
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Refusal {
    pub code: &'static str,
    pub message: String,
    pub reason: &'static str,
}

fn refuse(message: &str, reason: &'static str) -> Refusal {
    Refusal {
        code: "E_INVALID_PARAMS",
        message: message.to_string(),
        reason,
    }
}

const VALUE_IN_ARGUMENT: &str = "a key is read from stdin and never from an argument; treat the value you just typed as exposed (shell history, process list) and rotate it";

/// Pure routing and argument policy. No message names a user-supplied word: a mistyped `--api-key sk-...` makes the key
/// the provider, so the provider is never echoed either.
pub(crate) fn plan(args: &LoginArgs) -> Result<Route, Refusal> {
    if args.key.is_some()
        || !args.rest.is_empty()
        || args.api_key.as_deref().is_some_and(|v| !v.is_empty())
    {
        return Err(refuse(VALUE_IN_ARGUMENT, "value-in-argument"));
    }
    let Some(provider) = args.provider.as_deref() else {
        return Err(refuse(
            &format!("name a provider: {}", known_providers()),
            "provider-required",
        ));
    };
    let Some((name, oauth)) = PROVIDERS.iter().find(|(p, _)| *p == provider) else {
        // Anything that is not a plain lowercase word may be a pasted key.
        let looks_like_word = provider.len() <= 16
            && provider
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b == b'-');
        return Err(if looks_like_word {
            refuse(
                &format!("unknown provider; known providers: {}", known_providers()),
                "unknown-provider",
            )
        } else {
            refuse(VALUE_IN_ARGUMENT, "value-in-argument")
        });
    };
    let want_key = args.api_key.is_some() || !*oauth;
    if want_key {
        if args.oauth {
            return Err(refuse(
                "this provider has no OAuth sign-in; use --api-key and pipe the key on stdin",
                "unsupported-route",
            ));
        }
        if args.no_browser || args.paste || args.timeout.is_some() {
            return Err(refuse(
                "--no-browser, --paste and --timeout apply to the OAuth sign-in only",
                "unsupported-route",
            ));
        }
        let secret = args
            .name
            .clone()
            .unwrap_or_else(|| format!("{name}/api-key"));
        if !valid_secret_name(&secret) {
            return Err(refuse(
                "the secret name takes letters, digits and . _ : / @ - (at most 128, first a letter or digit)",
                "invalid-name",
            ));
        }
        Ok(Route::ApiKey {
            provider: (*name).to_string(),
            secret,
        })
    } else {
        if args.name.is_some() {
            return Err(refuse(
                "--name names the secret of an API key; the OAuth sign-in stores its own",
                "unsupported-route",
            ));
        }
        Ok(Route::Oauth {
            provider: (*name).to_string(),
        })
    }
}

/// `secret.set`'s name pattern: `^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$`.
fn valid_secret_name(s: &str) -> bool {
    let mut chars = s.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphanumeric())
        && s.len() <= 128
        && chars.all(|c| c.is_ascii_alphanumeric() || "._:/@-".contains(c))
}

// ---------------------------------------------------------------------------------------------------------------------
// RPC seam: the flows below are generic over how a connection is made, so tests drive them with a scripted core.

pub(crate) trait Rpc {
    fn call(&mut self, method: &str, params: Value) -> Result<Value, RpcError>;
}
impl Rpc for Client {
    fn call(&mut self, method: &str, params: Value) -> Result<Value, RpcError> {
        if !self.supports(method) {
            return Err(RpcError::Call {
                error: serde_json::from_value(json!("E_NOT_AVAILABLE"))
                    .expect("E_NOT_AVAILABLE is a schema error code"),
                jsonrpc: -32000,
                message: format!("core does not support {method} yet"),
                reason: Some("core-lacks-method".into()),
                detail: None,
                ids: None,
                ext: None,
            });
        }
        Client::call(self, method, params)
    }
}
pub(crate) type Connect = Arc<dyn Fn(Duration) -> Result<Box<dyn Rpc>, RpcError> + Send + Sync>;

fn real_connect(layout: &Layout) -> Connect {
    let layout = layout.clone();
    Arc::new(move |timeout| connect(&layout, timeout).map(|c| Box::new(c) as Box<dyn Rpc>))
}

// ---------------------------------------------------------------------------------------------------------------------
// OAuth flow

#[derive(Debug)]
pub(crate) enum FlowError {
    Rpc(RpcError),
    Cancelled,
    TimedOut,
    Local(String),
}
impl From<RpcError> for FlowError {
    fn from(e: RpcError) -> Self {
        FlowError::Rpc(e)
    }
}

pub(crate) enum Notice<'a> {
    Started {
        url: &'a str,
        port: u16,
        attempt: &'a str,
    },
    PasteRejected(&'static str),
    PasteReplayed,
    PasteFailed(String),
}

pub(crate) struct OauthOptions {
    pub provider: String,
    pub timeout: Duration,
}

/// Starts the login, reports the URL, then waits for whichever comes first: the core's answer, a pasted callback, an
/// interrupt or the deadline. An interrupt or the deadline cancels the login in the core (`auth.login.cancel`); the core
/// also cancels it by itself when this process disappears (the waiting connection closes).
pub(crate) fn oauth_flow(
    connect: &Connect,
    opts: &OauthOptions,
    pastes: &Receiver<String>,
    interrupted: &AtomicBool,
    notice: &mut dyn FnMut(Notice),
) -> Result<Value, FlowError> {
    let mut rpc = connect(Duration::from_secs(30))?;
    let started = rpc.call("auth.login.start", json!({ "provider": opts.provider }))?;
    let (Some(attempt), Some(url), Some(port)) = (
        started["attemptId"].as_str().map(str::to_string),
        started["authorizeUrl"].as_str().map(str::to_string),
        started["callbackPort"]
            .as_u64()
            .and_then(|p| u16::try_from(p).ok()),
    ) else {
        return Err(FlowError::Local(
            "the core answered auth.login.start with an unexpected shape".into(),
        ));
    };
    notice(Notice::Started {
        url: &url,
        port,
        attempt: &attempt,
    });
    let (tx, rx) = channel::<Result<Value, RpcError>>();
    {
        let connect = Arc::clone(connect);
        let attempt = attempt.clone();
        // The waiting call needs a connection of its own: this one stays free for a cancel.
        let call_timeout = opts.timeout + Duration::from_secs(60);
        std::thread::spawn(move || {
            let result = connect(call_timeout)
                .and_then(|mut c| c.call("auth.login.await", json!({ "attemptId": attempt })));
            let _ = tx.send(result);
        });
    }
    let deadline = Instant::now() + opts.timeout;
    let cancel = |rpc: &mut Box<dyn Rpc>| {
        let _ = rpc.call("auth.login.cancel", json!({ "attemptId": attempt }));
    };
    loop {
        if interrupted.load(Ordering::SeqCst) {
            cancel(&mut rpc);
            let _ = rx.recv_timeout(Duration::from_secs(5));
            return Err(FlowError::Cancelled);
        }
        if Instant::now() >= deadline {
            cancel(&mut rpc);
            let _ = rx.recv_timeout(Duration::from_secs(5));
            return Err(FlowError::TimedOut);
        }
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(result) => return result.map_err(FlowError::Rpc),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                return Err(FlowError::Local("the sign-in worker ended".into()))
            }
        }
        while let Ok(line) = pastes.try_recv() {
            match parse_paste(&line, port) {
                Ok(target) => match replay(port, &target) {
                    Ok(()) => notice(Notice::PasteReplayed),
                    Err(why) => notice(Notice::PasteFailed(why)),
                },
                Err(why) => notice(Notice::PasteRejected(why)),
            }
        }
    }
}

/// The request target (`/auth/callback?...`) of a pasted callback address, accepted only when it is exactly the loopback
/// address this login redirects to. The text is never echoed: it carries the authorization code.
pub(crate) fn parse_paste(line: &str, port: u16) -> Result<String, &'static str> {
    let line = line.trim();
    let prefix = format!("http://127.0.0.1:{port}/auth/callback");
    let Some(rest) = line.strip_prefix(&prefix) else {
        return Err("that is not this sign-in's callback address (http://127.0.0.1:<port>/auth/callback?...)");
    };
    if rest.len() > 4096 {
        return Err("the pasted address is too long");
    }
    if !(rest.is_empty() || rest.starts_with('?')) {
        return Err("that is not this sign-in's callback address (http://127.0.0.1:<port>/auth/callback?...)");
    }
    if rest
        .bytes()
        .any(|b| b <= b' ' || b == 0x7f || b == b'#' || b == b'\\')
    {
        return Err("the pasted address contains characters a callback never has");
    }
    Ok(format!("/auth/callback{rest}"))
}

/// Delivers the callback to the core's listener as the browser would have, from this machine. Only a status line is read.
pub(crate) fn replay(port: u16, target: &str) -> Result<(), String> {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(5)).map_err(|_| {
        "the sign-in is no longer listening (it finished, timed out or was cancelled)".to_string()
    })?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let request = format!(
        "GET {target} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: */*\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|_| "could not deliver the callback".to_string())?;
    let mut status = String::new();
    std::io::BufReader::new(stream.take(1024))
        .read_line(&mut status)
        .map_err(|_| "no answer from the sign-in listener".to_string())?;
    match status.split_whitespace().nth(1) {
        Some("200") => Ok(()),
        Some("410") => Err("this callback was already used".to_string()),
        _ => Err("the sign-in listener refused the callback".to_string()),
    }
}

/// Whether this machine most likely has no browser to open.
pub(crate) fn headless(get: &dyn Fn(&str) -> Option<String>, linux: bool) -> bool {
    let set = |k: &str| get(k).is_some_and(|v| !v.is_empty());
    set("SSH_CONNECTION")
        || set("SSH_TTY")
        || get("PLUR1BUS_CONTAINER").as_deref() == Some("1")
        || (linux && !set("DISPLAY") && !set("WAYLAND_DISPLAY"))
}

/// The program and arguments that open `url` in the default browser; no shell is involved.
pub(crate) fn browser_command(url: &str) -> Option<(&'static str, Vec<String>)> {
    if !url.starts_with("https://") || url.bytes().any(|b| b <= b' ' || b == 0x7f) {
        return None;
    }
    Some(if cfg!(target_os = "macos") {
        ("open", vec![url.to_string()])
    } else if cfg!(windows) {
        (
            "rundll32",
            vec!["url.dll,FileProtocolHandler".to_string(), url.to_string()],
        )
    } else {
        ("xdg-open", vec![url.to_string()])
    })
}

fn open_browser(url: &str) -> bool {
    let Some((program, args)) = browser_command(url) else {
        return false;
    };
    std::process::Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|mut child| {
            // Do not leave a zombie; the opener returns at once.
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        })
        .is_ok()
}

/// The command to run on the machine that has the browser so the redirect reaches this one.
pub(crate) fn ssh_hint(port: u16, user: &str, host: &str) -> String {
    format!("ssh -L {port}:127.0.0.1:{port} {user}@{host}")
}

fn interrupt_flag() -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    #[cfg(unix)]
    {
        use signal_hook::consts::{SIGINT, SIGTERM};
        for sig in [SIGINT, SIGTERM] {
            let _ = signal_hook::flag::register(sig, Arc::clone(&flag));
        }
    }
    // Elsewhere Ctrl-C ends this process; the core cancels the login when the waiting connection closes.
    flag
}

fn stdin_lines() -> Receiver<String> {
    let (tx, rx) = channel();
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut line = String::new();
        while let Ok(n) = stdin.lock().read_line(&mut line) {
            if n == 0 || tx.send(std::mem::take(&mut line)).is_err() {
                break;
            }
        }
    });
    rx
}

fn oauth(out: &Out, layout: &Layout, provider: String, args: &LoginArgs) {
    let timeout = Duration::from_secs(args.timeout.unwrap_or(DEFAULT_TIMEOUT_SECS));
    let no_browser = args.no_browser
        || headless(
            &|k| std::env::var(k).ok(),
            cfg!(all(unix, not(target_os = "macos"))),
        );
    let paste = args.paste;
    let pastes = if paste { stdin_lines() } else { channel().1 };
    let interrupted = interrupt_flag();
    let connect = real_connect(layout);
    let json_mode = out.json;
    let label = if provider == "openai" {
        "Sign in with ChatGPT"
    } else {
        "Sign in"
    };
    let mut notice = |n: Notice| match n {
        Notice::Started { url, port, attempt } => {
            if json_mode {
                crate::output::say(
                    &json!({
                        "schema": "login.started/1",
                        "provider": provider,
                        "attemptId": attempt,
                        "authorizeUrl": url,
                        "callbackPort": port
                    })
                    .to_string(),
                );
            }
            let opened = !no_browser && open_browser(url);
            say_err(&format!(
                "{label}: open this address in a browser.\n\n  {url}\n"
            ));
            if opened {
                say_err("A browser window was opened for you.");
            }
            if !opened {
                let user = whoami::username();
                let host = gethostname::gethostname().to_string_lossy().into_owned();
                say_err(&format!(
                    "No browser was opened. If you sign in on another machine, forward the callback port first, from that machine:\n\n  {}\n\nthen open the address there.",
                    ssh_hint(port, &user, &host)
                ));
                if !paste {
                    say_err("Or run this command again with --paste and paste the address the browser is sent to afterwards.");
                }
            }
            if paste {
                say_err(&format!(
                    "\nAfter you sign in the browser is sent to http://127.0.0.1:{port}/auth/callback?... and may show an error page. Copy that whole address from the address bar and paste it here, then press Enter:"
                ));
            }
            say_err(&format!(
                "\nWaiting for the sign-in (Ctrl-C cancels, gives up after {}s).",
                timeout.as_secs()
            ));
        }
        Notice::PasteRejected(why) => say_err(&format!("{why}; paste it again.")),
        Notice::PasteReplayed => say_err("Callback delivered; finishing the sign-in."),
        Notice::PasteFailed(why) => say_err(&format!("{why}.")),
    };
    let result = oauth_flow(
        &connect,
        &OauthOptions {
            provider: provider.clone(),
            timeout,
        },
        &pastes,
        &interrupted,
        &mut notice,
    );
    match result {
        Ok(credential) => {
            let mut doc = credential.clone();
            doc["provider"] = json!(provider);
            out.ok("login.done/1", &doc, || {
                format!(
                    "signed in: {} (workspace {}, id {})",
                    credential["person"].as_str().unwrap_or("?"),
                    credential["workspace"].as_str().unwrap_or("?"),
                    short(&credential["id"])
                )
            });
        }
        Err(FlowError::Rpc(e)) => out.from_rpc_error(&e),
        Err(FlowError::Cancelled) => out.fail(
            "E_CANCELLED",
            "sign-in cancelled; nothing was saved",
            json!({ "reason": "login-cancelled" }),
            130,
        ),
        Err(FlowError::TimedOut) => out.fail(
            "E_CONFLICT",
            "the sign-in did not finish in time; nothing was saved",
            json!({ "reason": "login-timeout" }),
            1,
        ),
        Err(FlowError::Local(m)) => out.fail("E_INTERNAL", &m, json!({}), 1),
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// API key

/// The key from `input`: one trailing newline removed, never empty. A terminal is refused (no echo-free prompt here).
fn read_key(out: &Out, input: &mut impl Read, is_terminal: bool) -> String {
    if is_terminal {
        out.fail(
            "E_INVALID_PARAMS",
            "the key is read from stdin and never from an argument: pipe it, e.g. `printf %s \"$KEY\" | plur1bus login anthropic --api-key`",
            json!({ "reason": "value-from-stdin" }),
            2,
        );
    }
    let mut buf = Vec::new();
    if input.take(MAX_KEY_BYTES + 1).read_to_end(&mut buf).is_err() {
        out.fail(
            "E_INVALID_PARAMS",
            "cannot read the key from stdin",
            json!({ "reason": "stdin-unreadable" }),
            2,
        );
    }
    crate::commands::secret::parse_value(buf)
        .unwrap_or_else(|why| out.fail("E_INVALID_PARAMS", why, json!({ "detail": "key" }), 2))
}

fn store_key(out: &Out, layout: &Layout, provider: &str, secret: &str, key: String) {
    let mut client = match connect(layout, Duration::from_secs(30)) {
        Ok(c) => c,
        Err(e) if is_unavailable(&e) => out.fail(
            "E_CORE_UNAVAILABLE",
            &format!("core unavailable: {e}"),
            json!({ "degraded": { "reason": "core-unavailable", "capability": "secrets",
                "detail": crate::commands::memory::unavailable_detail(layout, &e) } }),
            1,
        ),
        Err(e) => out.from_rpc_error(&e),
    };
    // `key` leaves this scope with the request; nothing below formats it.
    let stored = match Rpc::call(
        &mut client,
        "secret.set",
        json!({ "name": secret, "value": key }),
    ) {
        Ok(v) => v,
        Err(e) => out.from_rpc_error(&e),
    };
    let doc = json!({ "provider": provider, "ref": secret, "backend": stored["backend"] });
    out.ok("login.apikey/1", &doc, || {
        format!("stored the {provider} API key as secret ref {secret}")
    });
}

// ---------------------------------------------------------------------------------------------------------------------
// status, list, logout

fn short(id: &Value) -> String {
    id.as_str().unwrap_or("?").chars().take(12).collect()
}

fn when(ms: &Value) -> String {
    match ms.as_u64() {
        Some(ms) => format!("expires at epoch {ms} ms"),
        None => "no expiry".to_string(),
    }
}

pub(crate) fn render_credentials(v: &Value) -> String {
    let rows: Vec<String> = v["credentials"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|c| {
                    format!(
                        "{}  {}  workspace {}  {}{}",
                        short(&c["id"]),
                        c["person"].as_str().unwrap_or("?"),
                        c["workspace"].as_str().unwrap_or("?"),
                        when(&c["expiresAt"]),
                        if c["needsLogin"].as_bool() == Some(true) {
                            "  (sign in again)"
                        } else {
                            ""
                        }
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    if rows.is_empty() {
        "no saved sign-ins".to_string()
    } else {
        rows.join("\n")
    }
}

/// A saved id from what a person typed: the full id, or a prefix of at least 8 characters that names exactly one.
pub(crate) fn resolve_id(credentials: &[Value], typed: &str) -> Result<String, &'static str> {
    let ids: Vec<&str> = credentials
        .iter()
        .filter_map(|c| c["id"].as_str())
        .collect();
    if typed.len() == 64 && typed.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Ok(typed.to_ascii_lowercase());
    }
    if typed.len() < 8 || !typed.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(
            "give the full id or at least 8 hex characters of it (see `plur1bus login list`)",
        );
    }
    let wanted = typed.to_ascii_lowercase();
    let mut hits = ids.iter().filter(|id| id.starts_with(&wanted));
    match (hits.next(), hits.next()) {
        (Some(id), None) => Ok((*id).to_string()),
        (None, _) => Err("no saved sign-in has that id"),
        _ => Err("that prefix names more than one sign-in; give more characters"),
    }
}

fn rpc(out: &Out, layout: &Layout, method: &str, params: Value) -> Value {
    debug_assert!(LOGIN_METHODS.contains(&method));
    match connect(layout, Duration::from_secs(30)) {
        Ok(mut c) => match Rpc::call(&mut c, method, params) {
            Ok(v) => v,
            Err(e) => out.from_rpc_error(&e),
        },
        Err(e) if is_unavailable(&e) => out.fail(
            "E_CORE_UNAVAILABLE",
            &format!("core unavailable: {e}"),
            json!({ "degraded": { "reason": "core-unavailable", "capability": "login",
                "detail": crate::commands::memory::unavailable_detail(layout, &e) } }),
            1,
        ),
        Err(e) => out.from_rpc_error(&e),
    }
}

pub fn run(out: &Out, layout: &Layout, args: LoginArgs) {
    match &args.sub {
        Some(LoginCmd::Status) => {
            let v = rpc(out, layout, "auth.status", json!({}));
            out.ok("login.status/1", &v, || {
                format!(
                    "{}\n{} sign-in(s) in progress",
                    render_credentials(&v),
                    v["pendingLogins"].as_u64().unwrap_or(0)
                )
            });
        }
        Some(LoginCmd::List) => {
            let v = rpc(out, layout, "auth.credentials.list", json!({}));
            out.ok("login.list/1", &v, || render_credentials(&v));
        }
        Some(LoginCmd::Logout { id }) => {
            let id = if id.len() == 64 {
                id.clone()
            } else {
                let listed = rpc(out, layout, "auth.credentials.list", json!({}));
                let all = listed["credentials"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                resolve_id(&all, id).unwrap_or_else(|why| {
                    out.fail(
                        "E_NOT_FOUND",
                        why,
                        json!({ "reason": "credential-unknown" }),
                        1,
                    )
                })
            };
            let v = rpc(out, layout, "auth.logout", json!({ "id": id }));
            out.ok("login.logout/1", &v, || {
                format!("signed out {}", short(&v["id"]))
            });
        }
        None => match plan(&args) {
            Err(r) => out.fail(r.code, &r.message, json!({ "reason": r.reason }), 2),
            Ok(Route::Oauth { provider }) => oauth(out, layout, provider, &args),
            Ok(Route::ApiKey { provider, secret }) => {
                let key = read_key(out, &mut std::io::stdin(), std::io::stdin().is_terminal());
                store_key(out, layout, &provider, &secret, key);
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::{Cli, Cmd};
    use clap::Parser;
    use std::net::TcpListener;
    use std::sync::Mutex;

    fn args(list: &[&str]) -> LoginArgs {
        let mut full = vec!["plur1bus", "login"];
        full.extend_from_slice(list);
        match Cli::try_parse_from(full).unwrap().cmd {
            Cmd::Login(a) => a,
            _ => panic!("not login"),
        }
    }

    #[test]
    fn openai_defaults_to_oauth_and_others_to_an_api_key() {
        assert_eq!(
            plan(&args(&["openai"])).unwrap(),
            Route::Oauth {
                provider: "openai".into()
            }
        );
        assert_eq!(
            plan(&args(&["openai", "--api-key"])).unwrap(),
            Route::ApiKey {
                provider: "openai".into(),
                secret: "openai/api-key".into()
            }
        );
        assert_eq!(
            plan(&args(&["anthropic"])).unwrap(),
            Route::ApiKey {
                provider: "anthropic".into(),
                secret: "anthropic/api-key".into()
            }
        );
        assert_eq!(
            plan(&args(&["xai", "--name", "work/xai"])).unwrap(),
            Route::ApiKey {
                provider: "xai".into(),
                secret: "work/xai".into()
            }
        );
    }

    #[test]
    fn a_key_in_an_argument_is_refused_and_never_echoed() {
        const MARKER: &str = "sk-MARKER-9f3a7c1e5d2b";
        for list in [
            vec!["openai", "--api-key", MARKER],
            vec!["openai", "--api-key=sk-MARKER-9f3a7c1e5d2b"],
            vec!["--api-key", MARKER],
            vec!["openai", "--key", MARKER],
            vec!["openai", "--key=sk-MARKER-9f3a7c1e5d2b"],
            vec![MARKER],
            vec!["anthropic", MARKER],
        ] {
            let r = plan(&args(&list)).unwrap_err();
            assert_eq!(r.reason, "value-in-argument", "{list:?}");
            assert!(!r.message.contains("MARKER"), "{list:?}: {}", r.message);
            assert!(r.message.contains("stdin"));
        }
    }

    #[test]
    fn unknown_providers_and_mixed_routes_are_refused_without_echo() {
        let r = plan(&args(&["nope"])).unwrap_err();
        assert_eq!(r.reason, "unknown-provider");
        assert!(!r.message.contains("nope"));
        assert_eq!(plan(&args(&[])).unwrap_err().reason, "provider-required");
        assert_eq!(
            plan(&args(&["anthropic", "--oauth"])).unwrap_err().reason,
            "unsupported-route"
        );
        assert_eq!(
            plan(&args(&["anthropic", "--paste"])).unwrap_err().reason,
            "unsupported-route"
        );
        assert_eq!(
            plan(&args(&["openai", "--name", "x"])).unwrap_err().reason,
            "unsupported-route"
        );
        assert_eq!(
            plan(&args(&["xai", "--name", "-bad"])).unwrap_err().reason,
            "invalid-name"
        );
        assert!(
            Cli::try_parse_from(["plur1bus", "login", "openai", "--oauth", "--api-key"]).is_err()
        );
    }

    #[test]
    fn subcommands_parse_with_and_without_json() {
        for (list, want) in [
            (vec!["status"], "status"),
            (vec!["list"], "list"),
            (vec!["logout", "abcdef012345"], "logout"),
        ] {
            let a = args(&list);
            let got = match a.sub {
                Some(LoginCmd::Status) => "status",
                Some(LoginCmd::List) => "list",
                Some(LoginCmd::Logout { .. }) => "logout",
                None => "provider",
            };
            assert_eq!(got, want);
        }
        let cli = Cli::try_parse_from(["plur1bus", "--json", "login", "status"]).unwrap();
        assert!(cli.json);
        let cli = Cli::try_parse_from(["plur1bus", "login", "list", "--json"]).unwrap();
        assert!(cli.json);
    }

    #[test]
    fn paste_accepts_only_this_logins_loopback_callback() {
        assert_eq!(
            parse_paste(
                "  http://127.0.0.1:49152/auth/callback?code=c&state=s \n",
                49152
            ),
            Ok("/auth/callback?code=c&state=s".to_string())
        );
        for bad in [
            "http://127.0.0.1:49153/auth/callback?code=c",
            "http://localhost:49152/auth/callback?code=c",
            "https://127.0.0.1:49152/auth/callback?code=c",
            "http://127.0.0.1:49152/auth/callbackx?code=c",
            "http://127.0.0.1:49152/other?code=c",
            "http://127.0.0.1:49152/auth/callback?code=c d",
            "http://127.0.0.1:49152/auth/callback?code=c\r\nX: y",
            "http://127.0.0.1:49152/auth/callback?code=c#frag",
            "http://127.0.0.1:49152@evil.example/auth/callback",
            "",
            "sk-not-an-address",
        ] {
            let err = parse_paste(bad, 49152).unwrap_err();
            assert!(!err.contains("code=") && !err.contains("sk-"), "{err}");
        }
    }

    #[test]
    fn headless_detection_and_hint() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |k: &str| {
                pairs
                    .iter()
                    .find(|(n, _)| *n == k)
                    .map(|(_, v)| v.to_string())
            }
        };
        assert!(headless(
            &env(&[("SSH_CONNECTION", "1.2.3.4 1 5.6.7.8 22")]),
            false
        ));
        assert!(headless(&env(&[("PLUR1BUS_CONTAINER", "1")]), false));
        assert!(headless(&env(&[]), true), "linux without a display");
        assert!(!headless(&env(&[("DISPLAY", ":0")]), true));
        assert!(!headless(&env(&[]), false), "macOS/Windows have a desktop");
        assert_eq!(
            ssh_hint(49152, "me", "box"),
            "ssh -L 49152:127.0.0.1:49152 me@box"
        );
    }

    #[test]
    fn the_browser_is_only_ever_given_an_https_address_without_a_shell() {
        let (program, argv) = browser_command("https://auth.example/authorize?state=s").unwrap();
        assert!(["open", "xdg-open", "rundll32"].contains(&program));
        assert!(argv.last().unwrap().starts_with("https://"));
        for bad in [
            "http://x",
            "--help",
            "file:///etc/passwd",
            "https://x y",
            "https://x\n--flag",
        ] {
            assert!(browser_command(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn ids_resolve_from_a_unique_prefix_only() {
        let a = "a".repeat(8) + &"0".repeat(56);
        let b = "a".repeat(8) + &"1".repeat(56);
        let c = "b".repeat(64);
        let all = vec![json!({"id": a}), json!({"id": b}), json!({"id": c})];
        assert_eq!(resolve_id(&all, "bbbbbbbb").unwrap(), c);
        assert_eq!(resolve_id(&all, &a).unwrap(), a);
        assert!(resolve_id(&all, "aaaaaaaa")
            .unwrap_err()
            .contains("more than one"));
        assert!(resolve_id(&all, "cccccccc").is_err());
        assert!(resolve_id(&all, "bbb").is_err());
        assert!(resolve_id(&all, "../x").is_err());
    }

    #[test]
    fn credentials_render_as_metadata_only() {
        let v = json!({"credentials": [{"id": "ab".repeat(32), "person": "local-owner", "workspace": "Personal",
            "kind": "oauth_pkce", "billingPath": "plan", "expiresAt": 5, "needsLogin": true}], "pendingLogins": 0});
        let text = render_credentials(&v);
        assert!(text.contains("abababababab ") && text.contains("sign in again"));
        assert!(!text.contains(&"ab".repeat(32)));
        assert_eq!(
            render_credentials(&json!({"credentials": []})),
            "no saved sign-ins"
        );
    }

    // --- the flow, against a scripted core -------------------------------------------------------------------------

    fn call_error(reason: &str) -> RpcError {
        RpcError::Call {
            error: serde_json::from_value(json!("E_CONFLICT")).unwrap(),
            jsonrpc: -32000,
            message: format!("login refused ({reason})"),
            reason: Some(reason.into()),
            detail: None,
            ids: None,
            ext: None,
        }
    }

    /// A core whose `auth.login.await` finishes when the fake loopback listener receives a callback or `cancel` is called.
    struct FakeCore {
        calls: Mutex<Vec<String>>,
        listener: TcpListener,
        cancelled: Arc<AtomicBool>,
        finish_on_callback: bool,
        fail_with: Option<&'static str>,
    }
    struct FakeRpc(Arc<FakeCore>, bool /* is the waiting connection */);
    impl Rpc for FakeRpc {
        fn call(&mut self, method: &str, params: Value) -> Result<Value, RpcError> {
            let core = &self.0;
            core.calls.lock().unwrap().push(method.to_string());
            match method {
                "auth.login.start" => Ok(json!({
                    "attemptId": "attempt-1",
                    "authorizeUrl": "https://auth.example/authorize?state=s",
                    "callbackPort": core.listener.local_addr().unwrap().port()
                })),
                "auth.login.cancel" => {
                    assert_eq!(params["attemptId"], "attempt-1");
                    core.cancelled.store(true, Ordering::SeqCst);
                    Ok(json!({"cancelled": true}))
                }
                "auth.login.await" => {
                    assert!(self.1);
                    core.listener.set_nonblocking(true).unwrap();
                    loop {
                        if core.cancelled.load(Ordering::SeqCst) {
                            return Err(call_error("login-cancelled"));
                        }
                        if let Some(reason) = core.fail_with {
                            return Err(call_error(reason));
                        }
                        if let Ok((mut s, _)) = core.listener.accept() {
                            s.set_nonblocking(false).unwrap();
                            let mut head = String::new();
                            std::io::BufReader::new(&s).read_line(&mut head).unwrap();
                            core.calls.lock().unwrap().push(head.trim().to_string());
                            s.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
                                .unwrap();
                            if core.finish_on_callback {
                                return Ok(json!({"id": "c".repeat(64), "person": "local-owner",
                                    "workspace": "Personal", "kind": "oauth_pkce", "billingPath": "plan",
                                    "expiresAt": 9, "needsLogin": false}));
                            }
                        }
                        std::thread::sleep(Duration::from_millis(10));
                    }
                }
                _ => panic!("unexpected {method}"),
            }
        }
    }
    fn fake(finish_on_callback: bool, fail_with: Option<&'static str>) -> (Arc<FakeCore>, Connect) {
        let core = Arc::new(FakeCore {
            calls: Mutex::new(vec![]),
            listener: TcpListener::bind("127.0.0.1:0").unwrap(),
            cancelled: Arc::new(AtomicBool::new(false)),
            finish_on_callback,
            fail_with,
        });
        let waiting = Arc::new(AtomicBool::new(false));
        let c2 = Arc::clone(&core);
        // The first connection is the main one; later ones are the waiting call (and are only used for await).
        let connect: Connect = Arc::new(move |_t| {
            let first = !waiting.swap(true, Ordering::SeqCst);
            Ok(Box::new(FakeRpc(Arc::clone(&c2), !first)) as Box<dyn Rpc>)
        });
        (core, connect)
    }
    fn opts(secs: u64) -> OauthOptions {
        OauthOptions {
            provider: "openai".into(),
            timeout: Duration::from_secs(secs),
        }
    }

    #[test]
    fn a_pasted_callback_is_replayed_to_the_loopback_and_finishes_the_login() {
        let (core, connect) = fake(true, None);
        let port = core.listener.local_addr().unwrap().port();
        let (tx, pastes) = channel();
        let interrupted = AtomicBool::new(false);
        let mut seen = vec![];
        let mut sent = false;
        let result = oauth_flow(
            &connect,
            &opts(30),
            &pastes,
            &interrupted,
            &mut |n| match n {
                Notice::Started {
                    url,
                    port: p,
                    attempt,
                } => {
                    assert_eq!((p, attempt), (port, "attempt-1"));
                    assert!(url.starts_with("https://auth.example/"));
                    if !sent {
                        sent = true;
                        tx.send("not an address\n".into()).unwrap();
                        tx.send(format!(
                            "http://127.0.0.1:{port}/auth/callback?code=THE-CODE&state=s\n"
                        ))
                        .unwrap();
                    }
                    seen.push("started".to_string());
                }
                Notice::PasteRejected(why) => {
                    assert!(!why.contains("not an address"));
                    seen.push("rejected".into())
                }
                Notice::PasteReplayed => seen.push("replayed".into()),
                Notice::PasteFailed(why) => seen.push(format!("failed {why}")),
            },
        )
        .unwrap();
        assert_eq!(result["person"], "local-owner");
        assert!(seen.contains(&"rejected".to_string()), "{seen:?}");
        let calls = core.calls.lock().unwrap().clone();
        assert!(
            calls
                .iter()
                .any(|c| c == "GET /auth/callback?code=THE-CODE&state=s HTTP/1.1"),
            "{calls:?}"
        );
        // The code reached the listener only: no notice carried it.
        assert!(seen.iter().all(|s| !s.contains("THE-CODE")));
    }

    #[test]
    fn an_interrupt_cancels_the_login_in_the_core() {
        let (core, connect) = fake(false, None);
        let (_tx, pastes) = channel();
        let interrupted = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&interrupted);
        let result = oauth_flow(&connect, &opts(30), &pastes, &interrupted, &mut |n| {
            if matches!(n, Notice::Started { .. }) {
                flag.store(true, Ordering::SeqCst);
            }
        });
        assert!(matches!(result, Err(FlowError::Cancelled)), "{result:?}");
        assert!(core.cancelled.load(Ordering::SeqCst));
        assert!(core
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|c| c == "auth.login.cancel"));
    }

    #[test]
    fn the_deadline_cancels_the_login_and_reports_a_timeout() {
        let (core, connect) = fake(false, None);
        let (_tx, pastes) = channel();
        let interrupted = AtomicBool::new(false);
        let o = OauthOptions {
            provider: "openai".into(),
            timeout: Duration::from_millis(100),
        };
        let result = oauth_flow(&connect, &o, &pastes, &interrupted, &mut |_| {});
        assert!(matches!(result, Err(FlowError::TimedOut)), "{result:?}");
        assert!(core.cancelled.load(Ordering::SeqCst));
    }

    #[test]
    fn a_core_refusal_such_as_a_state_mismatch_surfaces_with_its_reason() {
        let (_core, connect) = fake(false, Some("state-mismatch"));
        let (_tx, pastes) = channel();
        let interrupted = AtomicBool::new(false);
        match oauth_flow(&connect, &opts(30), &pastes, &interrupted, &mut |_| {}) {
            Err(FlowError::Rpc(RpcError::Call { reason, .. })) => {
                assert_eq!(reason.as_deref(), Some("state-mismatch"))
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn replay_reports_a_closed_listener_without_the_address() {
        let port = {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let err = replay(port, "/auth/callback?code=SECRET").unwrap_err();
        assert!(!err.contains("SECRET"));
    }
}
