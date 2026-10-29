//! Native directory selection. A renderer never supplies a local path, executable or dialog script.
use std::path::PathBuf;

pub fn selected_uri(uris: &[String]) -> Result<PathBuf, &'static str> {
    if uris.len() != 1 || uris[0].len() > 16 * 1024 {
        return Err("file-dialog-invalid");
    }
    let uri = url::Url::parse(&uris[0]).map_err(|_| "file-dialog-invalid")?;
    if uri.scheme() != "file"
        || uri
            .host_str()
            .is_some_and(|host| !host.is_empty() && host != "localhost")
        || uri.query().is_some()
        || uri.fragment().is_some()
    {
        return Err("file-dialog-invalid");
    }
    let path = uri.to_file_path().map_err(|_| "file-dialog-invalid")?;
    if !path.is_absolute()
        || path
            .as_os_str()
            .to_string_lossy()
            .chars()
            .any(char::is_control)
    {
        return Err("file-dialog-invalid");
    }
    Ok(path)
}

#[cfg(target_os = "linux")]
pub async fn pick_source() -> Result<Option<PathBuf>, &'static str> {
    let connection = zbus::Connection::session()
        .await
        .map_err(|_| "file-dialog-unavailable")?;
    portal_pick(&connection).await
}

/// Listen before requesting the dialog: a fast portal may emit Response before OpenFile returns.
#[cfg(target_os = "linux")]
pub async fn portal_pick(connection: &zbus::Connection) -> Result<Option<PathBuf>, &'static str> {
    use futures_util::StreamExt;
    use std::collections::HashMap;
    use zbus::{
        zvariant::{OwnedObjectPath, OwnedValue, Value},
        Proxy,
    };
    let token = format!("p1b{}", uuid::Uuid::now_v7().simple());
    let sender = connection
        .unique_name()
        .ok_or("file-dialog-unavailable")?
        .as_str()
        .trim_start_matches(':')
        .replace('.', "_");
    let path = format!("/org/freedesktop/portal/desktop/request/{sender}/{token}");
    tokio::time::timeout(std::time::Duration::from_secs(120), async {
        let request = Proxy::new(
            connection,
            "org.freedesktop.portal.Desktop",
            path.as_str(),
            "org.freedesktop.portal.Request",
        )
        .await
        .map_err(|_| "file-dialog-unavailable")?;
        let mut response = request
            .receive_signal("Response")
            .await
            .map_err(|_| "file-dialog-unavailable")?;
        let portal = Proxy::new(
            connection,
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.FileChooser",
        )
        .await
        .map_err(|_| "file-dialog-unavailable")?;
        let options: HashMap<&str, Value<'_>> = HashMap::from([
            ("handle_token", Value::from(token.as_str())),
            ("directory", Value::from(true)),
            ("multiple", Value::from(false)),
            ("modal", Value::from(true)),
        ]);
        let actual: OwnedObjectPath = portal
            .call("OpenFile", &("", "Select an import source", options))
            .await
            .map_err(|_| "file-dialog-unavailable")?;
        if actual.as_str() != path {
            return Err("file-dialog-invalid");
        }
        let message = response.next().await.ok_or("file-dialog-unavailable")?;
        let (code, mut values): (u32, HashMap<String, OwnedValue>) =
            message
                .body()
                .deserialize()
                .map_err(|_| "file-dialog-invalid")?;
        if code == 1 {
            return Ok(None);
        }
        if code != 0 {
            return Err("file-dialog-unavailable");
        }
        let uris = values
            .remove("uris")
            .and_then(|value| Vec::<String>::try_from(value).ok())
            .ok_or("file-dialog-invalid")?;
        selected_uri(&uris).map(Some)
    })
    .await
    .map_err(|_| "file-dialog-timeout")?
}

#[cfg(any(target_os = "macos", windows))]
pub async fn pick_source() -> Result<Option<PathBuf>, &'static str> {
    use tokio::io::AsyncReadExt;
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut cmd = tokio::process::Command::new("/usr/bin/osascript");
        cmd.args([
            "-e",
            "POSIX path of (choose folder with prompt \"Select an import source\")",
        ]);
        cmd
    };
    #[cfg(windows)]
    let mut command = {
        let program =
            PathBuf::from(std::env::var_os("SystemRoot").ok_or("file-dialog-unavailable")?)
                .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let mut cmd = tokio::process::Command::new(program);
        cmd.args(["-NoProfile", "-NonInteractive", "-STA", "-Command",
            "[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false);Add-Type -AssemblyName System.Windows.Forms;$d=New-Object System.Windows.Forms.FolderBrowserDialog;$d.Description='Select an import source';if($d.ShowDialog() -eq 'OK'){[Console]::Write($d.SelectedPath)}"]);
        cmd
    };
    let mut child = command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "file-dialog-unavailable")?;
    let stdout = child.stdout.take().ok_or("file-dialog-unavailable")?;
    tokio::time::timeout(std::time::Duration::from_secs(120), async {
        let mut bytes = Vec::new();
        stdout
            .take(16 * 1024 + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| "file-dialog-unavailable")?;
        let status = child.wait().await.map_err(|_| "file-dialog-unavailable")?;
        if bytes.len() > 16 * 1024 {
            return Err("file-dialog-invalid");
        }
        if !status.success() || bytes.is_empty() {
            return Ok(None);
        }
        let raw = std::str::from_utf8(&bytes)
            .map_err(|_| "file-dialog-invalid")?
            .trim_end_matches(['\r', '\n']);
        let path = PathBuf::from(raw);
        if !path.is_absolute() || raw.chars().any(char::is_control) {
            return Err("file-dialog-invalid");
        }
        Ok(Some(path))
    })
    .await
    .map_err(|_| "file-dialog-timeout")?
}
