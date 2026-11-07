//! Lead holds pause the run, while facts and absolute deadlines remain replayable.
use super::{action::Machine, invalid, list, num, text};
use crate::ToolError;
use serde_json::{json, Value};
fn emit(m: &mut Machine, kind: &str) {
    m.emit(
        kind,
        json!({"leadEpoch":m.s["lead"]["epoch"],"member":m.s["lead"]["member"]}),
    );
}
fn stop(m: &mut Machine) {
    m.s["lead"]["epoch"] = json!(num(&m.s["lead"], "epoch") + 1);
    m.s["lead"]["stopPending"] = json!(true);
    emit(m, "stop-lead");
}
fn eligible(m: &Machine, id: &str) -> bool {
    list(&m.s, "members").iter().any(|member| {
        text(member, "id") == id
            && member["available"] == true
            && list(member, "roles").iter().any(|r| r == "lead")
    })
}
fn decision(m: &mut Machine, reason: &str) {
    m.s["lead"]["status"] = json!("needs-decision");
    m.s["lead"]["personPending"] = json!(true);
    let id = text(&m.s["run"], "id").to_owned();
    m.note("ask-person", &id, reason);
}
fn resume(m: &mut Machine) {
    if m.s["lead"]["stopPending"] == true {
        return;
    }
    m.s["lead"]["status"] = json!("active");
    m.s["lead"]["hold"] = Value::Null;
    m.s["lead"]["retrying"] = json!(false);
    m.s["lead"]["personPending"] = json!(false);
    if m.s["run"]["budgetAvailable"] == true && m.s["run"]["manualPaused"] != true {
        m.s["run"]["status"] = json!("running");
    }
    let id = text(&m.s["run"], "id").to_owned();
    m.note("lead-turn", &id, "resume-lead");
}
fn handover(m: &mut Machine, member: &str) -> Result<(), ToolError> {
    if !eligible(m, member) {
        return Err(invalid());
    }
    stop(m);
    m.s["lead"]["status"] = json!("handover");
    m.s["lead"]["handoverTo"] = json!(member);
    m.s["lead"]["handoverPhase"] = json!("stopping");
    Ok(())
}
pub(super) fn event(m: &mut Machine, e: &Value) -> Result<(), ToolError> {
    if m.s["lead"]["status"] == "needs-decision"
        && !matches!(text(e, "kind"), "lead.stopped" | "lead.reassign")
    {
        return Ok(());
    }
    match text(e, "kind") {
        "lead.failure" => {
            m.s["run"]["status"] = json!("paused");
            stop(m);
            m.quiesce(None);
            m.emit("pause", json!({"target":m.s["run"]["id"]}));
            let now = num(&m.s["run"], "now");
            match text(e, "class") {
                "quota" => {
                    m.s["lead"]["status"] = json!("holding");
                    m.s["lead"]["hold"] = json!({"since":now,"nextPollAt":now.saturating_add(num(&m.s["timers"],"pollIntervalMs")),"handoverAt":now.saturating_add(num(&m.s["timers"],"handoverAfterMs")),"resetAt":now.saturating_add(num(e,"retryAfterMs")),"veto":false,"keepUntil":null,"allowHandover":true,"pollPending":false});
                    let id = text(&m.s["run"], "id").to_owned();
                    m.note("notify", &id, "lead-quota-hold");
                }
                "crash" | "transient" => {
                    let field = if e["class"] == "crash" {
                        "crashRetries"
                    } else {
                        "retries"
                    };
                    let limit = if e["class"] == "crash" {
                        1
                    } else {
                        num(&m.s["timers"], "retryLimit")
                    };
                    if num(&m.s["lead"], field) >= limit {
                        decision(m, "lead-retry-exhausted");
                    } else {
                        m.s["lead"][field] = json!(num(&m.s["lead"], field) + 1);
                        m.s["lead"]["status"] = json!("holding");
                        m.s["lead"]["retrying"] = json!(true);
                        m.s["lead"]["retryAt"] =
                            json!(now.saturating_add(num(e, "retryAfterMs").max(1000)));
                    }
                }
                _ => decision(m, "lead-needs-decision"),
            }
        }
        "lead.stopped" => {
            m.s["lead"]["stopPending"] = json!(false);
            if m.s["lead"]["status"] == "handover" && m.s["lead"]["handoverPhase"] == "stopping" {
                m.s["lead"]["handoverPhase"] = json!("committing");
                emit(m, "commit-lead-handover");
            }
        }
        "lead.handover.committed"
            if m.s["lead"]["status"] == "handover"
                && m.s["lead"]["handoverPhase"] == "committing" =>
        {
            let target = text(&m.s["lead"], "handoverTo").to_owned();
            if eligible(m, &target) {
                m.s["lead"]["member"] = json!(target);
                m.s["lead"]["handoverTo"] = Value::Null;
                m.s["lead"]["handoverPhase"] = json!("none");
                resume(m);
            } else {
                decision(m, "lead-candidate-unavailable");
            }
        }
        "lead.quota.result" if m.s["lead"]["status"] == "holding" => {
            m.s["lead"]["hold"]["pollPending"] = json!(false);
            if e["available"] == true {
                resume(m);
            }
        }
        "lead.hold" if m.s["lead"]["status"] == "holding" && !m.s["lead"]["hold"].is_null() => {
            m.s["lead"]["hold"]["veto"] = json!(true);
            m.s["lead"]["hold"]["keepUntil"] = e["until"].clone();
        }
        "lead.reassign" => handover(m, text(e, "member"))?,
        _ => {}
    }
    Ok(())
}
pub(super) fn timer(m: &mut Machine) {
    if m.s["lead"]["status"] != "holding" {
        return;
    }
    let now = num(&m.s["run"], "now");
    if m.s["lead"]["retrying"] == true {
        if now >= num(&m.s["lead"], "retryAt") {
            resume(m);
        }
        return;
    }
    let h = m.s["lead"]["hold"].clone();
    if h.is_null() {
        return;
    }
    let veto = h["veto"] == true && (h["keepUntil"].is_null() || num(&h, "keepUntil") > now);
    if !veto && now >= num(&h, "handoverAt") {
        let candidate = list(&m.s, "members")
            .iter()
            .find(|member| member["id"] != m.s["lead"]["member"] && eligible(m, text(member, "id")))
            .map(|member| text(member, "id").to_owned());
        if let Some(member) = candidate {
            if handover(m, &member).is_err() {
                decision(m, "lead-candidate-unavailable");
            }
        } else {
            decision(m, "lead-candidate-unavailable");
        }
        return;
    }
    if now >= num(&h, "nextPollAt")
        && now >= num(&h, "resetAt")
        && h["pollPending"] == false
        && m.s["run"]["budgetAvailable"] == true
    {
        m.s["lead"]["hold"]["pollPending"] = json!(true);
        m.s["lead"]["hold"]["nextPollAt"] =
            json!(now.saturating_add(num(&m.s["timers"], "pollIntervalMs")));
        emit(m, "poll-lead");
    }
}
