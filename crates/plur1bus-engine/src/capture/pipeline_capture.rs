//! Primary capture work precedes optional Neo queue maintenance on every exit path.
use super::*;
use std::time::{Duration, Instant};
impl CaptureWorker for CapturePipeline {
    fn capture(
        &self,
        turn: &TurnRecord,
        context: &RequestContext,
        options: &CaptureOptions,
        replay: ReplayRows,
        cancel: &Cancel,
    ) -> Result<CaptureResult, EngineError> {
        let started = Instant::now();
        let mut neo_started = false;
        let result = self.capture_inner(turn, context, options, &replay, cancel, &mut neo_started);
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
}

impl CapturePipeline {
    fn capture_inner(
        &self,
        turn: &TurnRecord,
        context: &RequestContext,
        options: &CaptureOptions,
        replay: &ReplayRows,
        cancel: &Cancel,
        neo_started: &mut bool,
    ) -> Result<CaptureResult, EngineError> {
        if !self.policy.allowed(context).unwrap_or(false) {
            return Ok(counts(0, 1, Some("not_captured")));
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
            return Ok(counts(0, 0, None));
        }
        let mut early_store = None;
        if !replay.stale_row_ids().is_empty() {
            let store = self.store(context)?;
            let run = turn.run_id.as_deref().unwrap_or_default();
            // Validate the complete pending set before removing any existing row.
            for id in replay.stale_row_ids() {
                cancel.check()?;
                if let Some(row) = store.get(id)? {
                    if run.is_empty()
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
            for id in replay.stale_row_ids() {
                cancel.check()?;
                if store.get(id)?.is_some() {
                    store.delete_capture_replay_row(id, context.agent_id.as_str(), run)?;
                }
            }
            early_store = Some(store);
        }
        let items = prepare::select_items(turn)?;
        if items.is_empty() {
            return Ok(counts(0, 0, None));
        }
        let origin = prepare::capture_origin(turn, &items)?;
        let now = self.host.now_ms();
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
            let write = self
                .row(
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
                )
                .and_then(|row| {
                    cancel.check()?;
                    // Every upsert is a completed Lance commit before this row becomes visible.
                    store.upsert(std::slice::from_ref(&row))?;
                    Ok(row)
                });
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
        if !committed.is_empty() && failed == 0 {
            replay.on_rows_settled()?;
        } else {
            replay.on_rows_kept()?;
        }
        if let Err(error) = self
            .classifier
            .post_store(turn, context, &committed, cancel)
        {
            self.warn(&error, CaptureLogStage::CapturePipeline, 1);
        }
        if let Some(neo) = &self.neo {
            if let Err(error) = neo.post_store(turn, context, options, cancel) {
                self.warn(&error, CaptureLogStage::NeoCapture, 1);
            }
        }
        let stored = committed.len() as u64;
        Ok(counts(
            stored,
            if failed > 0 && stored == 0 {
                skipped.max(1)
            } else {
                skipped
            },
            (failed > 0).then_some("capture-incomplete"),
        ))
    }
}
