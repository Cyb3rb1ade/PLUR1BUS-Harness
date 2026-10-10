use plur1bus_desktop::runtime::{
    apple::{create_argv, parse_status, parse_version},
    spec::oneshot_spec,
    RuntimeError,
};
#[test]
fn unknown_json_fields_are_ignored_required_ones_are_not() {
    assert_eq!(
        parse_version(
            br#"[{"appName":"container","version":"1.3.0","newField":true}]"#,
            "1.3.0"
        )
        .unwrap(),
        "1.3.0"
    );
    assert!(parse_version(br#"[{"appName":"container"}]"#, "1.3.0").is_err());
    assert!(!parse_status(br#"{"status":"not running","newField":true}"#).unwrap());
}
#[test]
fn detect_parses_version_and_refuses_too_old() {
    assert!(matches!(
        parse_version(br#"[{"appName":"container","version":"1.2.0"}]"#, "1.3.0"),
        Err(RuntimeError::TooOld { .. })
    ));
}
#[test]
fn create_passes_exactly_the_spec_flags() {
    let s = oneshot_spec(
        &format!("sha256:{}", "a".repeat(64)),
        vec!["true".into()],
        vec![],
    );
    let a = create_argv(&s).unwrap();
    assert_eq!(
        &a[3..13],
        &[
            "-m",
            "3072M",
            "-c",
            "1",
            "--read-only",
            "--user",
            "10001:10001",
            "--tmpfs",
            "/tmp",
            "--network"
        ]
    );
    assert!(!a.iter().any(|v| v == "--restart"));
}

#[test]
fn malformed_versions_are_refused_instead_of_zero_filled() {
    assert!(parse_version(
        br#"[{"appName":"container","version":"999.not-a-version"}]"#,
        "1.3.0"
    )
    .is_err());
}
#[test]
fn inspect_uses_the_nested_status_and_required_configuration() {
    use plur1bus_desktop::runtime::apple::parse_state;
    let s=parse_state(br#"[{"configuration":{"id":"p1t-fixture","labels":{},"image":{"reference":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}},"status":{"state":"running","networks":[]}}]"#,"p1t-fixture").unwrap();
    assert!(s.exists && s.running);
    assert!(parse_state(
        br#"[{"configuration":{"id":"p1t-fixture"},"status":{"state":"running"}}]"#,
        "p1t-fixture"
    )
    .is_err());
}
#[cfg(target_os = "macos")]
#[tokio::test]
async fn detect_refuses_an_unsigned_binary() {
    let h = tempfile::tempdir().unwrap();
    let path = h.path().join("unsigned");
    std::fs::write(&path, b"synthetic unsigned fixture").unwrap();
    assert!(matches!(
        plur1bus_desktop::runtime::apple::SignedCli::verify(path, "UPBK2H6LZM").await,
        Err(RuntimeError::NoAccess(_))
    ));
}

struct ConflictingCli(std::sync::Arc<std::sync::atomic::AtomicUsize>);
#[async_trait::async_trait]
impl plur1bus_desktop::runtime::apple::Cli for ConflictingCli {
    async fn run(
        &self,
        argv: &[String],
        _stdin: Option<&[u8]>,
        _timeout: std::time::Duration,
    ) -> Result<plur1bus_desktop::runtime::ExecOutput, RuntimeError> {
        use plur1bus_desktop::runtime::ExecOutput;
        match argv[0].as_str() {
            "system" => Ok(ExecOutput {
                code: 0,
                stdout: br#"[{"appName":"container","version":"1.3.0"}]"#.to_vec(),
                stderr: vec![],
            }),
            "create" => Ok(ExecOutput {
                code: 1,
                stdout: vec![],
                stderr: b"already exists".to_vec(),
            }),
            "delete" => {
                self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(ExecOutput {
                    code: 0,
                    stdout: vec![],
                    stderr: vec![],
                })
            }
            _ => Err(RuntimeError::Failed("unexpected".into())),
        }
    }
}
#[tokio::test]
async fn conflicting_oneshot_never_deletes_the_existing_container() {
    use plur1bus_desktop::runtime::{apple::AppleRuntime, Runtime};
    let deletes = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let r = AppleRuntime::with_cli(
        std::sync::Arc::new(ConflictingCli(deletes.clone())),
        "fixture".into(),
        "1.3.0",
    )
    .await
    .unwrap();
    let s = oneshot_spec(
        &format!("sha256:{}", "a".repeat(64)),
        vec!["true".into()],
        vec![],
    );
    assert!(matches!(
        r.run_oneshot(&s, std::time::Duration::from_secs(2)).await,
        Err(RuntimeError::Conflict(_))
    ));
    assert_eq!(deletes.load(std::sync::atomic::Ordering::SeqCst), 0);
}
#[test]
fn unregistered_services_are_stopped_and_can_be_started() {
    assert!(!parse_status(br#"{"status":"unregistered"}"#).unwrap());
}
