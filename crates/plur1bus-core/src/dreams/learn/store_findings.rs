use super::migrations::{decision_summary, finding_on, start_prediction};
use super::{
    active_run, decode, denied, finish_on, invalid, is_invalidated, put_payload, rows, storage,
    target_hash, update_metadata, CollabError, LearnStore, Outcome, Reconcile, Run, C, DAY, R,
    SIZE,
};
use crate::dreams::learn::aggregation::merge_evidence;
use crate::dreams::learn::{array, digest, equals, string, target_value, Target};
use crate::identity::principals::derive_user_principal;
use crate::toolcall::json::{parse, V};
use plur1bus_store::rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;

#[path = "store_predictions.rs"]
mod predictions;

/// An owner decision about a reviewed learning finding.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// The human approved an applied learning effect.
    Accepted,
    /// The human rejected the claim.
    Rejected,
}

impl Decision {
    fn as_str(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::Rejected => "rejected",
        }
    }
}

/// One completed authorized session that can test an accepted prediction.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    /// The observed session.
    pub session_id: String,
    /// Last observed event time.
    pub at: i64,
    /// Possible recurrences.
    pub signals: Vec<Signal>,
}

/// An observed recurrence of a specific claim.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Signal {
    /// Stable claim identity.
    pub finding_id: String,
    /// Time of the observation.
    pub at: i64,
}

fn number(v: &V, key: &str) -> R<i64> {
    v.get(key)
        .and_then(V::as_f64)
        .filter(|n| {
            n.is_finite()
                && n.fract() == 0.0
                && (0.0..=crate::dreams::learn::SAFE_INTEGER as f64).contains(n)
        })
        .map(|n| n as i64)
        .ok_or_else(|| invalid("invalid learning finding number"))
}

fn field(v: &V, key: &str) -> R<String> {
    string(v, key).map_err(|_| invalid("invalid learning finding field"))
}

fn evidence(v: &V) -> R<&[V]> {
    array(v, "evidence").map_err(|_| invalid("missing learning evidence"))
}

fn pending_finding(cx: &Connection, id: &str, who: &str, hash: &str) -> R<(V, i64)> {
    let finding = finding_on(cx, id)?
        .ok_or_else(|| CollabError::new(C::NotFound, "learning finding is missing"))?;
    let target = finding.get("target").ok_or_else(denied)?;
    let run = field(&finding, "runId")?;
    if !equals(target, "owner", who) || is_invalidated(cx, &run)? {
        return Err(denied());
    }
    if !equals(&finding, "kind", "knowledge")
        || !equals(&finding, "status", "pending")
        || digest(&finding) != hash
    {
        return Err(CollabError::with_reason(
            C::Conflict,
            "learning finding changed",
            "finding-changed",
        ));
    }
    let revision = number(&finding, "revision")?;
    Ok((finding, revision))
}

fn action_on(cx: &Connection, id: &str, revision: i64) -> R<Option<V>> {
    let row = cx
        .query_row(
            "SELECT state,receipt FROM learn_action WHERE finding_id=? AND revision=?",
            params![id, revision],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()?;
    row.map(|(state, receipt)| {
        Ok(V::obj([
            ("state", V::s(&state)),
            (
                "receipt",
                parse(&receipt).ok_or_else(|| storage("invalid learning action receipt"))?,
            ),
        ]))
    })
    .transpose()
}

fn action_refused(action: Option<&V>) -> bool {
    action.is_none_or(|a| equals(a, "state", "refused"))
}

fn validate_receipt(receipt: &V, decision: Decision) -> R<()> {
    let object = receipt
        .as_obj()
        .ok_or_else(|| invalid("invalid learning receipt"))?;
    if decision == Decision::Rejected {
        return if object.is_empty() {
            Ok(())
        } else {
            Err(invalid("rejection cannot have an effect receipt"))
        };
    }
    let operation = field(receipt, "operation")?;
    let required = match operation.as_str() {
        "memory.importText.apply" => "runId",
        "memory.propose" => "proposalId",
        "memory.correct" => "id",
        "memory.forget" => "tombstoneId",
        _ => return Err(invalid("unexpected learning effect receipt")),
    };
    let present =
        |text: &str| !text.is_empty() && text.len() <= 256 && !text.chars().any(char::is_control);
    if !present(&field(receipt, required)?)
        || object.entries().iter().any(|(key, val)| {
            !["operation", "runId", "proposalId", "id", "tombstoneId"]
                .iter()
                .any(|k| key.is(k))
                || val.as_js().is_none_or(|v| !present(&v.lossy()))
        })
    {
        return Err(invalid("incomplete learning effect receipt"));
    }
    Ok(())
}

fn ref_identity(reference: &V) -> R<String> {
    let values = ["sessionId", "source", "sourceId"]
        .into_iter()
        .map(|key| field(reference, key).map(|x| V::s(&x)))
        .collect::<R<Vec<_>>>()?;
    Ok(digest(&V::Arr(values)))
}

fn prepare(cx: &Connection, next: &V, id: &str) -> R<Option<V>> {
    let Some(old) = finding_on(cx, id)? else {
        return Ok(Some(next.clone()));
    };
    if !old
        .get("target")
        .zip(next.get("target"))
        .is_some_and(|(a, b)| a.deep_equal(b))
    {
        return Err(denied());
    }
    let revision = number(&old, "revision")?;
    if equals(&old, "status", "accepted")
        || action_on(cx, id, revision)?.is_some_and(|a| equals(&a, "state", "started"))
    {
        return Ok(None);
    }
    let is_withdrawn = equals(&old, "status", "withdrawn");
    let is_rejected = equals(&old, "status", "rejected");
    if is_rejected {
        let previous = evidence(&old)?;
        let latest = previous
            .iter()
            .map(|e| field(e, "day"))
            .collect::<R<Vec<_>>>()?
            .into_iter()
            .max()
            .unwrap_or_default();
        let references = previous
            .iter()
            .map(ref_identity)
            .collect::<R<std::collections::HashSet<_>>>()?;
        let mut new = false;
        for item in evidence(next)? {
            if field(item, "day")? > latest && !references.contains(&ref_identity(item)?) {
                new = true;
                break;
            }
        }
        if !new {
            return Ok(None);
        }
    }
    let result = if is_withdrawn {
        next.clone()
    } else {
        merge_evidence(&old, next).map_err(|_| invalid("cannot merge evidence"))?
    };
    let V::Obj(mut result) = result else {
        return Err(invalid("learning finding must be an object"));
    };
    let new_revision = if is_withdrawn || is_rejected {
        revision + 1
    } else {
        revision
    };
    result.set("revision", V::Num(new_revision as f64));
    if is_rejected {
        let (outcome, at, summary) = cx.query_row(
            "SELECT outcome,decided_at,summary FROM learn_decision
            WHERE finding_id=? AND revision=?",
            params![id, revision],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                ))
            },
        )?;
        let hash = parse(&summary)
            .and_then(|s| s.get("hash").cloned())
            .ok_or_else(|| storage("invalid learning summary"))?;
        result.set(
            "previousDecision",
            V::obj([
                ("revision", V::Num(revision as f64)),
                ("outcome", V::s(&outcome)),
                ("at", V::Num(at as f64)),
                ("hash", hash),
            ]),
        );
    } else if let Some(previous) = old.get("previousDecision").filter(|_| !is_withdrawn) {
        result.set("previousDecision", previous.clone());
    }
    Ok(Some(V::Obj(result)))
}

fn finding_valid(finding: &V, run: &Run) -> R<String> {
    let id = field(finding, "id")?;
    let target = target_value(&run.target).map_err(|_| denied())?;
    let kind = field(finding, "kind")?;
    let expected = match kind.as_str() {
        "knowledge" if run.target.scope != "installation" => "pending",
        "procedural" => "waiting-h3",
        _ => return Err(invalid("invalid learning finding kind")),
    };
    if !equals(finding, "runId", &run.id)
        || !equals(finding, "effectiveTier", "C")
        || !equals(finding, "status", expected)
        || !finding
            .get("target")
            .is_some_and(|value| value.deep_equal(&target))
        || id.len() != 64
        || !id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(denied());
    }
    let owner = derive_user_principal(&run.target.owner).map_err(|_| denied())?;
    let items = evidence(finding)?;
    if items.is_empty()
        || items.iter().any(|v| {
            !equals(v, "owner", &owner)
                || (run.target.scope == "agent" && !equals(v, "agentId", &run.target.agent_id))
        })
    {
        return Err(denied());
    }
    Ok(id)
}

fn read_findings(conn: &Connection, ids: Vec<String>) -> R<Vec<V>> {
    let mut findings = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(finding) = finding_on(conn, &id)? {
            findings.push(finding);
        }
    }
    Ok(findings)
}

impl LearnStore {
    /// Publish a completed shadow window with bounded private payload.
    pub fn publish(
        &self,
        run: &Run,
        findings: &[V],
        at: i64,
        observations: &[Observation],
    ) -> R<Run> {
        if findings.len() > 100 {
            return Err(invalid("too many learning findings"));
        }
        let tx = self.transaction()?;
        let mut live = active_run(&tx, run)?;
        if is_invalidated(&tx, &run.id)? {
            return Err(denied());
        }
        let mut seen = std::collections::HashSet::new();
        let mut count = 0;
        for next in findings {
            let id = finding_valid(next, &live)?;
            if !seen.insert(id.clone()) {
                return Err(invalid("duplicate learning finding"));
            }
            let Some(finding) = prepare(&tx, next, &id)? else {
                continue;
            };
            let payload = finding.stringify();
            if payload.len() > SIZE {
                return Err(invalid("learning finding exceeds private payload bounds"));
            }
            let old = finding_on(&tx, &id)?
                .map(|f| field(&f, "runId"))
                .transpose()?;
            tx.execute("INSERT INTO learn_finding(id,run_id,state,revision) VALUES(?,?,?,?) ON CONFLICT(id)
                DO UPDATE SET run_id=excluded.run_id,state=excluded.state,revision=excluded.revision",
                params![id,live.id,field(&finding,"status")?,finding.get("revision").map_or(Ok(1), |_| number(&finding,"revision"))?])?;
            let key = format!("finding:{id}");
            if let Some(old) = old {
                tx.execute(
                    "DELETE FROM learn_payload WHERE run_id=? AND key=?",
                    params![old, key],
                )?;
            }
            put_payload(&tx, &live.id, &key, &payload)?;
            tx.execute(
                "INSERT OR IGNORE INTO learn_observation VALUES(?,?)",
                params![live.id, id],
            )?;
            count += 1;
        }
        live.findings = count;
        update_metadata(&tx, &live)?;
        let closed = finish_on(&tx, &live, Outcome::Completed, None, at)?;
        predictions::observe(&tx, &closed, observations)?;
        tx.commit()?;
        Ok(closed)
    }

    pub(in crate::dreams::learn) fn prepare_candidate(&self, finding: &V) -> R<Option<V>> {
        prepare(self.db.conn(), finding, &field(finding, "id")?)
    }

    /// Read one current finding from private storage. The caller must prove current scope first.
    pub fn finding(&self, id: &str) -> R<Option<V>> {
        finding_on(self.db.conn(), id)
    }

    /// Discover private findings observed in this run. The caller must authorize the run first.
    pub fn findings(&self, run: &str) -> R<Vec<V>> {
        let conn = self.db.conn();
        let ids = rows(
            conn,
            "SELECT finding_id FROM learn_observation WHERE run_id=? ORDER BY finding_id",
            [run],
            |r| r.get(0),
        )?;
        read_findings(conn, ids)
    }

    /// Read a bounded page of target-scoped findings. The caller must authorize the target first.
    pub fn target_findings(&self, target: &Target, limit: usize, offset: usize) -> R<Vec<V>> {
        if !(1..=100).contains(&limit) || offset > 100_000 {
            return Err(invalid("invalid learning finding page"));
        }
        let conn = self.db.conn();
        let ids = rows(
            conn,
            "SELECT f.id FROM learn_finding f JOIN learn_run r ON r.id=f.run_id
            WHERE r.owner=? AND r.target_hash=? ORDER BY r.window_to DESC,f.id LIMIT ? OFFSET ?",
            params![
                target.owner,
                target_hash(target),
                limit as i64,
                offset as i64
            ],
            |r| r.get(0),
        )?;
        read_findings(conn, ids)
    }

    /// Record dispatch of an explicitly approved action before the effect occurs.
    pub fn start_action(&self, id: &str, reviewer: &str, hash: &str) -> R<()> {
        let tx = self.transaction()?;
        let (_, revision) = pending_finding(&tx, id, reviewer, hash)?;
        if !action_refused(action_on(&tx, id, revision)?.as_ref()) {
            return Err(CollabError::with_reason(
                C::Conflict,
                "learning action awaits reconciliation",
                "action-awaits-reconciliation",
            ));
        }
        tx.execute(
            "INSERT OR REPLACE INTO learn_action VALUES(?,?,'started','{}')",
            params![id, revision],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Record a definitive refusal. An ambiguous effect must remain started.
    pub fn refuse_action(&self, id: &str, reviewer: &str, hash: &str) -> R<()> {
        let tx = self.transaction()?;
        let (_, revision) = pending_finding(&tx, id, reviewer, hash)?;
        let changed = tx.execute(
            "UPDATE learn_action SET state='refused',receipt='{}'
            WHERE finding_id=? AND revision=? AND state='started'",
            params![id, revision],
        )?;
        if changed != 1 {
            return Err(denied());
        }
        tx.commit()?;
        Ok(())
    }

    /// Read an action receipt for the current finding revision.
    pub fn action(&self, id: &str, revision: i64) -> R<Option<V>> {
        action_on(self.db.conn(), id, revision)
    }

    /// Persist an owner decision and, for a confirmed action, its content-free receipt.
    pub fn decide(
        &self,
        id: &str,
        reviewer: &str,
        hash: &str,
        decision: Decision,
        at: i64,
        receipt: &V,
    ) -> R<()> {
        validate_receipt(receipt, decision)?;
        let tx = self.transaction()?;
        let (finding, revision) = pending_finding(&tx, id, reviewer, hash)?;
        let action = action_on(&tx, id, revision)?;
        match decision {
            Decision::Accepted
                if action
                    .as_ref()
                    .is_none_or(|a| !equals(a, "state", "started")) =>
            {
                return Err(denied())
            }
            Decision::Rejected if !action_refused(action.as_ref()) => return Err(denied()),
            _ => {}
        }
        let run = super::find_run(&tx, &field(&finding, "runId")?)?.ok_or_else(denied)?;
        if run.finished_at.is_none_or(|f| at < f) || at > crate::dreams::learn::SAFE_INTEGER {
            return Err(invalid("invalid learning decision time"));
        }
        let serialized = receipt.stringify();
        tx.execute(
            "UPDATE learn_finding SET state=? WHERE id=? AND state='pending' AND revision=?",
            params![decision.as_str(), id, revision],
        )?;
        tx.execute(
            "INSERT INTO learn_decision VALUES(?,?,?,?,?,?,?)",
            params![
                id,
                revision,
                reviewer,
                decision.as_str(),
                at,
                serialized,
                decision_summary(&finding)?.stringify()
            ],
        )?;
        if decision == Decision::Accepted {
            tx.execute("UPDATE learn_action SET state='completed',receipt=? WHERE finding_id=? AND revision=?",
                params![serialized,id,revision])?;
            start_prediction(&tx, &finding, id, revision, at)?;
        }
        tx.commit()?;
        Ok(())
    }

    pub(in crate::dreams::learn) fn handoff_exists(&self, id: &str, hash: &str) -> R<bool> {
        Ok(self.db.conn().query_row(
            "SELECT EXISTS(SELECT 1 FROM learn_handoff WHERE finding_id=? AND hash=?)",
            params![id, hash],
            |row| row.get(0),
        )?)
    }

    pub(in crate::dreams::learn) fn record_handoff(
        &self,
        id: &str,
        hash: &str,
        receipt: &str,
    ) -> R<bool> {
        let tx = self.transaction()?;
        let current = finding_on(&tx, id)?.ok_or_else(denied)?;
        let run = field(&current, "runId")?;
        if is_invalidated(&tx, &run)?
            || !equals(&current, "status", "waiting-h3")
            || digest(&current) != hash
        {
            return Err(denied());
        }
        let inserted = tx.execute(
            "INSERT OR IGNORE INTO learn_handoff VALUES(?,?,?)",
            params![id, hash, receipt],
        )?;
        tx.commit()?;
        Ok(inserted == 1)
    }

    /// Read content-free decision records associated with a run.
    pub fn decisions(&self, run: &str) -> R<Vec<V>> {
        let rows = rows(self.db.conn(),"SELECT d.finding_id,d.outcome,d.receipt FROM learn_decision d
            JOIN learn_finding f ON f.id=d.finding_id WHERE f.run_id=? ORDER BY d.finding_id,d.revision",[run],
            |r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))?;
        rows.into_iter()
            .map(|(id, outcome, receipt)| {
                Ok(V::obj([
                    ("findingId", V::s(&id)),
                    ("outcome", V::s(&outcome)),
                    (
                        "receipt",
                        parse(&receipt).ok_or_else(|| storage("invalid learning receipt"))?,
                    ),
                ]))
            })
            .collect()
    }

    /// Read the latest still-valid decision summaries for a single owner.
    pub fn decided_findings(&self, owner: &str) -> R<Vec<V>> {
        let rows=rows(self.db.conn(),"SELECT d.summary,d.outcome FROM learn_decision d
            JOIN learn_finding f ON f.id=d.finding_id JOIN learn_run r ON r.id=f.run_id
            WHERE r.owner=? AND r.invalidated=0 AND f.state<>'withdrawn' AND d.revision>f.invalid_before AND
            d.revision=(SELECT max(n.revision) FROM learn_decision n WHERE n.finding_id=d.finding_id)
            ORDER BY d.finding_id",[owner],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?;
        rows.into_iter()
            .map(|(summary, outcome)| {
                Ok(V::obj([
                    (
                        "finding",
                        parse(&summary).ok_or_else(|| storage("invalid learning summary"))?,
                    ),
                    ("outcome", V::s(&outcome)),
                ]))
            })
            .collect()
    }
}

pub(super) fn reconcile(conn: &Connection, at: i64, rights: &dyn Reconcile) -> R<()> {
    let prediction_sessions = rows(
        conn,
        "SELECT s.finding_id,s.session_id,r.metadata FROM learn_prediction_session s
        JOIN learn_finding f ON f.id=s.finding_id JOIN learn_run r ON r.id=f.run_id",
        [],
        |r| {
            let metadata: String = r.get(2)?;
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, metadata))
        },
    )?;
    for (id, sid, metadata) in prediction_sessions {
        let run: Run = serde_json::from_str(&metadata)
            .map_err(|_| storage("invalid learning prediction scope"))?;
        if !rights.target(&run.target) || !rights.session(&run.target, &sid) {
            conn.execute(
                "DELETE FROM learn_prediction_session WHERE finding_id=? AND session_id=?",
                params![id, sid],
            )?;
            predictions::invalidate(conn, &id)?;
        }
    }
    let ids = rows(conn, "SELECT id FROM learn_finding", [], |r| r.get(0))?;
    for finding in read_findings(conn, ids)? {
        let id = field(&finding, "id")?;
        let run_id = field(&finding, "runId")?;
        let run = conn.query_row(
            "SELECT metadata FROM learn_run WHERE id=?",
            [&run_id],
            decode,
        )?;
        let previous = evidence(&finding)?;
        let mut remaining = Vec::new();
        let authorized = rights.target(&run.target) && !is_invalidated(conn, &run_id)?;
        if authorized {
            for item in previous {
                let sid = field(item, "sessionId")?;
                if rights.session(&run.target, &sid) && rights.evidence(&run.target, item) {
                    remaining.push(item.clone());
                }
            }
        }
        let withdraw = !authorized || remaining.len() != previous.len() || remaining.is_empty();
        let decided: Option<i64> = conn.query_row(
            "SELECT max(decided_at) FROM learn_decision WHERE finding_id=?",
            [&id],
            |r| r.get(0),
        )?;
        let expired = decided.is_some_and(|t| t <= at.saturating_sub(30 * DAY));
        let has_payload = !equals(&finding, "text", "") || finding.get("checks").is_some();
        if !(withdraw
            && (!equals(&finding, "status", "withdrawn")
                || remaining.len() != previous.len()
                || has_payload)
            || expired && has_payload)
        {
            continue;
        }
        let old_key = field(&finding, "contentKey").unwrap_or_default();
        let V::Obj(mut clean) = finding else {
            return Err(storage("invalid learning finding"));
        };
        clean.set("text", V::s(""));
        clean.remove("checks");
        clean.remove("previousDecision");
        if withdraw {
            clean.set("status", V::s("withdrawn"));
            clean.set("contentKey", V::s(&digest(&V::s(&old_key))));
            clean.set("evidence", V::Arr(remaining));
            clean.remove("toolPattern");
            conn.execute(
                "DELETE FROM learn_prediction_session WHERE finding_id=?",
                [&id],
            )?;
            predictions::invalidate(conn, &id)?;
            conn.execute(
                "UPDATE learn_finding SET state='withdrawn',invalid_before=revision WHERE id=?",
                [&id],
            )?;
        }
        put_payload(
            conn,
            &run_id,
            &format!("finding:{id}"),
            &V::Obj(clean).stringify(),
        )?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "store_finding_vectors.rs"]
mod vectors;
