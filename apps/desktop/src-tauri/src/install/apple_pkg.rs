//! The Apple package is bundled. This adapter has no network interface.
use super::verified::{self, Result};
use crate::controller::bundle::AppleReq;
use std::path::Path;
#[async_trait::async_trait]
pub trait AppleInstaller: Sync {
    async fn verify_signature(&self, package: &Path, team: &str) -> Result<()>;
    async fn open(&self, package: &Path) -> Result<()>;
    async fn start(&self) -> Result<()>;
}
pub async fn install(
    root: &Path,
    manifest: &AppleReq,
    licence_accepted: bool,
    native: &dyn AppleInstaller,
) -> Result<()> {
    if !licence_accepted {
        return Err("licences-required");
    }
    let package = verified::resource(root, &manifest.pkg_path)?;
    verified::verify(&package, &manifest.pkg_sha256)?;
    if manifest.team_id.len() != 10
        || !manifest
            .team_id
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit())
    {
        return Err("installer-signature");
    }
    native.verify_signature(&package, &manifest.team_id).await?;
    native.open(&package).await?;
    native.start().await
}
pub fn open_argv(package: &Path) -> Vec<std::ffi::OsString> {
    vec!["-W".into(), package.as_os_str().into()]
}
pub fn start_argv() -> [&'static str; 3] {
    ["system", "start", "--enable-kernel-install"]
}
pub fn trusted_signature(success: bool, text: &str, team: &str) -> bool {
    success
        && text
            .lines()
            .any(|line| line.trim() == "Status: signed by a certificate trusted by macOS")
        && text.lines().any(|line| {
            line.contains("Developer ID Installer:")
                && line.trim_end().ends_with(&format!("({team})"))
        })
}
pub struct NativeApple;
#[async_trait::async_trait]
impl AppleInstaller for NativeApple {
    async fn verify_signature(&self, package: &Path, team: &str) -> Result<()> {
        if !cfg!(target_os = "macos") {
            return Err("installer-platform");
        }
        let output = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            tokio::process::Command::new("/usr/sbin/pkgutil")
                .arg("--check-signature")
                .arg(package)
                .env("LC_ALL", "C")
                .kill_on_drop(true)
                .output(),
        )
        .await
        .map_err(|_| "installer-timeout")?
        .map_err(|_| "installer-signature")?;
        let text = String::from_utf8_lossy(&output.stdout);
        if !trusted_signature(output.status.success(), &text, team) {
            return Err("installer-signature");
        }
        Ok(())
    }
    async fn open(&self, package: &Path) -> Result<()> {
        let args = open_argv(package);
        verified::command(
            Path::new("/usr/bin/open"),
            &args.iter().map(|a| a.as_os_str()).collect::<Vec<_>>(),
        )
        .await
    }
    async fn start(&self) -> Result<()> {
        // Detection verifies the fixed CLI path and its safe executable metadata.
        let _runtime = crate::runtime::apple::AppleRuntime::detect()
            .await
            .map_err(|_| "installer-runtime")?;
        verified::command(
            Path::new("/usr/local/bin/container"),
            &start_argv().iter().map(|a| a.as_ref()).collect::<Vec<_>>(),
        )
        .await
    }
}
