//! The platform seam: probe (no dialog) and confirm (one fresh OS confirmation, bounded by `ttl`).
use crate::protocol::{Outcome, Probe};
use std::time::Duration;

pub trait Platform {
    /// Whether a confirmation could be asked for here. Must not show a dialog.
    fn probe(&self) -> Probe;
    /// One fresh confirmation by the person at the machine, shown with `text`. Returns within `ttl` (plus a small margin).
    fn confirm(&self, text: &str, ttl: Duration) -> Outcome;
}

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows_os;

/// The implementation for this operating system; elsewhere a platform that is never available.
pub fn native() -> Box<dyn Platform> {
    #[cfg(target_os = "macos")]
    return Box::new(macos::MacOs);
    #[cfg(target_os = "linux")]
    return Box::new(linux::Linux::from_env());
    #[cfg(windows)]
    return Box::new(windows_os::Windows);
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    return Box::new(Unsupported);
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
struct Unsupported;
#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
impl Platform for Unsupported {
    fn probe(&self) -> Probe {
        Probe::Unavailable {
            reason: "unsupported-platform".into(),
        }
    }
    fn confirm(&self, _text: &str, _ttl: Duration) -> Outcome {
        Outcome::Unavailable
    }
}
