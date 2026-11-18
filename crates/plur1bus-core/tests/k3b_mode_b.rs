//! Parity mode B for the inbox, delivery and channel hand-off stores (P4-K K3b): TypeScript writes the store files with the
//! product code, Rust opens, reads and writes copies of them and creates fresh files, TypeScript reads the result again and
//! compares the schema text of the Rust-made files with its own (`tests/core-parity/k3b-b-driver.ts`). Needs Node
//! (`PLUR1BUS_NODE` or `node` on PATH) with the workspace's TypeScript sources, like the other mixed-language tests.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use plur1bus_core::approvals::OsRandom;
use plur1bus_core::budget::{Clock, UuidIds};
use plur1bus_core::delivery::{
    ChannelIdentity, DeliveryIdentity, DeliveryOptions, DeliveryTargets, LinkedIdentity,
};
use plur1bus_core::handoff::{
    ChannelHandoff, ChatKind, HandoffOptions, HumanLookup, InboundMessage, MessageRecord,
    SessionPort, SessionRecord,
};
use plur1bus_core::identity::principals::derive_user_principal;
use plur1bus_core::inbox::store::{InboxStore, InboxStoreOptions};
use plur1bus_core::inbox::{Ids, InboxDraft, InboxListQuery, InboxRef};
use plur1bus_core::rbac::audit::{AuditEvent, AuditSink};
use plur1bus_core::rbac::types::{Principal, PrincipalKind, Role};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::rc::Rc;
use std::sync::Arc;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn driver(command: &str, dir: &Path) -> String {
    let node = std::env::var_os("PLUR1BUS_NODE").unwrap_or_else(|| "node".into());
    let output = Command::new(&node)
        .current_dir(root())
        .args([
            "--experimental-strip-types",
            "--conditions=source",
            "--no-warnings=ExperimentalWarning",
            "tests/core-parity/k3b-b-driver.ts",
            command,
        ])
        .arg(dir)
        .output()
        .unwrap_or_else(|e| {
            panic!("could not run Node {node:?}: {e}. Install Node and run `pnpm test:prep`.")
        });
    assert!(
        output.status.success(),
        "k3b-b-driver {command}: {}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

struct At(i64);

impl Clock for At {
    fn now(&self) -> i64 {
        self.0
    }
}

struct Quiet;

impl AuditSink for Quiet {
    fn append(&mut self, _: &AuditEvent) -> Result<(), String> {
        Ok(())
    }
}

fn alice() -> Principal {
    let mut p = Principal::new("alice", Role::Owner);
    p.kind = Some(PrincipalKind::Person);
    p
}

fn copy(dir: &Path, from: &str, to: &str) -> PathBuf {
    std::fs::copy(dir.join(from), dir.join(to)).unwrap();
    dir.join(to)
}

fn message(chat_id: &str, kind: ChatKind, sender: &str, text: &str) -> InboundMessage {
    InboundMessage {
        channel: "telegram".into(),
        chat_id: chat_id.into(),
        chat_kind: kind,
        sender_id: sender.into(),
        account_id: Some("bot".into()),
        text: text.into(),
    }
}

// ---- hand-off ---------------------------------------------------------------------------------------------------------

struct Sessions(Vec<(SessionRecord, Vec<MessageRecord>)>);

impl Sessions {
    fn world() -> Self {
        let owner = derive_user_principal("alice").unwrap();
        let rec = |id: &str, chat: &str| SessionRecord {
            id: id.into(),
            kind: "channel".into(),
            owner: owner.clone(),
            chat_key: Some(chat.into()),
            agent_id: "main".into(),
            title: Some("Private DM".into()),
            updated_at: 500,
        };
        let turns = vec![
            MessageRecord {
                role: "user".into(),
                text: "question-0".into(),
                created_at: 600,
            },
            MessageRecord {
                role: "assistant".into(),
                text: "reply-0".into(),
                created_at: 601,
            },
        ];
        Self(vec![
            (rec("s1", "telegram:dm"), turns.clone()),
            (rec("s2", "telegram:grp"), turns),
            (rec("s3", "telegram:dm3"), Vec::new()),
        ])
    }
    fn find(&self, id: &str) -> Option<&(SessionRecord, Vec<MessageRecord>)> {
        self.0.iter().find(|s| s.0.id == id)
    }
}

impl SessionPort for Sessions {
    fn available(&self) -> bool {
        true
    }
    fn get_session(&self, id: &str) -> Result<Option<SessionRecord>, String> {
        Ok(self.find(id).map(|s| s.0.clone()))
    }
    fn has_messages(&self, id: &str) -> Result<bool, String> {
        Ok(self.find(id).is_some_and(|s| !s.1.is_empty()))
    }
    fn last_messages(&self, id: &str) -> Result<Vec<MessageRecord>, String> {
        Ok(self.find(id).map(|s| s.1.clone()).unwrap_or_default())
    }
    fn active_for_chat(&self, chat_key: &str) -> Result<Option<SessionRecord>, String> {
        Ok(self
            .0
            .iter()
            .find(|s| s.0.chat_key.as_deref() == Some(chat_key))
            .map(|s| s.0.clone()))
    }
    fn create_channel_session(
        &mut self,
        _: &str,
        _: &str,
        _: &str,
        _: &str,
    ) -> Result<SessionRecord, String> {
        Err("not needed".into())
    }
    fn active_summary_texts(&self, _: &str) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
    fn context_messages(&self, id: &str) -> Result<Vec<MessageRecord>, String> {
        self.last_messages(id)
    }
    fn create_continuation(
        &mut self,
        _: &str,
        _: &str,
        _: &str,
        _: &str,
    ) -> Result<String, String> {
        Ok("cont-rust".into())
    }
}

struct Linked;

impl HumanLookup for Linked {
    fn human_of(&self, channel: &str, account_id: &str, user_id: &str) -> Option<String> {
        (channel == "telegram" && account_id == "bot" && user_id == "sender")
            .then(|| "alice".to_owned())
    }
}

fn handoff(path: &Path, now: i64) -> ChannelHandoff {
    ChannelHandoff::open(HandoffOptions {
        path: path.to_path_buf(),
        store: Box::new(Sessions::world()),
        identity: Box::new(Linked),
        resolve: Box::new(|id| (id == "alice").then(alice)),
        clock: Arc::new(At(now)),
        audit: Box::new(Quiet),
        base_url: Box::new(|| "https://web.example".into()),
        agent_id: Box::new(|| "main".into()),
        random: Arc::new(OsRandom),
        secure_path: None,
    })
    .unwrap()
}

fn handoff_round(dir: &Path, manifest: &Value, now: i64) -> Value {
    let path = copy(dir, "handoff-ts.sqlite", "handoff-rust.sqlite");
    let mut h = handoff(&path, now);
    // The link TypeScript issued redeems in Rust, and is spent afterwards.
    let ts_token = manifest["handoffToken"].as_str().unwrap();
    let redeemed = h.redeem(ts_token, "alice").unwrap();
    assert_eq!(redeemed.from_session_id, "s1");
    assert!(h.redeem(ts_token, "alice").unwrap_err().is_denied());
    // The group session TypeScript tainted stays closed.
    assert!(h.issue("s2", "alice").unwrap_err().is_denied());
    // Rust observes and issues; TypeScript redeems it.
    h.observe(
        &message("dm3", ChatKind::Direct, "sender", "hello"),
        "alice",
        "s3",
    )
    .unwrap();
    let issued = h.issue("s3", "alice").unwrap();
    let mut ids: Vec<String> = h
        .list("alice")
        .unwrap()
        .sessions
        .into_iter()
        .map(|e| e.id)
        .collect();
    ids.sort();
    assert_eq!(ids, ["s1", "s3"]);
    drop(h);
    drop(handoff(&dir.join("handoff-fresh-rust.sqlite"), now));
    json!({ "handoffRustToken": issued.token, "listed": ids })
}

// ---- delivery ---------------------------------------------------------------------------------------------------------

struct Links;

impl DeliveryIdentity for Links {
    fn resolve(&self, i: &ChannelIdentity) -> Option<String> {
        (i.channel == "telegram"
            && i.account_id == "bot"
            && ["sender", "sender2"].contains(&i.user_id.as_str()))
        .then(|| "alice".to_owned())
    }
    fn linked(&self) -> Vec<LinkedIdentity> {
        ["sender", "sender2"]
            .iter()
            .map(|u| LinkedIdentity {
                identity: ChannelIdentity {
                    channel: "telegram".into(),
                    account_id: "bot".into(),
                    user_id: (*u).into(),
                },
                human_id: "alice".into(),
                revoked: false,
            })
            .collect()
    }
}

type Sent = Rc<RefCell<Vec<(String, String, String)>>>;

fn delivery(path: &Path, now: i64, sent: &Sent) -> DeliveryTargets {
    let log = sent.clone();
    DeliveryTargets::open(DeliveryOptions {
        path: path.to_path_buf(),
        clock: Arc::new(At(now)),
        identity: Box::new(Links),
        resolve: Box::new(|id| (id == "alice").then(alice)),
        audit: Box::new(Quiet),
        allowed: Box::new(|_| true),
        target: Box::new(|_| "dm".into()),
        send: Box::new(move |c, chat, t| {
            log.borrow_mut().push((c.into(), chat.into(), t.into()));
            true
        }),
        ids: Arc::new(UuidIds),
        random: Arc::new(OsRandom),
        secure_path: None,
    })
    .unwrap()
}

fn delivery_round(dir: &Path, manifest: &Value, now: i64) -> Value {
    let path = copy(dir, "delivery-ts.sqlite", "delivery-rust.sqlite");
    let sent: Sent = Rc::default();
    let mut d = delivery(&path, now, &sent);
    let first = manifest["deliveryTarget"].as_str().unwrap();
    let second = manifest["secondTarget"].as_str().unwrap();
    let before: Vec<(String, bool)> = d
        .list(&alice())
        .unwrap()
        .into_iter()
        .map(|t| (t.id, t.validated))
        .collect();
    assert_eq!(
        before,
        [(first.to_owned(), true), (second.to_owned(), false)]
    );
    // Rust confirms the second target with a code of its own, and writes to the first.
    assert!(d.challenge(second, &alice()).unwrap().awaiting_channel);
    let code = {
        let log = sent.borrow();
        let text = &log.last().unwrap().2;
        text.rsplit("/delivery ").next().unwrap().to_owned()
    };
    assert_eq!(code.len(), 32);
    assert!(d
        .confirm_message(
            &message(
                "dm",
                ChatKind::Direct,
                "sender2",
                &format!("/delivery {code}")
            ),
            "alice"
        )
        .unwrap());
    assert!(d
        .deliver(first, "alice", "main", "hello from rust")
        .unwrap());
    assert!(d
        .subscribe(first, "system", "job1", "main", &alice())
        .unwrap());
    let after: Vec<(String, bool)> = d
        .list(&alice())
        .unwrap()
        .into_iter()
        .map(|t| (t.id, t.validated))
        .collect();
    assert_eq!(after, [(first.to_owned(), true), (second.to_owned(), true)]);
    drop(d);
    drop(delivery(
        &dir.join("delivery-fresh-rust.sqlite"),
        now,
        &sent,
    ));
    json!({ "confirmed": second })
}

// ---- inbox ------------------------------------------------------------------------------------------------------------

fn inbox_store(path: &Path, now: i64) -> InboxStore {
    InboxStore::open(InboxStoreOptions {
        path: path.to_path_buf(),
        clock: Arc::new(At(now)),
        max_age_ms: None,
        max_entries: None,
        ids: Some(Arc::new(UuidIds)),
        secure_path: None,
    })
    .unwrap()
}

fn draft(kind: &str, key: &str, dedupe: &str) -> InboxDraft {
    InboxDraft {
        user_id: "alice".into(),
        kind: kind.into(),
        severity: "info".into(),
        title_key: key.into(),
        params: Some(vec![("n".into(), json!(2))]),
        reference: Some(InboxRef {
            route: Some("/x".into()),
            object_id: None,
        }),
        dedupe_key: dedupe.into(),
    }
}

fn inbox_round(dir: &Path, now: i64) -> Value {
    let path = copy(dir, "inbox-ts.sqlite", "inbox-rust.sqlite");
    let mut s = inbox_store(&path, now);
    let q = InboxListQuery {
        include_dismissed: true,
        ..Default::default()
    };
    let page = s.list("alice", &q).unwrap();
    let seen: Vec<(String, bool)> = page
        .entries
        .iter()
        .map(|e| (e.id.clone(), e.read_at.is_some()))
        .collect();
    assert_eq!(
        seen,
        [("ts-2".to_owned(), false), ("ts-1".to_owned(), true)]
    );
    assert_eq!(page.entries[1].params, json!({ "n": 1 }));
    assert_eq!(s.count("alice").unwrap().total, 2);
    // The dedupe key TypeScript wrote holds in Rust.
    let again = s
        .publish(&draft("update", "inbox.update", "update:u1"))
        .unwrap();
    assert!(!again.created);
    let fresh = s
        .publish(&draft("system", "inbox.system", "system:r1"))
        .unwrap();
    assert!(fresh.created);
    assert_eq!(s.mark_read("alice", Ids::All).unwrap(), 2);
    assert_eq!(
        s.dismiss("alice", Ids::List(&["ts-2".to_owned()])).unwrap(),
        1
    );
    drop(s);
    drop(inbox_store(&dir.join("inbox-fresh-rust.sqlite"), now));
    json!({ "inboxRustId": fresh.id })
}

#[test]
fn typescript_inbox_delivery_and_handoff_files_round_trip_through_the_rust_port() {
    let dir = std::env::temp_dir().join(format!("plur1bus-k3b-b-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    driver("prepare", &dir);
    let manifest: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("manifest.json")).unwrap()).unwrap();
    let now = manifest["now"].as_i64().unwrap();

    let mut results = serde_json::Map::new();
    for part in [
        handoff_round(&dir, &manifest, now),
        delivery_round(&dir, &manifest, now),
        inbox_round(&dir, now),
    ] {
        results.extend(part.as_object().unwrap().clone());
    }
    std::fs::write(
        dir.join("rust-results.json"),
        Value::Object(results.clone()).to_string(),
    )
    .unwrap();

    // The files Rust wrote have the schema text of the files TypeScript made, and the product code reads them.
    let out: Value = serde_json::from_str(&driver("verify", &dir)).unwrap();
    for (k, v) in out["sameSchema"].as_object().unwrap() {
        assert_eq!(v, &json!(true), "schema text differs for {k}");
    }
    assert_eq!(out["handoff"]["redeemRustLink"], json!({ "ok": true }));
    assert!(out["handoff"]["redeemTsLinkAgain"]["err"].is_string());
    assert!(out["handoff"]["issueTainted"]["err"].is_string());
    assert_eq!(out["handoff"]["list"], json!({ "ok": ["s1", "s3"] }));
    let listed = out["delivery"]["listed"].as_array().unwrap();
    assert!(listed.iter().all(|t| t[1] == json!(true)), "{listed:?}");
    assert_eq!(out["delivery"]["delivered"], json!({ "sent": true }));
    // `notify` reaches the target the subscription written by Rust names.
    let sent = out["delivery"]["sent"].as_array().unwrap();
    assert!(sent.len() >= 2, "{sent:?}");
    let entries = out["inbox"]["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 3, "{entries:?}");
    assert_eq!(entries[1][4], json!(true), "ts-2 is dismissed");
    assert!(
        entries.iter().all(|e| e[3] == json!(true)),
        "everything is read"
    );
    assert_eq!(
        out["inbox"]["unread"],
        json!(2),
        "two open entries, none dismissed"
    );
    assert_eq!(out["inbox"]["again"], json!(false));
    let _ = std::fs::remove_dir_all(&dir);
}
