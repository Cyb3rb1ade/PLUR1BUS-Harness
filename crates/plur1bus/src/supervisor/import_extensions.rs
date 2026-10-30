//! Private maintenance bridge for imported, disabled MCP packages. Package bytes stay in the isolated worker.
//! Receipts at imports/native-extensions/<installationId>.json precede every package transaction.
use crate::ext::commit::{self, ModuleHost};
use crate::ext::imported::{self, Candidate, Receipt};
use crate::ext::paths::ExtPaths;
use crate::ext::record::{self, InspectionRecord, StagedItem};
use crate::ext::state::{self, ItemRecord};
use crate::ext::{self, ExtError};
use crate::paths::Layout;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
enum Phase {
    Prepared,
    Installed,
    RolledBack,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Ledger {
    version: u8,
    run_id: String,
    receipt: Receipt,
    candidate_sha256: String,
    package_sha256: String,
    manifest_sha256: String,
    extension_version: String,
    config_before: Value,
    config_installed: Option<Value>,
    installed_at: Option<String>,
    phase: Phase,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Prepared {
    inspection: InspectionRecord,
    staged: StagedItem,
}
fn conflict() -> ExtError {
    ExtError::new(
        "E_CONFLICT",
        "name-taken",
        "imported MCP ownership no longer matches the recorded transaction",
    )
}
fn storage() -> ExtError {
    ExtError::new(
        "E_STORAGE",
        "state-invalid",
        "imported MCP transaction metadata is unavailable",
    )
}
fn installation_id(run: &str, fingerprint: &str, digest: &str) -> String {
    imported::hash(format!("imported-mcp/1\0{run}\0{fingerprint}\0{digest}").as_bytes())
}
fn version(fingerprint: &str) -> String {
    format!("0.0.0-import.f{}", &fingerprint[..32])
}
fn directory(layout: &Layout, create: bool) -> Result<PathBuf, ExtError> {
    let mut path = layout.home.clone();
    for part in ["", "imports", "native-extensions"] {
        if !part.is_empty() {
            path.push(part);
        }
        match fs::symlink_metadata(&path) {
            Ok(metadata) => {
                if !metadata.is_dir() || metadata.file_type().is_symlink() {
                    return Err(storage());
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::MetadataExt;
                    if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o022 != 0
                    {
                        return Err(storage());
                    }
                }
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if metadata.file_attributes()
                        & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
                        != 0
                    {
                        return Err(storage());
                    }
                    if !part.is_empty() {
                        let user = plur1bus_rpc::win::user_sid().map_err(|_| storage())?;
                        let acl =
                            plur1bus_rpc::win::file_dacl_report(&path).map_err(|_| storage())?;
                        if !plur1bus_rpc::acl::run_writable_by_others(&acl, &user).is_empty() {
                            return Err(storage());
                        }
                    }
                }
            }
            Err(error)
                if error.kind() == std::io::ErrorKind::NotFound && create && !part.is_empty() =>
            {
                fs::create_dir(&path).map_err(|_| storage())?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
                        .map_err(|_| storage())?;
                    fs::File::open(path.parent().ok_or_else(storage)?)
                        .and_then(|directory| directory.sync_all())
                        .map_err(|_| storage())?;
                }
                #[cfg(windows)]
                {
                    let user = plur1bus_rpc::win::user_sid().map_err(|_| storage())?;
                    plur1bus_rpc::win::set_path_dacl(
                        &path,
                        &plur1bus_rpc::acl::run_dir_sddl(&user),
                    )
                    .map_err(|_| storage())?;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && !create => {
                return Ok(layout.home.join("imports/native-extensions"))
            }
            Err(_) => return Err(storage()),
        }
    }
    Ok(path)
}
fn path(layout: &Layout, id: &str, create: bool) -> Result<PathBuf, ExtError> {
    if !imported::is_hash(id) {
        return Err(imported::invalid());
    }
    Ok(directory(layout, create)?.join(format!("{id}.json")))
}
fn check_ledger(ledger: &Ledger) -> Result<(), ExtError> {
    Receipt::parse(&serde_json::to_value(&ledger.receipt).map_err(|_| storage())?)?;
    if ledger.version != 1
        || !imported::valid_run(&ledger.run_id)
        || !imported::is_hash(&ledger.candidate_sha256)
        || !imported::is_hash(&ledger.package_sha256)
        || !imported::is_hash(&ledger.manifest_sha256)
        || ledger.extension_version != version(&ledger.receipt.fingerprint)
        || ledger.receipt.installation_id
            != installation_id(
                &ledger.run_id,
                &ledger.receipt.fingerprint,
                &ledger.candidate_sha256,
            )
        || !ledger.config_before.is_null()
        || ledger
            .installed_at
            .as_deref()
            .is_some_and(|date| record::parse_iso_ms(date).is_none())
        || ledger.phase == Phase::Installed
            && (ledger.installed_at.is_none() || ledger.config_installed.is_none())
    {
        return Err(storage());
    }
    if let Some(config) = &ledger.config_installed {
        if config["enabled"] != false || !config.is_object() {
            return Err(storage());
        }
    }
    Ok(())
}
fn read_ledger(layout: &Layout, id: &str) -> Result<Option<Ledger>, ExtError> {
    let path = path(layout, id, false)?;
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(storage()),
        Ok(_) => {}
    }
    let ledger: Ledger =
        serde_json::from_value(imported::read_metadata(&path, true)?).map_err(|_| storage())?;
    check_ledger(&ledger)?;
    if ledger.receipt.installation_id != id {
        return Err(storage());
    }
    Ok(Some(ledger))
}
fn persist(layout: &Layout, ledger: &Ledger) -> Result<(), ExtError> {
    check_ledger(ledger)?;
    let path = path(layout, &ledger.receipt.installation_id, true)?;
    let temporary = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4().simple()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.access_mode(
                windows_sys::Win32::Foundation::GENERIC_WRITE
                    | windows_sys::Win32::Storage::FileSystem::WRITE_DAC,
            );
        }
        let mut file = options.open(&temporary).map_err(|_| storage())?;
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            plur1bus_rpc::win::restrict_to_user(file.as_raw_handle()).map_err(|_| storage())?;
        }
        let bytes = serde_json::to_vec(ledger).map_err(|_| storage())?;
        if bytes.len() > imported::MAX_METADATA as usize {
            return Err(storage());
        }
        file.write_all(&bytes)
            .and_then(|()| file.sync_all())
            .map_err(|_| storage())?;
        drop(file);
        state::rename_retrying(&temporary, &path).map_err(|_| storage())?;
        #[cfg(unix)]
        fs::File::open(path.parent().ok_or_else(storage)?)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| storage())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}
fn package_root(layout: &Layout, record: &ItemRecord) -> Result<PathBuf, ExtError> {
    let mut root = layout.home.clone();
    for part in ["mcp", &record.name, &record.version] {
        root.push(part);
        let metadata = fs::symlink_metadata(&root).map_err(|_| conflict())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(conflict());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes()
                & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
                != 0
            {
                return Err(conflict());
            }
        }
    }
    Ok(root)
}
fn manifest(layout: &Layout, record: &ItemRecord) -> Result<Value, ExtError> {
    let path = package_root(layout, record)?.join("p1x.json");
    let bytes = imported::read_metadata_bytes(&path, false)?;
    if record.manifest_sha256.as_deref() != Some(imported::hash(&bytes).as_str()) {
        return Err(conflict());
    }
    let manifest: Value = serde_json::from_slice(&bytes).map_err(|_| storage())?;
    if manifest["name"] != record.name
        || manifest["id"] != record.id
        || manifest["version"] != record.version
    {
        return Err(conflict());
    }
    Ok(manifest)
}
fn unchanged_payload(
    layout: &Layout,
    record: &ItemRecord,
    manifest: &Value,
) -> Result<(), ExtError> {
    let payload = package_root(layout, record)?.join("payload");
    let metadata = fs::symlink_metadata(&payload).map_err(|_| conflict())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(conflict());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes()
            & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
            != 0
        {
            return Err(conflict());
        }
    }
    let files = manifest["files"].as_object().ok_or_else(conflict)?;
    let expected: &[&str] = if manifest["remote"].is_object() {
        &["payload/README.md"]
    } else {
        &[
            "payload/README.md",
            "payload/manifest.json",
            "payload/SETUP_REQUIRED.txt",
        ]
    };
    if files.len() != expected.len() || expected.iter().any(|name| !files.contains_key(*name)) {
        return Err(conflict());
    }
    for name in expected {
        let want = &files[*name];
        let bytes = imported::read_metadata_bytes(
            &payload.join(name.strip_prefix("payload/").ok_or_else(conflict)?),
            false,
        )
        .map_err(|_| conflict())?;
        if want["size"].as_u64() != Some(bytes.len() as u64)
            || want["sha256"] != imported::hash(&bytes)
            || want["exec"] == true
        {
            return Err(conflict());
        }
    }
    Ok(())
}
fn matches_candidate(
    layout: &Layout,
    record: &ItemRecord,
    candidate: &Candidate,
) -> Result<bool, ExtError> {
    if record.name != candidate.name
        || record.kind != "mcp-server"
        || record.id != candidate.identity()
        || record.version != candidate.version()
        || record.trust != "imported"
        || record.removed_by_user
    {
        return Ok(false);
    }
    let note = format!(
        "Imported candidate SHA-256: {}. Installation: ",
        candidate.digest()?
    );
    let manifest = manifest(layout, record)?;
    Ok(manifest["notes"]["en"]
        .as_str()
        .is_some_and(|actual| actual.starts_with(&note))
        && unchanged_payload(layout, record, &manifest).is_ok())
}
fn own_record(layout: &Layout, ledger: &Ledger) -> Result<Option<ItemRecord>, ExtError> {
    let state = state::read(&ExtPaths::of(layout)).map_err(|_| storage())?;
    let Some(record) = state.items.get(&ledger.receipt.name) else {
        return Ok(None);
    };
    if record.name != ledger.receipt.name
        || record.kind != "mcp-server"
        || record.trust != "imported"
        || record.id != format!("imported/{}", ledger.receipt.name)
        || record.version != ledger.extension_version
        || record.package_sha256 != ledger.package_sha256
        || record.manifest_sha256.as_deref() != Some(ledger.manifest_sha256.as_str())
        || record.removed_by_user
        || record.capabilities_ack.is_some()
        || ledger
            .installed_at
            .as_ref()
            .is_some_and(|at| at != &record.installed_at)
        || manifest(layout, record)?["notes"]["en"]
            != imported::provenance_note(&ledger.candidate_sha256, &ledger.receipt.installation_id)
    {
        return Err(conflict());
    }
    unchanged_payload(layout, record, &manifest(layout, record)?)?;
    Ok(Some(record.clone()))
}
fn conflict_without_record(layout: &Layout, config: &Value, name: &str) -> bool {
    config["mcp"]["servers"].get(name).is_some()
        || fs::symlink_metadata(layout.home.join("mcp").join(name)).is_ok()
        || config["providers"]["mcp"]["servers"]
            .as_array()
            .is_some_and(|servers| servers.iter().any(|server| server["name"] == name))
}
fn config(layout: &Layout) -> Result<Value, ExtError> {
    plur1bus_config::read(&layout.config_path()).map_err(|_| storage())
}

/// Existing imported entries never become owned by a new import run.
pub fn plan(layout: &Layout, value: &Value) -> Result<Value, ExtError> {
    let candidate = Candidate::parse(value)?;
    let state = state::read(&ExtPaths::of(layout)).map_err(|_| storage())?;
    let config = config(layout)?;
    let action = if let Some(record) = state.items.get(&candidate.name) {
        if matches_candidate(layout, record, &candidate)? {
            "existing"
        } else {
            "conflict"
        }
    } else if config["extensions"]["allowUnsigned"] == false
        || record::check_name(
            layout,
            &state,
            &candidate.name,
            &candidate.identity(),
            "mcp-server",
        )
        .is_err()
        || conflict_without_record(layout, &config, &candidate.name)
    {
        "conflict"
    } else {
        "install"
    };
    Ok(json!({"action":action}))
}
/// The trusted parent supplies its validated run identity, never a worker-selected override.
pub fn plan_for_run(layout: &Layout, value: &Value, run_id: &str) -> Result<Value, ExtError> {
    let candidate = Candidate::parse(value)?;
    if !imported::valid_run(run_id) {
        return Err(imported::invalid());
    }
    let id = installation_id(run_id, &candidate.fingerprint, &candidate.digest()?);
    if let Some(ledger) = read_ledger(layout, &id)? {
        if ledger.phase == Phase::RolledBack {
            return Ok(json!({"action":"conflict"}));
        }
        own_record(layout, &ledger)?;
        return Ok(json!({"action":"install"}));
    }
    plan(layout, value)
}
struct Cleanup<'a> {
    layout: &'a Layout,
    id: String,
    name: String,
    candidate: PathBuf,
}
impl Drop for Cleanup<'_> {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.candidate);
        let _ = fs::remove_file(record::record_path(self.layout, &self.id));
        let _ = fs::remove_file(record::spool_path(self.layout, &self.id));
        let _ =
            state::remove_dir_all_retrying(&record::staging_dir(self.layout, &self.name, &self.id));
        let _ = fs::remove_dir(ExtPaths::of(self.layout).staging);
    }
}
fn prepare<'a>(
    exe: Option<&Path>,
    layout: &'a Layout,
    candidate: &Candidate,
    installation_id: &str,
    check: &dyn Fn() -> Result<(), ExtError>,
) -> Result<(Prepared, Cleanup<'a>), ExtError> {
    let id = ext::worker::new_inspection_id();
    let directory = ExtPaths::of(layout).inspect;
    fs::create_dir_all(&directory).map_err(|_| storage())?;
    if fs::symlink_metadata(&directory)
        .map_err(|_| storage())?
        .file_type()
        .is_symlink()
    {
        return Err(storage());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
            .map_err(|_| storage())?;
    }
    let path = directory.join(format!("{id}.tmp-candidate"));
    let cleanup = Cleanup {
        layout,
        id: id.clone(),
        name: candidate.name.clone(),
        candidate: path.clone(),
    };
    let mut file = crate::audit::create_private(&path, true).map_err(|_| storage())?;
    file.write_all(&serde_json::to_vec(candidate).map_err(|_| storage())?)
        .and_then(|()| file.sync_all())
        .map_err(|_| storage())?;
    drop(file);
    let path = path.to_str().ok_or_else(storage)?;
    let args = [
        "import-mcp",
        "--id",
        &id,
        "--installation-id",
        installation_id,
        "--candidate-file",
        path,
    ];
    let answer = match exe {
        Some(exe) => ext::worker::spawn_worker_with_check(
            exe,
            layout,
            &args,
            ext::worker::STAGE_DEADLINE,
            check,
        ),
        None => {
            ext::worker::spawn_worker_checked(layout, &args, ext::worker::STAGE_DEADLINE, check)
        }
    }
    .map_err(|error| {
        if matches!(error.reason, Some("import-aborted" | "import-deadline")) {
            error
        } else {
            storage()
        }
    })?;
    let prepared: Prepared = serde_json::from_value(answer).map_err(|_| storage())?;
    let record = &prepared.staged.record;
    if prepared.staged.name != candidate.name
        || prepared.staged.kind != plur1bus_ext::manifest::Kind::McpServer
        || record.id != candidate.identity()
        || record.version != candidate.version()
        || record.trust != "imported"
        || record.capabilities_ack.is_some()
        || !record.scripts.is_empty()
        || !imported::is_hash(&record.package_sha256)
        || !record
            .manifest_sha256
            .as_deref()
            .is_some_and(imported::is_hash)
        || prepared.inspection.manifest["notes"]["en"]
            != imported::provenance_note(&candidate.digest()?, installation_id)
    {
        return Err(storage());
    }
    Ok((prepared, cleanup))
}

pub fn install(
    layout: &Layout,
    host: &mut dyn ModuleHost,
    candidate: &Value,
    run_id: &str,
) -> Result<Value, ExtError> {
    install_with(None, layout, host, candidate, run_id)
}
fn install_with(
    exe: Option<&Path>,
    layout: &Layout,
    host: &mut dyn ModuleHost,
    value: &Value,
    run_id: &str,
) -> Result<Value, ExtError> {
    host.check_cancelled()?;
    let candidate = Candidate::parse(value)?;
    if !imported::valid_run(run_id) {
        return Err(imported::invalid());
    }
    let digest = candidate.digest()?;
    let id = installation_id(run_id, &candidate.fingerprint, &digest);
    let guard = ext::try_mutation()?;
    let previous = read_ledger(layout, &id)?;
    if let Some(ledger) = &previous {
        if ledger.phase == Phase::RolledBack {
            return Err(conflict());
        }
        if let Some(record) = own_record(layout, ledger)? {
            let section = record::config_section(&host.config(), &candidate.name, "mcp-server");
            if section["enabled"] != false {
                return Err(conflict());
            }
            let mut committed = ledger.clone();
            committed.phase = Phase::Installed;
            committed.installed_at = Some(record.installed_at);
            committed.config_installed = Some(section);
            persist(layout, &committed)?;
            return serde_json::to_value(&committed.receipt).map_err(|_| storage());
        }
        if ledger.phase == Phase::Installed {
            return Err(conflict());
        }
    }
    if plan(layout, value)?["action"] != "install" {
        return Err(conflict());
    }
    let (prepared, _cleanup) = prepare(exe, layout, &candidate, &id, &|| host.check_cancelled())?;
    host.check_cancelled()?;
    let staged = &prepared.staged.record;
    let mut ledger = Ledger {
        version: 1,
        run_id: run_id.into(),
        receipt: Receipt {
            schema: "import.extension-receipt/1".into(),
            name: candidate.name.clone(),
            fingerprint: candidate.fingerprint.clone(),
            installation_id: id,
        },
        candidate_sha256: digest,
        package_sha256: staged.package_sha256.clone(),
        manifest_sha256: staged.manifest_sha256.clone().ok_or_else(storage)?,
        extension_version: staged.version.clone(),
        config_before: Value::Null,
        config_installed: None,
        installed_at: None,
        phase: Phase::Prepared,
    };
    if previous
        .as_ref()
        .is_some_and(|previous| previous.package_sha256 != ledger.package_sha256)
    {
        return Err(conflict());
    }
    host.check_cancelled()?;
    persist(layout, &ledger)?;
    commit::fail_at("import.prepared")?;
    host.check_cancelled()?;
    commit::install_commit_held(
        layout,
        host,
        &prepared.inspection,
        prepared.staged,
        &commit::InstallOpts::default(),
        &guard,
    )?;
    commit::fail_at("import.committed")?;
    let installed = own_record(layout, &ledger)?.ok_or_else(storage)?;
    ledger.installed_at = Some(installed.installed_at);
    ledger.phase = Phase::Installed;
    ledger.config_installed = Some(record::config_section(
        &host.config(),
        &candidate.name,
        "mcp-server",
    ));
    persist(layout, &ledger)?;
    serde_json::to_value(&ledger.receipt).map_err(|_| storage())
}
/// Only this receipt's exact installation is removable; extension data and unrelated code survive.
pub fn rollback(
    layout: &Layout,
    host: &mut dyn ModuleHost,
    value: &Value,
) -> Result<Value, ExtError> {
    let receipt = Receipt::parse(value)?;
    let guard = ext::try_mutation()?;
    let Some(mut ledger) = read_ledger(layout, &receipt.installation_id)? else {
        return Err(conflict());
    };
    if ledger.receipt != receipt {
        return Err(conflict());
    }
    if ledger.phase == Phase::RolledBack {
        return Ok(Value::Null);
    }
    let record = own_record(layout, &ledger)?;
    let section = record::config_section(&host.config(), &receipt.name, "mcp-server");
    let expected = ledger
        .config_installed
        .as_ref()
        .is_some_and(|expected| expected == &section)
        || ledger.phase == Phase::Prepared && section["enabled"] == false;
    if !section.is_null() && !expected {
        return Err(conflict());
    }
    if record.is_some() {
        ext::remove::uninstall_held(
            layout,
            host,
            &receipt.name,
            &ext::remove::RemoveOpts::default(),
            &guard,
        )?;
    }
    if !record::config_section(&host.config(), &receipt.name, "mcp-server").is_null() {
        host.set_config(
            vec![(
                record::config_key(&receipt.name, "mcp-server"),
                ledger.config_before.clone(),
            )],
            false,
        )?;
    }
    ledger.phase = Phase::RolledBack;
    persist(layout, &ledger)?;
    Ok(Value::Null)
}
/// Recovery includes receipts lost between native commit and the worker sidecar's publication.
pub fn rollback_run(
    layout: &Layout,
    host: &mut dyn ModuleHost,
    run_id: &str,
) -> Result<Value, ExtError> {
    if !imported::valid_run(run_id) {
        return Err(imported::invalid());
    }
    let directory = directory(layout, false)?;
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Value::Null),
        Err(_) => return Err(storage()),
    };
    let mut receipts = Vec::new();
    for (index, entry) in entries.enumerate() {
        if index >= 10_000 {
            return Err(storage());
        }
        let entry = entry.map_err(|_| storage())?;
        let Some(id) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.strip_suffix(".json"))
            .map(str::to_owned)
        else {
            continue;
        };
        if !imported::is_hash(&id) {
            continue;
        }
        let ledger = read_ledger(layout, &id)?.ok_or_else(storage)?;
        if ledger.run_id == run_id && ledger.phase != Phase::RolledBack {
            receipts.push(ledger.receipt);
        }
    }
    for receipt in receipts.into_iter().rev() {
        rollback(
            layout,
            host,
            &serde_json::to_value(receipt).map_err(|_| storage())?,
        )?;
    }
    Ok(Value::Null)
}
#[cfg(test)]
pub fn install_with_worker(
    exe: &Path,
    layout: &Layout,
    host: &mut dyn ModuleHost,
    candidate: &Value,
    run_id: &str,
) -> Result<Value, ExtError> {
    install_with(Some(exe), layout, host, candidate, run_id)
}
