//! Primary capture work precedes optional Neo queue maintenance on every exit path.
use super::super::admission::{row_digest, scope_of, Admission, Assessment, Entry, Phase, Record};
use super::super::failure::{self, FailureClass, MAX_RECOVERY_ATTEMPTS};
use super::super::replay_guard::{turn_key_of, ReplayGuard};
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
    fn recover(&self, replay: &ReplayGuard) -> Result<(), EngineError> {
        // Only shutdown ends the startup recovery as a whole; each owner scope has its own
        // budget, and a scope that runs out of it is deferred to its own next turn (RE-D159).
        let inventory = self.admissions.inventory(&self.shutdown)?;
        self.unreadable.store(
            inventory.unattributable > 0,
            std::sync::atomic::Ordering::Release,
        );
        if inventory.unattributable > 0 {
            self.warn(
                &StoreError::Corrupt.into(),
                CaptureLogStage::CapturePipeline,
                1,
            );
        }
        for (scope, names) in inventory.scopes {
            self.recover_scope(replay, &scope, &names)?;
        }
        Ok(())
    }

    fn recover_owner(&self, replay: &ReplayGuard, turn: &TurnRecord) {
        // Only this caller's own pending records are retried, under their own budget and
        // cancellation; nothing here can refuse, delay beyond that budget, or abort the turn.
        let Ok(scope) = self.admissions.scope_for(turn, &self.shutdown) else {
            return;
        };
        let was = self
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&scope);
        if !was {
            return;
        }
        let outcome = self
            .admissions
            .scope_names(&scope, &self.shutdown)
            .and_then(|names| self.recover_scope(replay, &scope, &names));
        if let Err(error) = outcome {
            self.warn(&error, CaptureLogStage::CapturePipeline, 1);
            self.mark_pending(&scope);
        }
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

impl CapturePipeline {
    fn mark_pending(&self, scope: &str) {
        self.pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(scope.to_owned());
    }

    /// Recover one owner scope's records under that scope's own budget. Running out of it
    /// defers the rest to the owner's next turn; only shutdown escapes.
    fn recover_scope(
        &self,
        replay: &ReplayGuard,
        scope: &str,
        names: &[String],
    ) -> Result<(), EngineError> {
        let timeout = super::super::queue::RuntimeConfig::from_value(&self.config["runtime"])
            .capture_timeout_ms;
        let budget = self
            .shutdown
            .limited_to(Instant::now() + Duration::from_millis(timeout));
        let entries = match self.admissions.entries(names, &budget) {
            Ok(entries) => entries,
            Err(error) => return self.defer(scope, error),
        };
        for entry in entries {
            match entry {
                Entry::Record(record) => {
                    if let Err(error) = self.recover_one(replay, scope, &record, &budget) {
                        return self.defer(scope, error);
                    }
                }
                Entry::Unreadable => {
                    // Attributed to this owner only: kept and reported, never read again here.
                    self.warn(
                        &StoreError::Corrupt.into(),
                        CaptureLogStage::CapturePipeline,
                        1,
                    );
                }
            }
        }
        Ok(())
    }

    /// Keep a scope pending after its budget, a cancellation or an inventory error.
    fn defer(&self, scope: &str, error: EngineError) -> Result<(), EngineError> {
        self.mark_pending(scope);
        if self.shutdown.is_cancelled() {
            return Err(error);
        }
        self.warn(&error, CaptureLogStage::CapturePipeline, 1);
        Ok(())
    }

    /// Recover one retained record. The attempt is counted durably before anything else
    /// runs (RE-D159), so every failure counts; only maintenance gives it back. Only
    /// cancellation escapes; every other outcome is local to this record.
    fn recover_one(
        &self,
        replay: &ReplayGuard,
        scope: &str,
        record: &Record,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        let made = match self.admissions.note_attempt(record, cancel) {
            Ok(None) => return Ok(()),
            Ok(Some(made)) => made,
            Err(error @ EngineError::Cancelled(_)) => return Err(error),
            Err(error) => {
                self.warn(&error, CaptureLogStage::CapturePipeline, 1);
                self.mark_pending(scope);
                return Ok(());
            }
        };
        let outcome = (|| -> Result<Option<&'static str>, EngineError> {
            if made >= MAX_RECOVERY_ATTEMPTS {
                return Ok(Some("recovery-exhausted"));
            }
            match self.admissions.assess(record, cancel)? {
                Assessment::Ready => {}
                Assessment::Maintenance => return Err(maintenance()),
                Assessment::Revoked => return Ok(Some("workspace-policy-disabled")),
                Assessment::ConfigChanged => return Ok(Some("config-changed")),
                Assessment::WorkspaceChanged => return Ok(Some("workspace-identity-changed")),
                Assessment::CallerChanged => return Ok(Some("caller-changed")),
            }
            self.recover_record(replay, record, cancel)?;
            Ok(None)
        })();
        let reason = match outcome {
            Ok(None) => return Ok(()),
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
                    self.mark_pending(scope);
                    return Ok(());
                }
                FailureClass::Terminal(reason) => reason,
            },
        };
        self.close_terminally(replay, scope, record, reason, cancel)
    }

    /// Discard a retained record with a fixed reason; rows already written stay, as at the pin.
    fn close_terminally(
        &self,
        replay: &ReplayGuard,
        scope: &str,
        record: &Record,
        reason: &'static str,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
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
            let released = replay.recover(record.turn.agent_id.as_str(), &key, cancel, |rows| {
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
            Ok(()) => Ok(()),
            Err(error @ EngineError::Cancelled(_)) => Err(error),
            Err(error) => {
                // Not even the discard succeeded: keep it for the next attempt.
                self.warn(&error, CaptureLogStage::CapturePipeline, 1);
                self.mark_pending(scope);
                Ok(())
            }
        }
    }

    fn recover_record(
        &self,
        replay: &ReplayGuard,
        record: &Record,
        cancel: &Cancel,
    ) -> Result<(), EngineError> {
        let turn = &record.turn;
        let context = RequestContext::build(&turn.principal, &turn.agent, self.host.as_ref())?;
        let key = turn_key_of(turn)?;
        replay.recover(turn.agent_id.as_str(), &key, cancel, |rows| {
            if !self.admissions.pending(record, cancel)? {
                return Ok(());
            }
            let result =
                self.capture_attempt(turn, &context, &record.options, &rows, cancel, true)?;
            if self.admissions.pending(record, cancel)? {
                return Err(StoreError::Unavailable.into());
            }
            if result.reason.is_none() {
                rows.on_rows_settled()?;
            }
            Ok(())
        })
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
        let mut admission = self.admissions.begin(turn, context, options, cancel)?;
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
        // Once an ordinary invocation observes abort/timeout, do not resurrect it on open.
        // Startup's own bounded deadline instead leaves original work pending for retry.
        if !recovery && (cancel.is_cancelled() || turn.cancel.is_cancelled()) {
            admission.abandon()?;
        }
        // RE-D156: a terminal failure closes the record; only listed transient ones keep it.
        let result = match result {
            Ok(result) => Ok(result),
            Err(error) => match failure::classify(&error) {
                FailureClass::Transient => Err(error),
                FailureClass::Terminal(reason) => {
                    // Rows already written stay.
                    admission.abandon()?;
                    self.warn(&error, CaptureLogStage::CapturePipeline, 1);
                    if reason == "workspace-policy-disabled" {
                        // The owner switched capture off mid-turn: written rows stay and the
                        // unfinished turn's replay entry is released, as the pin's onRowsKept.
                        if !replay.primary_settled()? {
                            replay.on_rows_kept()?;
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
