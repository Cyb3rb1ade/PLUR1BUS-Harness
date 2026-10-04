//! SPA navigation and caller policy, independent of native window construction.
use crate::connections::Origin;
use url::Url;
/// Preferred origin; the measured engines use the approved loopback fallback.
pub const SPA_ORIGIN: &str = "plur1bus-harness://localhost";
/// A navigation stays in the SPA, opens externally, or is refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavDecision {
    Allow,
    OpenExternal,
    Block,
}
/// Rejected caller or navigation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PolicyError;
/// Compare normalized origins without accepting userinfo.
pub fn same_origin(url: &Url, origin: &Origin) -> bool {
    url.username().is_empty()
        && url.password().is_none()
        && url.origin().ascii_serialization() == origin.as_str()
}
/// Classify navigation with the active fallback origin.
pub fn navigation(proxy: &Origin, conn: &Origin, url: &Url) -> NavDecision {
    if same_origin(url, proxy) || same_origin(url, conn) {
        NavDecision::Allow
    } else if matches!(url.scheme(), "http" | "https" | "mailto")
        && url.username().is_empty()
        && url.password().is_none()
    {
        NavDecision::OpenExternal
    } else {
        NavDecision::Block
    }
}
/// Preferred custom-transport policy; production uses `navigation` with its port.
pub fn spa_navigation(conn: &Origin, url: &Url) -> NavDecision {
    if (url.scheme() == "plur1bus-harness"
        && url.host_str() == Some("localhost")
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none())
        || same_origin(url, conn)
    {
        NavDecision::Allow
    } else if matches!(url.scheme(), "https" | "http" | "mailto")
        && url.username().is_empty()
        && url.password().is_none()
    {
        NavDecision::OpenExternal
    } else {
        NavDecision::Block
    }
}
/// Every native SPA command rechecks exact label and active top-level origin.
pub fn check_spa_caller(label: &str, current: &Url, conn: &Origin) -> Result<(), PolicyError> {
    if label == "spa" && same_origin(current, conn) {
        Ok(())
    } else {
        Err(PolicyError)
    }
}
/// A classified external URL; construction is the only entrance to the OS opener.
pub struct ExternalUrl(Url);
impl ExternalUrl {
    /// Only URLs already classified as external may reach the operating system.
    pub fn classified(proxy: &Origin, conn: &Origin, url: &Url) -> Result<Self, PolicyError> {
        (navigation(proxy, conn, url) == NavDecision::OpenExternal)
            .then(|| Self(url.clone()))
            .ok_or(PolicyError)
    }
    /// Open using a fixed OS argument vector, never a JavaScript command.
    pub fn open(&self) -> Result<(), PolicyError> {
        #[cfg(target_os = "macos")]
        let result = std::process::Command::new("/usr/bin/open")
            .arg(self.0.as_str())
            .spawn();
        #[cfg(target_os = "linux")]
        let result = std::process::Command::new("xdg-open")
            .arg(self.0.as_str())
            .spawn();
        #[cfg(target_os = "windows")]
        let result = std::process::Command::new("rundll32.exe")
            .arg("url.dll,FileProtocolHandler")
            .arg(self.0.as_str())
            .spawn();
        result.map(|_| ()).map_err(|_| PolicyError)
    }
}
