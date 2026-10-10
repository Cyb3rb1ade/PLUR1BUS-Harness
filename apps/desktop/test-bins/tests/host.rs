use plur1bus_desktop::helper;
use std::{path::PathBuf, time::Duration};
use tokio::io::AsyncWriteExt;
#[tokio::test]
async fn helper_gets_no_inherited_env_in_the_actual_child() {
    let path = PathBuf::from(env!("CARGO_BIN_EXE_fake-host"));
    let vars = vec![
        ("PATH".into(), "/usr/bin".into()),
        ("HOME".into(), "/p1t/home".into()),
        ("LANG".into(), "de_DE.UTF-8".into()),
        ("INJECTED_SECRET".into(), "unused".into()),
        ("LD_PRELOAD".into(), "unused".into()),
    ];
    let mut child = helper::command(&path, vars).spawn().unwrap();
    let mut input = child.stdin.take().unwrap();
    input
        .write_all(b"{\"method\":\"environment\"}\n")
        .await
        .unwrap();
    drop(input);
    let output = child.wait_with_output().await.unwrap();
    let names: Vec<String> = serde_json::from_slice(&output.stdout).unwrap();
    assert!(!names
        .iter()
        .any(|n| n == "INJECTED_SECRET" || n == "LD_PRELOAD"));
    assert!(names
        .iter()
        .all(|n| ["PATH", "HOME", "LANG"].contains(&n.as_str())));
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
