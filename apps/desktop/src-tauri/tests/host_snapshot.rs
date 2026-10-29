//! Host import capabilities are bound to a selected directory and use a pinned, injected producer.
use plur1bus_desktop::controller::bundle::{CliArtifact, SnapshotRuntime};
use plur1bus_desktop::snapshot_commands::{verify_runtime, SourceSelections};
use sha2::{Digest, Sha256};

#[test]
fn source_selection_handles_are_bound_to_the_active_connection_and_never_serialize_paths() {
    let dir = tempfile::tempdir().unwrap();
    let a = uuid::Uuid::now_v7();
    let b = uuid::Uuid::now_v7();
    let mut selections = SourceSelections::default();
    let picked = selections.insert(a, dir.path().to_path_buf()).unwrap();
    let encoded = serde_json::to_string(&picked).unwrap();
    assert!(!encoded.contains(dir.path().to_str().unwrap()));
    assert!(selections.get(b, &picked.selection_id).is_err());
    assert_eq!(selections.get(a, &picked.selection_id).unwrap(), dir.path());
}

#[test]
fn snapshot_runtime_hashes_are_checked_before_a_producer_can_be_started() {
    let resources = tempfile::tempdir().unwrap();
    std::fs::create_dir(resources.path().join("snapshot")).unwrap();
    std::fs::write(
        resources.path().join("snapshot/node"),
        b"verified node fixture",
    )
    .unwrap();
    std::fs::write(
        resources.path().join("snapshot/import-snapshot.mjs"),
        b"verified entry fixture",
    )
    .unwrap();
    let runtime = SnapshotRuntime {
        node_version: "24.21.0".into(),
        node: CliArtifact {
            path: "snapshot/node".into(),
            sha256: format!("{:x}", Sha256::digest(b"verified node fixture")),
        },
        entry: CliArtifact {
            path: "snapshot/import-snapshot.mjs".into(),
            sha256: format!("{:x}", Sha256::digest(b"verified entry fixture")),
        },
    };
    assert!(verify_runtime(resources.path(), &runtime).is_ok());
    std::fs::write(
        resources.path().join("snapshot/import-snapshot.mjs"),
        b"modified",
    )
    .unwrap();
    assert!(verify_runtime(resources.path(), &runtime).is_err());
}

#[test]
fn file_dialog_responses_accept_one_local_selection_and_refuse_foreign_urls() {
    use plur1bus_desktop::file_dialog::selected_uri;
    let path = std::env::temp_dir();
    let uri = url::Url::from_directory_path(&path).unwrap().to_string();
    assert_eq!(selected_uri(&[uri]).unwrap(), path);
    for uris in [
        vec![],
        vec!["https://foreign.test/folder".into()],
        vec!["file://foreign.test/folder".into()],
        vec!["file:///one".into(), "file:///two".into()],
    ] {
        assert!(selected_uri(&uris).is_err());
    }
}

#[tokio::test]
async fn native_runtime_executes_the_packaged_shared_snapshot_producer() {
    use plur1bus_desktop::snapshot_commands::{produce_snapshot, NativeSnapshotProducer};
    let root = tempfile::tempdir().unwrap();
    let fixture = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/snapshot-runtime.ts");
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        tokio::process::Command::new("node")
            .args(["--experimental-strip-types", "--conditions=source"])
            .arg(fixture)
            .arg(root.path())
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(
        output.status.success(),
        "packaged producer fixture requires pinned Node and installed workspace packages"
    );
    assert!(output.stdout.len() < 16 * 1024);
    let prepared: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let runtime: SnapshotRuntime = serde_json::from_value(prepared["runtime"].clone()).unwrap();
    let produced = produce_snapshot(
        &root.path().join("resources"),
        &runtime,
        prepared["sourceType"].as_str().unwrap(),
        &root.path().join("source"),
        &NativeSnapshotProducer,
    )
    .await
    .unwrap();
    assert!(produced.summary.file_count >= 2);
    assert!(produced.summary.bytes > 0);
    assert!(produced.archive().is_file());
    assert!(!serde_json::to_string(&produced.summary)
        .unwrap()
        .contains(root.path().to_str().unwrap()));
    let archive = produced.archive().to_owned();
    drop(produced);
    assert!(
        !archive.exists(),
        "native temporary artifacts are removed after the operation"
    );
}

#[test]
fn snapshot_requests_carry_an_opaque_selection_and_never_a_local_source_path() {
    let request = serde_json::json!({"selectionId":"selected","sourceType":"fixture"});
    assert!(
        serde_json::from_value::<plur1bus_desktop::snapshot_commands::SnapshotRequest>(
            request.clone()
        )
        .is_ok()
    );
    let mut unsafe_request = request;
    unsafe_request["sourceRoot"] = serde_json::json!("/private/credential");
    assert!(
        serde_json::from_value::<plur1bus_desktop::snapshot_commands::SnapshotRequest>(
            unsafe_request
        )
        .is_err()
    );
}

struct ProducerFixture {
    wrong_size: bool,
}
#[async_trait::async_trait]
impl plur1bus_desktop::snapshot_commands::SnapshotProducer for ProducerFixture {
    async fn execute(
        &self,
        node: &std::path::Path,
        entry: &std::path::Path,
        bytes: Vec<u8>,
    ) -> Result<Vec<u8>, &'static str> {
        assert_eq!(node.file_name().unwrap(), "node");
        assert_eq!(entry.file_name().unwrap(), "import-snapshot.mjs");
        let job: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(job["schema"], "desktop.import-snapshot/1");
        assert_eq!(job["allowLiveCopy"], false);
        std::fs::write(
            std::path::Path::new(job["home"].as_str().unwrap()).join("snapshot.tar.gz"),
            b"archive",
        )
        .unwrap();
        Ok(serde_json::to_vec(
            &serde_json::json!({"schema":"desktop.import-snapshot-result/1","ok":true,
            "fileCount":1,"bytes":7,"archiveBytes":if self.wrong_size { 999 } else { 7 },
            "sha256":format!("{:x}",Sha256::digest(b"archive"))}),
        )
        .unwrap())
    }
}

#[tokio::test]
async fn native_producer_invocation_checks_receipts_and_cleans_owned_artifacts() {
    use plur1bus_desktop::snapshot_commands::produce_snapshot;
    let resources = tempfile::tempdir().unwrap();
    std::fs::write(resources.path().join("node"), b"node fixture").unwrap();
    std::fs::write(
        resources.path().join("import-snapshot.mjs"),
        b"entry fixture",
    )
    .unwrap();
    let runtime = SnapshotRuntime {
        node_version: "24.21.0".into(),
        node: CliArtifact {
            path: "node".into(),
            sha256: format!("{:x}", Sha256::digest(b"node fixture")),
        },
        entry: CliArtifact {
            path: "import-snapshot.mjs".into(),
            sha256: format!("{:x}", Sha256::digest(b"entry fixture")),
        },
    };
    assert!(produce_snapshot(
        resources.path(),
        &runtime,
        "fixture",
        resources.path(),
        &ProducerFixture { wrong_size: true }
    )
    .await
    .is_err());
    let produced = produce_snapshot(
        resources.path(),
        &runtime,
        "fixture",
        resources.path(),
        &ProducerFixture { wrong_size: false },
    )
    .await
    .unwrap();
    let path = produced.archive().to_path_buf();
    assert_eq!(std::fs::read(&path).unwrap(), b"archive");
    assert_eq!(
        serde_json::to_value(&produced.summary).unwrap().get("home"),
        None
    );
    drop(produced);
    assert!(!path.exists());
}

#[test]
fn only_active_spa_generation_gets_the_two_readonly_host_import_commands() {
    let origin = plur1bus_desktop::connections::Origin::parse("http://127.0.0.1:32123").unwrap();
    let live = plur1bus_desktop::spa::bridge_capability(&origin, false);
    let retired = plur1bus_desktop::spa::bridge_capability(&origin, true);
    for command in ["host-file-pick", "host-import-snapshot"] {
        assert!(live["permissions"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!(format!("allow-{command}"))));
        assert!(retired["permissions"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!(format!("deny-{command}"))));
    }
    assert!(plur1bus_desktop::commands::allowed_command(
        "shell",
        "host_file_pick"
    ));
    assert!(!plur1bus_desktop::commands::allowed_command(
        "approvals",
        "host_file_pick"
    ));
}
