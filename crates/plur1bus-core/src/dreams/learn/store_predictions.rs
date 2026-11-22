use super::super::{invalid, rows, storage, LearnStore, Outcome, Run, R};
use super::{field, number, Observation};
use crate::js::sort_default;
use crate::toolcall::json::{parse, V};
use plur1bus_store::rusqlite::{params, Connection, OptionalExtension};

struct Prediction {
    accepted_at: i64,
    not_before: i64,
    signal_hash: String,
    status: String,
}

fn counts(conn: &Connection, id: &str, revision: i64) -> R<(i64, i64)> {
    Ok(conn.query_row(
        "SELECT count(*),coalesce(sum(recurred),0) FROM learn_prediction_session
        WHERE finding_id=? AND revision=?",
        params![id, revision],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?)
}

impl LearnStore {
    /// Read the current revision's prediction state.
    pub fn prediction(&self, id: &str) -> R<Option<V>> {
        let Some(finding) = self.finding(id)? else {
            return Ok(None);
        };
        let revision = number(&finding, "revision")?;
        let conn = self.db.conn();
        let prediction=conn.query_row(
            "SELECT accepted_at,not_before,signal_hash,status FROM learn_prediction WHERE finding_id=? AND revision=?",
            params![id,revision],|row|Ok(Prediction{
                accepted_at:row.get(0)?,not_before:row.get(1)?,signal_hash:row.get(2)?,status:row.get(3)?,
            })).optional()?;
        let Some(p) = prediction else { return Ok(None) };
        let (sessions, recurrences) = counts(conn, id, revision)?;
        Ok(Some(V::obj([
            ("direction", V::s("rarer")),
            ("signalHash", V::s(&p.signal_hash)),
            ("acceptedAt", V::Num(p.accepted_at as f64)),
            ("notBefore", V::Num(p.not_before as f64)),
            ("sessions", V::Num(sessions as f64)),
            ("recurrences", V::Num(recurrences as f64)),
            ("status", V::s(&p.status)),
            ("retireProposed", V::Bool(p.status == "not-confirmed")),
        ])))
    }

    /// Summarize current accepted forecasts for the selected model classes without content.
    pub fn prediction_summary(&self, owner: &str, classes: &[String]) -> R<V> {
        let mut model_classes = classes.to_vec();
        sort_default(&mut model_classes);
        let classes = V::strs(&model_classes);
        let mut confirmed = 0_u64;
        let mut not_confirmed = 0_u64;
        let mut insufficient = 0_u64;
        let this=rows(self.db.conn(),"SELECT p.status,d.summary FROM learn_prediction p JOIN learn_finding f ON f.id=p.finding_id
            JOIN learn_decision d ON d.finding_id=p.finding_id AND d.revision=p.revision JOIN learn_run r ON r.id=f.run_id
            WHERE r.owner=? AND r.invalidated=0 AND f.state='accepted' AND f.revision=p.revision",[owner],
            |r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?;
        for (status, body) in this {
            let summary =
                parse(&body).ok_or_else(|| storage("invalid learning prediction summary"))?;
            if field(&summary, "promptVersion")? != super::super::PROMPT_VERSION {
                continue;
            }
            let mut row_classes = summary
                .get("modelClasses")
                .and_then(V::as_arr)
                .unwrap_or(&[])
                .iter()
                .filter_map(|v| v.as_js().map(|s| s.lossy()))
                .collect::<Vec<_>>();
            sort_default(&mut row_classes);
            if !classes.deep_equal(&V::strs(&row_classes)) {
                continue;
            }
            match status.as_str() {
                "confirmed" => confirmed += 1,
                "not-confirmed" => not_confirmed += 1,
                _ => insufficient += 1,
            }
        }
        let decided = confirmed + not_confirmed;
        let rate = if decided == 0 {
            V::Null
        } else {
            V::Num(confirmed as f64 / decided as f64)
        };
        Ok(V::obj([
            ("confirmed", V::Num(confirmed as f64)),
            ("notConfirmed", V::Num(not_confirmed as f64)),
            ("insufficientData", V::Num(insufficient as f64)),
            ("confirmationRate", rate),
        ]))
    }
}

pub(super) fn observe(conn: &Connection, run: &Run, observations: &[Observation]) -> R<()> {
    if run.outcome != Some(Outcome::Completed)
        || run.truncated == Some(true)
        || observations.is_empty()
    {
        return Ok(());
    }
    if observations.len() > crate::dreams::learn::SESSIONS
        || observations.iter().any(|o| {
            !run.session_ids.contains(&o.session_id)
                || o.at < 0
                || o.at >= run.window.to
                || o.signals.len() > 10_000
                || o.signals.iter().any(|s| s.at < 0 || s.at > o.at)
        })
    {
        return Err(invalid("invalid learning observation"));
    }
    let pending=rows(conn,"SELECT p.finding_id,p.revision,p.accepted_at,p.not_before FROM learn_prediction p
        JOIN learn_finding f ON f.id=p.finding_id JOIN learn_run r ON r.id=f.run_id
        WHERE r.target_hash=(SELECT target_hash FROM learn_run WHERE id=?)
        AND r.invalidated=0 AND f.state='accepted' AND f.revision=p.revision AND p.closed_at IS NULL",[&run.id],
        |r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,i64>(2)?,r.get::<_,i64>(3)?)))?;
    for (id, revision, accepted, not_before) in pending {
        if run.window.to <= accepted {
            continue;
        }
        for observation in observations.iter().filter(|o| o.at > accepted) {
            let recurred = observation
                .signals
                .iter()
                .any(|s| s.finding_id == id && s.at > accepted);
            conn.execute("INSERT INTO learn_prediction_session VALUES(?,?,?,?,?) ON CONFLICT(finding_id,revision,session_id)
                DO UPDATE SET at=max(at,excluded.at),recurred=max(recurred,excluded.recurred)",
                params![id,revision,observation.session_id,observation.at,recurred])?;
        }
        conn.execute(
            "INSERT OR IGNORE INTO learn_prediction_coverage VALUES(?,?,?,?)",
            params![id, revision, accepted.max(run.window.from), run.window.to],
        )?;
        let intervals=rows(conn,"SELECT start,end FROM learn_prediction_coverage WHERE finding_id=? AND revision=? ORDER BY start,end",
            params![id,revision],|row|Ok((row.get::<_,i64>(0)?,row.get::<_,i64>(1)?)))?;
        let mut covered = accepted;
        for (start, end) in intervals {
            if start > covered {
                break;
            }
            covered = covered.max(end);
        }
        let (sessions, recurrences) = counts(conn, &id, revision)?;
        if sessions >= 10 && covered >= not_before {
            let status = if recurrences > 0 {
                "not-confirmed"
            } else {
                "confirmed"
            };
            conn.execute("UPDATE learn_prediction SET status=?,closed_at=? WHERE finding_id=? AND revision=?",
                params![status,covered,id,revision])?;
        }
    }
    Ok(())
}

pub(super) fn invalidate(conn: &Connection, id: &str) -> R<()> {
    conn.execute(
        "DELETE FROM learn_prediction_coverage WHERE finding_id=?",
        [id],
    )?;
    conn.execute(
        "UPDATE learn_prediction SET status='insufficient-data',closed_at=NULL WHERE finding_id=?",
        [id],
    )?;
    Ok(())
}
