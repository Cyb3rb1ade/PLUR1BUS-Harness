//! Resident-window and quit decisions, with OS operations behind test seams.
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tokio::task::JoinHandle;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WindowFailure {
    Unavailable,
    Show,
    Unminimize,
    Focus,
    Hide,
    Minimize,
}
impl WindowFailure {
    pub fn code(self) -> &'static str {
        match self {
            Self::Unavailable => "WINDOW_UNAVAILABLE",
            Self::Show => "WINDOW_SHOW_FAILED",
            Self::Unminimize => "WINDOW_UNMINIMIZE_FAILED",
            Self::Focus => "WINDOW_FOCUS_FAILED",
            Self::Hide => "WINDOW_HIDE_FAILED",
            Self::Minimize => "WINDOW_MINIMIZE_FAILED",
        }
    }
}
pub trait WindowHost {
    fn exists(&self, label: &str) -> bool;
    /// Show, unminimize and focus the existing window; never construct a second instance.
    fn present(&self, label: &str) -> Result<(), WindowFailure>;
    fn show(&self, label: &str) -> Result<(), WindowFailure> {
        self.present(label)
    }
    fn hide(&self, label: &str) -> Result<(), WindowFailure>;
    fn minimize(&self, label: &str) -> Result<(), WindowFailure>;
}
pub fn focus_first(windows: &impl WindowHost) -> Result<(), WindowFailure> {
    windows.present(if windows.exists("spa") {
        "spa"
    } else {
        "shell"
    })
}
pub fn close_resident(
    windows: &impl WindowHost,
    label: &str,
    background: bool,
) -> Result<(), WindowFailure> {
    if background {
        windows.hide(label)
    } else {
        windows.minimize(label)
    }
}
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum QuitChoice {
    #[default]
    KeepRunning,
    StopBundled,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuitOffer {
    pub choice: QuitChoice,
    pub can_stop_harness: bool,
}
#[derive(Default)]
struct QuitState {
    pending: bool,
    approved: bool,
}
#[derive(Default)]
pub struct QuitSession(Mutex<QuitState>);
impl QuitSession {
    pub fn request(&self, bundled: bool) -> QuitOffer {
        self.0.lock().unwrap().pending = true;
        QuitOffer {
            choice: QuitChoice::KeepRunning,
            can_stop_harness: bundled,
        }
    }
    pub fn cancel(&self) {
        self.0.lock().unwrap().pending = false;
    }
    pub fn is_pending(&self) -> bool {
        self.0.lock().unwrap().pending
    }
    pub fn is_approved(&self) -> bool {
        self.0.lock().unwrap().approved
    }
    pub fn approve(&self, choice: QuitChoice, bundled: bool) -> Result<(), &'static str> {
        let mut state = self.0.lock().unwrap();
        if !state.pending || (choice == QuitChoice::StopBundled && !bundled) {
            return Err("QUIT_CHOICE_UNAVAILABLE");
        }
        state.approved = true;
        state.pending = false;
        Ok(())
    }
}
#[derive(Default)]
struct EventSlot {
    generation: u64,
    task: Option<JoinHandle<()>>,
}
#[derive(Default)]
pub struct EventOwner(Mutex<EventSlot>);
impl EventOwner {
    pub fn begin(&self) -> u64 {
        let mut slot = self.0.lock().unwrap();
        if let Some(task) = slot.task.take() {
            task.abort();
        }
        slot.generation = slot.generation.wrapping_add(1);
        slot.generation
    }
    pub fn stop(&self) {
        self.begin();
    }
    pub fn install(&self, generation: u64, task: JoinHandle<()>) -> bool {
        let mut slot = self.0.lock().unwrap();
        if slot.generation != generation {
            task.abort();
            return false;
        }
        if let Some(previous) = slot.task.replace(task) {
            previous.abort();
        }
        true
    }
    /// The lock covers the application of the update, rather than merely checking its generation.
    pub fn with_current<T>(&self, generation: u64, apply: impl FnOnce() -> T) -> Option<T> {
        let slot = self.0.lock().unwrap();
        (slot.generation == generation).then(apply)
    }
}
impl Drop for EventOwner {
    fn drop(&mut self) {
        if let Ok(slot) = self.0.get_mut() {
            if let Some(task) = slot.task.take() {
                task.abort();
            }
        }
    }
}

#[cfg(any(test, debug_assertions))]
pub fn fixture_identifier(production: &str, fixture: &str) -> String {
    use sha2::{Digest, Sha256};
    let hash = format!("{:x}", Sha256::digest(fixture.as_bytes()));
    format!("{production}.fixture.t{}", &hash[..16])
}
