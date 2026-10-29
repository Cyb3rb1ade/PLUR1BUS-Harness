//! Host import selections and the verified standalone snapshot producer. Local paths never enter renderer results.
use crate::controller::bundle::SnapshotRuntime;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use tauri::Manager;

#[derive(Default)]
pub struct HostSnapshotState {
    sources: std::sync::Mutex<SourceSelections>,
    producer: tokio::sync::Mutex<()>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FilePickRequest {}

fn caller_connection(window: &tauri::WebviewWindow, command: &str) -> Result<uuid::Uuid, String> {
    let app = window.app_handle();
    let state = app.state::<crate::spa::SpaState>();
    if window.label() == "shell" {
        crate::commands::check(window, command)?;
    } else {
        crate::spa::check_caller(
            &state,
            window.label(),
            &window.url().map_err(|_| "invalid")?,
        )?;
    }
    state.active_connection_id().ok_or("pairing-needed".into())
}

#[tauri::command]
pub async fn host_file_pick(
    window: tauri::WebviewWindow,
    request: FilePickRequest,
) -> Result<Option<SelectedSourceReceipt>, String> {
    let _ = request;
    let connection = caller_connection(&window, "host_file_pick")?;
    let Some(path) = crate::file_dialog::pick_source()
        .await
        .map_err(str::to_owned)?
    else {
        return Ok(None);
    };
    if caller_connection(&window, "host_file_pick")? != connection {
        return Err("connection-changed".into());
    }
    let app = window.app_handle();
    let state = app.state::<HostSnapshotState>();
    let result = state.sources.lock().unwrap().insert(connection, path);
    result.map(Some)
}

struct SelectedSource {
    connection: uuid::Uuid,
    path: PathBuf,
    created: Instant,
}
#[derive(Default)]
pub struct SourceSelections {
    entries: HashMap<String, SelectedSource>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedSourceReceipt {
    pub selection_id: String,
    pub label: String,
}

impl SourceSelections {
    fn expire(&mut self) {
        self.entries
            .retain(|_, value| value.created.elapsed() < Duration::from_secs(600));
    }
    pub fn insert(
        &mut self,
        connection: uuid::Uuid,
        path: PathBuf,
    ) -> Result<SelectedSourceReceipt, String> {
        self.expire();
        let meta = std::fs::symlink_metadata(&path).map_err(|_| "unsafe-file")?;
        if !path.is_absolute()
            || !meta.is_dir()
            || meta.file_type().is_symlink()
            || self.entries.len() >= 16
        {
            return Err("unsafe-file".into());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if meta.file_attributes() & 0x400 != 0 {
                return Err("unsafe-file".into());
            }
        }
        let label = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .chars()
            .filter(|c| !c.is_control())
            .take(120)
            .collect();
        let selection_id = uuid::Uuid::now_v7().to_string();
        self.entries.insert(
            selection_id.clone(),
            SelectedSource {
                connection,
                path,
                created: Instant::now(),
            },
        );
        Ok(SelectedSourceReceipt {
            selection_id,
            label,
        })
    }
    pub fn get(&mut self, connection: uuid::Uuid, id: &str) -> Result<PathBuf, String> {
        self.expire();
        self.entries
            .get(id)
            .filter(|entry| entry.connection == connection)
            .map(|entry| entry.path.clone())
            .ok_or("invalid".into())
    }
}

/// Both resources must still match the signed bundle immediately before every invocation. No PATH fallback exists.
pub fn verify_runtime(
    root: &Path,
    runtime: &SnapshotRuntime,
) -> Result<(PathBuf, PathBuf), &'static str> {
    const PINS: &str = include_str!("../../../../crates/plur1bus/src/install/pins.rs");
    let pinned = PINS
        .lines()
        .find_map(|line| {
            line.strip_prefix("pub const NODE_VERSION: &str = \"")
                .and_then(|value| value.split('"').next())
        })
        .ok_or("snapshot-unavailable")?;
    if runtime.node_version != pinned {
        return Err("snapshot-unavailable");
    }
    let node = crate::install::verified::resource(root, &runtime.node.path)?;
    let entry = crate::install::verified::resource(root, &runtime.entry.path)?;
    crate::install::verified::verify(&node, &runtime.node.sha256)?;
    crate::install::verified::verify(&entry, &runtime.entry.sha256)?;
    Ok((node, entry))
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotSummary {
    pub schema: String,
    pub ok: bool,
    pub file_count: u64,
    pub bytes: u64,
    pub archive_bytes: u64,
    pub sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotRequest {
    pub selection_id: String,
    pub source_type: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSnapshotReceipt {
    #[serde(flatten)]
    pub upload: crate::client::SnapshotUpload,
    pub file_count: u64,
    pub bytes: u64,
}

/// The source is copied on this host, then streamed directly to the current authenticated harness.
#[tauri::command]
pub async fn host_import_snapshot(
    window: tauri::WebviewWindow,
    request: SnapshotRequest,
) -> Result<HostSnapshotReceipt, String> {
    let connection = caller_connection(&window, "host_import_snapshot")?;
    let app = window.app_handle().clone();
    let state = app.state::<HostSnapshotState>();
    let _one_producer = state.producer.try_lock().map_err(|_| "snapshot-busy")?;
    let source = state
        .sources
        .lock()
        .unwrap()
        .get(connection, &request.selection_id)?;
    let resources = app
        .path()
        .resource_dir()
        .map_err(|_| "snapshot-unavailable")?;
    let runtime = crate::controller::bundle::embedded()
        .snapshot_runtime
        .as_ref()
        .ok_or("snapshot-unavailable")?;
    let produced = produce_snapshot(
        &resources,
        runtime,
        &request.source_type,
        &source,
        &NativeSnapshotProducer,
    )
    .await
    .map_err(str::to_owned)?;
    if caller_connection(&window, "host_import_snapshot")? != connection {
        return Err("connection-changed".into());
    }
    let (row, client) = app
        .state::<crate::spa::SpaState>()
        .upload_connection(connection)?;
    let archive = produced.archive().to_path_buf();
    let hash = produced.summary.sha256.clone();
    let owner = app.state::<crate::commands::ConnectionState>();
    let check = app.clone();
    let upload = crate::commands::credential_action(&owner, move |tokens, runtime| {
        if check.state::<crate::spa::SpaState>().active_connection_id() != Some(connection) {
            return Err("connection-changed".into());
        }
        let tokens = tokens.get_or_insert_with(crate::secrets::open_default);
        let token = crate::pair::connection_token(&row, tokens.as_ref())
            .map_err(|error| error.public_message())?;
        runtime
            .block_on(client.upload_snapshot_file(&token, &archive, &hash))
            .map_err(|error| crate::pair::PairError::Client(error).public_message())
    })
    .await;
    if upload
        .as_ref()
        .is_err_and(|error| error == "second-factor-required")
    {
        crate::stepup_commands::notify_required(
            &app,
            connection,
            crate::client::StepUpPurpose::Imports,
        );
    }
    let upload = upload?;
    Ok(HostSnapshotReceipt {
        upload,
        file_count: produced.summary.file_count,
        bytes: produced.summary.bytes,
    })
}

pub struct ProducedSnapshot {
    // Close the pinned directory handle before TempDir attempts removal on Windows.
    _owned: crate::logging::storage::OwnedDirectory,
    _temporary: tempfile::TempDir,
    archive: PathBuf,
    pub summary: SnapshotSummary,
}
impl ProducedSnapshot {
    pub fn archive(&self) -> &Path {
        &self.archive
    }
}

#[async_trait::async_trait]
pub trait SnapshotProducer: Send + Sync {
    async fn execute(
        &self,
        node: &Path,
        entry: &Path,
        job: Vec<u8>,
    ) -> Result<Vec<u8>, &'static str>;
}
pub struct NativeSnapshotProducer;
#[async_trait::async_trait]
impl SnapshotProducer for NativeSnapshotProducer {
    async fn execute(
        &self,
        node: &Path,
        entry: &Path,
        job: Vec<u8>,
    ) -> Result<Vec<u8>, &'static str> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut child = tokio::process::Command::new(node)
            .arg("--disable-warning=ExperimentalWarning")
            .arg(entry)
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| "snapshot-unavailable")?;
        let mut stdin = child.stdin.take().ok_or("snapshot-failed")?;
        let stdout = child.stdout.take().ok_or("snapshot-failed")?;
        tokio::time::timeout(Duration::from_secs(300), async {
            stdin.write_all(&job).await.map_err(|_| "snapshot-failed")?;
            drop(stdin);
            let mut bytes = Vec::new();
            stdout
                .take(4097)
                .read_to_end(&mut bytes)
                .await
                .map_err(|_| "snapshot-failed")?;
            if bytes.len() > 4096 || !child.wait().await.map_err(|_| "snapshot-failed")?.success() {
                return Err("snapshot-failed");
            }
            Ok(bytes)
        })
        .await
        .map_err(|_| "snapshot-timeout")?
    }
}

pub async fn produce_snapshot(
    root: &Path,
    runtime: &SnapshotRuntime,
    source_type: &str,
    source: &Path,
    producer: &dyn SnapshotProducer,
) -> Result<ProducedSnapshot, &'static str> {
    if source_type.is_empty()
        || source_type.len() > 32
        || !source_type.bytes().all(|b| b.is_ascii_lowercase())
    {
        return Err("invalid");
    }
    let (node, entry) = verify_runtime(root, runtime)?;
    let temporary = tempfile::Builder::new()
        .prefix("plur1bus-import-")
        .tempdir()
        .map_err(|_| "snapshot-storage")?;
    let home = temporary
        .path()
        .canonicalize()
        .map_err(|_| "snapshot-storage")?;
    let owned =
        crate::logging::storage::OwnedDirectory::open(&home).map_err(|_| "snapshot-storage")?;
    let job = serde_json::to_vec(
        &serde_json::json!({"schema":"desktop.import-snapshot/1","sourceType":source_type,
        "sourceRoot":source,"home":home,"stagingDir":home.join("snapshot"),"allowLiveCopy":false}),
    )
    .map_err(|_| "invalid")?;
    if job.len() > 16 * 1024 {
        return Err("invalid");
    }
    let result = producer.execute(&node, &entry, job).await?;
    owned.check().map_err(|_| "snapshot-storage")?;
    let summary: SnapshotSummary =
        serde_json::from_slice(&result).map_err(|_| "snapshot-failed")?;
    let archive = home.join("snapshot.tar.gz");
    let archive_metadata = std::fs::symlink_metadata(&archive).map_err(|_| "snapshot-failed")?;
    if summary.schema != "desktop.import-snapshot-result/1"
        || !summary.ok
        || summary.file_count > 10_000
        || summary.bytes > 512 * 1024 * 1024
        || summary.archive_bytes > 1024 * 1024 * 1024
        || !archive_metadata.is_file()
        || archive_metadata.file_type().is_symlink()
        || summary.archive_bytes == 0
        || archive_metadata.len() != summary.archive_bytes
        || crate::install::verified::sha256(&archive)? != summary.sha256
    {
        return Err("snapshot-failed");
    }
    Ok(ProducedSnapshot {
        _owned: owned,
        _temporary: temporary,
        archive,
        summary,
    })
}
