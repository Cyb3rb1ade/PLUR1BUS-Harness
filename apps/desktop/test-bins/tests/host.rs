#[path = "support/cleared_environment.rs"]
mod cleared_environment;
use plur1bus_desktop::helper;
use std::{path::PathBuf, time::Duration};
use tokio::io::AsyncWriteExt;
#[tokio::test]
async fn helper_gets_no_inherited_env_in_the_actual_child() {
    let path = PathBuf::from(env!("CARGO_BIN_EXE_fake-host"));
    let mut baseline = std::process::Command::new(&path)
        .env_clear()
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    std::io::Write::write_all(
        &mut baseline.stdin.take().unwrap(),
        b"{\"method\":\"environment\"}\n",
    )
    .unwrap();
    let baseline = baseline.wait_with_output().unwrap();
    assert!(baseline.status.success());
    let cleared: serde_json::Value = serde_json::from_slice(&baseline.stdout).unwrap();
    let vars = vec![
        ("PATH".into(), "/usr/bin".into()),
        ("HOME".into(), "/p1t/home".into()),
        ("LANG".into(), "de_DE.UTF-8".into()),
        ("INJECTED_SECRET".into(), "unused".into()),
        ("LD_PRELOAD".into(), "unused".into()),
        ("PROCESSOR_ARCHITECTURE".into(), "must-not-pass".into()),
    ];
    let mut child = helper::command(&path, vars).spawn().unwrap();
    let mut input = child.stdin.take().unwrap();
    input
        .write_all(b"{\"method\":\"environment\"}\n")
        .await
        .unwrap();
    drop(input);
    let output = child.wait_with_output().await.unwrap();
    assert!(output.status.success());
    let actual: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    cleared_environment::assert_environment(&actual, &cleared, &["PATH", "HOME", "LANG"]);
    let names = actual["env"].as_array().unwrap();
    for expected in ["PATH", "HOME", "LANG"] {
        assert!(
            names.iter().any(|name| name == expected),
            "missing explicit helper variable"
        );
    }
}
#[tokio::test]
async fn helper_is_restarted_with_backoff_after_an_actual_child_exit() {
    let owner = helper::Owner::default();
    owner.start_at(
        PathBuf::from(env!("CARGO_BIN_EXE_fake-host")),
        vec![],
        || 0.5,
    );
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if owner.status.lock().unwrap().restarting {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(owner.status.lock().unwrap().attempts, 1);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(owner.status.lock().unwrap().attempts, 1);
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if owner.status.lock().unwrap().attempts >= 2 {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    owner.stop();
}
