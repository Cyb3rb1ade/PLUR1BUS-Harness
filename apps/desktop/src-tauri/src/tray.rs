//! Complete harness/runtime states remain visible in words; badges collapse only the icon classes.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HarnessState {
    Starting,
    Ready,
    Degraded,
    Down,
    #[default]
    Unpaired,
    Updating,
    Rollback,
    Crashed,
}
impl HarnessState {
    pub fn words(self) -> &'static str {
        match self {
            Self::Starting => "Starting",
            Self::Ready => "Running",
            Self::Degraded => "Degraded",
            Self::Down => "Stopped",
            Self::Unpaired => "Not paired",
            Self::Updating => "Updating",
            Self::Rollback => "Rolling back",
            Self::Crashed => "Crashed",
        }
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeState {
    Ready,
    Stopped,
    Missing,
}
#[derive(Clone, Debug, Default)]
pub struct HarnessStatus {
    pub runtime: Option<RuntimeState>,
    pub crashed: bool,
    pub secrets_locked: bool,
}
#[derive(Clone, Debug, Default)]
pub struct UpdateModelState {
    pub updating: bool,
    pub rollback: bool,
    pub available: bool,
    pub held: bool,
}
/// The path of the active remote connection in the tray header (transport choice spec §7.3).
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PathLabel {
    Tailscale,
    Direct,
    DirectPublic,
}
impl PathLabel {
    /// „Über Tailscale“ is always the Tailscale path; a direct path is public when the open's check found a public
    /// target.
    pub fn of(transport: crate::transport::Transport, public: bool) -> Self {
        match (transport, public) {
            (crate::transport::Transport::Tailscale, _) => Self::Tailscale,
            (crate::transport::Transport::Direct, true) => Self::DirectPublic,
            (crate::transport::Transport::Direct, false) => Self::Direct,
        }
    }
}
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayState {
    pub harness: HarnessState,
    pub runtime: Option<RuntimeState>,
    pub secrets_locked: bool,
    pub update_available: bool,
    pub held: bool,
    /// The active remote connection's path; `None` for bundled and local connections or none.
    pub path: Option<PathLabel>,
    /// The active connection's path needs the person: a Tailscale disconnect (daemon down, stopped, needs login, peer
    /// offline), `tailscale-unreachable`, `tailscale-route-mismatch`, or a reconnect stopped because the target needs a
    /// confirmation. The badge shows *Attention*.
    pub transport_attention: bool,
    /// The attention is one of the four Tailscale disconnect states (the header says „Tailscale getrennt“).
    pub tailscale_notice: bool,
}
/// The hint codes of an actual Tailscale disconnect (transport choice spec §7.3): the daemon is down, Tailscale is
/// stopped or needs a login, or the matched peer is offline. Only these read „Tailscale getrennt“.
pub const TAILSCALE_DISCONNECTED: [&str; 4] = [
    "tailscale-daemon-down",
    "tailscale-stopped",
    "tailscale-needs-login",
    "tailscale-peer-offline",
];
/// The hint codes of a Tailscale path that does not work although Tailscale runs (the probe failed, or the connection
/// left through another interface): the attention badge, without „Tailscale getrennt“.
pub const TAILSCALE_PATH_BROKEN: [&str; 2] = ["tailscale-unreachable", "tailscale-route-mismatch"];
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Badge {
    Running,
    Busy,
    Attention,
    Update,
}
impl TrayState {
    /// The active connection's path after a check (transport choice spec §7.3): its label, and whether Tailscale is
    /// disconnected for it ([`TAILSCALE_DISCONNECTED`]: „Tailscale getrennt“ and the attention badge). A chosen path
    /// that does not work ([`TAILSCALE_PATH_BROKEN`]) sets the badge without that text. Other Tailscale notices, such
    /// as an unprobed subnet route, set neither. `None` (bundled, local, no connection) clears both.
    pub fn set_transport(
        &mut self,
        checked: Option<(
            crate::transport::Transport,
            &crate::transport::TransportReport,
        )>,
    ) {
        match checked {
            Some((transport, report)) => {
                self.path = Some(PathLabel::of(
                    transport,
                    report.category == Some(crate::transport::Category::Public),
                ));
                self.tailscale_notice = report
                    .hints
                    .iter()
                    .any(|h| TAILSCALE_DISCONNECTED.contains(&h.code));
                self.transport_attention = self.tailscale_notice
                    || report
                        .hints
                        .iter()
                        .any(|h| TAILSCALE_PATH_BROKEN.contains(&h.code));
            }
            None => {
                self.path = None;
                self.tailscale_notice = false;
                self.transport_attention = false;
            }
        }
    }
    /// A reconnect stopped because the target needs a confirmation (spec §9.2): the path is public now.
    pub fn set_confirm_needed(&mut self, transport: crate::transport::Transport) {
        self.path = Some(PathLabel::of(transport, true));
        self.tailscale_notice = false;
        self.transport_attention = true;
    }
    pub fn badge(&self) -> Badge {
        if self.transport_attention || self.tailscale_notice {
            return Badge::Attention;
        }
        match self.harness {
            HarnessState::Starting | HarnessState::Updating => Badge::Busy,
            HarnessState::Ready if self.secrets_locked => Badge::Attention,
            HarnessState::Ready if self.update_available => Badge::Update,
            HarnessState::Ready => Badge::Running,
            _ => Badge::Attention,
        }
    }
}
pub fn map_status(event: &Value) -> HarnessState {
    match event.get("state").and_then(Value::as_str) {
        Some("starting") => HarnessState::Starting,
        Some("ready") => HarnessState::Ready,
        Some("degraded") => HarnessState::Degraded,
        Some("down") => HarnessState::Down,
        Some("unpaired") => HarnessState::Unpaired,
        Some("updating") => HarnessState::Updating,
        Some("rollback") => HarnessState::Rollback,
        Some("crashed") => HarnessState::Crashed,
        _ => HarnessState::Degraded,
    }
}
pub fn combine(
    controller: &HarnessStatus,
    event: HarnessState,
    update: &UpdateModelState,
) -> TrayState {
    let harness = if update.rollback {
        HarnessState::Rollback
    } else if update.updating {
        HarnessState::Updating
    } else if controller.crashed {
        HarnessState::Crashed
    } else if controller
        .runtime
        .is_some_and(|runtime| runtime != RuntimeState::Ready)
    {
        HarnessState::Down
    } else {
        event
    };
    TrayState {
        harness,
        runtime: controller.runtime,
        secrets_locked: controller.secrets_locked,
        update_available: update.available,
        held: update.held,
        ..TrayState::default()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Language {
    En,
    De,
}
impl Language {
    pub fn resolve(preference: crate::settings::Locale, system: &str) -> Self {
        match preference {
            crate::settings::Locale::De => Self::De,
            crate::settings::Locale::En => Self::En,
            crate::settings::Locale::System
                if system
                    .split(['-', '_'])
                    .next()
                    .is_some_and(|part| part.eq_ignore_ascii_case("de")) =>
            {
                Self::De
            }
            _ => Self::En,
        }
    }
    pub fn text(self, id: &str) -> &'static str {
        match (self, id) {
            (Self::De, "open") => "PLUR1BUS öffnen",
            (Self::De, "start-harness") => "Harness starten",
            (Self::De, "stop-harness") => "Harness stoppen",
            (Self::De, "start-runtime") => "Runtime starten",
            (Self::De, "update") => "Update verfügbar…",
            (Self::De, "connections") => "Verbindungen…",
            (Self::De, "settings") => "Einstellungen…",
            (Self::De, "quit") => "PLUR1BUS beenden",
            (Self::De, "no-connection") => "Keine Verbindung",
            (Self::De, "path-tailscale") => "Tailscale",
            (Self::De, "path-direct") => "direkt",
            (Self::De, "path-public") => "direkt, öffentlich",
            (Self::De, "tailscale-attention") => "Tailscale getrennt",
            (Self::De, "switch") => "Verbindung wechseln",
            (Self::De, "manage") => "Verbindungen verwalten…",
            (Self::De, "more") => "Weitere Verbindungen…",
            (Self::De, "reason-not-bundled") => "wechsle zur gebündelten Verbindung",
            (Self::De, "reason-runtime-down") => "Runtime nicht erreichbar",
            (Self::De, "reason-not-installed") => "nicht installiert",
            (Self::De, "reason-busy") => "Vorgang läuft",
            (Self::De, "reason-running") => "läuft bereits",
            (Self::De, "reason-stopped") => "läuft nicht",
            (_, "switch") => "Switch connection",
            (_, "manage") => "Manage connections…",
            (_, "more") => "More connections…",
            (_, "reason-not-bundled") => "switch to the bundled connection",
            (_, "reason-runtime-down") => "runtime not reachable",
            (_, "reason-not-installed") => "not installed",
            (_, "reason-busy") => "operation in progress",
            (_, "reason-running") => "already running",
            (_, "reason-stopped") => "not running",
            (_, "path-tailscale") => "Tailscale",
            (_, "path-direct") => "direct",
            (_, "path-public") => "direct, public",
            (_, "tailscale-attention") => "Tailscale disconnected",
            (_, "open") => "Open PLUR1BUS",
            (_, "start-harness") => "Start harness",
            (_, "stop-harness") => "Stop harness",
            (_, "start-runtime") => "Start runtime",
            (_, "update") => "Update available…",
            (_, "connections") => "Connections…",
            (_, "settings") => "Settings…",
            (_, "quit") => "Quit PLUR1BUS",
            _ => "No connection",
        }
    }
    pub fn harness(self, state: HarnessState) -> &'static str {
        if self == Self::En {
            return state.words();
        }
        match state {
            HarnessState::Starting => "Startet",
            HarnessState::Ready => "Läuft",
            HarnessState::Degraded => "Eingeschränkt",
            HarnessState::Down => "Gestoppt",
            HarnessState::Unpaired => "Nicht gekoppelt",
            HarnessState::Updating => "Wird aktualisiert",
            HarnessState::Rollback => "Wird zurückgesetzt",
            HarnessState::Crashed => "Abgestürzt",
        }
    }
    pub fn status(self, view: &TrayState, connection: &str) -> String {
        let runtime = match (self, view.runtime) {
            (Self::De, Some(RuntimeState::Ready)) => " — Runtime läuft",
            (Self::De, Some(RuntimeState::Stopped)) => " — Runtime gestoppt",
            (Self::De, Some(RuntimeState::Missing)) => " — Runtime fehlt",
            (_, Some(RuntimeState::Ready)) => " — Runtime running",
            (_, Some(RuntimeState::Stopped)) => " — Runtime stopped",
            (_, Some(RuntimeState::Missing)) => " — Runtime missing",
            (_, None) => "",
        };
        let locked = match (self, view.secrets_locked) {
            (Self::De, true) => " — Geheimnisspeicher gesperrt",
            (_, true) => " — Secrets store locked",
            (_, false) => "",
        };
        // Transport choice spec §7.3: `PLUR1BUS — {connection} · {path} — {state}`, the path omitted for bundled and
        // local connections, and a Tailscale notice appended.
        let path = match view.path {
            Some(PathLabel::Tailscale) => format!(" · {}", self.text("path-tailscale")),
            Some(PathLabel::Direct) => format!(" · {}", self.text("path-direct")),
            Some(PathLabel::DirectPublic) => format!(" · {}", self.text("path-public")),
            None => String::new(),
        };
        let tailscale = if view.tailscale_notice {
            format!(" — {}", self.text("tailscale-attention"))
        } else {
            String::new()
        };
        format!(
            "PLUR1BUS — {connection}{path} — {}{runtime}{locked}{tailscale}",
            self.harness(view.harness)
        )
    }
}

// Package T4b (desktop spec §6.3, transport choice spec §7.3): the tray's connection switch and its harness controls.
// Everything here is decided from `connections.json`, the transport store and native state; no value of it comes
// from a webview.

/// The switch lists at most this many connections, then *More…* (`#/connections`).
pub const SWITCH_LIMIT: usize = 20;
/// A switch entry's menu id is this prefix and the connection's id, generated by the app.
pub const CONNECTION_ID_PREFIX: &str = "connection:";
/// A burst of connection-list or active-connection changes is gathered this long before the menu is rebuilt once.
pub const REBUILD_DEBOUNCE: std::time::Duration = std::time::Duration::from_millis(150);

/// One connection as the switch shows it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SwitchRow {
    pub id: uuid::Uuid,
    pub name: String,
    /// A remote row's stored path (a confirmed public target reads „direkt, öffentlich“); `None` for bundled and
    /// local rows.
    pub path: Option<PathLabel>,
}
impl SwitchRow {
    /// The rows of `connections.json` in its order, each remote row with its path from the transport store.
    pub fn load(
        connections: &crate::connections::Store,
        transports: &crate::transport::Transports,
        store: &crate::transport::TransportStore,
    ) -> Result<Vec<Self>, crate::connections::StoreError> {
        Ok(connections
            .load()?
            .into_iter()
            .map(|row| {
                let path = (row.kind == crate::connections::Kind::Remote).then(|| {
                    let view = transports.view(store, &row);
                    PathLabel::of(view.transport, view.public_ack)
                });
                Self {
                    id: row.id,
                    name: row.name,
                    path,
                }
            })
            .collect())
    }
}

/// One entry of the switch: `{name} ({path})` (spec §7.3), the active connection checked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SwitchEntry {
    pub menu_id: String,
    pub id: uuid::Uuid,
    pub text: String,
    pub checked: bool,
}

/// The *Connections* submenu and the item after it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SwitchMenu {
    pub title: &'static str,
    pub entries: Vec<SwitchEntry>,
    /// A disabled line in place of the entries when there is no connection.
    pub empty: Option<&'static str>,
    /// *More…* (`#/connections`) after the first [`SWITCH_LIMIT`] entries.
    pub more: Option<&'static str>,
    /// *Manage connections…* (`#/connections`).
    pub manage: &'static str,
}
impl SwitchMenu {
    /// The connections this menu offers: the only ids a switch event is accepted for.
    pub fn offered(&self) -> Vec<uuid::Uuid> {
        self.entries.iter().map(|e| e.id).collect()
    }
}

/// Native menus read `&` as a mnemonic marker; a name shows it literally.
fn menu_text(text: &str) -> String {
    text.replace('&', "&&")
}

/// Why a harness control is disabled; its text follows the item (native menus have no tooltips).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ControlReason {
    /// The active connection is not the bundled one (remote, local or none).
    NotBundled,
    /// The container runtime is not reachable, or its state is not known yet.
    RuntimeDown,
    /// The bundled harness is not installed.
    NotInstalled,
    /// A start, stop, upgrade or rollback is running.
    Busy,
    Running,
    Stopped,
}
impl ControlReason {
    pub fn code(self) -> &'static str {
        match self {
            Self::NotBundled => "not-bundled",
            Self::RuntimeDown => "runtime-down",
            Self::NotInstalled => "not-installed",
            Self::Busy => "busy",
            Self::Running => "running",
            Self::Stopped => "stopped",
        }
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Control {
    Enabled,
    Disabled(ControlReason),
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HarnessOp {
    Start,
    Stop,
}
/// *Start harness* and *Stop harness*: enabled only for the active bundled connection whose runtime is reachable.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct HarnessControls {
    pub start: Control,
    pub stop: Control,
}
impl HarnessControls {
    /// `active` is the kind of the connection open now, `controller` the runtime controller's last status, `busy`
    /// whether a start, stop, upgrade or rollback is running.
    pub fn of(
        active: Option<&crate::connections::Kind>,
        controller: Option<&crate::controller::HarnessStatus>,
        busy: bool,
    ) -> Self {
        use crate::controller::HarnessStatus;
        let both = |reason| Self {
            start: Control::Disabled(reason),
            stop: Control::Disabled(reason),
        };
        if active != Some(&crate::connections::Kind::Bundled) {
            return both(ControlReason::NotBundled);
        }
        if busy {
            return both(ControlReason::Busy);
        }
        match controller {
            None | Some(HarnessStatus::RuntimeDown) => both(ControlReason::RuntimeDown),
            Some(HarnessStatus::NotInstalled) => both(ControlReason::NotInstalled),
            Some(HarnessStatus::Starting) => Self {
                start: Control::Disabled(ControlReason::Busy),
                stop: Control::Enabled,
            },
            Some(HarnessStatus::Ready { .. }) => Self {
                start: Control::Disabled(ControlReason::Running),
                stop: Control::Enabled,
            },
            Some(HarnessStatus::Stopped | HarnessStatus::Crashed { .. }) => Self {
                start: Control::Enabled,
                stop: Control::Disabled(ControlReason::Stopped),
            },
        }
    }
    /// A click is honoured only while its control is enabled now (the menu it came from may be older).
    pub fn request(&self, op: HarnessOp) -> Result<HarnessOp, ControlReason> {
        let control = match op {
            HarnessOp::Start => self.start,
            HarnessOp::Stop => self.stop,
        };
        match control {
            Control::Enabled => Ok(op),
            Control::Disabled(reason) => Err(reason),
        }
    }
}

/// What a tray menu event asks for. Ids come only from the native menu the app built.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TrayAction {
    Open,
    /// Open this connection the way *Open* in the connection list does.
    Switch(uuid::Uuid),
    /// *Manage connections…* and *More…*: the connection list.
    Connections,
    HarnessStart,
    HarnessStop,
    Update,
    Settings,
    Quit,
}
impl TrayAction {
    /// `offered` are the connections of the menu last built ([`SwitchMenu::offered`]); a connection id outside it, or
    /// not in the app's own hyphenated form, is ignored.
    pub fn parse(id: &str, offered: &[uuid::Uuid]) -> Option<Self> {
        Some(match id {
            "open" => Self::Open,
            "connections" | "more" => Self::Connections,
            "harness-start" => Self::HarnessStart,
            "harness-stop" => Self::HarnessStop,
            "update" => Self::Update,
            "settings" => Self::Settings,
            "quit" => Self::Quit,
            _ => {
                let raw = id.strip_prefix(CONNECTION_ID_PREFIX)?;
                let uuid = uuid::Uuid::try_parse(raw).ok()?;
                if uuid.hyphenated().to_string() != raw || !offered.contains(&uuid) {
                    return None;
                }
                Self::Switch(uuid)
            }
        })
    }
}

/// How a switch from the tray ended.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SwitchOutcome {
    Opened,
    /// The open path's gate refused with `transport-confirm-needed` before any harness contact: the shell shows the
    /// connection's confirm dialog.
    ConfirmNeeded(uuid::Uuid),
    /// The connection is no longer in `connections.json`: nothing to do but rebuild the menu.
    Ignored,
    /// The open failed with this code: the shell shows it on the connection.
    Failed(uuid::Uuid, String),
}
impl SwitchOutcome {
    pub fn of<T>(id: uuid::Uuid, result: Result<T, String>) -> Self {
        match result {
            Ok(_) => Self::Opened,
            Err(code) if code == crate::transport::TransportError::ConfirmNeeded.code() => {
                Self::ConfirmNeeded(id)
            }
            Err(code) => Self::Failed(id, code),
        }
    }
    /// The shell route this outcome opens.
    pub fn route(&self) -> Option<&'static str> {
        match self {
            Self::ConfirmNeeded(_) | Self::Failed(..) => Some("#/connections"),
            Self::Opened | Self::Ignored => None,
        }
    }
}

/// A switch from the tray: the open path of the connection list's *Open* ([`crate::transport::Transports::open_gated`],
/// the T4 gate before `connect`), its result as a [`SwitchOutcome`]. `connect` is the harness contact
/// (`commands::connect_checked` in the app); it never runs when the gate refuses.
pub async fn switch<T, F, Fut>(
    transports: &crate::transport::Transports,
    connections: &crate::connections::Store,
    store: &crate::transport::TransportStore,
    id: uuid::Uuid,
    connect: F,
) -> SwitchOutcome
where
    F: FnOnce(
        crate::connections::Connection,
        Option<(crate::transport::CheckedTarget, crate::transport::Transport)>,
    ) -> Fut,
    Fut: std::future::Future<Output = Result<T, String>>,
{
    let result = transports.open_gated(connections, store, id, connect).await;
    // Removed: the row is really gone. Any other `invalid` (the row changed between gate and contact, no shell window
    // for a bundled repair) is a failure the list shows, as *Open* does.
    if matches!(&result, Err(code) if code == "invalid")
        && connections
            .load()
            .is_ok_and(|rows| rows.iter().all(|row| row.id != id))
    {
        return SwitchOutcome::Ignored;
    }
    SwitchOutcome::of(id, result)
}

/// Gathers rebuild requests: each request takes a ticket, and only the latest ticket rebuilds after the debounce.
#[derive(Debug, Default)]
pub struct Debounce(std::sync::atomic::AtomicU64);
impl Debounce {
    pub fn schedule(&self) -> u64 {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1
    }
    pub fn is_latest(&self, ticket: u64) -> bool {
        self.0.load(std::sync::atomic::Ordering::SeqCst) == ticket
    }
}

impl Language {
    fn path_text(self, path: PathLabel) -> &'static str {
        match path {
            PathLabel::Tailscale => self.text("path-tailscale"),
            PathLabel::Direct => self.text("path-direct"),
            PathLabel::DirectPublic => self.text("path-public"),
        }
    }
    /// The switch for `rows` (in their order). `active` is the connection open now; its path is the one of its last
    /// check (`active_path`, the header's) when there is one.
    pub fn switch_menu(
        self,
        rows: &[SwitchRow],
        active: Option<uuid::Uuid>,
        active_path: Option<PathLabel>,
    ) -> SwitchMenu {
        // The open connection is always listed: past the limit, it takes the last place.
        let mut shown: Vec<&SwitchRow> = rows.iter().take(SWITCH_LIMIT).collect();
        if let Some(open) =
            active.and_then(|id| rows.iter().skip(SWITCH_LIMIT).find(|r| r.id == id))
        {
            if let Some(last) = shown.last_mut() {
                *last = open;
            }
        }
        let entries = shown
            .into_iter()
            .map(|row| {
                let checked = active == Some(row.id);
                let path = if checked {
                    active_path.or(row.path)
                } else {
                    row.path
                };
                let name = menu_text(&row.name);
                SwitchEntry {
                    menu_id: format!("{CONNECTION_ID_PREFIX}{}", row.id.hyphenated()),
                    id: row.id,
                    text: match path {
                        Some(path) => format!("{name} ({})", self.path_text(path)),
                        None => name,
                    },
                    checked,
                }
            })
            .collect();
        SwitchMenu {
            title: self.text("switch"),
            entries,
            empty: rows.is_empty().then(|| self.text("no-connection")),
            more: (rows.len() > SWITCH_LIMIT).then(|| self.text("more")),
            manage: self.text("manage"),
        }
    }
    /// *Start harness* / *Stop harness*, followed by the reason when disabled.
    pub fn control(self, op: HarnessOp, control: Control) -> String {
        let label = self.text(match op {
            HarnessOp::Start => "start-harness",
            HarnessOp::Stop => "stop-harness",
        });
        match control {
            Control::Enabled => label.to_owned(),
            Control::Disabled(reason) => {
                format!(
                    "{label} — {}",
                    self.text(&format!("reason-{}", reason.code()))
                )
            }
        }
    }
}
