//! Cached, read-only operational metadata. Never call the writer's mutating tail reader here.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io;
use std::path::Path;

const MAX_SEQ: u64 = 9_007_199_254_740_991;
const GENESIS: &str = "0000000000000000000000000000000000000000000000000000000000000000";
const CODES: &[&str] = &[
    "anchor-missing",
    "anchor-invalid",
    "chain-shorter-than-anchor",
    "tail-anchor-mismatch",
    "tail-malformed",
    "sequence-exhausted",
    "rotation-target-exists",
    "lock-timeout",
];
fn number(v: &Value) -> Option<u64> {
    v.as_u64().filter(|n| *n <= MAX_SEQ)
}
fn hex(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        s.len() == 64
            && s.bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    })
}
fn hash(s: &str) -> String {
    format!("{:x}", Sha256::digest(s.as_bytes()))
}
fn note(v: &Value) -> Value {
    let a = &v["actor"];
    let actor = match (a["user"].as_str(), a["host"].as_str()) {
        (Some(user), Some(host)) => {
            json!({"user":user.chars().take(128).collect::<String>(),"host":host.chars().take(128).collect::<String>()})
        }
        _ => Value::Null,
    };
    json!({"at":number(&v["at"]),"actor":actor})
}
fn refuse(s: &mut Value, reason: &str) {
    s["state"] = json!("refusing");
    s["reason"] = json!(reason);
}

pub(crate) fn read(dir: &Path, now: u64) -> Value {
    let verified = fs::read(dir.join("audit-chain.verified.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .filter(|v| v["v"] == 1)
        .and_then(|v| number(&v["at"]));
    let mut s = json!({"state":"ok","reason":null,"lastSeq":0,"observedAt":now,"lastVerifiedAt":verified,"pendingLines":0,"pendingDropped":0,"pending":[],"lastAnchorAdvanced":null,"lastReanchor":null});
    if read_into(dir, &mut s).is_err() {
        s["lastSeq"] = Value::Null;
        refuse(&mut s, "audit-unreadable");
    }
    s
}
fn read_into(dir: &Path, s: &mut Value) -> io::Result<()> {
    let mut names = Vec::new();
    match fs::read_dir(dir) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => (),
        Err(e) => return Err(e),
        Ok(entries) => {
            for e in entries {
                names.push(e?.file_name().to_string_lossy().into_owned());
            }
        }
    }
    let mut files: Vec<_> = names
        .iter()
        .filter(|n| {
            n.strip_prefix("audit-chain.")
                .and_then(|n| n.strip_suffix(".jsonl"))
                .is_some_and(|n| n.len() == 10 && n.bytes().all(|c| c.is_ascii_digit()))
        })
        .cloned()
        .collect();
    files.sort();
    if names.iter().any(|n| n == "audit-chain.jsonl") {
        files.push("audit-chain.jsonl".into());
    }
    let mut tails = std::collections::VecDeque::new();
    for file in files {
        let bytes = fs::read(dir.join(file))?;
        let text = String::from_utf8_lossy(&bytes);
        let end = text.rfind('\n').map_or(0, |n| n + 1);
        for raw in text[..end].split_terminator('\n') {
            let line = raw.strip_suffix('\r').unwrap_or(raw);
            tails.push_back(line.to_string());
            if tails.len() > 2 {
                tails.pop_front();
            }
            if let Ok(v) = serde_json::from_str::<Value>(line) {
                match v["rec"]["action"].as_str() {
                    Some("audit.chain.anchor-advanced") => {
                        s["lastAnchorAdvanced"] = note(&v["rec"])
                    }
                    Some("audit.chain.reanchored") => s["lastReanchor"] = note(&v["rec"]),
                    _ => (),
                }
            }
        }
    }
    let (mut seq, mut tail_hash, mut prev) = (0, GENESIS.to_string(), GENESIS.to_string());
    if let Some(latest) = tails.back() {
        let tail = serde_json::from_str::<Value>(latest).unwrap_or(Value::Null);
        match number(&tail["seq"]).filter(|n| *n > 0) {
            Some(n) if hex(&tail["prev"]) && tail["rec"].is_object() => {
                seq = n;
                s["lastSeq"] = json!(n);
                tail_hash = hash(latest);
                prev = tail["prev"].as_str().unwrap().to_string();
            }
            _ => {
                s["lastSeq"] = Value::Null;
                refuse(s, "tail-malformed");
            }
        }
    }
    match fs::read(dir.join("audit-chain.anchor")) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            if s["state"] == "ok" && seq > 0 {
                refuse(s, "anchor-missing");
            }
        }
        Err(e) => return Err(e),
        Ok(bytes) => {
            let a = serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null);
            let aseq = number(&a["seq"]).filter(|n| *n > 0);
            if let Some(n) = aseq.filter(|_| a["v"] == 1 && hex(&a["hash"])) {
                if s["state"] == "ok" {
                    let h = a["hash"].as_str().unwrap();
                    if seq < n {
                        refuse(s, "chain-shorter-than-anchor");
                    } else if !(seq == n && tail_hash == h
                        || seq == n + 1 && prev == h && tails.len() == 2 && hash(&tails[0]) == h)
                    {
                        refuse(s, "tail-anchor-mismatch");
                    }
                }
            } else if s["state"] == "ok" {
                refuse(s, "anchor-invalid");
            }
        }
    }
    if s["state"] == "ok" && seq == MAX_SEQ {
        refuse(s, "sequence-exhausted");
    }
    match fs::read(dir.join("audit-chain.pending.jsonl")) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => (),
        Err(e) => return Err(e),
        Ok(bytes) => {
            let text = String::from_utf8_lossy(&bytes);
            let mut pending = Vec::new();
            for (index, line) in text.split('\n').filter(|l| !l.is_empty()).enumerate() {
                let row = serde_json::from_str::<Value>(line).unwrap_or(Value::Null);
                if index == 0 {
                    if let Some(n) = number(&row["pendingDropped"]) {
                        s["pendingDropped"] = json!(n);
                        continue;
                    }
                }
                let mut meta = note(&row);
                let action = row["action"]
                    .as_str()
                    .filter(|a| {
                        !a.is_empty()
                            && a.len() <= 128
                            && a.as_bytes()[0].is_ascii_lowercase()
                            && a.bytes().all(|c| {
                                c.is_ascii_lowercase() || c.is_ascii_digit() || b"_.-".contains(&c)
                            })
                    })
                    .unwrap_or("unknown");
                meta["action"] = json!(action);
                meta["reason"] = json!(row["chainReason"].as_str().filter(|r| CODES.contains(r)));
                pending.push(meta);
            }
            s["pendingLines"] = json!(pending.len());
            s["pending"] = json!(pending);
        }
    }
    Ok(())
}

#[derive(Default)]
pub(crate) struct Cache {
    cached: Option<Value>,
}
impl Cache {
    pub(crate) fn status(&mut self, dir: &Path, now: u64) -> Value {
        if self.cached.as_ref().is_none_or(|v| {
            v["observedAt"]
                .as_u64()
                .is_none_or(|at| now < at || now - at >= 30_000)
        }) {
            self.cached = Some(read(dir, now));
        }
        self.cached.as_ref().unwrap().clone()
    }
}

/// A local supervisor-token holder is the OS owner; delegated callers need audit.read and a human role.
pub(crate) fn authorized(principal: Option<&Value>) -> bool {
    let Some(p) = principal else {
        return true;
    };
    p["kind"] == "person"
        && matches!(p["role"].as_str(), Some("owner" | "admin"))
        && (p.get("tokenScopes").is_none()
            || p["tokenScopes"].as_array().is_some_and(|a| {
                a.iter().filter_map(Value::as_str).any(|s| {
                    s == "audit.read"
                        || s.strip_suffix(".*")
                            .is_some_and(|prefix| "audit.read".starts_with(&format!("{prefix}.")))
                })
            }))
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    #[test]
    fn status_cache_preserves_torn_evidence_and_only_observes_the_anchor_after_ttl() {
        let dir = tempfile::tempdir().unwrap();
        super::super::chain::append(dir.path(), &json!({"at":42,"actor":{"user":"owner","host":"host"},"action":"audit.chain.reanchored","target":"audit-chain","detail":{"confidential":"must-not-escape"}})).unwrap();
        let file = dir.path().join("audit-chain.jsonl");
        let torn = fs::read_to_string(&file).unwrap() + "torn evidence";
        fs::write(&file, &torn).unwrap();
        let files_before = fs::read_dir(dir.path()).unwrap().count();
        let mut cache = Cache::default();
        let s = cache.status(dir.path(), 100);
        assert_eq!(s["state"], "ok");
        assert_eq!(s["lastSeq"], 1);
        assert_eq!(s["lastVerifiedAt"], Value::Null);
        assert_eq!(
            s["lastReanchor"],
            json!({"at":42,"actor":{"user":"owner","host":"host"}})
        );
        assert!(!s.to_string().contains("must-not-escape"));
        fs::write(dir.path().join("audit-chain.anchor"), "broken").unwrap();
        assert_eq!(cache.status(dir.path(), 101)["state"], "ok");
        assert_eq!(cache.status(dir.path(), 30_101)["reason"], "anchor-invalid");
        assert_eq!(fs::read_to_string(&file).unwrap(), torn);
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), files_before);
    }
    #[test]
    fn verification_time_comes_from_the_shared_success_marker_only() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read(dir.path(), 100)["lastVerifiedAt"], Value::Null);
        fs::write(
            dir.path().join("audit-chain.verified.json"),
            "{\"v\":1,\"at\":42}\n",
        )
        .unwrap();
        assert_eq!(read(dir.path(), 100)["lastVerifiedAt"], 42);
        fs::write(
            dir.path().join("audit-chain.verified.json"),
            "{\"v\":1,\"at\":-1}\n",
        )
        .unwrap();
        assert_eq!(read(dir.path(), 100)["lastVerifiedAt"], Value::Null);
    }
}

#[cfg(test)]
mod parity {
    use super::*;
    use std::process::Command;
    #[test]
    fn typescript_and_rust_observe_the_same_metadata_without_repairing_any_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let compare = || {
            let result = Command::new(std::env::var_os("PLUR1BUS_NODE").unwrap_or_else(|| "node".into()))
                .current_dir(&root).args(["--experimental-strip-types", "--conditions=source", "--no-warnings=ExperimentalWarning", "--input-type=module", "-e", "import {readAuditHealth} from './packages/core/src/audit/health.ts'; console.log(JSON.stringify(readAuditHealth(process.argv[1],500)))"])
                .arg(dir.path()).output().expect("Node 24.21 is required for TS/Rust parity; prepare the workspace first");
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
            let ts: Value = serde_json::from_slice(&result.stdout).unwrap();
            assert_eq!(read(dir.path(), 500), ts);
        };
        compare();
        let rec = json!({"at":42,"actor":{"user":"owner","host":"host"},"action":"audit.chain.anchor-advanced","target":"audit-chain","detail":{"secret":"must-not-escape"}});
        super::super::chain::append(dir.path(), &rec).unwrap();
        compare();
        let anchor = fs::read(dir.path().join("audit-chain.anchor")).unwrap();
        super::super::chain::append(dir.path(), &rec).unwrap();
        fs::write(dir.path().join("audit-chain.anchor"), &anchor).unwrap();
        compare();
        fs::write(
            dir.path().join("audit-chain.verified.json"),
            "{\"v\":1,\"at\":123}",
        )
        .unwrap();
        fs::write(dir.path().join("audit-chain.pending.jsonl"), format!("{{\"pendingDropped\":2}}\n{}\nmalformed confidential row\n", json!({"at":43,"actor":{"user":"u","host":"h"},"action":"audit_config_set","chainReason":"anchor-invalid","detail":{"secret":"must-not-escape"}}))).unwrap();
        compare();
        fs::write(dir.path().join("audit-chain.anchor"), "broken").unwrap();
        compare();
        fs::write(dir.path().join("audit-chain.anchor"), &anchor).unwrap();
        let active = dir.path().join("audit-chain.jsonl");
        let chain = fs::read_to_string(&active).unwrap();
        fs::write(&active, format!("{chain}torn evidence")).unwrap();
        compare();
        assert_eq!(
            fs::read_to_string(&active).unwrap(),
            format!("{chain}torn evidence")
        );
        fs::write(&active, format!("{chain}\n")).unwrap();
        compare();
    }
    #[test]
    fn only_the_local_owner_or_human_owner_admin_with_audit_scope_can_read_metadata() {
        assert!(authorized(None));
        for role in ["viewer", "operator", "member"] {
            assert!(!authorized(Some(&json!({"kind":"person","role":role}))));
        }
        for role in ["owner", "admin"] {
            assert!(authorized(Some(&json!({"kind":"person","role":role}))));
            assert!(authorized(Some(
                &json!({"kind":"person","role":role,"tokenScopes":["audit.*"]})
            )));
            assert!(!authorized(Some(
                &json!({"kind":"person","role":role,"tokenScopes":["doctor.read"]})
            )));
            assert!(!authorized(Some(&json!({"kind":"agent","role":role}))));
        }
    }
}
