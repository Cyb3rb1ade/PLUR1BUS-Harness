//! Strict, bounded parsing of OS link and argv input. No parsing action performs I/O.
use crate::connections::{CertPin, Origin};
use serde::Serialize;

/// A validated link is only an intent; pairing always needs an explicit submission.
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DeepLink {
    Pair {
        origin: Origin,
        code: String,
        pin: Option<CertPin>,
        ca: Option<CertPin>,
    },
    Open {
        path: String,
    },
    Chat {
        rest: String,
    },
    Install {
        catalogue_id: String,
    },
    P1x,
    Ignored,
}
/// Parse without side effects; reject ambiguous encodings before a URL parser normalizes them.
pub fn parse(input: &str) -> DeepLink {
    parse_inner(input).unwrap_or(DeepLink::Ignored)
}
fn parse_inner(input: &str) -> Option<DeepLink> {
    if input.len() > 4096
        || !input.is_ascii()
        || input
            .bytes()
            .any(|b| b.is_ascii_control() || b.is_ascii_whitespace())
        || input.contains(['\\', '#'])
    {
        return None;
    }
    let rest = input.strip_prefix("plur1bus://")?;
    let (action, query) = rest.split_once('?').unwrap_or((rest, ""));
    let mut fields = std::collections::BTreeMap::new();
    if !query.is_empty() {
        for field in query.split('&') {
            let (key, raw) = field.split_once('=')?;
            if !["origin", "code", "pin", "ca", "path", "id"].contains(&key)
                || fields.contains_key(key)
            {
                return None;
            }
            fields.insert(key, decode(raw)?);
        }
    }
    match action {
        "pair" => {
            let origin = Origin::parse(&fields.remove("origin")?).ok()?;
            let code = fields.remove("code")?;
            let compact = code.replace('-', "");
            if ![8, 9].contains(&code.len())
                || (code.len() == 9 && code.as_bytes()[4] != b'-')
                || compact.len() != 8
                || !compact
                    .bytes()
                    .all(|b| b"0123456789ABCDEFGHJKMNPQRSTVWXYZ".contains(&b))
            {
                return None;
            }
            let pin = fields
                .remove("pin")
                .map(|p| CertPin::parse(&p))
                .transpose()
                .ok()?;
            let ca = fields
                .remove("ca")
                .map(|p| CertPin::parse(&p))
                .transpose()
                .ok()?;
            if !fields.is_empty()
                || (pin.is_some() && ca.is_some())
                || (origin.as_str().starts_with("http:") && (pin.is_some() || ca.is_some()))
            {
                return None;
            }
            Some(DeepLink::Pair {
                origin,
                code: format!("{}-{}", &compact[..4], &compact[4..]),
                pin,
                ca,
            })
        }
        "open" if fields.len() == 1 => {
            let path = fields.remove("path")?;
            allowed_path(&path).then_some(DeepLink::Open { path })
        }
        "install" if fields.len() == 1 => {
            let catalogue_id = fields.remove("id")?;
            (catalogue_id.len() <= 128
                && catalogue_id.split('/').count() <= 2
                && catalogue_id.split('/').all(identifier))
            .then_some(DeepLink::Install { catalogue_id })
        }
        _ if action.starts_with("chat/") && fields.is_empty() && query.is_empty() => {
            let rest = action.strip_prefix("chat/")?;
            identifier(rest).then(|| DeepLink::Chat { rest: rest.into() })
        }
        _ => None,
    }
}
fn decode(raw: &str) -> Option<String> {
    let mut result = Vec::with_capacity(raw.len());
    let mut chars = raw.bytes();
    while let Some(b) = chars.next() {
        let decoded = if b == b'%' {
            let hi = (chars.next()? as char).to_digit(16)?;
            let lo = (chars.next()? as char).to_digit(16)?;
            (hi * 16 + lo) as u8
        } else {
            b
        };
        if !decoded.is_ascii_graphic() || [b'%', b'\\', b'+', b'#'].contains(&decoded) {
            return None;
        }
        result.push(decoded);
    }
    String::from_utf8(result).ok()
}
fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && !value.contains("..")
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
}
/// SPA routes mirror packages/web/src/nav.ts; API, auth, setup and arbitrary URLs are excluded.
pub fn allowed_path(path: &str) -> bool {
    if path.len() > 1024 || !path.starts_with('/') {
        return false;
    }
    let parts: Vec<_> = path[1..].split('/').collect();
    parts.len() <= 4
        && parts.iter().all(|p| identifier(p) && *p != ".")
        && [
            "home",
            "chat",
            "projects",
            "agents",
            "inbox",
            "memories",
            "library",
            "skills",
            "plugins",
            "models",
            "switchboard",
            "recurring",
            "approvals",
            "breakglass",
            "usage",
            "doctor",
            "logs",
            "settings",
            "help",
            "media",
            "identities",
        ]
        .contains(&parts[0])
}
/// Fixed, argument-free diagnostic for every unsupported external input.
pub const IGNORED_LOG: &str = "DESKTOP_DEEP_LINK_IGNORED";
/// OS file associations and argv use the same parser. The hook never opens or reads a file.
pub fn parse_argument(input: &str) -> DeepLink {
    if input.len() <= 4096 && !input.chars().any(char::is_control) {
        let path = std::path::Path::new(input);
        if path.is_absolute() && path.extension().is_some_and(|ext| ext == "p1x") {
            return DeepLink::P1x;
        }
        if let Ok(url) = url::Url::parse(input) {
            if url.scheme() == "file"
                && url
                    .host_str()
                    .is_none_or(|h| h.is_empty() || h == "localhost")
                && url.query().is_none()
                && url.fragment().is_none()
                && url
                    .to_file_path()
                    .ok()
                    .is_some_and(|p| p.extension().is_some_and(|ext| ext == "p1x"))
            {
                return DeepLink::P1x;
            }
        }
    }
    parse(input)
}

/// Intent delivered only to the bundled shell after its listener is ready.
#[derive(Clone, Serialize)]
pub struct Envelope {
    pub id: u64,
    pub intent: DeepLink,
}
/// Bounded in-memory mailbox. Neither pairing codes nor file paths are persisted.
#[derive(Default)]
pub struct Inbox {
    next_id: u64,
    pending: std::collections::VecDeque<Envelope>,
    offered: std::collections::BTreeMap<u64, DeepLink>,
}
impl Inbox {
    /// Ingest first- and second-instance argv; executable is skipped, every argument is untrusted.
    pub fn argv<'a>(
        &mut self,
        args: impl IntoIterator<Item = &'a str>,
        mut log: impl FnMut(&'static str),
    ) {
        for input in args.into_iter().skip(1).take(64) {
            if input == "--autostart" {
                continue;
            }
            self.ingest(input, &mut log);
        }
    }
    /// OS URLs and argv enter through exactly the same validation function.
    pub fn ingest(&mut self, input: &str, mut log: impl FnMut(&'static str)) {
        let intent = parse_argument(input);
        if intent == DeepLink::Ignored || self.pending.len() >= 16 {
            log(IGNORED_LOG);
            return;
        }
        self.next_id = self.next_id.saturating_add(1);
        self.pending.push_back(Envelope {
            id: self.next_id,
            intent,
        });
    }
    /// Pull after listener installation; retain pairing provenance in Rust until explicit submission.
    pub fn take(&mut self) -> Option<Envelope> {
        self.offered.clear();
        let next = self.pending.pop_front()?;
        if matches!(next.intent, DeepLink::Pair { .. }) {
            if self.offered.len() >= 16 {
                self.offered.pop_first();
            }
            self.offered.insert(next.id, next.intent.clone());
        }
        Some(next)
    }
    /// Forget a completed offer; a failed explicit attempt can be retried until dismissed.
    pub fn finish_pair(&mut self, id: u64) {
        self.offered.remove(&id);
    }
    /// A link pin applies only to the exact displayed origin and code.
    pub fn confirm_pair(&mut self, id: u64, origin: &str, code: &str) -> Option<DeepLink> {
        let offer = self.offered.get(&id)?.clone();
        match &offer {
            DeepLink::Pair {
                origin: expected,
                code: expected_code,
                ..
            } if expected.as_str() == origin && expected_code == code => Some(offer),
            _ => None,
        }
    }
}
/// Native mailbox shared by launch, OS-open events and the singleton callback.
#[derive(Default)]
pub struct LinkState(pub std::sync::Mutex<Inbox>);
/// Route OS inputs without showing an incompletely loaded initial window.
pub fn dispatch(app: &tauri::AppHandle, args: Vec<String>) {
    use tauri::{Emitter, Manager};
    if let Some(state) = app.try_state::<LinkState>() {
        state
            .0
            .lock()
            .unwrap()
            .argv(args.iter().map(String::as_str), |_| {
                let native = app.state::<crate::native::NativeState>();
                if let Ok(diagnostics) = native.diagnostics.lock() {
                    if let Some(diagnostics) = diagnostics.as_ref() {
                        let _ = diagnostics.writer.emit(crate::logging::RecordInput::new(
                            crate::logging::Event::DeeplinkIgnored,
                        ));
                    }
                };
            });
        if let Some(shell) = app.get_webview_window("shell") {
            let _ = shell.emit("desktop-link-pending", ());
        }
    }
}
/// Production singleton callback; routes arguments before focusing the existing shell.
pub fn second_instance(app: &tauri::AppHandle, args: Vec<String>, _cwd: String) {
    dispatch(app, args);
    crate::native::focus(app);
}
/// Fetch only from the trusted shell, never the SPA. Event payloads carry no input.
#[tauri::command]
pub fn deep_link_next(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, LinkState>,
) -> Result<Option<Envelope>, String> {
    crate::commands::check(&window, "deep_link_next")?;
    Ok(state.0.lock().unwrap().take())
}
/// Closed shell IPC request; this is a SPA path, never a URL or origin to fetch.
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpenRequest {
    pub path: String,
}
/// Navigate an already-open SPA for the current connection only; no connection switch or login side effect.
#[tauri::command]
pub fn deep_link_open(window: tauri::WebviewWindow, request: OpenRequest) -> Result<(), String> {
    use tauri::Manager;
    crate::commands::check(&window, "deep_link_open")?;
    if !allowed_path(&request.path) {
        return Err("invalid".into());
    }
    let app = window.app_handle();
    let active = crate::commands::app_connection_store(app)?
        .active()
        .map_err(|_| "storage")?
        .ok_or("pairing-needed")?;
    crate::spa::navigate_active(app, active, &request.path)
}
