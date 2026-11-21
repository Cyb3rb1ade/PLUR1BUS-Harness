use super::*;
use crate::rbac::{
    audit::AuditEvent,
    types::{PrincipalKind, Role},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

struct Runtime;
impl Clock for Runtime {
    fn now(&self) -> i64 {
        1
    }
}
impl Authority for Runtime {
    fn active_agent(&self, agent: &str) -> bool {
        agent == "alpha"
    }
    fn current(&self, id: &str) -> Option<Principal> {
        Some(Principal {
            kind: Some(PrincipalKind::Person),
            ..Principal::new(id, Role::Owner)
        })
    }
}

#[derive(Default)]
struct Disk {
    files: BTreeMap<Slot, Vec<u8>>,
    external_edit: bool,
}
fn sha(v: &[u8]) -> String {
    format!("{:x}", Sha256::digest(v))
}
impl Files for Disk {
    fn trusted_root(&self, agent: &str) -> bool {
        agent == "alpha"
    }
    fn read(&self, slot: Slot, max: usize) -> R<Option<Vec<u8>>> {
        let result = self.files.get(&slot);
        if result.is_some_and(|v| v.len() > max) {
            return Err(CollabError::new(CollabErrorCode::Invalid, "byte ceiling"));
        }
        Ok(result.cloned())
    }
    fn compare_write(
        &mut self,
        slot: Slot,
        expected: Option<&str>,
        bytes: Option<&[u8]>,
    ) -> R<bool> {
        if self.external_edit && slot == Slot::Knowledge {
            self.put(slot, b"Concurrent fixture edit");
            self.external_edit = false;
        }
        if self.files.get(&slot).map(|v| sha(v)).as_deref() != expected {
            return Ok(false);
        }
        if let Some(bytes) = bytes {
            self.put(slot, bytes);
        } else {
            self.files.remove(&slot);
        }
        Ok(true)
    }
}
impl Disk {
    fn contents(&self, slot: Slot) -> Option<String> {
        self.files
            .get(&slot)
            .map(|bytes| String::from_utf8(bytes.clone()).unwrap())
    }
    fn put(&mut self, slot: Slot, bytes: &[u8]) {
        self.files.insert(slot, bytes.to_vec());
    }
}

fn to_value(value: R<impl Serialize>) -> Value {
    match value {
        Ok(v) => json!(v),
        Err(e) => json!({"error":e.reason.unwrap_or(e.message)}),
    }
}

#[test]
fn knowledge_writes_require_both_import_and_private_memory_rights() {
    for capability in ["imports.manage", "memory.agent-private.write"] {
        let who = Principal {
            token_scopes: Some(vec![capability.to_owned()]),
            ..Runtime.current("ada").unwrap()
        };
        let mut disk = Disk::default();
        let mut context = Context {
            who: &who,
            agent: "alpha",
            authority: &Runtime,
            clock: &Runtime,
            audit: &mut |_: &AuditEvent| Ok(()),
        };
        let result = append(&mut disk, &mut context, "fixture note", "fixture source");
        assert!(
            matches!(result, Err(error) if error.code == CollabErrorCode::Unauthorized),
            "only {capability} is insufficient"
        );
        assert!(disk.contents(Slot::Knowledge).is_none());
    }
}

#[test]
fn quoted_knowledge_file_and_atomic_migration_match_typescript() {
    let vectors: Value = serde_json::from_str(include_str!(
        "../../../../fixtures/parity/knowledge/file.json"
    ))
    .unwrap();
    let text = vectors["text"].as_str().unwrap();
    let source = vectors["source"].as_str().unwrap();
    assert_eq!(json!(format_imported(text, source)), vectors["formatted"]);
    let who = Runtime.current("ada").unwrap();
    let mut audit = |_: &AuditEvent| Ok(());
    let mut context = Context {
        who: &who,
        agent: "alpha",
        authority: &Runtime,
        clock: &Runtime,
        audit: &mut audit,
    };
    for row in vectors["append"].as_array().unwrap() {
        let name = row["name"].as_str().unwrap();
        let mut disk = Disk::default();
        if name == "existing" {
            disk.put(Slot::Knowledge, "\u{feff}# Earlier fixture\n".as_bytes());
        }
        let before = append(&mut disk, &mut context, text, source).unwrap();
        let after = append(&mut disk, &mut context, text, source).unwrap();
        let actual = json!({"name":name,"first":before,"second":after,"contents":disk.contents(Slot::Knowledge)});
        assert_eq!(actual, *row, "{name}");
    }
    for row in vectors["migration"].as_array().unwrap() {
        let name = row["name"].as_str().unwrap();
        let mut disk = Disk::default();
        let before = b"# Existing fixture\n";
        if name != "no legacy" {
            let source = match name {
                "bad encoding" => vec![0xc3, 0x28],
                "utf16" => [0xff, 0xfe]
                    .into_iter()
                    .chain("Wide fixture".encode_utf16().flat_map(u16::to_le_bytes))
                    .collect(),
                _ => b"<note> & evidence\n".to_vec(),
            };
            disk.put(Slot::Pool, &source);
            if name == "both" {
                disk.put(Slot::Memories, b"Second file");
            }
        }
        if matches!(
            name,
            "restore"
                | "drift"
                | "bad backup"
                | "resume before"
                | "resume after"
                | "conflict before"
        ) {
            disk.put(Slot::Knowledge, before);
        }
        if name == "bad report" {
            disk.put(Slot::Report, br#"{"version":1,"state":"unknown"}"#);
        }
        let initial = to_value(migrate(&mut disk, &mut context));
        let follow = if matches!(name, "restore" | "remove" | "drift" | "bad backup") {
            if name == "drift" {
                disk.put(Slot::Knowledge, b"External fixture edit");
            }
            if name == "bad backup" {
                disk.put(Slot::Before, b"Changed backup");
            }
            to_value(rollback(&mut disk, &mut context))
        } else if matches!(name, "resume before" | "resume after" | "conflict before") {
            let mut report: Report =
                serde_json::from_slice(disk.files.get(&Slot::Report).unwrap()).unwrap();
            report.state = State::Prepared;
            let line = serde_json::to_string_pretty(&report).unwrap() + "\n";
            disk.put(Slot::Report, line.as_bytes());
            if name != "resume after" {
                disk.put(
                    Slot::Knowledge,
                    if name == "resume before" {
                        before
                    } else {
                        b"External fixture edit"
                    },
                );
            }
            to_value(migrate(&mut disk, &mut context))
        } else if name == "both" {
            to_value(migrate(&mut disk, &mut context))
        } else {
            Value::Null
        };
        assert_eq!(
            json!({"name":name,"initial":initial,"follow":follow,"contents":disk.contents(Slot::Knowledge),
            "beforeBackup":disk.contents(Slot::Before),"afterBackup":disk.contents(Slot::After),"report":disk.contents(Slot::Report)}),
            *row,
            "{name}"
        );
    }
}

#[test]
fn concurrent_edits_are_preserved_by_the_conditional_writer() {
    let mut disk = Disk {
        external_edit: true,
        ..Disk::default()
    };
    let who = Runtime.current("ada").unwrap();
    let mut audit = |_: &AuditEvent| Ok(());
    let mut context = Context {
        who: &who,
        agent: "alpha",
        authority: &Runtime,
        clock: &Runtime,
        audit: &mut audit,
    };
    let error = append(&mut disk, &mut context, "new fixture", "source fixture").unwrap_err();
    assert_eq!(error.reason.as_deref(), Some("knowledge-changed"));
    assert_eq!(
        disk.contents(Slot::Knowledge).as_deref(),
        Some("Concurrent fixture edit")
    );
}
