use assert_cmd::prelude::*;
use serde_json::Value;
use std::process::Command;

fn run(home: &std::path::Path, args: &[&str]) -> std::process::Output {
    Command::cargo_bin("plur1bus")
        .unwrap()
        .arg("--home")
        .arg(home)
        .args(["inbox", "--json"])
        .args(args)
        .output()
        .unwrap()
}

#[test]
fn every_leaf_json_fails_cleanly_without_a_core() {
    let dir = tempfile::tempdir().unwrap();
    for args in [
        vec!["list"],
        vec![
            "list", "--kind", "approval", "--unread", "--all", "--limit", "5",
        ],
        vec!["count"],
        vec!["read", "a"],
        vec!["read", "--all"],
        vec!["dismiss", "a", "b"],
    ] {
        let output = run(dir.path(), &args);
        assert!(!output.status.success(), "{args:?}");
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(value["error"], "E_CORE_UNAVAILABLE", "{args:?}");
    }
}

#[test]
fn bad_arguments_are_usage_errors_not_rpc_calls() {
    let dir = tempfile::tempdir().unwrap();
    for args in [
        vec!["read"],
        vec!["read", "a", "--all"],
        vec!["dismiss"],
        vec!["list", "--kind", "bogus"],
        vec!["list", "--limit", "0"],
    ] {
        let output = run(dir.path(), &args);
        assert_eq!(output.status.code(), Some(2), "{args:?}");
    }
}

#[cfg(unix)]
#[test]
fn json_is_the_raw_rpc_result_under_its_schema_id() {
    use serde_json::json;
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixListener;
    let dir = tempfile::tempdir().unwrap();
    let run_dir = dir.path().join("run");
    std::fs::create_dir_all(&run_dir).unwrap();
    std::fs::write(run_dir.join("core.token"), "offline-fixture").unwrap();
    let listener = UnixListener::bind(run_dir.join("core.sock")).unwrap();
    let results = [
        json!({"entries":[{"id":"e1","kind":"approval","severity":"info","titleKey":"inbox.approval.requested","params":{},"ref":null,"createdAt":1,"readAt":null,"dismissedAt":null}],"nextCursor":"c1"}),
        json!({"unread":{"breakglass":0,"approval":1,"job-failed":0,"update":0,"media-index":0,"pairing":0,"channel":0,"system":0},"total":1}),
        json!({"changed":1}),
        json!({"changed":1}),
    ];
    let served = results.clone();
    let server = std::thread::spawn(move || {
        let mut requests = Vec::new();
        for result in served {
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut writer = stream.try_clone().unwrap();
            let mut lines = BufReader::new(stream).lines();
            let auth: Value = serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
            writeln!(writer, "{}", json!({"jsonrpc":"2.0","id":auth["id"],"result":{"contract":"1.12.0","rpc":plur1bus_rpc::RPC_VERSION,"instanceId":"00000000-0000-4000-8000-000000000000","pid":std::process::id(),"capabilities":plur1bus_rpc::capabilities("core",&[])}})).unwrap();
            let request: Value = serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
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
    let cases: [(&[&str], &str); 4] = [
        (&["list", "--kind", "approval", "--unread"], "inbox.list/1"),
        (&["count"], "inbox.count/1"),
        (&["read", "e1"], "inbox.read/1"),
        (&["dismiss", "e1"], "inbox.dismiss/1"),
    ];
    for (n, (args, schema)) in cases.iter().enumerate() {
        let output = run(dir.path(), args);
        assert!(
            output.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(value["schema"], *schema);
        for (k, v) in results[n].as_object().unwrap() {
            assert_eq!(&value[k], v, "{args:?} {k}");
        }
    }
    let requests = server.join().unwrap();
    assert_eq!(requests[0]["method"], "inbox.list");
    assert_eq!(requests[0]["params"]["kinds"], json!(["approval"]));
    assert_eq!(requests[0]["params"]["unreadOnly"], true);
    assert_eq!(requests[1]["method"], "inbox.count");
    assert_eq!(requests[2]["method"], "inbox.markRead");
    assert_eq!(requests[2]["params"], json!({"ids":["e1"]}));
    assert_eq!(requests[3]["params"], json!({"ids":["e1"]}));
}
