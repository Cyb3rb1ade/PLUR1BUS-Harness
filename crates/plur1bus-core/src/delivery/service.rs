//! `DeliveryTargets` (`delivery/service.ts`), line by line. See the module documentation for the rule.
use super::{
    store, AllowedPort, Challenged, ChannelIdentity, DeliveryError, DeliveryIdentity,
    DeliveryTarget, SecurePath, SendPort, Subscription, TargetPort, TargetRow,
};
use crate::approvals::Random;
use crate::budget::{Clock, IdSource};
use crate::handoff::{ChatKind, InboundMessage, PrincipalLookup};
use crate::rbac::audit::{AuditEvent, AuditSink};
use crate::rbac::authorize::authorize;
use crate::rbac::types::{AuthorizeContext, Principal, PrincipalKind, Resource, Role};
use plur1bus_store::rusqlite::{params, Connection};
use plur1bus_store::Store;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::Arc;

/// Targets one person may hold.
const MAX_TARGETS: usize = 32;
/// Subscriptions one target keeps (the last ones).
const MAX_SUBSCRIPTIONS: usize = 32;
/// Ten minutes: how long a code lives.
const CODE_TTL_MS: i64 = 600_000;
/// Tries per code.
const MAX_ATTEMPTS: i64 = 5;

/// `DeliveryOptions`.
pub struct DeliveryOptions {
    /// The database file.
    pub path: PathBuf,
    /// The clock.
    pub clock: Arc<dyn Clock>,
    /// The identity lookup (`identity()`).
    pub identity: Box<dyn DeliveryIdentity>,
    /// The principal lookup (`resolve`).
    pub resolve: PrincipalLookup,
    /// The audit sink. An event that cannot be recorded stops the call before its effect.
    pub audit: Box<dyn AuditSink>,
    /// `deliveryAllowed(config, identity)` over the current configuration.
    pub allowed: AllowedPort,
    /// `target`: the chat the channel resolves for a handle; empty when it has none.
    pub target: TargetPort,
    /// `send(channel, chatId, text)`: whether the channel took the message (a failure is `false`).
    pub send: SendPort,
    /// `randomUUID()`.
    pub ids: Arc<dyn IdSource>,
    /// `randomBytes`.
    pub random: Arc<dyn Random>,
    /// The platform's owner-only hook; `None` applies mode 0600 on Unix and refuses elsewhere.
    pub secure_path: Option<SecurePath>,
}

fn sha_hex(s: &str) -> String {
    Sha256::digest(s.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The characters `\s` and `String.prototype.trim` agree on: JavaScript's WhiteSpace and LineTerminator. (Rust's own
/// `char::is_whitespace` has U+0085 and lacks U+FEFF.)
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// `/^\/delivery(?:\s|$)/i.test(text)` on an already trimmed text. Without the `u` flag, `i` folds ASCII letters only (a
/// non-ASCII letter whose upper case is ASCII does not match), so the prefix is an ASCII case-insensitive comparison.
fn is_delivery_command(text: &str) -> bool {
    let b = text.as_bytes();
    if b.len() < 9 || !b[..9].eq_ignore_ascii_case(b"/delivery") {
        return false;
    }
    text[9..].chars().next().is_none_or(is_js_space)
}

/// `/^\/delivery\s+([a-f0-9]{32})$/i.exec(text)?.[1]?.toLowerCase()` on an already trimmed text.
fn command_code(text: &str) -> Option<String> {
    let b = text.as_bytes();
    if b.len() < 9 || !b[..9].eq_ignore_ascii_case(b"/delivery") {
        return None;
    }
    let rest = &text[9..];
    let code = rest.trim_start_matches(is_js_space);
    if code.len() == rest.len() || code.len() != 32 || !code.bytes().all(|c| c.is_ascii_hexdigit())
    {
        return None;
    }
    Some(code.to_ascii_lowercase())
}

fn parse_row(value: &str) -> Result<TargetRow, DeliveryError> {
    serde_json::from_str(value)
        .map_err(|_| DeliveryError::Store("a delivery row does not parse".into()))
}

fn all(conn: &Connection) -> Result<Vec<TargetRow>, DeliveryError> {
    let mut st = conn.prepare("SELECT value FROM delivery_targets ORDER BY rowid")?;
    let rows = st.query_map([], |r| r.get::<_, String>(0))?;
    let mut out = Vec::new();
    for v in rows {
        out.push(parse_row(&v?)?);
    }
    Ok(out)
}

fn get(conn: &Connection, id: &str) -> Result<TargetRow, DeliveryError> {
    all(conn)?
        .into_iter()
        .find(|t| t.id == id)
        .ok_or_else(DeliveryError::denied)
}

fn save(conn: &Connection, t: &TargetRow) -> Result<(), DeliveryError> {
    let value = serde_json::to_string(t).map_err(|e| DeliveryError::Store(e.to_string()))?;
    conn.execute(
        "INSERT INTO delivery_targets VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
        params![t.id, value],
    )?;
    Ok(())
}

fn audit(
    o: &mut DeliveryOptions,
    person: &str,
    action: &str,
    id: &str,
) -> Result<(), DeliveryError> {
    let e = AuditEvent {
        at: o.clock.now(),
        user: person.to_owned(),
        host: "core".into(),
        action: action.into(),
        target: id.to_owned(),
        detail: Vec::new(),
    };
    o.audit.append(&e).map_err(DeliveryError::Audit)
}

/// `#live`: the target still belongs to the person, the person exists, the handle is still linked to them and the
/// configuration still allows it.
fn live(o: &DeliveryOptions, t: &TargetRow, person: &str) -> bool {
    t.person == person
        && (o.resolve)(person).is_some()
        && o.identity.resolve(&t.identity).as_deref() == Some(person)
        && (o.allowed)(&t.identity)
}

fn public(t: &TargetRow) -> DeliveryTarget {
    DeliveryTarget {
        id: t.id.clone(),
        person: t.person.clone(),
        identity: t.identity.clone(),
        chat_id: t.chat_id.clone(),
        validated: t.validated,
        created_at: t.created_at,
    }
}

fn require_person(o: &DeliveryOptions, p: &Principal) -> Result<(), DeliveryError> {
    if p.kind != Some(PrincipalKind::Person) || (o.resolve)(&p.user_id).is_none() {
        return Err(DeliveryError::denied());
    }
    Ok(())
}

fn is_owner_or_admin(r: Role) -> bool {
    matches!(r, Role::Owner | Role::Admin)
}

/// `#validate` (the public `validate`): the target as it is now, when it is confirmed and every live check passes, else the
/// refusal after an audit line (`delivery.denied`; an audit that cannot be written fails the call instead).
fn validate_in(
    conn: &Connection,
    o: &mut DeliveryOptions,
    id: &str,
    person: &str,
    agent_id: &str,
) -> Result<TargetRow, DeliveryError> {
    let t = get(conn, id)?;
    let p = (o.resolve)(person);
    let ok = t.validated
        && live(o, &t, person)
        && p.as_ref().is_some_and(|p| {
            authorize(
                Some(p),
                "agent.use",
                &Resource::Agent {
                    agent_id: agent_id.to_owned(),
                },
                &AuthorizeContext {
                    now: Some(o.clock.now() as f64),
                },
            )
            .is_allow()
        });
    if !ok {
        audit(o, person, "delivery.denied", id)?;
        return Err(DeliveryError::denied());
    }
    Ok(t)
}

/// `/^[a-zA-Z0-9._-]{1,64}$/` (`$` is the end of the text in a pattern without the `m` flag).
fn job_ok(job: &str) -> bool {
    (1..=64).contains(&job.len())
        && job
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}

/// `DeliveryTargets`.
pub struct DeliveryTargets {
    db: Store,
    o: DeliveryOptions,
}

impl DeliveryTargets {
    /// `new DeliveryTargets(options)`: opens (and creates) the store.
    pub fn open(o: DeliveryOptions) -> Result<Self, DeliveryError> {
        let db = store::open(&o.path, o.secure_path.as_deref())?;
        Ok(Self { db, o })
    }

    /// `eligible`: the person's active handles that the configuration allows.
    pub fn eligible(&self, p: &Principal) -> Result<Vec<ChannelIdentity>, DeliveryError> {
        require_person(&self.o, p)?;
        Ok(self
            .o
            .identity
            .linked()
            .into_iter()
            .filter(|l| l.human_id == p.user_id && !l.revoked && (self.o.allowed)(&l.identity))
            .map(|l| l.identity)
            .collect())
    }

    /// `list`: the person's targets; `validated` is true only while every live check still passes.
    pub fn list(&self, p: &Principal) -> Result<Vec<DeliveryTarget>, DeliveryError> {
        require_person(&self.o, p)?;
        Ok(all(self.db.conn())?
            .into_iter()
            .filter(|t| t.person == p.user_id)
            .map(|t| {
                let mut v = public(&t);
                v.validated = t.validated && live(&self.o, &t, &p.user_id);
                v
            })
            .collect())
    }

    /// `add`: a new, unconfirmed target for a handle of the person, then its challenge. The code goes to the handle's own
    /// chat; if it cannot be sent the call fails but the target stays (and can be challenged again).
    pub fn add(
        &mut self,
        identity: &ChannelIdentity,
        p: &Principal,
    ) -> Result<DeliveryTarget, DeliveryError> {
        require_person(&self.o, p)?;
        let held = |conn: &Connection| -> Result<usize, DeliveryError> {
            Ok(all(conn)?.iter().filter(|t| t.person == p.user_id).count())
        };
        if held(self.db.conn())? >= MAX_TARGETS {
            return Err(DeliveryError::denied());
        }
        let mut t = TargetRow {
            id: self.o.ids.next_id(),
            person: p.user_id.clone(),
            identity: identity.clone(),
            chat_id: String::new(),
            validated: false,
            created_at: self.o.clock.now(),
            code_hash: None,
            expires: None,
            attempts: None,
            subscriptions: None,
        };
        if !live(&self.o, &t, &p.user_id) {
            return Err(DeliveryError::denied());
        }
        // The channel lookup is where TypeScript awaits: a port call outside a transaction, then everything is checked again.
        t.chat_id = (self.o.target)(&t.identity);
        if t.chat_id.is_empty() || !live(&self.o, &t, &p.user_id) {
            return Err(DeliveryError::denied());
        }
        {
            let Self { db, o } = self;
            db.write_with(|tx| {
                if held(tx)? >= MAX_TARGETS {
                    return Err(DeliveryError::denied());
                }
                audit(o, &p.user_id, "delivery.target.add", &t.id)?;
                save(tx, &t)?;
                Ok::<_, DeliveryError>(())
            })?;
        }
        self.challenge(&t.id, p)?;
        Ok(public(&t))
    }

    /// `challenge`: a fresh code (the old one stops working), sent to the target's own chat. The code is never returned.
    pub fn challenge(&mut self, id: &str, p: &Principal) -> Result<Challenged, DeliveryError> {
        require_person(&self.o, p)?;
        let (channel, chat_id, code) = {
            let Self { db, o } = self;
            db.write_with(|tx| {
                let mut t = get(tx, id)?;
                if !live(o, &t, &p.user_id) {
                    return Err(DeliveryError::denied());
                }
                let mut raw = [0u8; 16];
                o.random.fill(&mut raw);
                let code: String = raw.iter().map(|b| format!("{b:02x}")).collect();
                t.code_hash = Some(sha_hex(&code));
                t.expires = Some(o.clock.now() + CODE_TTL_MS);
                t.attempts = Some(0);
                t.validated = false;
                audit(o, &p.user_id, "delivery.target.challenge", id)?;
                save(tx, &t)?;
                Ok::<_, DeliveryError>((t.identity.channel.clone(), t.chat_id.clone(), code))
            })?
        };
        let text = format!("Confirm delivery in this DM: /delivery {code}");
        if !(self.o.send)(&channel, &chat_id, &text) {
            return Err(DeliveryError::not_available(
                "confirmation could not be sent",
            ));
        }
        Ok(Challenged {
            awaiting_channel: true,
        })
    }

    /// `confirmMessage`: whether the message was a `/delivery` command (it is consumed either way). Only a direct message
    /// from the target's own handle, chat and bot account, with the right code, in time and within five tries, confirms.
    pub fn confirm_message(
        &mut self,
        msg: &InboundMessage,
        person: &str,
    ) -> Result<bool, DeliveryError> {
        let text = msg.text.trim_matches(is_js_space);
        if !is_delivery_command(text) {
            return Ok(false);
        }
        let code = command_code(text);
        let candidates: Vec<TargetRow> = all(self.db.conn())?
            .into_iter()
            .filter(|t| {
                t.person == person
                    && t.identity.channel == msg.channel
                    && Some(t.identity.account_id.as_str()) == msg.account_id.as_deref()
                    && t.identity.user_id == msg.sender_id
                    && t.chat_id == msg.chat_id
            })
            .collect();
        let Self { db, o } = self;
        for mut t in candidates {
            if t.code_hash.as_deref().is_none_or(str::is_empty)
                || !live(o, &t, person)
                || msg.chat_kind != ChatKind::Direct
            {
                continue;
            }
            let attempts = t.attempts.unwrap_or(0) + 1;
            t.attempts = Some(attempts);
            let correct = code.as_deref().is_some_and(|c| {
                attempts <= MAX_ATTEMPTS
                    && o.clock.now() < t.expires.unwrap_or(0)
                    && Some(sha_hex(c)) == t.code_hash
            });
            if correct {
                audit(o, person, "delivery.target.confirmed", &t.id)?;
                t.validated = true;
                t.code_hash = None;
                t.expires = None;
            }
            db.write_with(|tx| save(tx, &t))?;
        }
        Ok(true)
    }

    /// `remove`: deletes the person's target.
    pub fn remove(&mut self, id: &str, p: &Principal) -> Result<bool, DeliveryError> {
        require_person(&self.o, p)?;
        let Self { db, o } = self;
        db.write_with(|tx| {
            let t = get(tx, id)?;
            if t.person != p.user_id {
                return Err(DeliveryError::denied());
            }
            audit(o, &p.user_id, "delivery.target.removed", id)?;
            tx.execute("DELETE FROM delivery_targets WHERE id=?", [id])?;
            Ok::<_, DeliveryError>(true)
        })
    }

    /// `validate`: the target, when it is confirmed and every live check passes; otherwise the refusal (audited).
    pub fn validate(
        &mut self,
        id: &str,
        person: &str,
        agent_id: &str,
    ) -> Result<TargetRow, DeliveryError> {
        let Self { db, o } = self;
        validate_in(db.conn(), o, id, person, agent_id)
    }

    /// `deliver`: validates, asks the channel for the target's chat, validates again, and refuses unless the chat and the bot
    /// account are still the confirmed ones. Then the attempt is audited and the message sent.
    pub fn deliver(
        &mut self,
        id: &str,
        person: &str,
        agent_id: &str,
        text: &str,
    ) -> Result<bool, DeliveryError> {
        let t = self.validate(id, person, agent_id)?;
        let destination = (self.o.target)(&t.identity);
        let current = self.validate(id, person, agent_id)?;
        if current.chat_id != destination || current.identity.account_id != t.identity.account_id {
            return Err(DeliveryError::denied());
        }
        audit(&mut self.o, person, "delivery.attempt", id)?;
        if !(self.o.send)(&t.identity.channel, &t.chat_id, text) {
            return Err(DeliveryError::not_available("delivery unavailable"));
        }
        Ok(true)
    }

    /// `subscribe`: the target gets the outcome of a job. `system` jobs only for an owner or admin; the last 32 are kept.
    pub fn subscribe(
        &mut self,
        id: &str,
        source: &str,
        job: &str,
        agent_id: &str,
        p: &Principal,
    ) -> Result<bool, DeliveryError> {
        let Self { db, o } = self;
        db.write_with(|tx| {
            let mut t = validate_in(tx, o, id, &p.user_id, agent_id)?;
            if !matches!(source, "system" | "dreams") || !job_ok(job) || agent_id.is_empty() {
                return Err(DeliveryError::denied());
            }
            if source == "system" && !is_owner_or_admin(p.role) {
                return Err(DeliveryError::denied());
            }
            let mut subs: Vec<Subscription> = t
                .subscriptions
                .take()
                .unwrap_or_default()
                .into_iter()
                .filter(|s| !(s.source == source && s.job == job && s.agent_id == agent_id))
                .collect();
            subs.push(Subscription {
                source: source.to_owned(),
                job: job.to_owned(),
                agent_id: agent_id.to_owned(),
            });
            let skip = subs.len().saturating_sub(MAX_SUBSCRIPTIONS);
            t.subscriptions = Some(subs.split_off(skip));
            audit(o, &p.user_id, "delivery.subscription", id)?;
            save(tx, &t)?;
            Ok::<_, DeliveryError>(true)
        })
    }

    /// `notify`: sends the outcome of a job to every subscribed target that still passes every check. A refusal is audited by
    /// `validate`; no result and no error text goes to another target. Errors of a single delivery are not reported.
    pub fn notify(
        &mut self,
        source: &str,
        job: &str,
        agent_id: Option<&str>,
        outcome: &str,
    ) -> Result<(), DeliveryError> {
        // A snapshot, as `for (const t of this.#all())`: a subscription added meanwhile is not visited.
        let snapshot = all(self.db.conn())?;
        for t in snapshot {
            for s in t.subscriptions.as_deref().unwrap_or_default() {
                if s.source != source || s.job != job || agent_id.is_some_and(|a| s.agent_id != a) {
                    continue;
                }
                let role = (self.o.resolve)(&t.person).map(|p| p.role);
                if source == "system" && !role.is_some_and(is_owner_or_admin) {
                    continue;
                }
                let _ = self.deliver(
                    &t.id,
                    &t.person,
                    &s.agent_id,
                    &format!("{source}: {job} — {outcome}"),
                );
            }
        }
        Ok(())
    }
}

/// Used by the tests: whether an optional row exists.
#[cfg(test)]
pub(crate) fn row_exists(conn: &Connection, id: &str) -> bool {
    use plur1bus_store::rusqlite::OptionalExtension;
    conn.query_row(
        "SELECT 1 FROM delivery_targets WHERE id=?",
        [id],
        |_| Ok(()),
    )
    .optional()
    .unwrap()
    .is_some()
}
