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
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayState {
    pub harness: HarnessState,
    pub runtime: Option<RuntimeState>,
    pub secrets_locked: bool,
    pub update_available: bool,
    pub held: bool,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Badge {
    Running,
    Busy,
    Attention,
    Update,
}
impl TrayState {
    pub fn badge(&self) -> Badge {
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
        format!(
            "PLUR1BUS — {connection} — {}{runtime}{locked}",
            self.harness(view.harness)
        )
    }
}
