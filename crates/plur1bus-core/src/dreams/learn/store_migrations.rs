use plur1bus_store::rusqlite::{
    params, Connection, OptionalExtension, Transaction, TransactionBehavior,
};
use plur1bus_store::StoreError;

use super::{read_payload_on, rows, CollabError, C, R};
use crate::dreams::learn::{aggregation::content_key, digest};
use crate::toolcall::json::V;

const DDL: &[&str] = &[
    include_str!("store-v1.sql"),
    include_str!("store-v2.sql"),
    include_str!("store-v3.sql"),
    include_str!("store-v4.sql"),
    include_str!("store-v5.sql"),
    include_str!("store-v6.sql"),
    include_str!("store-v7.sql"),
];

pub(super) const VERSION: u32 = 7;
const PREDICTION_DELAY: i64 = 14 * 86_400_000;

pub(super) fn apply(cx: &Connection) -> R<()> {
    loop {
        let tx = Transaction::new_unchecked(cx, TransactionBehavior::Immediate)?;
        let version: u32 = tx.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version > VERSION {
            return Err(StoreError::NewerSchema {
                store: "learn",
                found: version,
                supported: VERSION,
            }
            .into());
        }
        let Some(sql) = DDL.get(version as usize) else {
            tx.commit()?;
            return Ok(());
        };
        let next = version + 1;
        tx.execute_batch(sql)?;
        match next {
            3 => old_decisions(&tx)?,
            7 => accepted_predictions(&tx)?,
            _ => {}
        }
        tx.pragma_update(None, "user_version", next)?;
        tx.commit()?;
    }
}

pub(super) fn finding_on(cx: &Connection, id: &str) -> R<Option<V>> {
    let header = cx
        .query_row(
            "SELECT run_id,state,revision FROM learn_finding WHERE id=?",
            [id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            },
        )
        .optional()?;
    let Some((run, state, revision)) = header else {
        return Ok(None);
    };
    let Some(V::Obj(mut body)) = read_payload_on(cx, &run, &format!("finding:{id}"))? else {
        return Ok(None);
    };
    body.set("status", V::s(&state));
    body.set("revision", V::Num(revision as f64));
    Ok(Some(V::Obj(body)))
}

pub(super) fn decision_summary(finding: &V) -> R<V> {
    let mut summary = Vec::new();
    for key in [
        "id",
        "target",
        "kind",
        "desiredTier",
        "promptVersion",
        "models",
    ] {
        let value = finding
            .get(key)
            .ok_or_else(|| CollabError::new(C::Storage, "invalid learning finding"))?;
        summary.push((key.into(), value.clone()));
    }
    summary.push((
        "modelClasses".into(),
        finding
            .get("modelClasses")
            .cloned()
            .unwrap_or(V::Arr(Vec::new())),
    ));
    summary.push(("hash".into(), V::s(&digest(finding))));
    Ok(V::Obj(crate::toolcall::json::Obj::from_pairs(summary)))
}

fn old_decisions(cx: &Connection) -> R<()> {
    let old = rows(
        cx,
        "SELECT finding_id,reviewer,outcome,decided_at,receipt FROM old_decision",
        [],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, String>(4)?,
            ))
        },
    )?;
    for (id, reviewer, outcome, decided_at, receipt) in old {
        let finding = finding_on(cx, &id)?
            .ok_or_else(|| CollabError::new(C::Storage, "missing legacy learning finding"))?;
        cx.execute(
            "INSERT INTO learn_decision VALUES(?,?,?,?,?,?,?)",
            params![
                id,
                1,
                reviewer,
                outcome,
                decided_at,
                receipt,
                decision_summary(&finding)?.stringify()
            ],
        )?;
    }
    cx.execute_batch("DROP TABLE old_decision;")?;
    Ok(())
}

pub(super) fn start_prediction(
    cx: &Connection,
    finding: &V,
    id: &str,
    revision: i64,
    at: i64,
) -> R<()> {
    if finding
        .get("kind")
        .is_some_and(|kind| kind.is_str("knowledge"))
    {
        let signal = digest(&V::s(&content_key(finding).map_err(|_| {
            CollabError::new(C::Storage, "invalid legacy learning finding")
        })?));
        cx.execute(
            "INSERT OR IGNORE INTO learn_prediction VALUES(?,?,?,?,?,?,?)",
            params![
                id,
                revision,
                at,
                at.saturating_add(PREDICTION_DELAY),
                signal,
                "insufficient-data",
                Option::<i64>::None
            ],
        )?;
    }
    Ok(())
}

fn accepted_predictions(cx: &Connection) -> R<()> {
    let accepted = rows(cx, "SELECT d.finding_id,d.revision,d.decided_at FROM learn_decision d
        JOIN learn_finding f ON f.id=d.finding_id WHERE f.state='accepted' AND f.revision=d.revision", [], |r|
        Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,i64>(2)?)))?;
    for (id, revision, at) in accepted {
        if let Some(finding) = finding_on(cx, &id)? {
            start_prediction(cx, &finding, &id, revision, at)?;
        }
    }
    Ok(())
}
