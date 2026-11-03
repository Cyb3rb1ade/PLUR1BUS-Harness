//! Human command dispatch and call results. Approval answers come only from the native input branch.
use super::*;

impl Runtime {
    pub(super) fn handle_input(&mut self, line: String, key: AcceptKey) -> Result<(), CodeError> {
        if line.trim().is_empty() {
            self.frontend.next_line();
            return Ok(());
        }
        if line.chars().count() > 200_000 {
            return Err(CodeError::new(
                "E_INVALID_PARAMS",
                "input exceeds 200000 Unicode characters",
            ));
        }
        if !self.interactive {
            self.input_pending = true;
        }
        if self.model_question.is_some() {
            match line.trim().to_ascii_lowercase().as_str() {
                "y" | "j" => {
                    if let Some(params) = self.model_question.take() {
                        self.frontend.update(|state| state.question.clear());
                        self.start(Kind::ModelApply, "session.model.set", params)?;
                    }
                }
                "n" => {
                    self.model_question = None;
                    self.frontend.update(|state| state.question.clear());
                }
                "?" => self.note(crate::commands::session::model_switch_warning(self.lang.0))?,
                _ => {
                    return Err(CodeError::new(
                        "E_INVALID_PARAMS",
                        self.lang.text(
                            "Answer y or n for the model switch.",
                            "Modellwechsel mit y oder n beantworten.",
                        ),
                    ))
                }
            }
            return Ok(());
        }
        let approval = self
            .approval_order
            .iter()
            .find(|id| !self.deciding.contains(*id))
            .cloned();
        if let Some(id) = approval {
            if let Some(record) = self.approvals.get(&id) {
                if let Some(answer) = approve::answer(&line, record, self.interactive) {
                    match answer {
                        approve::Answer::Details => {
                            self.frontend
                                .print(&approve::details(record, self.color, self.lang))?;
                            return Ok(());
                        }
                        approve::Answer::Once => {
                            self.decide(&id, "approve", Some("once"), false)?
                        }
                        approve::Answer::Grant(scope) => {
                            self.decide(&id, "approve", Some(&scope), false)?
                        }
                        approve::Answer::Deny => self.decide(&id, "deny", None, false)?,
                    }
                    return Ok(());
                }
            }
        }
        let command = commands::parse(&line)
            .map_err(|message| CodeError::new("E_INVALID_PARAMS", message))?;
        let model_busy = self.running.is_some()
            || self
                .operation
                .as_ref()
                .is_some_and(|op| matches!(op.kind, Kind::Submit | Kind::Transcript));
        match command {
            Command::Help => self.note(self.lang.text(
                "/check [format|lint|typecheck|test] · /diff [call] · /done · /rewind · /compact\n/model [profile] [--reasoning level] · /steer text · /queue [text] · /unqueue n\nEnter submits or steers; Alt+Enter (Esc then Enter) queues. Ctrl+C cancels; twice exits. Ctrl+D exits when idle.",
                "/check [format|lint|typecheck|test] · /diff [call] · /done · /rewind · /compact\n/model [Profil] [--reasoning Stufe] · /steer Text · /queue [Text] · /unqueue n\nEnter sendet oder steuert; Alt+Enter (Esc, dann Enter) reiht ein. Ctrl+C bricht ab; zweimal beendet. Ctrl+D beendet im Leerlauf."))?,
            Command::Message(text) => self.submit(text, input::delivery(key, model_busy))?,
            Command::Steer(text) => {
                if !model_busy { return Err(CodeError::new("E_CONFLICT", self.lang.text("No turn is running.", "Es läuft kein Turn."))); }
                self.submit(text, Delivery::Steer)?;
            }
            Command::Queue(Some(text)) => self.submit(text, Delivery::Queue)?,
            Command::Queue(None) => { self.require_queue()?; self.start(Kind::QueueList(None), "session.queue.list", self.params())?; }
            Command::Unqueue(index) => { self.require_queue()?; self.start(Kind::QueueList(Some(index)), "session.queue.list", self.params())?; }
            Command::Check(kind) => {
                self.require_idle(model_busy)?;
                let mut params = self.params(); if let Some(kind) = kind { params["kind"] = json!(kind); }
                self.start(Kind::Check, "code.session.check", params)?;
            }
            Command::Done => {
                self.require_idle(model_busy)?;
                if let (Some(project), Some(card)) = (self.opened["projectId"].as_str(),self.opened["cardId"].as_str()) {
                    self.start(Kind::Done, "task.complete", json!({"projectId":project,"cardId":card}))?;
                } else { self.start(Kind::Check, "code.session.check", self.params())?; }
            }
            Command::Diff(call) => {
                let mut params = self.params(); if let Some(call) = call { params["callId"] = json!(call); }
                params["limit"] = json!(65536); self.start(Kind::Diff,"code.session.diff",params)?;
            }
            Command::Transcript(text) => {
                self.require_idle(model_busy)?;
                if text.starts_with("/rewind") && !self.feature("session.rewind") {
                    return Err(CodeError::new("E_NOT_AVAILABLE",self.lang.text("Core does not provide Rewind yet; input retained.", "Core bietet Rewind noch nicht an; Eingabe bleibt erhalten.")));
                }
                let mut params = self.params(); params["text"] = json!(text); params["wait"] = json!(false);
                self.start(Kind::Transcript,"session.submit",params)?;
            }
            Command::Model(args) => {
                self.require_idle(model_busy)?;
                let (profile, reasoning) = model_args(&args).map_err(|message| CodeError::new("E_INVALID_PARAMS",message))?;
                if let Some(profile) = profile {
                    let params = crate::commands::session::model_switch_params(&self.caller,&self.session,&profile,reasoning.as_deref());
                    self.start(Kind::ModelPreview { params: params.clone(), base_revision: None },"session.model.set",params)?;
                } else {
                    self.start(Kind::ModelGet(reasoning.map(Value::String)),"session.model.get",self.params())?;
                }
            }
        }
        Ok(())
    }
    fn require_idle(&self, busy: bool) -> Result<(), CodeError> {
        if busy {
            Err(CodeError::new(
                "E_CONFLICT",
                self.lang.text(
                    "Finish or cancel the running turn first.",
                    "Zuerst den laufenden Turn beenden oder abbrechen.",
                ),
            ))
        } else {
            Ok(())
        }
    }
    fn require_queue(&self) -> Result<(), CodeError> {
        if !self.feature("session.queue.list") {
            Err(CodeError::new(
                "E_NOT_AVAILABLE",
                self.lang.text(
                    "Core does not provide Steering/queue yet; input retained.",
                    "Core bietet Steering/Warteschlange noch nicht an; Eingabe bleibt erhalten.",
                ),
            ))
        } else {
            Ok(())
        }
    }
    fn submit(&mut self, text: String, delivery: Delivery) -> Result<(), CodeError> {
        let mut params = self.params();
        params["text"] = json!(text);
        params["wait"] = json!(false);
        match delivery {
            Delivery::Submit => {}
            Delivery::Steer => {
                self.require_queue()?;
                params["delivery"] = json!("steer");
            }
            Delivery::Queue => {
                self.require_queue()?;
                params["delivery"] = json!("queue");
            }
        }
        self.start(Kind::Submit, "session.submit", params)
    }
    pub(super) fn result(&mut self, operation: Operation, result: Value) -> Result<(), CodeError> {
        self.emit(operation.method, result.clone())?;
        match operation.kind {
            Kind::Submit | Kind::Transcript => {
                if result["state"] == "queued" {
                    self.start(Kind::QueueList(None), "session.queue.list", self.params())?;
                    return Ok(());
                }
                if result["state"] == "steered" {
                    return Ok(());
                }
                let turn = result["turnId"].as_str().ok_or_else(|| {
                    CodeError::new("E_RPC_PROTOCOL", "submit result has no turn id")
                })?;
                if !self.completed.iter().any(|id| id == turn) {
                    self.running = Some(turn.into());
                }
            }
            Kind::Diff => {
                if self.interactive {
                    self.frontend.print(&render::diff(
                        result["diff"].as_str().unwrap_or(""),
                        self.color,
                        None,
                        self.lang,
                    ))?;
                }
                if let Some(offset) = result["nextOffset"].as_u64() {
                    if offset <= operation.params["offset"].as_u64().unwrap_or(0) {
                        return Err(CodeError::new(
                            "E_RPC_PROTOCOL",
                            "diff page did not advance",
                        ));
                    }
                    let mut params = operation.params;
                    params["offset"] = json!(offset);
                    self.start(Kind::Diff, "code.session.diff", params)?;
                }
            }
            Kind::Check => {
                if result["ok"] == false {
                    self.failed = true;
                }
                if self.interactive {
                    for check in result["checks"].as_array().into_iter().flatten() {
                        self.frontend.print(&format!(
                            "{} {}",
                            if check["ok"] == true { "✓" } else { "✗" },
                            render::safe(check["kind"].as_str().unwrap_or("check"), false)
                        ))?;
                        if let Some(text) = check["essence"]
                            .as_str()
                            .or_else(|| check["output"].as_str().filter(|_| check["ok"] != true))
                        {
                            let excerpt = text.lines().take(80).collect::<Vec<_>>().join("\n");
                            self.note(&excerpt)?;
                            if text.lines().count() > 80 {
                                self.note(self.lang.text(
                                    "Output folded after 80 lines.",
                                    "Ausgabe nach 80 Zeilen eingeklappt.",
                                ))?;
                            }
                        }
                    }
                }
            }
            Kind::Done => {
                if self.interactive {
                    self.note(&serde_json::to_string_pretty(&result)?)?;
                }
            }
            Kind::ModelGet(reasoning) => {
                if let Some(reasoning) = reasoning {
                    let profile = result["profile"]
                        .as_str()
                        .or(result["defaultProfile"].as_str())
                        .ok_or_else(|| {
                            CodeError::new("E_NOT_AVAILABLE", "choose a model profile first")
                        })?;
                    let params = crate::commands::session::model_switch_params(
                        &self.caller,
                        &self.session,
                        profile,
                        reasoning.as_str(),
                    );
                    self.start(
                        Kind::ModelPreview {
                            params: params.clone(),
                            base_revision: Some(result["revision"].clone()),
                        },
                        "session.model.set",
                        params,
                    )?;
                } else if self.interactive {
                    self.note(&serde_json::to_string_pretty(&result)?)?;
                }
            }
            Kind::ModelPreview {
                params,
                base_revision,
            } => {
                if !result["revision"].is_u64() {
                    return Err(CodeError::new(
                        "E_RPC_PROTOCOL",
                        "model preview has no revision",
                    ));
                }
                if !crate::commands::session::model_preview_is_current(
                    base_revision.as_ref(),
                    &result,
                ) {
                    return Err(CodeError::new(
                        "E_CONFLICT",
                        "model changed during preview; retry",
                    ));
                }
                self.note(crate::commands::session::model_switch_warning(self.lang.0))?;
                let confirmed = crate::commands::session::confirm_model_switch(params, &result);
                if self.auto_model {
                    self.start(Kind::ModelApply, "session.model.set", confirmed)?;
                } else if self.interactive {
                    self.model_question = Some(confirmed);
                    self.frontend.update(|state| {
                        state.question = self
                            .lang
                            .text("Switch model? [y/n]", "Modell wechseln? [y/n]")
                            .into()
                    });
                } else {
                    return Err(CodeError::new(
                        "E_APPROVAL_REQUIRED",
                        "model switch requires --yes in a script",
                    ));
                }
            }
            Kind::ModelApply => {
                self.frontend.update(|state| state.question.clear());
                self.note(
                    self.lang
                        .text("Model choice updated.", "Modellauswahl aktualisiert."),
                )?;
            }
            Kind::QueueList(remove) => {
                self.queue_items = result["items"]
                    .as_array()
                    .cloned()
                    .ok_or_else(|| CodeError::new("E_RPC_PROTOCOL", "queue has no items array"))?;
                if self.queue_items.len() > 20 {
                    return Err(CodeError::new("E_RPC_PROTOCOL", "queue exceeds 20 entries"));
                }
                if let Some(index) = remove {
                    let item = self.queue_items.get(index - 1).ok_or_else(|| {
                        CodeError::new("E_INVALID_PARAMS", "queue position does not exist")
                    })?;
                    let id = item["id"]
                        .as_str()
                        .ok_or_else(|| CodeError::new("E_RPC_PROTOCOL", "queue item has no id"))?;
                    let mut params = self.params();
                    params["id"] = json!(id);
                    self.start(Kind::QueueRemove, "session.queue.remove", params)?;
                } else {
                    let text = self
                        .queue_items
                        .iter()
                        .enumerate()
                        .map(|(i, item)| {
                            format!(
                                "{}. {}",
                                i + 1,
                                render::safe(item["text"].as_str().unwrap_or(""), false)
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    self.frontend.update(|state| state.queue = text);
                }
            }
            Kind::QueueRemove => {
                self.start(Kind::QueueList(None), "session.queue.list", self.params())?;
            }
        }
        Ok(())
    }
}

fn model_args(args: &[String]) -> Result<(Option<String>, Option<String>), &'static str> {
    let mut profile = None;
    let mut reasoning = None;
    let mut index = 0;
    while index < args.len() {
        if args[index] == "--reasoning" {
            index += 1;
            let level = args.get(index).ok_or("--reasoning requires a level")?;
            if reasoning.is_some()
                || ![
                    "default", "off", "minimal", "low", "medium", "high", "xhigh",
                ]
                .contains(&level.as_str())
            {
                return Err("invalid reasoning level");
            }
            reasoning = Some(level.clone());
        } else if profile.is_none() && !args[index].starts_with('-') {
            profile = Some(args[index].clone());
        } else {
            return Err("/model [profile] [--reasoning level]");
        }
        index += 1;
    }
    Ok((profile, reasoning))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn model_command_keeps_reasoning_explicit_and_never_treats_yes_as_a_tool_approval() {
        assert!(crate::commands::session::model_preview_is_current(
            Some(&json!(3)),
            &json!({"revision":3})
        ));
        assert!(!crate::commands::session::model_preview_is_current(
            Some(&json!(2)),
            &json!({"revision":3})
        ));
        assert_eq!(
            model_args(&["fast".into(), "--reasoning".into(), "off".into()]),
            Ok((Some("fast".into()), Some("off".into())))
        );
        assert_eq!(
            model_args(&["--reasoning".into(), "high".into()]),
            Ok((None, Some("high".into())))
        );
        assert!(model_args(&["--yes".into()]).is_err());
        assert!(model_args(&["--reasoning".into(), "huge".into()]).is_err());
    }
}
