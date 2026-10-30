//! Worker deadlines terminate inherited descendants and release captured pipes (M-A11).
#![allow(dead_code)]
mod paths {
    pub struct Layout {
        pub home: std::path::PathBuf,
    }
}
mod ext {
    #[derive(Debug)]
    pub struct ExtError {
        pub code: &'static str,
        pub reason: Option<&'static str>,
        pub message: String,
        pub data: serde_json::Value,
    }
    impl ExtError {
        pub fn new(code: &'static str, reason: &'static str, message: impl Into<String>) -> Self {
            Self {
                code,
                reason: Some(reason),
                message: message.into(),
                data: serde_json::Value::Null,
            }
        }
        pub fn with_data(mut self, data: serde_json::Value) -> Self {
            self.data = data;
            self
        }
    }
}
use ext::ExtError;
#[path = "../src/ext/worker.rs"]
pub mod worker;

#[cfg(unix)]
#[test]
fn deadline_kills_the_worker_descendant_before_its_delayed_write() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("worker.sh");
    let marker = dir.path().join("escaped");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\n(sleep 0.7; printf escaped > '{}') >/dev/null 2>&1 &\nsleep 20\n",
            marker.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let started = std::time::Instant::now();
    let result = worker::spawn_worker_with(
        &script,
        &paths::Layout {
            home: dir.path().into(),
        },
        &[],
        std::time::Duration::from_millis(100),
    );
    assert!(result.is_err());
    assert!(started.elapsed() < std::time::Duration::from_secs(2));
    std::thread::sleep(std::time::Duration::from_millis(850));
    assert!(
        !marker.exists(),
        "worker descendant escaped the parser deadline"
    );
}

#[cfg(unix)]
#[test]
fn a_successful_worker_cannot_leave_a_descendant_running() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("worker.sh");
    let marker = dir.path().join("escaped");
    std::fs::write(&script,format!("#!/bin/sh\n(sleep 0.7; printf escaped > '{}') >/dev/null 2>&1 &\nprintf '{{\"ok\":true,\"result\":{{}}}}\\n'\n",marker.display())).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    worker::spawn_worker_with(
        &script,
        &paths::Layout {
            home: dir.path().into(),
        },
        &[],
        std::time::Duration::from_secs(2),
    )
    .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(850));
    assert!(!marker.exists());
}
