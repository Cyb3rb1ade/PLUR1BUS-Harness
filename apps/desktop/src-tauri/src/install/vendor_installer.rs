//! Vendor URLs come only from the bundled manifest, never from renderer arguments.
use super::verified::{self, Result};
use crate::controller::bundle::VendorArtifact;
use futures_util::StreamExt;
use std::{io::Write, path::Path};
const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
#[async_trait::async_trait]
pub trait VendorInstaller: Sync {
    async fn download(&self, url: &url::Url, target: &mut std::fs::File) -> Result<()>;
    async fn verify_signature(&self, _path: &Path, _thumbprint: &str) -> Result<()> {
        Err("installer-signature")
    }
    async fn launch(&self, path: &Path) -> Result<()>;
}
pub async fn install(
    manifest: &VendorArtifact,
    licence_accepted: bool,
    native: &dyn VendorInstaller,
) -> Result<()> {
    install_with_progress(manifest, licence_accepted, native, |_| {}).await
}
pub async fn install_with_progress(
    manifest: &VendorArtifact,
    licence_accepted: bool,
    native: &dyn VendorInstaller,
    progress: impl Fn(&'static str),
) -> Result<()> {
    if !licence_accepted {
        return Err("licences-required");
    }
    if manifest.licence.trim().is_empty() || !verified::valid_hash(&manifest.sha256) {
        return Err("installer-unconfigured");
    }
    let url = url::Url::parse(&manifest.installer_url).map_err(|_| "installer-url")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("installer-url");
    }
    let mut target = tempfile::Builder::new()
        .prefix("plur1bus-installer-")
        .suffix(".exe")
        .tempfile()
        .map_err(|_| "installer-file")?;
    progress("download");
    native.download(&url, target.as_file_mut()).await?;
    progress("check");
    target
        .as_file_mut()
        .sync_all()
        .map_err(|_| "installer-file")?;
    verified::verify(target.path(), &manifest.sha256)?;
    // Close the writable handle before Windows creates an executable image section.
    let target = target.into_temp_path();
    if let Some(thumbprint) = &manifest.signer_thumbprint {
        if thumbprint.len() != 40 || !thumbprint.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("installer-signature");
        }
        native.verify_signature(&target, thumbprint).await?;
    }
    // Retain the private temporary file until the interactive installer exits; drop deletes it on every error.
    progress("installer");
    native.launch(&target).await?;
    progress("recheck");
    Ok(())
}
pub struct NativeVendor;
#[async_trait::async_trait]
impl VendorInstaller for NativeVendor {
    async fn download(&self, url: &url::Url, target: &mut std::fs::File) -> Result<()> {
        let client = reqwest::Client::builder()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(900))
            .build()
            .map_err(|_| "installer-download")?;
        let response = client
            .get(url.clone())
            .send()
            .await
            .map_err(|_| "installer-download")?;
        if !response.status().is_success()
            || response.content_length().is_some_and(|n| n > MAX_BYTES)
        {
            return Err("installer-download");
        }
        let mut stream = response.bytes_stream();
        let mut total = 0u64;
        while let Some(bytes) = stream.next().await {
            let bytes = bytes.map_err(|_| "installer-download")?;
            total = total
                .checked_add(bytes.len() as u64)
                .ok_or("installer-download")?;
            if total > MAX_BYTES {
                return Err("installer-download");
            }
            target.write_all(&bytes).map_err(|_| "installer-file")?;
        }
        Ok(())
    }
    async fn verify_signature(&self, path: &Path, thumbprint: &str) -> Result<()> {
        #[cfg(windows)]
        {
            windows_installer(path, Some(thumbprint)).await
        }
        #[cfg(not(windows))]
        {
            let _ = (path, thumbprint);
            Err("installer-platform")
        }
    }
    async fn launch(&self, path: &Path) -> Result<()> {
        #[cfg(windows)]
        {
            windows_installer(path, None).await
        }
        #[cfg(not(windows))]
        {
            let _ = path;
            Err("installer-platform")
        }
    }
}
#[cfg(windows)]
async fn windows_installer(path: &Path, thumbprint: Option<&str>) -> Result<()> {
    // Fixed native script: env values are data, never PowerShell source or installer flags.
    const SCRIPT: &str = r#"$ErrorActionPreference='Stop'; if($env:PLUR1BUS_SIGNER){$s=Get-AuthenticodeSignature -LiteralPath $env:PLUR1BUS_INSTALLER; if($s.Status -ne 'Valid' -or $s.SignerCertificate.Thumbprint -ine $env:PLUR1BUS_SIGNER){exit 2}} else {$p=Start-Process -FilePath $env:PLUR1BUS_INSTALLER -Wait -PassThru; exit $p.ExitCode}"#;
    let program = std::env::var_os("SystemRoot")
        .map(std::path::PathBuf::from)
        .ok_or("installer-command")?
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let status = tokio::time::timeout(
        std::time::Duration::from_secs(3600),
        tokio::process::Command::new(program)
            .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
            .env("PLUR1BUS_INSTALLER", path)
            .env("PLUR1BUS_SIGNER", thumbprint.unwrap_or(""))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .status(),
    )
    .await
    .map_err(|_| "installer-timeout")?
    .map_err(|_| "installer-command")?;
    if status.success() {
        Ok(())
    } else {
        Err(if thumbprint.is_some() {
            "installer-signature"
        } else {
            "installer-command"
        })
    }
}
