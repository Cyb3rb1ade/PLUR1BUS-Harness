use assert_cmd::prelude::*;
use serde_json::Value;
use std::process::Command;

#[test]
fn board_commands_json_fail_cleanly_without_a_core() {
    let dir = tempfile::tempdir().unwrap();
    for args in [
        vec!["board", "p"],
        vec!["card", "list", "p"],
        vec!["card", "show", "p", "c"],
        vec!["card", "create", "p", "col", "Task"],
        vec!["card", "move", "p", "c", "col", "0"],
        vec!["card", "assign", "p", "c", "agent", "a"],
        vec!["card", "comment", "p", "c", "Text"],
        vec!["card", "archive", "p", "c"],
        vec!["column", "list", "p"],
        vec!["column", "create", "p", "Custom"],
        vec!["column", "move", "p", "col", "0"],
        vec!["column", "delete", "p", "col"],
    ] {
        let output = Command::cargo_bin("plur1bus")
            .unwrap()
            .arg("--home")
            .arg(dir.path())
            .args(["project", "--json"])
            .args(args)
            .output()
            .unwrap();
        assert!(!output.status.success());
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(value["error"], "E_CORE_UNAVAILABLE");
    }
}

#[cfg(unix)]
#[test]
fn board_overview_pages_cards_and_preserves_json_over_offline_ipc() {
    use serde_json::json;
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixListener;
    let dir = tempfile::tempdir().unwrap();
    let run = dir.path().join("run");
    std::fs::create_dir_all(&run).unwrap();
    std::fs::write(run.join("core.token"), "offline-fixture").unwrap();
    let listener = UnixListener::bind(run.join("core.sock")).unwrap();
    let server = std::thread::spawn(move || {
        let mut requests = Vec::new();
        for n in 0..3 {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut writer = stream.try_clone().unwrap();
            let mut lines = BufReader::new(stream).lines();
            let auth: Value = serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
            writeln!(writer, "{}", json!({"jsonrpc":"2.0","id":auth["id"],"result":{"contract":"1.12.0","rpc":plur1bus_rpc::RPC_VERSION,"instanceId":"00000000-0000-4000-8000-000000000000","pid":std::process::id(),"capabilities":plur1bus_rpc::capabilities("core",&[])}})).unwrap();
            let request: Value = serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
            let result = if n == 0 {
                json!({"columns":[{"id":"col","title":null,"titleKey":"project.board.backlog","position":0,"wipLimit":null}]})
            } else {
                json!({"cards":[{"id":format!("c{n}"),"title":"Task","columnId":"col","position":n-1}],"nextCursor":if n==1 {Some("next")} else {None}})
            };
            writeln!(
                writer,
                "{}",
                json!({"jsonrpc":"2.0","id":request["id"],"result":result})
            )
            .unwrap();
            requests.push(request);
        }
        requests
    });
    let result = Command::cargo_bin("plur1bus")
        .unwrap()
        .arg("--home")
        .arg(dir.path())
        .args(["project", "board", "p", "--json"])
        .assert()
        .success();
    let value: Value = serde_json::from_slice(&result.get_output().stdout).unwrap();
    assert_eq!(value["schema"], "project.board/1");
    assert_eq!(value["columns"][0]["cards"].as_array().unwrap().len(), 2);
    let requests = server.join().unwrap();
    assert_eq!(requests[0]["method"], "project.column.list");
    assert_eq!(requests[2]["params"]["cursor"], "next");
}
