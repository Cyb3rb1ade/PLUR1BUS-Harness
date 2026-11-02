//! Render raw stream events and reconcile transient approvals; completed-before-submit-reply is an expected race.
use super::*;

impl Runtime {
    pub(super) fn frame(&mut self, frame: Value) -> Result<(), CodeError> {
        if frame["method"] == "session.event" {
            let event = &frame["params"]["event"];
            if event["sessionId"].as_str() != Some(&self.session) {
                return Ok(());
            }
            let turn = event["turnId"].as_str();
            if event["seq"]
                .as_u64()
                .is_some_and(|seq| seq <= self.initial_seq)
                && turn != self.initial_turn.as_deref()
            {
                return Ok(());
            }
            if !self.interactive {
                self.frontend.print(&render::json_event(&frame)?)?;
            }
            let data = &event["data"];
            match event["type"].as_str().unwrap_or("") {
                "turn.started" => {
                    if let Some(turn) = turn {
                        if !self.completed.iter().any(|id| id == turn) {
                            self.running = Some(turn.into());
                        }
                    }
                }
                "delta" if self.interactive => {
                    self.partial
                        .push_str(&render::safe(data["text"].as_str().unwrap_or(""), true));
                    if let Some(end) = self.partial.rfind('\n') {
                        self.frontend.print(&self.partial[..=end])?;
                        self.partial.drain(..=end);
                    }
                    if self.partial.len() > 1024 * 1024 {
                        self.flush_partial()?;
                    }
                    self.frontend
                        .update(|state| state.partial = self.partial.clone());
                }
                "tool.call" => {
                    self.flush_partial()?;
                    if let Some(id) = data["id"].as_str() {
                        if self.tools.len() >= 128 && !self.tools.contains_key(id) {
                            return Err(CodeError::new(
                                "E_RPC_PROTOCOL",
                                "too many unfinished tool calls",
                            ));
                        }
                        self.tools.insert(id.into(), data.clone());
                    }
                }
                "tool.result" => {
                    let call = data["id"].as_str().unwrap_or("?");
                    let info = self.tools.remove(call).unwrap_or(Value::Null);
                    if self.interactive {
                        let output = data["output"].as_str().unwrap_or("");
                        self.frontend.print(&tool_line(&info, output))?;
                        self.frontend
                            .print(&render::tool_result(output, call, self.color, self.lang))?;
                    }
                }
                "turn.completed" | "turn.failed" => {
                    self.flush_partial()?;
                    if let Some(turn) = turn {
                        if self.running.as_deref() == Some(turn) {
                            self.running = None;
                        }
                        if !self.completed.iter().any(|id| id == turn) {
                            self.completed.push_back(turn.into());
                        }
                        while self.completed.len() > 64 {
                            self.completed.pop_front();
                        }
                    }
                    if event["type"] == "turn.failed" {
                        self.failed = true;
                        if self.interactive {
                            self.note(&format!(
                                "{}: {}",
                                self.lang.text("Turn failed", "Turn fehlgeschlagen"),
                                data["error"].as_str().unwrap_or("failed")
                            ))?;
                        }
                    }
                }
                "session.model.changed" if self.interactive => self.note(
                    self.lang
                        .text("Model selection changed.", "Modellauswahl geändert."),
                )?,
                _ => {}
            }
            return Ok(());
        }
        if frame["method"]
            .as_str()
            .is_some_and(|name| name.starts_with("approval."))
        {
            let record = &frame["params"]["approval"];
            if record["sessionId"].as_str() != Some(&self.session) {
                return Ok(());
            }
            if !self.interactive {
                self.frontend.print(&render::json_event(&frame)?)?;
            }
            let Some(id) = record["id"].as_str() else {
                return Err(CodeError::new("E_RPC_PROTOCOL", "approval has no id"));
            };
            if frame["method"] == "approval.resolved" {
                self.approvals.remove(id);
                self.deciding.remove(id);
                self.approval_answers.remove(id);
                self.approval_order.retain(|entry| entry != id);
                self.approval_prompt()?;
            } else if frame["method"] == "approval.requested"
                && record["status"] == "pending"
                && !self.approvals.contains_key(id)
            {
                if self.approvals.len() >= 128 {
                    return Err(CodeError::new(
                        "E_RPC_PROTOCOL",
                        "too many pending session approvals",
                    ));
                }
                self.approvals.insert(id.into(), record.clone());
                self.approval_order.push_back(id.into());
                if !self.interactive {
                    self.denied = true;
                    self.decide(id, "deny", None, false)?;
                    self.emit("code.approval-required",json!({"sessionId":self.session,"approvalId":id,"reason":"approval-required","decision":"deny"}))?;
                } else {
                    self.frontend
                        .print(&approve::preview(record, self.color, self.lang))?;
                    self.approval_prompt()?;
                }
            }
            return Ok(());
        }
        if !self.interactive {
            self.frontend.print(&render::json_event(&frame)?)?;
        }
        Ok(())
    }
    pub(super) fn flush_partial(&mut self) -> Result<(), CodeError> {
        if !self.partial.is_empty() {
            self.frontend.print(&self.partial)?;
            self.partial.clear();
        }
        self.frontend.update(|state| state.partial.clear());
        Ok(())
    }
    pub(super) fn decide(
        &mut self,
        id: &str,
        decision: &str,
        scope: Option<&str>,
        attest: bool,
    ) -> Result<(), CodeError> {
        let params = crate::commands::approval::decide_params(id, decision, scope, false, attest);
        self.reader
            .command(&format!("approval:{id}"), "approval.decide", params.clone())?;
        self.approval_answers.insert(id.into(), params);
        self.deciding.insert(id.into());
        self.approval_prompt()
    }
    fn approval_prompt(&mut self) -> Result<(), CodeError> {
        if self.model_question.is_some() {
            return Ok(());
        }
        let record = self
            .approval_order
            .iter()
            .find(|id| !self.deciding.contains(*id))
            .and_then(|id| self.approvals.get(id));
        let question = record
            .map(|record| approve::question(record, self.lang))
            .unwrap_or_default();
        self.frontend.update(|state| state.question = question);
        Ok(())
    }
    pub(super) fn reader_reply(
        &mut self,
        operation: &str,
        result: Result<Value, CodeError>,
    ) -> Result<(), CodeError> {
        match result {
            Ok(value) => self.emit(
                if operation.starts_with("approval:") {
                    "approval.decide"
                } else {
                    "session.cancel"
                },
                value,
            ),
            Err(error) => {
                if let Some(id) = operation.strip_prefix("approval:") {
                    if error.code == "E_APPROVAL_REQUIRED"
                        && error.reason.as_deref() == Some("attestation-required")
                        && self.interactive
                    {
                        if let Some(params) = self
                            .approval_answers
                            .get(id)
                            .filter(|p| p["attest"] != true)
                        {
                            let mut params = params.clone();
                            params["attest"] = json!(true);
                            self.note(self.lang.text(
                                "Confirm this decision in the operating-system dialog.",
                                "Diese Entscheidung im Dialog des Betriebssystems bestätigen.",
                            ))?;
                            self.reader
                                .command(operation, "approval.decide", params.clone())?;
                            self.approval_answers.insert(id.into(), params);
                            return Ok(());
                        }
                    }
                    self.deciding.remove(id);
                    self.approval_prompt()?;
                }
                self.command_error(error)
            }
        }
    }
}

fn tool_line(info: &Value, output: &str) -> String {
    let name = render::safe(info["name"].as_str().unwrap_or("tool"), false);
    let target = info["args"]["path"]
        .as_str()
        .or(info["args"]["cwd"].as_str())
        .map(|s| format!(" {}", render::safe(s, false)))
        .unwrap_or_default();
    let parsed = serde_json::from_str::<Value>(output).unwrap_or(Value::Null);
    let value = parsed.get("value").unwrap_or(&parsed);
    let counts = value["diff"]
        .as_str()
        .or(value["unifiedDiff"].as_str())
        .map(|patch| {
            let added = patch
                .lines()
                .filter(|line| line.starts_with('+') && !line.starts_with("+++"))
                .count();
            let removed = patch
                .lines()
                .filter(|line| line.starts_with('-') && !line.starts_with("---"))
                .count();
            format!(" +{added} −{removed}")
        })
        .unwrap_or_default();
    format!("▸ {name}{target}{counts}")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tool_line_counts_real_diff_lines_without_echoing_command_arguments() {
        let call =
            json!({"name":"file.edit","args":{"path":"src/a.rs","command":"private-argument"}});
        let output = json!({"value":{"diff":"--- a\n+++ b\n-old\n+new\n+second"}}).to_string();
        assert_eq!(tool_line(&call, &output), "▸ file.edit src/a.rs +2 −1");
        assert!(!tool_line(&call, &output).contains("private-argument"));
    }
}
