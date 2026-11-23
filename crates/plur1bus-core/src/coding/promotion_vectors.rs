use super::*;

// The rejected file's mode is a Unix filesystem property.
#[cfg(unix)]
#[test]
fn the_coding_stores_leave_a_newer_schema_and_permissions_untouched() {
    use crate::coding::gate::CodingGate;
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().unwrap();
    for name in ["coding-gate", "chat-promotions"] {
        let path = dir.path().join(format!("{name}.sqlite"));
        {
            let conn = Connection::open(&path).unwrap();
            conn.pragma_update(None, "user_version", 7).unwrap();
        }
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let before = std::fs::metadata(&path).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let refused = if name == "coding-gate" {
            CodingGate::open(&path).map(|_| ())
        } else {
            ChatPromotion::open(&path).map(|_| ())
        };
        let error = refused.unwrap_err();
        assert_eq!(error.reason.as_deref(), Some("schema-too-new"));
        assert!(error.message.starts_with(&format!("{name} store schema")));
        let after = std::fs::metadata(&path).unwrap();
        assert_eq!(
            after.permissions().mode(),
            before.permissions().mode(),
            "{name}"
        );
        assert_eq!(
            after.modified().unwrap(),
            before.modified().unwrap(),
            "{name}"
        );
        assert_eq!(std::fs::read(&path).unwrap(), bytes, "{name}");
    }
}
use crate::approvals::js_json::J;
use crate::collab::board::CardFields;
use crate::collab::ids::CollabIds;
use crate::collab::service::Ports;
use crate::collab::{CollabStore, StoreOptions};
use crate::identity::principals::derive_user_principal;
use crate::rbac::{
    audit::AuditEvent,
    types::{PrincipalKind, Role},
};
use crate::sessions::MessageRole;
use serde_json::json;
use std::cell::Cell;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicI64, Ordering},
    Arc, Mutex,
};

struct Fixed(AtomicI64);
impl Clock for Fixed {
    fn now(&self) -> i64 {
        self.0.load(Ordering::Relaxed)
    }
}

#[derive(Default)]
struct Ids(Mutex<HashMap<String, usize>>);
impl CollabIds for Ids {
    fn new_id(&self, prefix: &str) -> String {
        let mut ids = self.0.lock().unwrap();
        let id = ids.entry(prefix.into()).or_default();
        *id += 1;
        format!("{prefix}_{id}")
    }
    fn span_id(&self) -> String {
        self.new_id("span")
    }
    fn trace_id(&self) -> String {
        self.new_id("trace")
    }
}
impl IdSource for Ids {
    fn next_id(&self) -> String {
        self.new_id("preview")
    }
}

struct Source(Cell<u8>);
impl PromotionSource for Source {
    fn identity(&self, id: &str) -> R<Option<ChatIdentity>> {
        Ok((id == "ses_1").then(|| ChatIdentity {
            owner: derive_user_principal("owner").unwrap(),
            agent: "sender".to_owned(),
            kind: SessionKind::Direct,
        }))
    }
    fn content(&self, id: &str) -> R<ChatContent> {
        let msg = |n, role, text: &str| MessageRecord {
            id: format!("msg_{n}"),
            session_id: id.to_owned(),
            turn_id: Some("turn".to_owned()),
            seq: n,
            role,
            text: text.to_owned(),
            tokens: 1,
            created_at: 1_000,
        };
        let mut messages = vec![
            msg(1, MessageRole::User, "chosen text"),
            msg(2, MessageRole::Assistant, "other text"),
        ];
        if self.0.get() == 1 {
            messages.push(msg(3, MessageRole::User, "later"));
        }
        let rewinds = if self.0.get() == 2 {
            json!([{"id": "rewind-fixture"}])
        } else {
            json!([])
        };
        Ok(ChatContent { messages, rewinds })
    }
}

struct Publish<'a> {
    svc: &'a CollabService,
    calls: usize,
}
impl PromotionPublisher for Publish<'_> {
    fn publish(&mut self, input: PublishInput<'_>) -> R<Published> {
        self.calls += 1;
        let project_id = if input.target.kind == TargetKind::NewProject {
            self.svc
                .create_project(input.actor, input.target.name.as_deref().unwrap(), None)?
                .id
        } else {
            input.target.project_id.clone().unwrap()
        };
        let card_id = if input.create_card {
            let columns = self.svc.store().board_columns(&project_id)?;
            let first = columns[0].get("id").and_then(J::as_str).unwrap();
            let card = self.svc.store().board_create_card(
                &project_id,
                input.target.column_id.as_deref().unwrap_or(first),
                None,
                &CardFields {
                    title: Some(
                        input
                            .target
                            .title
                            .clone()
                            .unwrap_or_else(|| "Conversation notes".to_owned()),
                    ),
                    description: Some(input.content.to_owned()),
                    ..CardFields::default()
                },
                &J::obj([("kind", J::s("person")), ("id", J::s(&input.actor.user_id))]),
                false,
            )?;
            Some(card.get("id").and_then(J::as_str).unwrap().to_owned())
        } else {
            None
        };
        Ok(Published {
            project_id,
            card_id,
        })
    }
}

#[test]
fn chat_promotion_vectors() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../fixtures/parity/coding/promotion.json"
    ))
    .unwrap();
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let clock = Arc::new(Fixed(AtomicI64::new(1000)));
        let ids = Arc::new(Ids::default());
        let store = CollabStore::open(
            Path::new(":memory:"),
            StoreOptions::new(clock.clone(), ids.clone()),
        )
        .unwrap();
        let collab = CollabService::new(store, Ports::default(), ids.clone());
        let person = |id| Principal {
            kind: Some(PrincipalKind::Person),
            ..Principal::new(id, Role::Owner)
        };
        let owner = person("owner");
        let other = person("other");
        let project = collab
            .create_project(&owner, "Existing project", None)
            .unwrap();
        let source = Source(Cell::new(0));
        let mut publish = Publish {
            svc: &collab,
            calls: 0,
        };
        let mut audit = Vec::new();
        let mut sink = |e: &AuditEvent| {
            let detail: HashMap<&str, &Value> =
                e.detail.iter().map(|(k, v)| (k.as_str(), v)).collect();
            audit.push(json!({ "action": e.action, "person": e.user, "bytes": detail["bytes"], "selection": detail["selection"] }));
            Ok(())
        };
        let mut ports = PromotionPorts {
            source: &source,
            collab: &collab,
            clock: clock.as_ref(),
            ids: ids.as_ref(),
            publisher: &mut publish,
            audit: &mut sink,
        };
        let new = name == "new project";
        let target = Target {
            kind: if new {
                TargetKind::NewProject
            } else if name == "empty card" {
                TargetKind::Card
            } else {
                TargetKind::Project
            },
            project_id: (!new).then_some(project.id.clone()),
            name: new.then(|| "New fixture".to_owned()),
            title: (name == "empty card").then(|| "Empty card".to_owned()),
            column_id: None,
        };
        let (kind, summary, message_ids) = match name {
            "summary" | "new project" => (
                SelectionKind::Summary,
                Some("Explicit note é".to_owned()),
                None,
            ),
            "too many bytes" => (SelectionKind::Summary, Some("é".repeat(32769)), None),
            "selected" | "stale" | "foreign commit" => (
                SelectionKind::Selected,
                None,
                Some(vec!["msg_1".to_owned()]),
            ),
            "duplicates" => (
                SelectionKind::Selected,
                None,
                Some(vec!["msg_1".to_owned(); 2]),
            ),
            "foreign message" => (
                SelectionKind::Selected,
                None,
                Some(vec!["foreign-fixture".to_owned()]),
            ),
            "transcript" | "rewind stale" => (SelectionKind::Transcript, None, None),
            _ => (SelectionKind::None, None, None),
        };
        let mut service = ChatPromotion::open(Path::new(":memory:")).unwrap();
        let mut preview = Value::Null;
        let records: R<Value> = (|| {
            let who = if name == "foreign source" {
                &other
            } else {
                &owner
            };
            let pick = service.preview(
                who,
                "ses_1",
                target,
                &Selection {
                    kind,
                    summary,
                    message_ids,
                },
                &ports,
            )?;
            preview = json!({ "selection": pick.selection, "content": pick.content, "expiresAt": pick.expires_at });
            match name {
                "stale" => source.0.set(1),
                "rewind stale" => source.0.set(2),
                "expired" => clock.0.store(601_000, Ordering::Relaxed),
                _ => {}
            }
            let who = if name == "foreign commit" {
                &other
            } else {
                &owner
            };
            let done = service.commit(who, &pick.id, &mut ports)?;
            let repeated = service.commit(who, &pick.id, &mut ports)?;
            let card = done.card_id.as_deref().map(|id| {
                let card = collab.store().board_get_card(&done.project_id, id).unwrap();
                json!({ "title": card.get("title").map(J::to_value), "description": card.get("description").map(J::to_value) })
            });
            let links = service.links(who, "ses_1", &ports)?;
            Ok(json!({ "ok": done, "repeated": repeated, "card": card, "links": links }))
        })();
        let projected = match records {
            Ok(value) => value,
            Err(e) => {
                json!({ "err": { "code": if name == "foreign source" { e.code.as_str() } else { match e.code {
                C::Invalid => "E_INVALID_PARAMS", C::NotFound => "E_NOT_FOUND", C::Conflict => "E_CONFLICT", _ => e.code.as_str()
            } }, "message": e.message } })
            }
        };
        assert_eq!(projected, case["result"], "{name}");
        assert_eq!(preview, case["preview"], "{name}");
        assert_eq!(json!(audit), case["audit"], "{name}");
        assert_eq!(
            publish.calls,
            usize::from(projected.get("ok").is_some()),
            "{name}"
        );
    }
}

#[test]
fn private_receipts_round_trip_between_typescript_and_rust() {
    let dir = tempfile::tempdir().unwrap();
    let script = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/core-parity/k6b-promotion-b-driver.ts");
    let driver = |action| {
        let out = std::process::Command::new("node")
            .args([
                "--experimental-strip-types",
                "--conditions=source",
                "--no-warnings=ExperimentalWarning",
            ])
            .arg(&script)
            .arg(action)
            .arg(dir.path())
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "promotion driver failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    };
    driver("prepare");
    let clock = Arc::new(Fixed(AtomicI64::new(1000)));
    let ids = Arc::new(Ids::default());
    let store = CollabStore::open(
        Path::new(":memory:"),
        StoreOptions::new(clock.clone(), ids.clone()),
    )
    .unwrap();
    let collab = CollabService::new(store, Ports::default(), ids.clone());
    let owner = Principal {
        kind: Some(PrincipalKind::Person),
        ..Principal::new("owner", Role::Owner)
    };
    let project = collab
        .create_project(&owner, "Existing project", None)
        .unwrap();
    let source = Source(Cell::new(0));
    let mut publish = Publish {
        svc: &collab,
        calls: 0,
    };
    let mut audit = |_: &AuditEvent| Ok(());
    let mut ports = PromotionPorts {
        source: &source,
        collab: &collab,
        clock: clock.as_ref(),
        ids: ids.as_ref(),
        publisher: &mut publish,
        audit: &mut audit,
    };
    for (name, expected) in [("promotion-ts.sqlite", 1), ("promotion-rust.sqlite", 0)] {
        let mut service = ChatPromotion::open_with_permissions(
            &dir.path().join(name),
            crate::private_store::fixture_owner_hook(),
        )
        .unwrap();
        assert_eq!(
            service.links(&owner, "ses_1", &ports).unwrap().len(),
            expected
        );
        let preview = service
            .preview(
                &owner,
                "ses_1",
                existing_target(project.id.clone()),
                &Selection {
                    kind: SelectionKind::None,
                    summary: None,
                    message_ids: None,
                },
                &ports,
            )
            .unwrap();
        service.commit(&owner, &preview.id, &mut ports).unwrap();
        assert_eq!(
            service.links(&owner, "ses_1", &ports).unwrap().len(),
            expected + 1
        );
    }
    driver("verify");
}
