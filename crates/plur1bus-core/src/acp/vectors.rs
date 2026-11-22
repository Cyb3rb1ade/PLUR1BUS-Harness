//! Replays `fixtures/parity/acp/*.json` (mode W over stdio, `scripts/parity/export-acp.ts`) against the Rust server: every
//! scenario runs on a real [`super::server::AcpServer`] with scripted ports, and the transcript it writes (frames, log lines,
//! calls on the backend or the Core, in order) must equal the one the TypeScript server wrote, line for line.
use super::testing::run_scenario;
use serde_json::{json, Value};

fn fixture(name: &str) -> Value {
    let text = match name {
        "framing" => include_str!("../../../../fixtures/parity/acp/framing.json"),
        "protocol" => include_str!("../../../../fixtures/parity/acp/protocol.json"),
        "limits" => include_str!("../../../../fixtures/parity/acp/limits.json"),
        "corelimit" => include_str!("../../../../fixtures/parity/acp/corelimit.json"),
        "files" => include_str!("../../../../fixtures/parity/acp/files.json"),
        "filesmore" => include_str!("../../../../fixtures/parity/acp/filesmore.json"),
        "filesclip" => include_str!("../../../../fixtures/parity/acp/filesclip.json"),
        "fileslarge" => include_str!("../../../../fixtures/parity/acp/fileslarge.json"),
        "permissions" => include_str!("../../../../fixtures/parity/acp/permissions.json"),
        "core" => include_str!("../../../../fixtures/parity/acp/core.json"),
        other => panic!("no fixture {other}"),
    };
    serde_json::from_str(text).expect("fixture parses")
}

/// Runs every scenario of a file; returns the names that differ (with the first differing line) and how many ran.
fn replay(name: &str) -> (Vec<String>, usize) {
    let data = fixture(name);
    let scenarios = data["scenarios"].as_array().expect("scenarios");
    let mut bad = Vec::new();
    for sc in scenarios {
        let want: Vec<String> = sc["transcript"]
            .as_array()
            .expect("transcript")
            .iter()
            .map(|l| l.as_str().expect("line").to_owned())
            .collect();
        let want = match sc.get("pendingLimit") {
            Some(limit) => bounded_flood(want, limit),
            None => want,
        };
        let got = run_scenario(sc);
        if got != want {
            let at = got
                .iter()
                .zip(&want)
                .position(|(g, w)| g != w)
                .unwrap_or(got.len().min(want.len()));
            let cut =
                |s: Option<&str>| s.map_or("<none>".to_owned(), |s| s.chars().take(300).collect());
            bad.push(format!(
                "{} (line {at} of {}/{}):\n   want {}\n   got  {}",
                sc["name"].as_str().unwrap_or("?"),
                want.len(),
                got.len(),
                cut(want.get(at).map(String::as_str)),
                cut(got.get(at).map(String::as_str))
            ));
        }
    }
    (bad, scenarios.len())
}

// K8-D6: every request in this recorded batch waits one microtask to send its reply. Rust
// admits the first batch of requests and refuses the surplus before the queued replies.
fn bounded_flood(mut recorded: Vec<String>, limit: &Value) -> Vec<String> {
    assert_eq!(limit["divergence"], "K8-D6");
    let capacity = limit["rust"].as_u64().unwrap() as usize;
    let first_reply = recorded
        .iter()
        .position(|line| line.starts_with("OUT "))
        .unwrap();
    let replies = recorded.split_off(first_reply);
    assert!(capacity < replies.len());
    recorded.truncate(capacity + 1);
    for line in &replies[capacity..] {
        let reply: Value = serde_json::from_str(line.strip_prefix("OUT ").unwrap()).unwrap();
        // Keep the wire member order of the rest of this replay.
        recorded.push(format!(
            "OUT {{\"jsonrpc\":\"2.0\",\"id\":{},\"error\":{{\"code\":-32000,\"message\":\"too many pending requests\",\"data\":{{\"reason\":\"pending-limit\"}}}}}}",
            json!(reply["id"])
        ));
    }
    recorded.extend(replies.into_iter().take(capacity));
    recorded
}

fn check(name: &str, at_least: usize) {
    let (bad, n) = replay(name);
    assert!(n >= at_least, "{name}: only {n} scenarios");
    assert!(
        bad.is_empty(),
        "{name}: {} of {n} scenarios differ:\n{}",
        bad.len(),
        bad.join("\n")
    );
}

#[test]
fn framing_transcripts_are_the_same() {
    check("framing", 60);
}

#[test]
fn protocol_transcripts_are_the_same() {
    check("protocol", 70);
}

#[test]
fn limit_transcripts_are_the_same() {
    check("limits", 2);
}

#[test]
fn permission_transcripts_are_the_same() {
    check("permissions", 60);
}

#[test]
fn core_backend_transcripts_are_the_same() {
    check("core", 150);
    check("corelimit", 1);
}

#[test]
fn file_change_transcripts_are_the_same() {
    check("files", 25);
    check("filesmore", 2);
    check("filesclip", 2);
    check("fileslarge", 1);
}
