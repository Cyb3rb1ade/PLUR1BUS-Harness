//! Unit tests of the ACP port that are not transcripts: the places where Rust could drift from JavaScript without the
//! recorded scenarios noticing, and hostile input that has no TypeScript counterpart to compare with.
use super::exec::{Exec, Receiver};
use super::file_changes::{AcpFileChanges, AcpFileContent};
use super::json::V;
use super::permissions::{
    AcpPermissionAsk, AcpPermissionOption, AcpPermissionOutcome, AcpPermissions,
};
use super::testing::{run_scenario, ListIds, TestClock};
use super::text::AcpLanguage;
use serde_json::json;
use std::cell::RefCell;
use std::rc::Rc;

fn permissions(sent: Rc<RefCell<Vec<V>>>) -> Rc<AcpPermissions> {
    AcpPermissions::new(
        move |m| {
            sent.borrow_mut().push(m.clone());
            true
        },
        Rc::new(TestClock::default()),
        Rc::new(ListIds::new((1..=4).map(|i| format!("id{i}")).collect())),
        300_000,
    )
}

/// Follows a request the way the server's tasks do: the cell holds the outcome once there is one.
fn watch(
    exec: &Rc<Exec>,
    rx: Receiver<AcpPermissionOutcome>,
) -> Rc<RefCell<Option<AcpPermissionOutcome>>> {
    let cell = Rc::new(RefCell::new(None));
    let sink = cell.clone();
    exec.spawn(async move {
        *sink.borrow_mut() = Some(rx.await);
    });
    exec.run_until_stalled();
    cell
}

fn ask(tool_call: V) -> AcpPermissionAsk {
    AcpPermissionAsk {
        tool_call,
        options: vec![AcpPermissionOption {
            option_id: "a".to_owned(),
            name: Some("Allow".to_owned()),
            kind: "allow_once".to_owned(),
        }],
    }
}

#[test]
fn a_permission_request_over_one_line_is_cancelled_and_never_sent() {
    // The request must fit one ACP line; an oversized tool payload is not kept while a human is asked.
    let sent = Rc::new(RefCell::new(Vec::new()));
    let p = permissions(sent.clone());
    let exec = Exec::new();
    let huge = V::obj([("title", V::s(&"x".repeat(1_048_576)))]);
    let out = watch(&exec, p.request("s1", &ask(huge), None));
    assert_eq!(*out.borrow(), Some(AcpPermissionOutcome::Cancelled));
    assert!(sent.borrow().is_empty());
    assert_eq!(p.pending(), 0);
    // Just under the line it is sent and stays open.
    let fits = V::obj([("title", V::s(&"x".repeat(1_048_000)))]);
    let out = watch(&exec, p.request("s1", &ask(fits), None));
    assert_eq!(*out.borrow(), None);
    assert_eq!(sent.borrow().len(), 1);
    assert_eq!(p.pending(), 1);
}

#[test]
fn an_answer_selects_only_through_the_issued_id() {
    let sent = Rc::new(RefCell::new(Vec::new()));
    let p = permissions(sent.clone());
    let exec = Exec::new();
    let out = watch(&exec, p.request("s1", &ask(V::obj([])), None));
    let answer = |id: V| {
        V::obj([
            ("jsonrpc", V::s("2.0")),
            ("id", id),
            (
                "result",
                V::obj([(
                    "outcome",
                    V::obj([("outcome", V::s("selected")), ("optionId", V::s("a"))]),
                )]),
            ),
        ])
    };
    // An array that holds the id, or a number, is not the id (`===` on a string only).
    assert!(!p.answer(&answer(V::Arr(vec![V::s("acp-permission-id1")]))));
    assert!(!p.answer(&answer(V::n(1.0))));
    assert!(p.answer(&answer(V::s("acp-permission-id1"))));
    exec.run_until_stalled();
    assert_eq!(
        *out.borrow(),
        Some(AcpPermissionOutcome::Selected("a".to_owned()))
    );
    assert!(
        !p.answer(&answer(V::s("acp-permission-id1"))),
        "a second answer has no effect"
    );
}

#[test]
fn a_message_with_a_method_is_a_request_and_never_an_answer() {
    // The server routes by `method` first, so only this unit sees the check inside `answer` (it must hold on its own).
    let p = permissions(Rc::new(RefCell::new(Vec::new())));
    let exec = Exec::new();
    let out = watch(&exec, p.request("s1", &ask(V::obj([])), None));
    let with_method = V::obj([
        ("jsonrpc", V::s("2.0")),
        ("id", V::s("acp-permission-id1")),
        ("method", V::s("x")),
        (
            "result",
            V::obj([(
                "outcome",
                V::obj([("outcome", V::s("selected")), ("optionId", V::s("a"))]),
            )]),
        ),
    ]);
    assert!(!p.answer(&with_method));
    exec.run_until_stalled();
    assert_eq!(*out.borrow(), None);
    assert_eq!(p.pending(), 1);
}

#[test]
fn a_closed_permission_set_cancels_everything_that_follows() {
    let p = permissions(Rc::new(RefCell::new(Vec::new())));
    let exec = Exec::new();
    let first = watch(&exec, p.request("s1", &ask(V::obj([])), None));
    p.close();
    exec.run_until_stalled();
    assert_eq!(*first.borrow(), Some(AcpPermissionOutcome::Cancelled));
    let later = watch(&exec, p.request("s1", &ask(V::obj([])), None));
    assert_eq!(*later.borrow(), Some(AcpPermissionOutcome::Cancelled));
}

#[test]
fn general_responses_enforce_the_utf8_frame_boundary_before_writing() {
    use super::framing::MAX_LINE_BYTES;

    let run = |title: &str| {
        run_scenario(&json!({
            "server": {"agentInfo": ["fixture", title, "1"]},
            "events": [
                {"in":"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":1}}\n"},
                {"end":true}
            ]
        }))
    };
    let baseline = run("");
    let envelope = baseline
        .iter()
        .find_map(|l| l.strip_prefix("OUT "))
        .unwrap()
        .len();
    let room = MAX_LINE_BYTES - envelope;
    let mut title = "é".repeat(room / 2);
    if !room.is_multiple_of(2) {
        title.push('a');
    }
    assert!(run(&title).iter().any(|l| l
        .strip_prefix("OUT ")
        .is_some_and(|line| line.len() == MAX_LINE_BYTES)));
    title.push('a');
    let oversized = run(&title);
    assert!(!oversized.iter().any(|l| l.starts_with("OUT ")));
    assert!(oversized.iter().any(|l| l.contains("output-error")));
    assert!(!oversized.iter().any(|l| l == "EVENT 1" || l == "HUNG"));
}

#[test]
fn writer_failure_cancels_permission_and_turn_before_reading_more_input() {
    let log = run_scenario(&json!({
        "ids": ["one"],
        "backend": {
            "create":[{"sessionId":"s1"}],
            "prompts":[[{"spawnPermission":{"tag":"waiting","askJson":"{\"toolCall\":{},\"options\":[{\"optionId\":\"yes\",\"kind\":\"allow_once\"}]}"}},{"awaitCancel":true}]]
        },
        "events": [
            {"in":"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":1}}\n"},
            {"in":"{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"session/new\",\"params\":{\"cwd\":\"/work\",\"mcpServers\":[]}}\n"},
            {"in":"{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"session/prompt\",\"params\":{\"sessionId\":\"s1\",\"prompt\":[{\"type\":\"text\",\"text\":\"hello\"}]}}\n"},
            {"breakWriter":true},
            {"in":"{\n"},
            {"outputClosed":true},
            {"end":true}
        ]
    }));
    let error = log
        .iter()
        .position(|l| l.contains("output-error"))
        .expect("failed write");
    assert!(
        log[..error]
            .iter()
            .any(|l| l.contains("session/request_permission")),
        "{log:?}"
    );
    assert!(
        log[error..].iter().any(|l| l == "BACKEND cancel s1"),
        "{log:?}"
    );
    assert!(
        log[error..]
            .iter()
            .any(|l| l == "BACKEND permission waiting cancelled"),
        "{log:?}"
    );
    assert!(
        !log[error..]
            .iter()
            .any(|l| l.starts_with("EVENT ") || l == "HUNG"),
        "{log:?}"
    );
}

#[test]
fn pending_limit_refuses_work_and_admits_again_when_a_slot_is_released() {
    let log = run_scenario(&json!({
        "server":{"maxPending":1},
        "backend":{
            "create":[{"sessionId":"s1"},{"sessionId":"s2"}],
            "prompts":[[{"gate":"ready"},{"return":"completed"}],[{"return":"completed"}]]
        },
        "events":[
            {"in":"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":1}}\n"},
            {"in":"{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"session/new\",\"params\":{\"cwd\":\"/work\",\"mcpServers\":[]}}\n"},
            {"in":"{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"session/prompt\",\"params\":{\"sessionId\":\"s1\",\"prompt\":[{\"type\":\"text\",\"text\":\"first\"}]}}\n{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"session/new\",\"params\":{\"cwd\":\"/work\",\"mcpServers\":[]}}\n"},
            {"release":"ready"},
            {"in":"{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"session/new\",\"params\":{\"cwd\":\"/work\",\"mcpServers\":[]}}\n"},
            {"end":true}
        ]
    }));
    let reply = |id| {
        log.iter()
            .filter_map(|l| l.strip_prefix("OUT "))
            .map(|l| serde_json::from_str::<serde_json::Value>(l).unwrap())
            .find(|l| l["id"] == id)
            .unwrap()
    };
    assert_eq!(reply(4)["error"]["data"]["reason"], "pending-limit");
    assert_eq!(reply(5)["result"]["sessionId"], "s2");
}

fn write_result(path: &str, bytes: usize) -> String {
    format!(
        r#"{{"isError":false,"tool":"file.write","value":{{"rootId":"coding-worktree","path":"{path}","created":true,"bytesWritten":{bytes}}}}}"#
    )
}

#[test]
fn a_root_that_is_not_a_string_fails_only_where_node_would() {
    // The Core's answer is kept as it came; `path.isAbsolute(5)` throws only when a result with a usable path needs it.
    for root in [
        V::n(5.0),
        V::Arr(vec![V::s("/w")]),
        V::obj([]),
        V::Bool(true),
    ] {
        let mut changes = AcpFileChanges::new(Some(root), AcpLanguage::En);
        changes.call(
            "w",
            "file.write",
            Some(&V::obj([("path", V::s("a.txt")), ("content", V::s("x"))])),
        );
        assert!(changes.result("w", &write_result("a.txt", 1)).is_err());
        changes.call("v", "file.write", Some(&V::obj([("content", V::s("x"))])));
        assert!(
            changes.result("v", &write_result("../a.txt", 1)).is_ok(),
            "a refused path never reaches the root"
        );
    }
    for root in [V::Null, V::Bool(false), V::n(0.0), V::n(f64::NAN), V::s("")] {
        let mut changes = AcpFileChanges::new(Some(root), AcpLanguage::En);
        changes.call("w", "file.write", Some(&V::obj([("content", V::s("x"))])));
        let content = changes
            .result("w", &write_result("a.txt", 1))
            .expect("falsy roots are ignored")
            .expect("text");
        assert!(matches!(content[0], AcpFileContent::Text(_)));
    }
}

#[test]
fn a_result_over_two_mib_is_not_parsed() {
    let mut changes = AcpFileChanges::new(Some(V::s("/work")), AcpLanguage::En);
    changes.call("e", "file.edit", None);
    let pad = "x".repeat(2 * 1024 * 1024);
    let output = format!(r#"{{"diff":"seen","pad":"{pad}"}}"#);
    let content = changes.result("e", &output).expect("ok").expect("text");
    let AcpFileContent::Text(text) = &content[0] else {
        panic!("text")
    };
    assert!(
        text.contains("no unified patch supplied"),
        "no patch is read from a result that was not parsed: {text}"
    );
    let mut changes = AcpFileChanges::new(Some(V::s("/work")), AcpLanguage::En);
    changes.call("e", "file.edit", None);
    let output = format!(
        r#"{{"diff":"seen","pad":"{}"}}"#,
        "x".repeat(2 * 1024 * 1024 - 100)
    );
    let content = changes.result("e", &output).expect("ok").expect("text");
    let AcpFileContent::Text(text) = &content[0] else {
        panic!("text")
    };
    assert!(
        text.starts_with("Unified text patch"),
        "a result under the bound is parsed and its patch shown: {text}"
    );
}

/// A small deterministic generator, so that a failure can be replayed.
struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0 >> 33
    }
}

#[test]
fn hostile_byte_streams_never_panic_and_always_settle() {
    // Random bytes, random cuts, valid frames with random damage: the server answers or ignores, never panics or hangs.
    let frames = [
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}"#,
        r#"{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/w","mcpServers":[]}}"#,
        r#"{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"s1","prompt":[{"type":"text","text":"hi"}]}}"#,
        r#"{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"s1"}}"#,
        r#"{"jsonrpc":"2.0","id":"acp-permission-x","result":{"outcome":{"outcome":"selected","optionId":"a"}}}"#,
    ];
    let mut rng = Lcg(0x5eed);
    for round in 0..300 {
        let mut stream: Vec<u8> = Vec::new();
        for _ in 0..(1 + rng.next() % 6) {
            let mut frame = frames[(rng.next() % frames.len() as u64) as usize]
                .as_bytes()
                .to_vec();
            for _ in 0..(rng.next() % 4) {
                if frame.is_empty() {
                    break;
                }
                let at = (rng.next() as usize) % frame.len();
                match rng.next() % 4 {
                    0 => frame[at] = (rng.next() % 256) as u8,
                    1 => frame.truncate(at),
                    2 => frame.insert(at, 0xff),
                    _ => frame.insert(at, b'\n'),
                }
            }
            stream.extend(frame);
            if !rng.next().is_multiple_of(5) {
                stream.push(b'\n');
            }
        }
        let hex: String = stream.iter().map(|b| format!("{b:02x}")).collect();
        let scenario = json!({
            "name": format!("fuzz-{round}"),
            "backend": { "create": [{ "sessionId": "s1" }, { "sessionId": "s2" }], "prompts": [[{ "text": "a" }], [{ "text": "b" }]] },
            "events": [{ "hex": hex }],
        });
        let transcript = run_scenario(&scenario);
        assert!(!transcript.is_empty(), "round {round}");
        assert!(
            transcript.iter().all(|l| !l.contains("panicked")),
            "round {round}: {transcript:?}"
        );
    }
}
