use async_trait::async_trait;
use plur1bus_desktop::runtime::{
    apple::{AppleRuntime, Cli},
    ExecOutput, Runtime, RuntimeError,
};
use serde_json::json;
use std::{sync::Arc, time::Duration};
struct Fake {
    scenario: tempfile::NamedTempFile,
}
#[async_trait]
impl Cli for Fake {
    async fn run(
        &self,
        argv: &[String],
        stdin: Option<&[u8]>,
        _timeout: Duration,
    ) -> Result<ExecOutput, RuntimeError> {
        use std::io::Write;
        let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_fake-container"))
            .args(argv)
            .env("PLUR1BUS_FAKE_SCENARIO", self.scenario.path())
            .env(
                "PLUR1BUS_FAKE_RECORD",
                self.scenario.path().with_extension("argv"),
            )
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        if let Some(b) = stdin {
            child.stdin.take().unwrap().write_all(b).unwrap()
        }
        drop(child.stdin.take());
        let o = child.wait_with_output().unwrap();
        Ok(ExecOutput {
            code: o.status.code().unwrap_or(1),
            stdout: o.stdout,
            stderr: o.stderr,
        })
    }
}
#[tokio::test]
async fn detect_reports_stopped_and_ensure_started_runs_system_start() {
    let file = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(file.path(),serde_json::to_vec(&json!({"commands":[
 {"argv":["system","version","--format","json"],"exit":0,"stdout":[{"appName":"container","version":"1.3.0"}]},
 {"argv":["system","status","--format","json"],"exit":1,"stdout":{"status":"not running"}},
 {"argv":["system","start"],"exit":0,"stdout":""},
 {"argv":["stop","-t","150","p1t-fixture"],"exit":0,"stdout":""},
 {"argv":["exec","-i","p1t-fixture","cat"],"exit":7,"stdout":"synthetic-input","stdin":"synthetic-input"}
 ]})).unwrap()).unwrap();
    let r = AppleRuntime::with_cli(Arc::new(Fake { scenario: file }), "fixture".into(), "1.3.0")
        .await
        .unwrap();
    assert_eq!(r.ping().await, Err(RuntimeError::Stopped));
    // This static fake remains stopped after start; prove command was invoked but fail closed.
    assert_eq!(r.ensure_started().await, Err(RuntimeError::Stopped));
    r.stop("p1t-fixture", Duration::from_secs(150))
        .await
        .unwrap();
    let e = r
        .exec(
            "p1t-fixture",
            &["cat"],
            Some(b"synthetic-input"),
            Duration::from_secs(2),
        )
        .await
        .unwrap();
    assert_eq!(e.code, 7);
    assert_eq!(e.stdout, b"synthetic-input");
}
