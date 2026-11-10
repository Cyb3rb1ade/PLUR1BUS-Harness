//! Primary capture work precedes optional Neo queue maintenance on every exit path.
use super::super::accept::RecoverySteps;
use super::super::admission::{
    expired, row_digest, scope_of, Admission, Assessment, Begin, Entry, Phase, Record,
};
use super::super::failure::{self, FailureClass, MAX_RECOVERY_ATTEMPTS};
use super::super::queue::QueueMeta;
use super::super::replay_guard::turn_key_of;
use super::super::shared_scope::PolicyDecision;
use super::*;
use std::time::{Duration, Instant};

fn maintenance() -> EngineError {
    EngineError::NotAvailable {
        reason: "workspace-maintenance".into(),
    }
}
fn is_maintenance(error: &EngineError) -> bool {
    matches!(error, EngineError::NotAvailable { reason } if reason == "workspace-maintenance")
}
impl CaptureWorker for CapturePipeline {
    fn inventory(&self, cancel: &Cancel) -> Result<(), EngineError> {
        // Directory entries only (RE-D162): which owner scopes retain a record, and what
        // nobody owns. No host is asked, no file is read, no lease is taken.
        let inventory = self.admissions.inventory(cancel)?;
        self.foreign
            .store(inventory.foreign, std::sync::atomic::Ordering::Release);
        if inventory.foreign > 0 {
            self.warn(
                &StoreError::Corrupt.into(),
                CaptureLogStage::CapturePipeline,
                inventory.foreign as u64,
            );
        }
        self.retained.replace(inventory.scopes);
        match &self.neo {
            Some(neo) => neo.inventory(cancel),
            None => Ok(()),
        }
    }

    fn has_retained(&self) -> bool {
        self.retained.waiting() || self.neo.as_ref().is_some_and(|neo| neo.has_retained())
    }

    fn recover_retained(self: Arc<Self>, steps: &RecoverySteps) {
        self.pass(steps, false);
        if let Some(neo) = &self.neo {
            neo.recover_retained(&steps.bounds());
        }
    }

    fn expire_retained(self: Arc<Self>, steps: &RecoverySteps) {
        self.pass(steps, true);
    }

    fn recover_owner(
        self: Arc<Self>,
        steps: &RecoverySteps,
        turn: &TurnRecord,
        context: &RequestContext,
        cancel: &Cancel,
    ) {
        // Only this caller's own scope: join the attempt in flight or start the one attempt,
        // and wait for it at most as long as the scope's own budget and the turn's own
        // cancellation allow. Whatever comes of it, the turn goes on.
        if let Ok(scope) = scope_of(context.agent_id.as_str(), &context.owner_user_id) {
            if self.retained.concerns(&scope) {
                self.start_scope(steps, &scope, false);
                let wait = cancel.limited_to(Instant::now() + self.scope_budget());
                self.retained.join(&scope, &wait, &steps.shutdown);
            }
        }
        if let Some(neo) = &self.neo {
            neo.recover_owner(turn, context, cancel, &steps.bounds());
        }
    }

    fn close_retained(&self, budget: Duration) -> bool {
        let started = Instant::now();
        self.retained.close();
        let neo = self
            .neo
            .as_ref()
            .is_none_or(|neo| neo.close_retained(budget));
        self.retained
            .drained(budget.saturating_sub(started.elapsed()))
            && neo
    }

    fn capture(
        &self,
        turn: &TurnRecord,
        context: &RequestContext,
        options: &CaptureOptions,
        replay: ReplayRows,
        cancel: &Cancel,
    ) -> Result<CaptureResult, EngineError> {
        self.capture_attempt(turn, context, options, &replay, cancel, false)
    }
}

/// How long the pass waits beyond a scope's budget for its attempt to return. An attempt
/// that is still not back (a host call that ignores cancellation) keeps its own key busy;
/// the pass goes on to the next owner.
const ATTEMPT_GRACE: Duration = Duration::from_secs(1);

impl CapturePipeline {
    fn mark_pending(&self, scope: &str) {
        self.retained.mark(scope);
    }

    /// One owner scope's recovery budget: a turn's capture budget.
    fn scope_budget(&self) -> Duration {
        Duration::from_millis(
            super::super::queue::RuntimeConfig::from_value(&self.config["runtime"])
                .capture_timeout_ms,
        )
    }

    /// One pass over the waiting scopes, one after the other. The pass itself only waits:
    /// each scope's attempt runs on its own thread, under its own budget.
    fn pass(self: &Arc<Self>, steps: &RecoverySteps, expire_only: bool) {
        for scope in self.retained.keys() {
            if steps.shutdown.is_cancelled() {
                return;
            }
            if self.start_scope(steps, &scope, expire_only) {
                let patience = Instant::now() + self.scope_budget() + ATTEMPT_GRACE;
                let patience = steps.shutdown.limited_to(patience);
                self.retained.join(&scope, &patience, &steps.shutdown);
            }
        }
    }

    /// Start the one attempt for a waiting scope; true when one is in flight afterwards.
    fn start_scope(
        self: &Arc<Self>,
        steps: &RecoverySteps,
        scope: &str,
        expire_only: bool,
    ) -> bool {
        let (this, steps, key) = (self.clone(), steps.clone(), scope.to_owned());
        self.retained.start(scope, "capture-recovery", move || {
            this.recover_scope(&steps, &key, expire_only)
        })
    }

    /// Recover one owner scope's records under that scope's own budget; true when nothing
    /// of the scope is left. Running out of the budget, a transient failure or shutdown
    /// leave the scope waiting for the next attempt; every attempt made was counted.
    fn recover_scope(
        self: &Arc<Self>,
        steps: &RecoverySteps,
        scope: &str,
        expire_only: bool,
    ) -> bool {
        let budget = steps
            .shutdown
            .limited_to(Instant::now() + self.scope_budget());
        let (entries, more) = match self.admissions.entries(scope, &budget) {
            Ok(entries) => entries,
            Err(error) => {
                self.deferred(steps, &error);
                return false;
            }
        };
        // Records beyond the per-scope bound wait for a later attempt.
        let mut clean = !more;
        // RE-D162: retained input older than seven days is discarded, never resumed.
        let now = self.host.now_ms();
        for entry in entries {
            match entry {
                Entry::Record(record) => {
                    let outcome = if expired(record.at_ms, now) {
                        self.close_terminally(steps, &record, "recovery-expired", &budget)
                    } else if expire_only {
                        Ok(false)
                    } else {
                        self.recover_one(steps, &record, &budget)
                    };
                    match outcome {
                        Ok(done) => clean &= done,
                        Err(error) => {
                            self.deferred(steps, &error);
                            return false;
                        }
                    }
                }
                Entry::Unreadable { name, modified_ms } => {
                    let removed = modified_ms.is_some_and(|at| expired(at, now))
                        && match self.admissions.remove_unreadable(scope, &name, &budget) {
                            Ok(()) => true,
                            Err(error @ EngineError::Cancelled(_)) => {
                                self.deferred(steps, &error);
                                return false;
                            }
                            Err(_) => false,
                        };
                    if !removed {
                        // This owner's own scope stays deferred and reported (m5); nobody
                        // else is affected.
                        if !expire_only {
                            self.warn(
                                &StoreError::Corrupt.into(),
                                CaptureLogStage::CapturePipeline,
                                1,
                            );
                        }
                        clean = false;
                    }
                }
            }
        }
        clean
    }

    /// A scope stays waiting after its budget, a cancellation or an inventory error.
    fn deferred(&self, steps: &RecoverySteps, error: &EngineError) {
        if !steps.shutdown.is_cancelled() {
            self.warn(error, CaptureLogStage::CapturePipeline, 1);
        }
    }

    /// Recover one retained record; true when it is finished or closed, false when it stays
    /// for a later attempt. The attempt is counted durably before anything else runs
    /// (RE-D159), so every failure counts; only maintenance gives it back. Only
    /// cancellation (the scope's budget or shutdown) is an error.
    fn recover_one(
        self: &Arc<Self>,
        steps: &RecoverySteps,
        record: &Record,
        cancel: &Cancel,
    ) -> Result<bool, EngineError> {
        let made = match self.admissions.note_attempt(record, cancel) {
            Ok(None) => return Ok(true),
            Ok(Some(made)) => made,
            Err(error @ EngineError::Cancelled(_)) => return Err(error),
            Err(error) => {
                self.warn(&error, CaptureLogStage::CapturePipeline, 1);
                return Ok(false);
            }
        };
        let outcome = (|| -> Result<Option<&'static str>, EngineError> {
            if made >= MAX_RECOVERY_ATTEMPTS {
                return Ok(Some("recovery-exhausted"));
            }
            let assessment = self.asked(steps, record, cancel, |this, record, cancel| {
                this.admissions.assess(record, cancel)
            })?;
            match assessment {
                Assessment::Ready => {}
                Assessment::Maintenance => return Err(maintenance()),
                Assessment::Revoked => return Ok(Some("workspace-policy-disabled")),
                Assessment::ConfigChanged => return Ok(Some("config-changed")),
                Assessment::WorkspaceChanged => return Ok(Some("workspace-identity-changed")),
                Assessment::CallerChanged => return Ok(Some("caller-changed")),
            }
            self.recover_record(steps, record, cancel)?;
            Ok(None)
        })();
        let reason = match outcome {
            Ok(None) => return Ok(true),
            Ok(Some(reason)) => reason,
            Err(error) => match failure::classify(&error) {
                FailureClass::Transient => {
                    if let EngineError::Cancelled(cancelled) = error {
                        return Err(EngineError::Cancelled(cancelled));
                    }
                    if is_maintenance(&error) {
                        // Maintenance is no attempt: give the counted one back.
                        let _ = self.admissions.revert_attempt(record, cancel);
                    } else {
                        self.warn(&error, CaptureLogStage::CapturePipeline, 1);
                    }
                    return Ok(false);
                }
                FailureClass::Terminal(reason) => reason,
            },
        };
        self.close_terminally(steps, record, reason, cancel)
    }

    /// Ask the host for a retained record on a thread of its own (RE-D163): within the
    /// scope's budget and the agent's places for outstanding host lookups. An answer that
    /// never comes ends this attempt with its budget; the attempt was counted and its
    /// scope waits again, so no key stays in flight behind a host.
    fn asked<T: Send + 'static>(
        self: &Arc<Self>,
        steps: &RecoverySteps,
        record: &Record,
        cancel: &Cancel,
        call: impl FnOnce(&Self, &Record, &Cancel) -> Result<T, EngineError> + Send + 'static,
    ) -> Result<T, EngineError> {
        let (this, owned, budget) = (self.clone(), record.clone(), cancel.clone());
        let answer = steps.bounds().host_call(
            record.turn.agent_id.as_str(),
            // The lookup is part of the attempt and carries its thread name.
            "capture-recovery",
            cancel,
            self.scope_budget(),
            move || call(&this, &owned, &budget),
        );
        match answer {
            Some(answer) => answer,
            None => {
                cancel.check()?;
                Err(crate::contract::HostError::Unavailable.into())
            }
        }
    }

    /// Discard a retained record with a fixed reason; rows already written stay, as at the
    /// pin. True when the record is gone, false when not even the discard succeeded.
    fn close_terminally(
        &self,
        steps: &RecoverySteps,
        record: &Record,
        reason: &'static str,
        cancel: &Cancel,
    ) -> Result<bool, EngineError> {
        self.warn(
            &EngineError::NotAvailable {
                reason: reason.into(),
            },
            CaptureLogStage::CapturePipeline,
            1,
        );
        if reason == "workspace-policy-disabled" && record.phase == Phase::Primary {
            // Revocation also releases the replay entry of the unfinished turn (as the pin's
            // onRowsKept): no row is deleted, and only when every pending ID is this record's.
            let key = turn_key_of(&record.turn)?;
            let released =
                steps
                    .replay
                    .recover(record.turn.agent_id.as_str(), &key, cancel, |rows| {
                        let stale = rows.stale_row_ids();
                        if !stale.is_empty()
                            && !rows.primary_settled()?
                            && stale.iter().all(|id| record.rows.contains_key(id))
                        {
                            rows.on_rows_kept()?;
                        }
                        Ok(())
                    });
            match released {
                Ok(()) => {}
                Err(error @ EngineError::Cancelled(_)) => return Err(error),
                // The entry stays; it holds no content and expires after seven days.
                Err(error) => self.warn(&error, CaptureLogStage::CapturePipeline, 1),
            }
        }
        match self.admissions.abandon_record(record, cancel) {
            Ok(()) => Ok(true),
            Err(error @ EngineError::Cancelled(_)) => Err(error),
            Err(error) => {
                // Not even the discard succeeded: keep it for the next attempt.
                self.warn(&error, CaptureLogStage::CapturePipeline, 1);
                Ok(false)
            }
        }
    }

    /// The row work of one retained record: one job in its agent's capture queue, exactly
    /// as a turn's (RE-D162). Until the job has its slot nothing of the agent is held; in
    /// the job the scope and turn leases are only tried, never waited for. Another owner's
    /// turn of the same agent therefore waits for this one record as it would for one
    /// running turn of this owner, which is the pin's order per agent.
    fn recover_record(
        self: &Arc<Self>,
        steps: &RecoverySteps,
        record: &Record,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        let turn = &record.turn;
        let context = self.asked(steps, record, cancel, |this, record, _| {
            let turn = &record.turn;
            RequestContext::build(&turn.principal, &turn.agent, this.host.as_ref())
        })?;
        let key = turn_key_of(turn)?;
        let (this, replay, record) = (self.clone(), steps.replay.clone(), record.clone());
        let agent = turn.agent_id.to_string();
        let receipt = steps.queue.enqueue(
            &agent,
            QueueMeta {
                cancel: cancel.clone(),
                ..QueueMeta::default()
            },
            Box::new(move |effective| {
                let turn = &record.turn;
                replay.recover(turn.agent_id.as_str(), &key, &effective, |rows| {
                    if !this.admissions.pending(&record, &effective)? {
                        return Ok(());
                    }
                    let result = this.capture_attempt(
                        turn,
                        &context,
                        &record.options,
                        &rows,
                        &effective,
                        true,
                    )?;
                    if this.admissions.pending(&record, &effective)? {
                        return Err(StoreError::Unavailable.into());
                    }
                    if result.reason.is_none() {
                        rows.on_rows_settled()?;
                    }
                    Ok(())
                })?;
                Ok(counts(0, 0, None))
            }),
        );
        loop {
            match receipt.recv_timeout(Duration::from_millis(20)) {
                Ok(outcome) if outcome.ok => return Ok(()),
                Ok(outcome) => {
                    return Err(match outcome.error {
                        Some(error) => error,
                        // The job's own budget ran out, or the scope's did before it ran.
                        None if outcome.timed_out || outcome.aborted => {
                            EngineError::Cancelled(crate::contract::Cancelled {
                                reason: crate::contract::CancelReason::Deadline,
                            })
                        }
                        // Refused by the queue (closing, full or under pressure): later.
                        None => StoreError::Busy.into(),
                    });
                }
                // Past the scope's budget while the job still waits for its slot: the job
                // then starts cancelled and does nothing.
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => cancel.check()?,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(StoreError::Unavailable.into())
                }
            }
        }
    }

    fn capture_attempt(
        &self,
        turn: &TurnRecord,
        context: &RequestContext,
        options: &CaptureOptions,
        replay: &ReplayRows,
        cancel: &Cancel,
        recovery: bool,
    ) -> Result<CaptureResult, EngineError> {
        let started = Instant::now();
        let mut neo_started = false;
        match self.policy.decision(context) {
            Ok(PolicyDecision::Allowed) => {}
            // A recovery attempt reports why it could not run, so it is kept or closed.
            Ok(PolicyDecision::Maintenance) if recovery => return Err(maintenance()),
            Ok(PolicyDecision::Revoked) if recovery => {
                return Err(EngineError::NotAvailable {
                    reason: "workspace-policy-disabled".into(),
                })
            }
            Err(error) if recovery => return Err(error),
            _ => return Ok(counts(0, 1, Some("not_captured"))),
        }
        cancel.check()?;
        let mode = Begin {
            inherits_rows: !replay.stale_row_ids().is_empty(),
            recovery,
        };
        let mut admission = self
            .admissions
            .begin(turn, context, options, cancel, mode)?;
        let result = if admission.record.phase == Phase::PostStore {
            self.finish_post(turn, context, options, replay, &mut admission, cancel)
        } else if replay.primary_settled()? {
            Err(StoreError::Corrupt.into())
        } else {
            self.capture_inner(
                turn,
                context,
                replay,
                cancel,
                &mut neo_started,
                &mut admission,
            )
        };
        // A cleanup that fails never replaces the turn's own result (m8): the record then
        // stays and is closed by its owner's next recovery.
        let abandon = |admission: &Admission<'_>| {
            if let Err(error) = admission.abandon() {
                self.warn(&error, CaptureLogStage::CapturePipeline, 1);
            }
        };
        // Once an ordinary invocation observes abort/timeout, do not resurrect it on open.
        // A recovery attempt's own bounded deadline instead leaves the work for a retry.
        if !recovery && (cancel.is_cancelled() || turn.cancel.is_cancelled()) {
            abandon(&admission);
        }
        // RE-D156: a terminal failure closes the record; only listed transient ones keep it.
        let result = match result {
            Ok(result) => Ok(result),
            Err(error) => match failure::classify(&error) {
                FailureClass::Transient => Err(error),
                FailureClass::Terminal(reason) => {
                    // Rows already written stay.
                    abandon(&admission);
                    self.warn(&error, CaptureLogStage::CapturePipeline, 1);
                    if reason == "workspace-policy-disabled" {
                        // The owner switched capture off mid-turn: written rows stay and the
                        // unfinished turn's replay entry is released, as the pin's onRowsKept.
                        // The caller hears `not_captured` whatever the cleanup did.
                        let kept = replay
                            .primary_settled()
                            .map_err(EngineError::from)
                            .and_then(|settled| {
                                if settled {
                                    Ok(())
                                } else {
                                    replay.on_rows_kept()
                                }
                            });
                        if let Err(error) = kept {
                            self.warn(&error, CaptureLogStage::CapturePipeline, 1);
                        }
                        Ok(counts(0, 1, Some("not_captured")))
                    } else {
                        Err(error)
                    }
                }
            },
        };
        if !admission.is_closed() {
            self.mark_pending(&scope_of(
                context.agent_id.as_str(),
                &context.owner_user_id,
            )?);
        }
        if neo_started && !cancel.is_cancelled() && !turn.cancel.is_cancelled() {
            if let Some(hook) = &self.neo {
                let timeout =
                    super::super::queue::RuntimeConfig::from_value(&self.config["runtime"])
                        .capture_timeout_ms;
                let end = started
                    .checked_add(Duration::from_millis(timeout))
                    .unwrap_or(started);
                let maintenance = cancel.limited_to(end);
                if let Err(error) = hook.after_capture(turn, context, &maintenance) {
                    self.warn(&error, CaptureLogStage::NeoCapture, 1);
                }
            }
        }
        result
    }
    fn capture_inner(
        &self,
        turn: &TurnRecord,
        context: &RequestContext,
        replay: &ReplayRows,
        cancel: &Cancel,
        neo_started: &mut bool,
        admission: &mut Admission<'_>,
    ) -> Result<CaptureResult, EngineError> {
        // Revocation (terminal) and maintenance (transient) are typed for the caller.
        match self.policy.decision(context)? {
            PolicyDecision::Allowed => {}
            PolicyDecision::Revoked => {
                return Err(EngineError::NotAvailable {
                    reason: "workspace-policy-disabled".into(),
                })
            }
            PolicyDecision::Maintenance => {
                return Err(EngineError::NotAvailable {
                    reason: "workspace-maintenance".into(),
                })
            }
        }
        if cancel.is_cancelled() {
            return Ok(aborted(0, 0));
        }
        if self.config["neo"]["enabled"] != false {
            let result = self.neo.as_ref().map_or_else(
                || {
                    Err(EngineError::NotAvailable {
                        reason: "neo-capture-unavailable".into(),
                    })
                },
                |hook| hook.record_turn(turn, context, cancel),
            );
            *neo_started = result.is_ok();
            if let Err(error) = result {
                self.warn(&error, CaptureLogStage::NeoCapture, 1);
            }
        }
        if turn.messages.is_empty() {
            replay.on_rows_settled()?;
            admission.complete(cancel)?;
            return Ok(counts(0, 0, None));
        }
        let mut early_store = None;
        let mut stale = replay.stale_row_ids().to_vec();
        for id in admission.record.rows.keys() {
            if !stale.contains(id) {
                stale.push(id.clone());
            }
        }
        if !stale.is_empty() {
            let store = self.store(context)?;
            let run = turn.run_id.as_deref().unwrap_or_default();
            // Validate the complete pending set before removing any existing row.
            for id in &stale {
                cancel.check()?;
                if let Some(row) = store.get(id)? {
                    if admission
                        .record
                        .rows
                        .get(id)
                        .is_some_and(|expected| row_digest(&row).as_ref() != Ok(expected))
                    {
                        return Err(StoreError::Corrupt.into());
                    }
                    if (run.is_empty() && !admission.record.rows.contains_key(id))
                        || row.stored_by != context.agent_id.as_str()
                        || row.source_turn_id != run
                        || row.scope != "agent-private"
                        || !row.owner_user_id.is_empty()
                        || !row.agent_id.is_empty()
                        || !row.workspace_id.is_empty()
                        || !row.workspace_key.is_empty()
                    {
                        return Err(StoreError::Corrupt.into());
                    }
                }
            }
            for id in &stale {
                admission.check(cancel)?;
                if let Some(row) = store.get(id)? {
                    if let Some(expected) = admission.record.rows.get(id) {
                        if row_digest(&row)? != *expected {
                            return Err(StoreError::Corrupt.into());
                        }
                        store.delete_capture_admission_row(&row)?;
                    } else {
                        store.delete_capture_replay_row(id, context.agent_id.as_str(), run)?;
                    }
                }
            }
            admission.record.rows.clear();
            admission.save(cancel)?;
            early_store = Some(store);
        }
        let items = prepare::select_items(turn)?;
        if items.is_empty() {
            replay.on_rows_settled()?;
            admission.complete(cancel)?;
            return Ok(counts(0, 0, None));
        }
        let origin = prepare::capture_origin(turn, &items)?;
        let now = admission.record.at_ms;
        let (preps, mut failed) = self.prepare(items, context, cancel);
        if cancel.is_cancelled() {
            return Ok(aborted(0, 0));
        }
        let expansion = chunking::expand_for_capture(
            &preps,
            self.expansion_mode(),
            |text| {
                self.decider
                    .as_ref()
                    .map_or(StorageDecision::Both, |decider| {
                        match decider.decide(text, context, cancel) {
                            Ok(storage) => storage,
                            Err(error) => {
                                self.warn(&error, CaptureLogStage::CapturePipeline, 1);
                                StorageDecision::Both
                            }
                        }
                    })
            },
            || uuid::Uuid::new_v4().to_string(),
        );
        if cancel.is_cancelled() {
            return Ok(aborted(0, 0));
        }
        let (prepared, embed_failed) = self.embed(expansion.items, context, cancel);
        failed += embed_failed;
        if cancel.is_cancelled() {
            return Ok(aborted(0, 0));
        }
        let store = match early_store.map(Ok).unwrap_or_else(|| self.store(context)) {
            Ok(store) => store,
            Err(error) => {
                self.warn(
                    &error,
                    CaptureLogStage::CapturePipeline,
                    prepared.len() as u64,
                );
                return Ok(counts(
                    0,
                    (prepared.len() as u64).max(1),
                    Some("capture-incomplete"),
                ));
            }
        };
        let mut selected = Vec::new();
        let prepared_count = prepared.len();
        let threshold = self.config["duplicateThreshold"].as_f64().unwrap_or(0.95);
        for (prep, vector) in prepared {
            cancel.check()?;
            match store.search_capture_duplicates(&vector, 1) {
                Ok(nearest) if !dedupe::is_duplicate(nearest.first(), threshold) => {
                    selected.push((prep, vector))
                }
                Ok(_) => {}
                Err(error) => {
                    failed += 1;
                    self.warn(&error.into(), CaptureLogStage::CapturePipeline, 1);
                }
            }
        }
        let mut skipped = (prepared_count - selected.len()) as u64;
        let planned = selected
            .iter()
            .map(|_| uuid::Uuid::new_v4().to_string())
            .collect::<Vec<_>>();
        if !planned.is_empty() {
            replay.on_rows_planned(&planned)?;
        }
        let mut committed = Vec::new();
        for ((prep, vector), id) in selected.into_iter().zip(planned) {
            if cancel.is_cancelled() {
                return Ok(aborted(committed.len() as u64, skipped));
            }
            let built = self.row(
                id,
                &prep,
                vector,
                row::RowContext {
                    turn,
                    context,
                    origin,
                    now,
                    cancel,
                },
            );
            let write = match built {
                Ok(row) => {
                    cancel.check()?;
                    admission
                        .record
                        .rows
                        .insert(row.id.clone(), row_digest(&row)?);
                    admission.save(cancel)?;
                    store
                        .upsert(std::slice::from_ref(&row))
                        .map(|()| row)
                        .map_err(EngineError::from)
                }
                Err(error) => Err(error),
            };
            match write {
                Ok(row) => committed.push(row),
                Err(_) if cancel.is_cancelled() => {
                    return Ok(aborted(committed.len() as u64, skipped))
                }
                Err(EngineError::Store(StoreError::TombstoneBlocked)) => skipped += 1,
                Err(error) => {
                    failed += 1;
                    self.warn(&error, CaptureLogStage::CapturePipeline, 1);
                }
            }
        }
        let stored = committed.len() as u64;
        let result = counts(
            stored,
            if failed > 0 && stored == 0 {
                skipped.max(1)
            } else {
                skipped
            },
            (failed > 0).then_some("capture-incomplete"),
        );
        admission.record.phase = Phase::PostStore;
        admission.record.post_at_ms = Some(self.host.now_ms());
        admission.record.result = Some(result);
        admission.record.row_order = committed.iter().map(|row| row.id.clone()).collect();
        admission.record.rows = committed
            .iter()
            .map(|row| Ok((row.id.clone(), row_digest(row)?)))
            .collect::<Result<_, StoreError>>()?;
        admission.save(cancel)?;
        // RE-D161: every stored row is a new fragment of the agent table. As at the pin
        // (`capture-turn.js:768-772`, after the store loop and its abort check, before the
        // post-store steps) the writes are only noted; a due compaction runs detached and
        // the turn never waits for it or hears of its failure.
        if stored > 0 {
            if let Some(compactor) = &self.compactor {
                compactor.note_writes(context.agent_id.as_str(), stored);
            }
        }
        let options = admission.record.options.clone();
        self.finish_post(turn, context, &options, replay, admission, cancel)
    }

    fn finish_post(
        &self,
        turn: &TurnRecord,
        context: &RequestContext,
        options: &CaptureOptions,
        replay: &ReplayRows,
        admission: &mut Admission<'_>,
        cancel: &Cancel,
    ) -> Result<CaptureResult, EngineError> {
        let result = admission.record.result.clone().ok_or(StoreError::Corrupt)?;
        let store = self.store(context)?;
        let mut rows = Vec::new();
        for id in &admission.record.row_order {
            let expected = admission.record.rows.get(id).ok_or(StoreError::Corrupt)?;
            admission.check(cancel)?;
            let row = store.get(id)?.ok_or(StoreError::Corrupt)?;
            if row_digest(&row)? != *expected {
                return Err(StoreError::Corrupt.into());
            }
            rows.push(row);
        }
        admission.check(cancel)?;
        if result.reason.is_none() {
            replay.on_rows_settled()?;
        } else {
            replay.on_rows_kept()?;
        }
        if !admission.record.classifier_done {
            let resuming = admission.record.classifier_started;
            admission.record.classifier_started = true;
            admission.save(cancel)?;
            match self
                .classifier
                .post_store_recoverable(turn, context, &rows, admission, resuming, cancel)
            {
                Ok(()) => {
                    admission.record.classifier_done = true;
                    admission.save(cancel)?;
                }
                Err(error) => {
                    self.warn(&error, CaptureLogStage::CapturePipeline, 1);
                    // RE-D155/156: any failure not listed transient closes this step.
                    if let FailureClass::Terminal(reason) = failure::classify(&error) {
                        admission.record.classifier_done = true;
                        admission.record.post_skipped.push(reason.to_owned());
                        admission.save(cancel)?;
                    }
                }
            }
        }
        if !admission.record.neo_done {
            admission.check(cancel)?;
            let resuming = admission.record.neo_started;
            admission.record.neo_started = true;
            admission.save(cancel)?;
            match self.neo.as_ref().map_or(Ok(()), |neo| {
                neo.post_store_recoverable(turn, context, options, resuming, cancel)
            }) {
                Ok(()) => {
                    admission.record.neo_done = true;
                    admission.save(cancel)?;
                }
                Err(error) => {
                    self.warn(&error, CaptureLogStage::NeoCapture, 1);
                    if let FailureClass::Terminal(reason) = failure::classify(&error) {
                        admission.record.neo_done = true;
                        admission.record.post_skipped.push(reason.to_owned());
                        admission.save(cancel)?;
                    }
                }
            }
        }
        if admission.record.classifier_done && admission.record.neo_done {
            admission.complete(cancel)?;
        }
        Ok(result)
    }
}
