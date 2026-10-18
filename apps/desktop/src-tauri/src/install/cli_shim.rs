//! A copied release host CLI with digest ownership. A name or version string never proves ownership.
use super::verified::{self, Result};
use crate::controller::bundle::CliArtifact;
use serde::{Deserialize, Serialize};
use std::{
    io::Write,
    path::{Path, PathBuf},
};
const MARKER: &str = ".plur1bus-desktop-cli.json";
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Ownership {
    version: u8,
    sha256: String,
}
pub fn bin_dir(home: &Path) -> PathBuf {
    if cfg!(windows) {
        home.join("PLUR1BUS/bin")
    } else {
        home.join(".local/bin")
    }
}
fn name() -> &'static str {
    if cfg!(windows) {
        "plur1bus.exe"
    } else {
        "plur1bus"
    }
}
fn regular(path: &Path) -> Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(m) => {
            if !m.is_file() || m.file_type().is_symlink() {
                Err("shim-collision")
            } else {
                Ok(true)
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err("shim-storage"),
    }
}
fn ensure_dir(root: &Path, dir: &Path) -> Result<()> {
    let relative = dir.strip_prefix(root).map_err(|_| "shim-storage")?;
    let mut p = root.to_path_buf();
    for c in relative.components() {
        if !matches!(c, std::path::Component::Normal(_)) {
            return Err("shim-storage");
        }
        p.push(c);
        match std::fs::symlink_metadata(&p) {
            Ok(m) if m.is_dir() && !m.file_type().is_symlink() => {}
            Ok(_) => return Err("shim-collision"),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&p).map_err(|_| "shim-storage")?
            }
            Err(_) => return Err("shim-storage"),
        }
    }
    Ok(())
}
fn owner(dir: &Path) -> Result<Option<Ownership>> {
    let marker = dir.join(MARKER);
    if !regular(&marker)? {
        return Ok(None);
    }
    if std::fs::metadata(&marker)
        .map_err(|_| "shim-storage")?
        .len()
        > 1024
    {
        return Err("shim-collision");
    }
    let o: Ownership = serde_json::from_slice(&std::fs::read(marker).map_err(|_| "shim-storage")?)
        .map_err(|_| "shim-collision")?;
    if o.version != 1 || !verified::valid_hash(&o.sha256) {
        return Err("shim-collision");
    }
    Ok(Some(o))
}
pub fn install(root: &Path, artifact: &CliArtifact, home: &Path) -> Result<PathBuf> {
    let source = verified::resource(root, &artifact.path)?;
    verified::verify(&source, &artifact.sha256)?;
    let dir = bin_dir(home);
    ensure_dir(home, &dir)?;
    let destination = dir.join(name());
    if regular(&destination)? {
        let o = owner(&dir)?.ok_or("shim-collision")?;
        verified::verify(&destination, &o.sha256).map_err(|_| "shim-collision")?;
        if o.sha256 != artifact.sha256 {
            return Err("shim-collision");
        }
        return Ok(destination);
    }
    if owner(&dir)?.is_some() {
        return Err("shim-collision");
    }
    let mut temp = tempfile::NamedTempFile::new_in(&dir).map_err(|_| "shim-storage")?;
    let mut input = std::fs::File::open(source).map_err(|_| "shim-storage")?;
    std::io::copy(&mut input, &mut temp).map_err(|_| "shim-storage")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temp.as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o755))
            .map_err(|_| "shim-storage")?;
    }
    verified::verify(temp.path(), &artifact.sha256)?;
    temp.persist_noclobber(&destination)
        .map_err(|_| "shim-collision")?;
    let mut marker = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(dir.join(MARKER))
        .map_err(|_| "shim-collision")?;
    let bytes = serde_json::to_vec(&Ownership {
        version: 1,
        sha256: artifact.sha256.clone(),
    })
    .map_err(|_| "shim-storage")?;
    marker.write_all(&bytes).map_err(|_| "shim-storage")?;
    marker.sync_all().map_err(|_| "shim-storage")?;
    Ok(destination)
}
pub fn remove(home: &Path) -> Result<()> {
    let dir = bin_dir(home);
    let destination = dir.join(name());
    // Validate ancestors even on removal; never follow a substituted bin directory.
    if !dir.exists() {
        return Ok(());
    }
    ensure_dir(home, &dir)?;
    let Some(o) = owner(&dir)? else {
        return Ok(());
    };
    if regular(&destination)? {
        verified::verify(&destination, &o.sha256).map_err(|_| "shim-collision")?;
        std::fs::remove_file(destination).map_err(|_| "shim-storage")?;
    }
    std::fs::remove_file(dir.join(MARKER)).map_err(|_| "shim-storage")?;
    Ok(())
}
fn path_block(dir: &Path) -> Result<String> {
    let d = dir.to_str().ok_or("shim-storage")?;
    if d.contains(['\n', '\r', '\0']) {
        return Err("shim-storage");
    }
    Ok(format!(
        "# BEGIN PLUR1BUS DESKTOP PATH\nexport PATH='{}':\"$PATH\"\n# END PLUR1BUS DESKTOP PATH\n",
        d.replace('\'', "'\\''")
    ))
}
pub fn update_profile(profile: &Path, dir: &Path, add: bool) -> Result<()> {
    let exists = regular(profile)?;
    let original = if exists {
        if std::fs::metadata(profile)
            .map_err(|_| "shim-storage")?
            .len()
            > 1024 * 1024
        {
            return Err("shim-storage");
        }
        std::fs::read_to_string(profile).map_err(|_| "shim-storage")?
    } else {
        String::new()
    };
    let block = path_block(dir)?;
    if add {
        if original.contains(&block) {
            return Ok(());
        }
        if original.contains("# BEGIN PLUR1BUS DESKTOP PATH") {
            return Err("shim-path-collision");
        }
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(profile)
            .map_err(|_| "shim-storage")?;
        if !original.is_empty() && !original.ends_with('\n') {
            file.write_all(b"\n").map_err(|_| "shim-storage")?;
        }
        file.write_all(block.as_bytes())
            .map_err(|_| "shim-storage")?;
    } else if original.contains(&block) {
        let parent = profile.parent().ok_or("shim-storage")?;
        let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|_| "shim-storage")?;
        if exists {
            temp.as_file()
                .set_permissions(
                    std::fs::metadata(profile)
                        .map_err(|_| "shim-storage")?
                        .permissions(),
                )
                .map_err(|_| "shim-storage")?;
        }
        temp.write_all(original.replace(&block, "").as_bytes())
            .map_err(|_| "shim-storage")?;
        temp.persist(profile).map_err(|_| "shim-storage")?;
    }
    Ok(())
}
#[cfg(windows)]
pub async fn update_windows_path(dir: &Path, add: bool) -> Result<()> {
    // Values are passed through environment variables, never interpolated into executable code.
    // The separate HKCU marker records whether we added this exact entry. A pre-existing entry stays foreign.
    const SCRIPT: &str = r#"$ErrorActionPreference='Stop'; $d=$env:PLUR1BUS_SHIM_DIR; $p=[Environment]::GetEnvironmentVariable('Path','User'); $k='HKCU:\Software\PLUR1BUS\Desktop'; $m=(Get-ItemProperty -Path $k -Name CliPath -ErrorAction SilentlyContinue).CliPath; $rows=@($p -split ';' | Where-Object { $_ -ne '' }); if($env:PLUR1BUS_SHIM_ADD -eq '1'){ if($rows -notcontains $d){ $rows+= $d; New-Item -Path $k -Force | Out-Null; Set-ItemProperty -Path $k -Name CliPath -Value $d; [Environment]::SetEnvironmentVariable('Path',($rows -join ';'),'User') } } elseif($m -ceq $d){ $rows=@($rows | Where-Object { $_ -cne $d }); [Environment]::SetEnvironmentVariable('Path',($rows -join ';'),'User'); Remove-ItemProperty -Path $k -Name CliPath }"#;
    let program = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .ok_or("shim-storage")?
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let status = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        tokio::process::Command::new(program)
            .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
            .env("PLUR1BUS_SHIM_DIR", dir)
            .env("PLUR1BUS_SHIM_ADD", if add { "1" } else { "0" })
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status(),
    )
    .await
    .map_err(|_| "shim-path")?
    .map_err(|_| "shim-path")?;
    if status.success() {
        Ok(())
    } else {
        Err("shim-path")
    }
}
