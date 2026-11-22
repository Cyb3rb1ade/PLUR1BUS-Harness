use super::{
    active_run, checkpoint_key, denied, find_run, invalid, is_invalidated, put_payload,
    target_hash, update_metadata, CollabError, LearnStore, Outcome, Run, C, R, SIZE,
};
use crate::dreams::learn::{Error, SAFE_INTEGER};
use crate::toolcall::json::V;
use plur1bus_store::rusqlite::{params, Connection};

const CLAIM: &str = "runner:claim";

pub(in crate::dreams::learn) struct BudgetHold {
    key: String,
    reserved: i64,
    cap: i64,
}

fn attached_error(e: Error) -> CollabError {
    let code = if matches!(e, Error::Rights) {
        C::Unauthorized
    } else {
        C::Invalid
    };
    CollabError::with_reason(code, "learning attempt was refused", e.as_str())
}

fn active_attempt(conn: &Connection, run: &Run, attempt: &str) -> R<Run> {
    let live = active_run(conn, run)?;
    let held: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM learn_step WHERE run_id=? AND step=? AND state=?)",
        params![run.id, CLAIM, attempt],
        |r| r.get(0),
    )?;
    if !held || is_invalidated(conn, &run.id)? {
        return Err(denied());
    }
    Ok(live)
}

impl LearnStore {
    /// Recover owner-attempt locks after exclusive startup, preserving model reservations and checkpoints.
    pub fn recover_attempts(&self) -> R<usize> {
        Ok(self
            .db
            .conn()
            .execute("DELETE FROM learn_step WHERE step=?", [CLAIM])?)
    }

    pub(in crate::dreams::learn) fn claim_attempt(&self, id: &str, attempt: &str) -> R<Run> {
        if attempt.is_empty() || attempt.len() > 128 || attempt.chars().any(char::is_control) {
            return Err(invalid("invalid learning attempt identity"));
        }
        let tx = self.transaction()?;
        let mut run = find_run(&tx, id)?
            .ok_or_else(|| CollabError::new(C::NotFound, "learning run is missing"))?;
        if is_invalidated(&tx, id)? || run.outcome == Some(Outcome::Completed) {
            return Err(denied());
        }
        let busy: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM learn_step s JOIN learn_run r ON r.id=s.run_id
            WHERE r.target_hash=? AND s.step=?)",
            params![target_hash(&run.target), CLAIM],
            |r| r.get(0),
        )?;
        if busy {
            return Err(CollabError::with_reason(
                C::Conflict,
                "learning target already running",
                "already-running",
            ));
        }
        tx.execute(
            "INSERT INTO learn_step VALUES(?,?,?)",
            params![id, CLAIM, attempt],
        )?;
        run.outcome = None;
        run.reason = None;
        run.finished_at = None;
        update_metadata(&tx, &run)?;
        tx.commit()?;
        Ok(run)
    }

    pub(in crate::dreams::learn) fn release_attempt(&self, id: &str, token: &str) -> R<()> {
        self.db.conn().execute(
            "DELETE FROM learn_step WHERE run_id=? AND step=? AND state=?",
            params![id, CLAIM, token],
        )?;
        Ok(())
    }

    pub(in crate::dreams::learn) fn reserve_model(
        &self,
        run: &mut Run,
        token: &str,
        key: &str,
        amount: i64,
        cap: i64,
    ) -> R<BudgetHold> {
        if !checkpoint_key(key) || amount <= 0 || cap < 0 {
            return Err(invalid("invalid model reservation"));
        }
        let tx = self.transaction()?;
        let mut live = active_attempt(&tx, run, token)?;
        let after = live
            .tokens
            .checked_add(amount)
            .filter(|n| *n <= cap)
            .ok_or_else(|| attached_error(Error::Budget))?;
        live.tokens = after;
        update_metadata(&tx, &live)?;
        tx.execute("INSERT INTO learn_step VALUES(?,?,'started') ON CONFLICT(run_id,step) DO UPDATE SET state='started'",
            params![run.id,key])?;
        tx.commit()?;
        *run = live;
        Ok(BudgetHold {
            key: key.into(),
            reserved: amount,
            cap,
        })
    }

    pub(in crate::dreams::learn) fn settle_model(
        &self,
        run: &mut Run,
        token: &str,
        hold: BudgetHold,
        used: i64,
        value: &V,
    ) -> R<()> {
        let BudgetHold { key, reserved, cap } = hold;
        let text = value.stringify();
        if !(0..=SAFE_INTEGER).contains(&used) || text.len() > SIZE {
            return Err(attached_error(Error::ProviderFailed));
        }
        let tx = self.transaction()?;
        let mut live = active_attempt(&tx, run, token)?;
        let started: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM learn_step WHERE run_id=? AND step=? AND state='started')",
            params![run.id, key],
            |r| r.get(0),
        )?;
        if !started {
            return Err(denied());
        }
        live.tokens = live
            .tokens
            .checked_sub(reserved)
            .and_then(|n| n.checked_add(used))
            .filter(|n| (0..=SAFE_INTEGER).contains(n))
            .ok_or_else(|| attached_error(Error::ProviderFailed))?;
        update_metadata(&tx, &live)?;
        let accepted = live.tokens <= cap;
        if accepted {
            put_payload(&tx, &run.id, &key, &text)?;
            tx.execute(
                "UPDATE learn_step SET state='completed' WHERE run_id=? AND step=?",
                params![run.id, key],
            )?;
        }
        tx.commit()?;
        *run = live;
        if !accepted {
            return Err(attached_error(Error::Budget));
        }
        Ok(())
    }
}
