//! `approvals/store.ts` (D109 §5/§6): the approval store. A request is bound to (request id, action hash, principal, subject,
//! turn, task, session, nonce); a decision is a chain entry; [`ApprovalStore::consume`] is single-use. The HMAC chain is the
//! authority: the `approvals` table is a projection for listing, and nothing is decided from it. A broken chain fails closed
//! ([`ApprovalError::Integrity`]).
//!
//! The functions take the connection of the caller's write transaction ([`crate::grants::open::PermissionStores`] opens it
//! with `BEGIN IMMEDIATE`); reads take any connection.
use super::chain::{binding_tuple, same_bytes, ApprovalChain, ChainEntry, ChainSnapshot};
use super::js_json::J;
use super::{js_number, js_string, random_hex, ApprovalError, Clock, Random};
use plur1bus_store::rusqlite::{params, Connection};
use std::rc::Rc;
use std::sync::Arc;

const MAX_DETAIL_UNITS: usize = 16 * 1024;
/// `DEFAULT_REQUEST_TTL_MS`: a request is parked up to 24 h, then expired (= denied).
pub const DEFAULT_REQUEST_TTL_MS: i64 = 24 * 60 * 60_000;

/// `ApprovalBinding` without the request id: what an approval is bound to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Binding {
    /// The action hash of the call.
    pub action_hash: String,
    /// The person on whose behalf the call runs (and the only one who may decide it).
    pub principal: String,
    /// `subject.kind`.
    pub subject_kind: String,
    /// `subject.id`.
    pub subject_id: String,
    /// The turn.
    pub turn_id: String,
    /// The task (`-` for none).
    pub task_id: String,
    /// The session (`-` for none).
    pub session_id: String,
}

impl Binding {
    /// `{ actionHash, principal, subject: { kind, id }, turnId, taskId, sessionId }` in that member order.
    pub fn j(&self) -> J {
        J::obj([
            ("actionHash", J::s(&self.action_hash)),
            ("principal", J::s(&self.principal)),
            (
                "subject",
                J::obj([
                    ("kind", J::s(&self.subject_kind)),
                    ("id", J::s(&self.subject_id)),
                ]),
            ),
            ("turnId", J::s(&self.turn_id)),
            ("taskId", J::s(&self.task_id)),
            ("sessionId", J::s(&self.session_id)),
        ])
    }

    /// The binding a verified request entry carries (all seven members are strings: the verifier made sure).
    pub fn of(b: Option<&J>) -> Option<Binding> {
        binding_tuple(b)?;
        let b = b?;
        let s = |v: Option<&J>| v.and_then(J::as_str).map(str::to_owned);
        let subject = b.get("subject");
        Some(Binding {
            action_hash: s(b.get("actionHash"))?,
            principal: s(b.get("principal"))?,
            subject_kind: s(subject.and_then(|x| x.get("kind")))?,
            subject_id: s(subject.and_then(|x| x.get("id")))?,
            turn_id: s(b.get("turnId"))?,
            task_id: s(b.get("taskId"))?,
            session_id: s(b.get("sessionId"))?,
        })
    }
}

/// `ApprovalDenial`: the closed reasons of `E_DENIED` (§6).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Denial {
    /// `approval-mismatch`.
    Mismatch,
    /// `approval-used`.
    Used,
    /// `approval-expired`.
    Expired,
    /// `surface-untrusted`: a decision from a T0 surface (or not a surface level at all).
    SurfaceUntrusted,
}

impl Denial {
    /// The wire name.
    pub fn as_str(self) -> &'static str {
        match self {
            Denial::Mismatch => "approval-mismatch",
            Denial::Used => "approval-used",
            Denial::Expired => "approval-expired",
            Denial::SurfaceUntrusted => "surface-untrusted",
        }
    }
}

/// `ApprovalStatus`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    /// `pending`.
    Pending,
    /// `approved`.
    Approved,
    /// `denied`.
    Denied,
    /// `used`.
    Used,
    /// `expired`.
    Expired,
    /// `cancelled`.
    Cancelled,
}

impl Status {
    /// The wire name.
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Pending => "pending",
            Status::Approved => "approved",
            Status::Denied => "denied",
            Status::Used => "used",
            Status::Expired => "expired",
            Status::Cancelled => "cancelled",
        }
    }
}

/// `ApprovalRecord`: a request as the chain tells it.
#[derive(Clone, Debug, PartialEq)]
pub struct ApprovalRecord {
    /// The request id.
    pub id: String,
    /// Where it stands now.
    pub status: Status,
    /// `String(payload.capability)`.
    pub capability: String,
    /// What it is bound to.
    pub bound: Binding,
    /// The request entry's time.
    pub created_at: f64,
    /// `Number(payload.expiresAt)`.
    pub expires_at: f64,
    /// The decision entry's time.
    pub decided_at: Option<f64>,
    /// `String(decision.person)`.
    pub decided_by: Option<String>,
    /// `decision.surface` as written.
    pub decision_surface: Option<J>,
    /// `decision.delegable === true`.
    pub delegable: bool,
    /// The use entry's time.
    pub used_at: Option<f64>,
    /// What the harness computed about the request (inside the chained payload).
    pub detail: Option<J>,
    /// The cancel entry's time.
    pub cancelled_at: Option<f64>,
}

impl ApprovalRecord {
    /// The TypeScript object (`bound` with its members, optional members only when set).
    pub fn json(&self) -> serde_json::Value {
        use super::js_json::num_value;
        let b = &self.bound;
        let mut o = serde_json::json!({
            "id": self.id, "status": self.status.as_str(), "capability": self.capability,
            "bound": { "actionHash": b.action_hash, "principal": b.principal, "subject": { "kind": b.subject_kind, "id": b.subject_id },
                "turnId": b.turn_id, "taskId": b.task_id, "sessionId": b.session_id },
            "createdAt": num_value(self.created_at), "expiresAt": num_value(self.expires_at), "delegable": self.delegable,
        });
        let mut put = |k: &str, v: Option<serde_json::Value>| {
            if let (Some(v), Some(m)) = (v, o.as_object_mut()) {
                m.insert(k.to_owned(), v);
            }
        };
        put("decidedAt", self.decided_at.map(num_value));
        put(
            "decidedBy",
            self.decided_by.clone().map(serde_json::Value::String),
        );
        put(
            "decisionSurface",
            self.decision_surface.as_ref().map(J::to_value),
        );
        put("usedAt", self.used_at.map(num_value));
        put("cancelledAt", self.cancelled_at.map(num_value));
        put("detail", self.detail.as_ref().map(J::to_value));
        o
    }
}

/// `RequestInput`.
#[derive(Clone, Debug)]
pub struct RequestInput {
    /// The binding.
    pub bound: Binding,
    /// The capability asked for.
    pub capability: String,
    /// Redacted by the caller; kept verbatim. More than 16 KiB (as `JSON.stringify(detail).length`) is refused.
    pub detail: Option<J>,
}

/// What [`ApprovalStore::request`] issues. The nonce goes only to the surfaces that may decide.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Requested {
    /// `apr_` and 24 hex digits.
    pub id: String,
    /// 32 hex digits, single-use.
    pub nonce: String,
    /// When the request expires.
    pub expires_at: i64,
}

/// `DecideInput`.
#[derive(Clone, Debug)]
pub struct DecideInput {
    /// The request.
    pub request_id: String,
    /// Its nonce.
    pub nonce: String,
    /// `true` approve, `false` deny.
    pub approve: bool,
    /// Who decides.
    pub person: String,
    /// On which surface (`SurfaceTrust`, 0 to 3).
    pub surface: u8,
    /// "Allow for this task, including helpers" (D104).
    pub delegable: bool,
}

/// `ApprovalStore`.
pub struct ApprovalStore {
    /// The chain this store (and the grant store) write.
    pub chain: ApprovalChain,
    clock: Arc<dyn Clock>,
    random: Arc<dyn Random>,
    ttl_ms: i64,
}

fn find<'a>(list: &[&'a ChainEntry], kind: &str) -> Option<&'a ChainEntry> {
    list.iter().copied().find(|e| e.kind == kind)
}

fn parse(e: &ChainEntry) -> J {
    // A verified chain only holds approval entries that parse (the verifier refuses the rest).
    J::parse(&e.payload).unwrap_or(J::Null)
}

impl ApprovalStore {
    /// `createApprovalStore` without the key loading (the caller built the chain from its key and signer).
    pub fn new(
        chain: ApprovalChain,
        clock: Arc<dyn Clock>,
        random: Arc<dyn Random>,
        ttl_ms: Option<i64>,
    ) -> Self {
        ApprovalStore {
            chain,
            clock,
            random,
            ttl_ms: ttl_ms.unwrap_or(DEFAULT_REQUEST_TTL_MS),
        }
    }

    /// The verified snapshot, or the integrity error (fail closed).
    pub fn trusted(&self, conn: &Connection) -> Result<Rc<ChainSnapshot>, ApprovalError> {
        let snap = self.chain.snapshot(conn)?;
        if let Some(e) = snap.broken() {
            return Err(e.into());
        }
        Ok(snap)
    }

    fn record(id: &str, list: &[&ChainEntry], now: f64) -> Option<ApprovalRecord> {
        let req = find(list, "approval.requested")?;
        let rp = parse(req);
        let dec = find(list, "approval.decided");
        let used = find(list, "approval.used");
        let dp = dec.map(parse);
        let expires_at = js_number(rp.get("expiresAt"));
        let cancel = find(list, "approval.cancelled");
        let approve = dp
            .as_ref()
            .map(|d| d.get("decision").and_then(J::as_str) == Some("approve"));
        let mut status = if used.is_some() {
            Status::Used
        } else if cancel.is_some() {
            Status::Cancelled
        } else {
            match approve {
                Some(true) => Status::Approved,
                Some(false) => Status::Denied,
                None => Status::Pending,
            }
        };
        if matches!(status, Status::Pending | Status::Approved) && now >= expires_at {
            status = Status::Expired;
        }
        let detail = rp.get("detail").filter(|d| d.is_object_like()).cloned();
        Some(ApprovalRecord {
            id: id.to_owned(),
            status,
            capability: js_string(rp.get("capability")),
            bound: Binding::of(rp.get("bound"))?,
            created_at: req.ts,
            expires_at,
            decided_at: dec.and(dp.as_ref()).and(dec.map(|d| d.ts)),
            decided_by: dp.as_ref().map(|d| js_string(d.get("person"))),
            decision_surface: dp.as_ref().and_then(|d| d.get("surface").cloned()),
            delegable: dp
                .as_ref()
                .is_some_and(|d| d.get("delegable") == Some(&J::Bool(true))),
            used_at: used.map(|u| u.ts),
            detail,
            cancelled_at: cancel.map(|c| c.ts),
        })
    }

    /// `request(input)`: issues a request with a one-time nonce. Runs in the caller's write transaction.
    pub fn request(
        &self,
        tx: &Connection,
        input: &RequestInput,
    ) -> Result<Requested, ApprovalError> {
        let id = format!("apr_{}", random_hex(self.random.as_ref(), 12));
        let nonce = random_hex(self.random.as_ref(), 16);
        if let Some(d) = &input.detail {
            if d.stringify().encode_utf16().count() > MAX_DETAIL_UNITS {
                return Err(ApprovalError::Invalid(
                    "approval request detail is too large".to_owned(),
                ));
            }
        }
        self.trusted(tx)?;
        let now = self.clock.now();
        let expires_at = now + self.ttl_ms;
        let b = &input.bound;
        let mut payload = J::obj([
            ("capability", J::s(&input.capability)),
            ("expiresAt", J::Num(expires_at as f64)),
            ("bound", b.j()),
        ]);
        if let Some(d) = &input.detail {
            payload.set("detail", d.clone());
        }
        self.chain
            .append(tx, "approval.requested", &id, &payload, Some(&nonce))?;
        tx.execute(
            "INSERT INTO approvals (id, principal, subject_kind, subject_id, capability, action_hash, turn_id, task_id, session_id, nonce, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
            params![id, b.principal, b.subject_kind, b.subject_id, input.capability, b.action_hash, b.turn_id, b.task_id, b.session_id, nonce, now, expires_at],
        )?;
        Ok(Requested {
            id,
            nonce,
            expires_at,
        })
    }

    /// `decide(input)`: records a person's decision. Runs in the caller's write transaction.
    pub fn decide(
        &self,
        tx: &Connection,
        d: &DecideInput,
    ) -> Result<Result<bool, Denial>, ApprovalError> {
        if !matches!(d.surface, 1..=3) {
            return Ok(Err(Denial::SurfaceUntrusted));
        }
        let snap = self.trusted(tx)?;
        let list = snap.by_ref(&d.request_id);
        let Some(req) = find(&list, "approval.requested") else {
            return Ok(Err(Denial::Mismatch));
        };
        let rp = parse(req);
        let bound = rp.get("bound").cloned().unwrap_or(J::Null);
        if bound.get("principal").and_then(J::as_str) != Some(d.person.as_str()) {
            return Ok(Err(Denial::Mismatch));
        }
        if !req
            .nonce
            .as_deref()
            .is_some_and(|n| same_bytes(&d.nonce, n))
        {
            return Ok(Err(Denial::Mismatch));
        }
        if find(&list, "approval.decided").is_some() {
            return Ok(Err(Denial::Used));
        }
        if find(&list, "approval.cancelled").is_some() {
            return Ok(Err(Denial::Expired)); // closed without a decision
        }
        let now = self.clock.now();
        if now as f64 >= js_number(rp.get("expiresAt")) {
            return Ok(Err(Denial::Expired));
        }
        let delegable = d.delegable && d.approve;
        let decision = if d.approve { "approve" } else { "deny" };
        let payload = J::obj([
            ("decision", J::s(decision)),
            ("person", J::s(&d.person)),
            ("surface", J::Num(f64::from(d.surface))),
            ("delegable", J::Bool(delegable)),
            ("bound", bound),
        ]);
        self.chain.append(
            tx,
            "approval.decided",
            &d.request_id,
            &payload,
            Some(&d.nonce),
        )?;
        let status = if d.approve { "approved" } else { "denied" };
        tx.execute(
            "UPDATE approvals SET status = ?, decided_at = ?, decided_by = ?, decision_surface = ?, delegable = ? WHERE id = ?",
            params![status, now, d.person, d.surface, i64::from(delegable), d.request_id],
        )?;
        Ok(Ok(d.approve))
    }

    /// `cancel(id, by)`: closes a pending request without a decision; it can never be decided or consumed afterwards.
    pub fn cancel(
        &self,
        tx: &Connection,
        id: &str,
        by: &str,
    ) -> Result<Result<(), Denial>, ApprovalError> {
        let snap = self.trusted(tx)?;
        let list = snap.by_ref(id);
        let Some(req) = find(&list, "approval.requested") else {
            return Ok(Err(Denial::Mismatch));
        };
        let rp = parse(req);
        if find(&list, "approval.decided").is_some() || find(&list, "approval.cancelled").is_some()
        {
            return Ok(Err(Denial::Used));
        }
        if self.clock.now() as f64 >= js_number(rp.get("expiresAt")) {
            return Ok(Err(Denial::Expired));
        }
        let payload = J::obj([
            ("by", J::s(by)),
            ("bound", rp.get("bound").cloned().unwrap_or(J::Null)),
        ]);
        self.chain
            .append(tx, "approval.cancelled", id, &payload, None)?;
        tx.execute(
            "UPDATE approvals SET status = 'cancelled' WHERE id = ?",
            params![id],
        )?;
        Ok(Ok(()))
    }

    /// `consume(binding)`: atomic single use; exactly one caller gets `Ok(delegable)`, the same arguments afterwards are
    /// `approval-used`.
    pub fn consume(
        &self,
        tx: &Connection,
        request_id: &str,
        b: &Binding,
    ) -> Result<Result<bool, Denial>, ApprovalError> {
        let tuple = binding_tuple(Some(&b.j()));
        let snap = self.trusted(tx)?;
        let list = snap.by_ref(request_id);
        let (Some(req), Some(dec), Some(tuple)) = (
            find(&list, "approval.requested"),
            find(&list, "approval.decided"),
            tuple,
        ) else {
            return Ok(Err(Denial::Mismatch));
        };
        let rp = parse(req);
        let dp = parse(dec);
        if dp.get("decision").and_then(J::as_str) != Some("approve")
            || binding_tuple(rp.get("bound")).as_deref() != Some(tuple.as_str())
        {
            return Ok(Err(Denial::Mismatch));
        }
        if find(&list, "approval.used").is_some() {
            return Ok(Err(Denial::Used));
        }
        let now = self.clock.now();
        if now as f64 >= js_number(rp.get("expiresAt")) {
            return Ok(Err(Denial::Expired));
        }
        let payload = J::obj([("bound", rp.get("bound").cloned().unwrap_or(J::Null))]);
        self.chain
            .append(tx, "approval.used", request_id, &payload, None)?;
        tx.execute(
            "UPDATE approvals SET status = 'used', used_at = ? WHERE id = ?",
            params![now, request_id],
        )?;
        Ok(Ok(dp.get("delegable") == Some(&J::Bool(true))))
    }

    /// `get(id)`.
    pub fn get(
        &self,
        conn: &Connection,
        id: &str,
    ) -> Result<Option<ApprovalRecord>, ApprovalError> {
        let snap = self.trusted(conn)?;
        Ok(Self::record(id, &snap.by_ref(id), self.clock.now() as f64))
    }

    /// `list(filter)`: oldest first.
    pub fn list(
        &self,
        conn: &Connection,
        status: Option<Status>,
        principal: Option<&str>,
    ) -> Result<Vec<ApprovalRecord>, ApprovalError> {
        let snap = self.trusted(conn)?;
        let now = self.clock.now() as f64;
        let mut out: Vec<ApprovalRecord> = snap
            .refs()
            .filter_map(|(id, list)| Self::record(id, &list, now))
            .filter(|r| status.is_none_or(|s| r.status == s))
            .filter(|r| principal.is_none_or(|p| r.bound.principal == p))
            .collect();
        // `sort((a, b) => a.createdAt - b.createdAt)`: stable.
        out.sort_by(|a, b| {
            a.created_at
                .partial_cmp(&b.created_at)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        Ok(out)
    }

    /// `verify()`.
    pub fn verify(&self, conn: &Connection) -> Result<super::chain::VerifyResult, ApprovalError> {
        Ok(self.chain.verify(conn)?)
    }
}
