//! GNOME notification decisions; no OS notification or portal is used by model tests.
use crate::tray::{HarnessState, TrayState};
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Action {
    Open,
    Dismiss,
    ShowLog,
    StartAgain,
    Later,
    Update,
}
impl Action {
    pub fn id(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Dismiss => "dismiss",
            Self::ShowLog => "show-log",
            Self::StartAgain => "start-again",
            Self::Later => "later",
            Self::Update => "update",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Open => "Open",
            Self::Dismiss => "Dismiss",
            Self::ShowLog => "Show log",
            Self::StartAgain => "Start again",
            Self::Later => "Later",
            Self::Update => "Update…",
        }
    }
    pub fn parse(value: &str) -> Option<Self> {
        [
            Self::Open,
            Self::Dismiss,
            Self::ShowLog,
            Self::StartAgain,
            Self::Later,
            Self::Update,
        ]
        .into_iter()
        .find(|action| action.id() == value)
    }
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Banner {
    pub state: TrayState,
    pub actions: [Action; 2],
}
impl Banner {
    pub fn from_state(state: &TrayState) -> Self {
        let actions = if state.update_available {
            [Action::Later, Action::Update]
        } else if matches!(
            state.harness,
            HarnessState::Down | HarnessState::Crashed | HarnessState::Rollback
        ) {
            [Action::ShowLog, Action::StartAgain]
        } else {
            [Action::Open, Action::Dismiss]
        };
        Self {
            state: state.clone(),
            actions,
        }
    }
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NotifyFailure;
pub trait Notifier {
    fn show(&mut self, banner: &Banner) -> Result<(), NotifyFailure>;
}
#[derive(Default)]
pub struct StateObserver {
    last: Option<TrayState>,
}
impl StateObserver {
    pub fn changed(
        &mut self,
        tray_host: bool,
        state: &TrayState,
        notifier: &mut impl Notifier,
    ) -> Result<bool, NotifyFailure> {
        if tray_host {
            self.last = None;
            return Ok(false);
        }
        if self.last.as_ref() == Some(state) {
            return Ok(false);
        }
        notifier.show(&Banner::from_state(state))?;
        self.last = Some(state.clone());
        Ok(true)
    }
}
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct BackgroundGrant {
    pub background: bool,
    pub autostart: bool,
}
impl BackgroundGrant {
    pub fn may_hide(self, tray_host: bool) -> bool {
        tray_host || self.background
    }
}

#[cfg(unix)]
pub mod dbus {
    use super::*;
    use std::{collections::HashMap, time::Duration};
    use zbus::{zvariant::Value, Connection, Proxy};
    /// Only registered hosts count, not merely a process owning the watcher's name.
    pub async fn tray_host(connection: &Connection) -> Result<bool, NotifyFailure> {
        tokio::time::timeout(Duration::from_secs(3), async {
            let watcher = Proxy::new(
                connection,
                "org.kde.StatusNotifierWatcher",
                "/StatusNotifierWatcher",
                "org.kde.StatusNotifierWatcher",
            )
            .await
            .map_err(|_| NotifyFailure)?;
            watcher
                .get_property::<bool>("IsStatusNotifierHostRegistered")
                .await
                .map_err(|_| NotifyFailure)
        })
        .await
        .map_err(|_| NotifyFailure)?
    }
    /// Returns the native ID; callers must retain the allowed actions and connection generation.
    pub async fn show(connection: &Connection, banner: &Banner) -> Result<u32, NotifyFailure> {
        tokio::time::timeout(Duration::from_secs(3), async {
            let service = Proxy::new(
                connection,
                "org.freedesktop.Notifications",
                "/org/freedesktop/Notifications",
                "org.freedesktop.Notifications",
            )
            .await
            .map_err(|_| NotifyFailure)?;
            let caps: Vec<String> = service
                .call("GetCapabilities", &())
                .await
                .map_err(|_| NotifyFailure)?;
            if !caps.iter().any(|cap| cap == "actions") {
                return Err(NotifyFailure);
            }
            let actions: Vec<&str> = banner
                .actions
                .iter()
                .flat_map(|action| [action.id(), action.label()])
                .collect();
            let mut hints: HashMap<&str, Value<'_>> = HashMap::new();
            hints.insert("desktop-entry", Value::from(crate::ids::BUNDLE_ID));
            service
                .call(
                    "Notify",
                    &(
                        "PLUR1BUS",
                        0u32,
                        crate::ids::BUNDLE_ID,
                        "PLUR1BUS",
                        banner.state.harness.words(),
                        actions,
                        hints,
                        -1i32,
                    ),
                )
                .await
                .map_err(|_| NotifyFailure)
        })
        .await
        .map_err(|_| NotifyFailure)?
    }
}

#[cfg(unix)]
pub mod portal {
    use super::{BackgroundGrant, NotifyFailure};
    use futures_util::StreamExt;
    use std::{collections::HashMap, time::Duration};
    use zbus::{
        zvariant::{OwnedObjectPath, OwnedValue, Value},
        Connection, Proxy,
    };
    /// Subscribe before RequestBackground: the response may arrive before its method reply.
    pub async fn request_background(
        connection: &Connection,
        autostart: bool,
        executable: &str,
    ) -> Result<BackgroundGrant, NotifyFailure> {
        let token = format!("p1b{}", uuid::Uuid::now_v7().simple());
        let sender = connection
            .unique_name()
            .ok_or(NotifyFailure)?
            .as_str()
            .trim_start_matches(':')
            .replace('.', "_");
        let path = format!("/org/freedesktop/portal/desktop/request/{sender}/{token}");
        let result = tokio::time::timeout(Duration::from_secs(120), async {
            let request = Proxy::new(
                connection,
                "org.freedesktop.portal.Desktop",
                path.as_str(),
                "org.freedesktop.portal.Request",
            )
            .await
            .map_err(|_| NotifyFailure)?;
            let mut response = request
                .receive_signal("Response")
                .await
                .map_err(|_| NotifyFailure)?;
            let portal = Proxy::new(
                connection,
                "org.freedesktop.portal.Desktop",
                "/org/freedesktop/portal/desktop",
                "org.freedesktop.portal.Background",
            )
            .await
            .map_err(|_| NotifyFailure)?;
            let mut options: HashMap<&str, Value<'_>> = HashMap::new();
            options.insert("handle_token", Value::from(token.as_str()));
            options.insert(
                "reason",
                Value::from("Keep PLUR1BUS available in the background"),
            );
            options.insert("autostart", Value::from(autostart));
            options.insert("commandline", Value::new(vec![executable, "--autostart"]));
            options.insert("dbus-activatable", Value::from(false));
            let actual: OwnedObjectPath = portal
                .call("RequestBackground", &("", options))
                .await
                .map_err(|_| NotifyFailure)?;
            if actual.as_str() != path {
                return Err(NotifyFailure);
            }
            let message = response.next().await.ok_or(NotifyFailure)?;
            let (code, mut values): (u32, HashMap<String, OwnedValue>) =
                message.body().deserialize().map_err(|_| NotifyFailure)?;
            if code != 0 {
                return Ok(BackgroundGrant::default());
            }
            Ok(BackgroundGrant {
                background: values
                    .remove("background")
                    .and_then(|value| bool::try_from(value).ok())
                    .unwrap_or(false),
                autostart: values
                    .remove("autostart")
                    .and_then(|value| bool::try_from(value).ok())
                    .unwrap_or(false),
            })
        })
        .await;
        match result {
            Ok(result) => result,
            Err(_) => {
                // Close a pending permission request rather than leaving it to complete later.
                let _ = tokio::time::timeout(Duration::from_secs(3), async {
                    let request = Proxy::new(
                        connection,
                        "org.freedesktop.portal.Desktop",
                        path.as_str(),
                        "org.freedesktop.portal.Request",
                    )
                    .await?;
                    request.call::<_, _, ()>("Close", &()).await
                })
                .await;
                Err(NotifyFailure)
            }
        }
    }
}

/// Bounded, one-shot registrations; only actions offered by this app can be resolved.
#[derive(Default)]
pub struct ActionLedger(std::collections::VecDeque<(u32, u64, [Action; 2])>);
impl ActionLedger {
    pub fn record(&mut self, id: u32, generation: u64, actions: [Action; 2]) {
        if id == 0 {
            return;
        }
        self.0.retain(|entry| entry.0 != id);
        if self.0.len() == 64 {
            self.0.pop_front();
        }
        self.0.push_back((id, generation, actions));
    }
    pub fn resolve(&mut self, id: u32, action: &str, generation: u64) -> Option<Action> {
        let index = self.0.iter().position(|entry| entry.0 == id)?;
        let entry = self.0.get(index)?;
        if entry.1 != generation {
            self.0.remove(index);
            return None;
        }
        let action = Action::parse(action)?;
        if !entry.2.contains(&action) {
            return None;
        }
        self.0.remove(index);
        Some(action)
    }
}
