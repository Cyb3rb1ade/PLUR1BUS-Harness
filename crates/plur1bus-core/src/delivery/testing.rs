//! Test doubles of the delivery ports, driven by the "world" of a recorded scenario (`scripts/parity/export-delivery.ts`): one
//! shared state the clock, the identity lookup, the principal lookup, the audit sink and the channel all read, so a scenario
//! can change a link, a right or the allowlist between two calls, or in the middle of one (a *hook* runs inside the next
//! `target` call, which is where TypeScript awaits and another caller gets in).
use super::{ChannelIdentity, DeliveryIdentity, DeliveryOptions, DeliveryTargets, LinkedIdentity};
use crate::budget::{Clock, IdSource};
use crate::handoff::testing::{principal_of, ScriptedRandom};
use crate::rbac::audit::{AuditEvent, AuditSink};
use plur1bus_store::rusqlite::Connection;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

pub(crate) struct Link {
    pub identity: ChannelIdentity,
    pub human: String,
    pub revoked: bool,
}

pub(crate) struct World {
    pub now: i64,
    pub links: Vec<Link>,
    pub principals: Vec<(String, Value)>,
    /// `None`: everything is allowed.
    pub allowed: Option<Vec<ChannelIdentity>>,
    /// A string (one chat for every channel), an object by channel, or `null` (no chat).
    pub chat: Value,
    pub send_ok: bool,
    pub send_throws: bool,
    pub audit: Vec<AuditEvent>,
    pub audit_fail: bool,
    pub sent: Vec<(String, String, String)>,
    pub hooks: VecDeque<Value>,
    pub path: PathBuf,
    pub ids: Vec<String>,
}

pub(crate) type Shared = Arc<Mutex<World>>;

fn s(v: &Value) -> String {
    v.as_str().unwrap_or_default().to_owned()
}

pub(crate) fn identity_of(v: &Value) -> ChannelIdentity {
    ChannelIdentity {
        channel: s(&v["channel"]),
        account_id: s(&v["accountId"]),
        user_id: s(&v["userId"]),
    }
}

pub(crate) fn link_of(v: &Value) -> Link {
    Link {
        identity: identity_of(v),
        human: s(&v["human"]),
        revoked: v["revoked"].as_bool().unwrap_or(false),
    }
}

impl World {
    pub fn from_json(w: &Value, path: PathBuf) -> World {
        let mut world = World {
            now: w["now"].as_i64().unwrap_or(0),
            links: w["links"]
                .as_array()
                .map(|a| a.iter().map(link_of).collect())
                .unwrap_or_default(),
            principals: w["principals"]
                .as_object()
                .map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
                .unwrap_or_default(),
            allowed: None,
            chat: Value::Null,
            send_ok: true,
            send_throws: false,
            audit: Vec::new(),
            audit_fail: false,
            sent: Vec::new(),
            hooks: VecDeque::new(),
            path,
            ids: Vec::new(),
        };
        world.patch(w);
        world
    }

    /// `Object.assign(world, patch)` for the members a scenario changes.
    pub fn patch(&mut self, p: &Value) {
        if let Some(a) = p.get("allowed") {
            self.allowed = a.as_array().map(|l| l.iter().map(identity_of).collect());
        }
        if let Some(c) = p.get("chat") {
            self.chat = c.clone();
        }
        if let Some(b) = p["sendOk"].as_bool() {
            self.send_ok = b;
        }
        if let Some(b) = p["sendThrows"].as_bool() {
            self.send_throws = b;
        }
    }

    fn run_hook(&mut self) {
        let Some(h) = self.hooks.pop_front() else {
            return;
        };
        match h["kind"].as_str().unwrap_or_default() {
            "delete-row" => {
                let id = h["nth"]
                    .as_u64()
                    .and_then(|n| self.ids.get(n as usize).cloned())
                    .unwrap_or_else(|| s(&h["id"]));
                let db = Connection::open(&self.path).unwrap();
                db.execute("DELETE FROM delivery_targets WHERE id=?", [id])
                    .unwrap();
            }
            "fill-quota" => {
                let db = Connection::open(&self.path).unwrap();
                for i in 0..h["count"].as_u64().unwrap_or(0) {
                    let row = serde_json::json!({"id": format!("filler-{i}"), "person": h["person"], "identity": {"channel": "telegram", "accountId": "bot", "userId": format!("f{i}")}, "chatId": "dm", "validated": false, "createdAt": 1});
                    db.execute(
                        "INSERT INTO delivery_targets VALUES (?,?)",
                        [format!("filler-{i}"), row.to_string()],
                    )
                    .unwrap();
                }
            }
            "world" => self.patch(&h["patch"]),
            "unlink" => {
                let i = identity_of(&h);
                self.links.retain(|l| l.identity != i);
            }
            other => panic!("unknown hook {other}"),
        }
    }
}

pub(crate) struct WorldClock(pub Shared);
impl Clock for WorldClock {
    fn now(&self) -> i64 {
        self.0.lock().unwrap().now
    }
}

pub(crate) struct WorldAudit(pub Shared);
impl AuditSink for WorldAudit {
    fn append(&mut self, event: &AuditEvent) -> Result<(), String> {
        let mut w = self.0.lock().unwrap();
        if w.audit_fail {
            return Err("audit unavailable".into());
        }
        w.audit.push(event.clone());
        Ok(())
    }
}

pub(crate) struct WorldIdentity(pub Shared);
impl DeliveryIdentity for WorldIdentity {
    fn resolve(&self, identity: &ChannelIdentity) -> Option<String> {
        self.0
            .lock()
            .unwrap()
            .links
            .iter()
            .find(|l| !l.revoked && l.identity == *identity)
            .map(|l| l.human.clone())
    }
    fn linked(&self) -> Vec<LinkedIdentity> {
        let w = self.0.lock().unwrap();
        let mut humans: Vec<&str> = Vec::new();
        for l in &w.links {
            if !humans.contains(&l.human.as_str()) {
                humans.push(&l.human);
            }
        }
        humans
            .into_iter()
            .flat_map(|h| w.links.iter().filter(move |l| l.human == h))
            .map(|l| LinkedIdentity {
                identity: l.identity.clone(),
                human_id: l.human.clone(),
                revoked: l.revoked,
            })
            .collect()
    }
}

/// `randomUUID()` of `k3b-support.ts`: the first 16 bytes of the SHA-256 of `uuid:k`, formatted as a UUID.
#[derive(Default)]
pub(crate) struct ScriptedIds(pub AtomicU64);
impl IdSource for ScriptedIds {
    fn next_id(&self) -> String {
        let k = self.0.fetch_add(1, Ordering::SeqCst) + 1;
        let h: String = Sha256::digest(format!("uuid:{k}").as_bytes())
            .iter()
            .take(16)
            .map(|b| format!("{b:02x}"))
            .collect();
        format!(
            "{}-{}-{}-{}-{}",
            &h[..8],
            &h[8..12],
            &h[12..16],
            &h[16..20],
            &h[20..32]
        )
    }
}

pub(crate) fn world_principals(w: &Shared) -> crate::handoff::PrincipalLookup {
    let w = w.clone();
    Box::new(move |id| {
        w.lock()
            .unwrap()
            .principals
            .iter()
            .find(|(k, _)| k == id)
            .map(|(k, v)| principal_of(k, v))
    })
}

/// A delivery service over a temporary store and a world.
pub(crate) struct Rig {
    pub w: Shared,
    pub d: Option<DeliveryTargets>,
    pub path: PathBuf,
    pub rnd: Arc<ScriptedRandom>,
    pub ids: Arc<ScriptedIds>,
    _dir: tempfile::TempDir,
}

impl Rig {
    pub fn new(world: &Value) -> Rig {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state").join("delivery.sqlite");
        let w: Shared = Arc::new(Mutex::new(World::from_json(world, path.clone())));
        let mut r = Rig {
            w,
            d: None,
            path,
            rnd: Arc::new(ScriptedRandom::default()),
            ids: Arc::new(ScriptedIds::default()),
            _dir: dir,
        };
        r.reopen();
        r
    }

    /// Closes the service and opens a new one on the same file (a restart).
    pub fn reopen(&mut self) {
        self.d = None;
        let w = self.w.clone();
        let o = DeliveryOptions {
            path: self.path.clone(),
            clock: Arc::new(WorldClock(w.clone())),
            identity: Box::new(WorldIdentity(w.clone())),
            resolve: world_principals(&w),
            audit: Box::new(WorldAudit(w.clone())),
            allowed: {
                let w = w.clone();
                Box::new(move |i| {
                    w.lock()
                        .unwrap()
                        .allowed
                        .as_ref()
                        .is_none_or(|l| l.contains(i))
                })
            },
            target: {
                let w = w.clone();
                Box::new(move |i| {
                    // The lock is released before the hook touches the file, and the hook runs before the answer is read.
                    let mut g = w.lock().unwrap();
                    g.run_hook();
                    match &g.chat {
                        Value::String(c) => c.clone(),
                        Value::Object(m) => m
                            .get(&i.channel)
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        _ => String::new(),
                    }
                })
            },
            send: {
                let w = w.clone();
                Box::new(move |channel, chat, text| {
                    let mut g = w.lock().unwrap();
                    g.sent
                        .push((channel.to_owned(), chat.to_owned(), text.to_owned()));
                    !g.send_throws && g.send_ok
                })
            },
            ids: self.ids.clone(),
            random: self.rnd.clone(),
            secure_path: Some(Box::new(|_| true)),
        };
        self.d = Some(DeliveryTargets::open(o).unwrap());
    }

    pub fn d(&mut self) -> &mut DeliveryTargets {
        self.d.as_mut().unwrap()
    }
}
