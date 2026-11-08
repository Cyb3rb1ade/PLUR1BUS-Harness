//! Pure event application followed by deterministic admission and merge proposals.
use super::{action::Machine, invalid, list, num, state, text};
use crate::ToolError;
use serde_json::{json, Value};

pub(super) fn next(input: &Value) -> Result<Value, ToolError> {
    let original = &input["state"];
    let e = &input["event"];
    state::validate(original)?;
    let unchanged = || Ok(json!({"state":original,"actions":[]}));
    if num(e, "seq") <= num(&original["run"], "lastEventSeq") {
        return unchanged();
    }
    let package = if e.get("package").is_some() {
        Some(
            list(original, "packages")
                .iter()
                .position(|p| p["key"] == e["package"])
                .ok_or_else(invalid)?,
        )
    } else {
        None
    };
    if let Some(i) = package {
        if e["writerEpoch"] != original["packages"][i]["writerEpoch"] {
            return unchanged();
        }
    }
    if e.get("leadEpoch").is_some() && e["leadEpoch"] != original["lead"]["epoch"] {
        return unchanged();
    }
    if num(e, "at") < num(&original["run"], "now") {
        return Err(invalid());
    }
    if matches!(
        text(&original["run"], "status"),
        "cancelled" | "done" | "failed"
    ) {
        return unchanged();
    }
    let mut m = Machine {
        s: original.clone(),
        actions: Vec::new(),
        seq: num(e, "seq"),
    };
    m.s["run"]["lastEventSeq"] = e["seq"].clone();
    m.s["run"]["now"] = e["at"].clone();
    m.s["counters"]["transitions"] = json!(num(&m.s["counters"], "transitions") + 1);
    if let Some(i) = package {
        package_event(&mut m, e, i)?;
    } else {
        run_event(&mut m, e)?;
    }
    pump(&mut m);
    m.s["counters"]["personPending"] = json!(state::pending(&m.s));
    Ok(json!({"state":m.s,"actions":m.actions}))
}
fn bound(m: &Machine, e: &Value) -> bool {
    ["planHash", "checkHash", "compositionHash", "policyHash"]
        .iter()
        .all(|key| m.s["run"][key] == e[key])
}
fn run_event(m: &mut Machine, e: &Value) -> Result<(), ToolError> {
    if text(e, "kind").starts_with("lead.") {
        return super::lead::event(m, e);
    }
    match text(e, "kind") {
        "plan.approved" | "scope.extended" => {
            if !bound(m, e) || e["scope"]["kind"] == "auto" && m.s["run"]["autoAllowed"] != true {
                return Err(invalid());
            }
            let previous = m.s["run"]["scope"].clone();
            let allowed: Vec<_> = (0..list(&m.s, "packages").len())
                .filter(|&i| state::scoped(&m.s, i))
                .collect();
            m.s["run"]["scope"] = e["scope"].clone();
            if !(0..list(&m.s, "packages").len()).any(|i| state::scoped(&m.s, i))
                || text(e, "kind") == "scope.extended"
                    && (previous.is_null() || allowed.iter().any(|&i| !state::scoped(&m.s, i)))
            {
                return Err(invalid());
            }
            m.s["run"]["approved"] = json!(true);
            m.s["run"]["status"] = json!(if m.s["run"]["manualPaused"] == true
                || m.s["lead"]["status"] != "active"
            {
                "paused"
            } else {
                "running"
            });
        }
        "team.pause" => {
            m.s["run"]["manualPaused"] = json!(true);
            m.quiesce(None);
            m.s["run"]["status"] = json!("paused");
            for i in 0..list(&m.s, "packages").len() {
                if matches!(
                    text(&m.s["packages"][i], "status"),
                    "writing" | "fixing" | "syncing"
                ) {
                    m.stop(i);
                    m.status(i, "interrupted");
                }
            }
            m.emit("pause", json!({"target":m.s["run"]["id"]}));
        }
        "team.resume" => {
            m.s["run"]["manualPaused"] = json!(false);
            if m.s["lead"]["status"] == "needs-decision" && m.s["lead"]["stopPending"] != true {
                m.s["lead"]["status"] = json!("active");
                m.s["lead"]["personPending"] = json!(false);
                let id = text(&m.s["run"], "id").to_owned();
                m.note("lead-turn", &id, "human-resume-lead");
            }
            if m.s["run"]["approved"] == true
                && m.s["run"]["budgetAvailable"] == true
                && m.s["lead"]["status"] == "active"
            {
                m.s["run"]["status"] = json!("running");
            }
        }
        "team.cancel" => {
            m.s["run"]["status"] = json!("cancelled");
            for i in 0..list(&m.s, "packages").len() {
                if !state::terminal(&m.s["packages"][i]) {
                    m.stop(i);
                    m.status(i, "cancelled");
                    m.s["packages"][i]["personPending"] = json!(false);
                    m.dequeue(i);
                }
            }
            m.emit("cancel", json!({"target":m.s["run"]["id"]}));
        }
        "disk.measured" => m.s["disk"]["freeBytes"] = e["freeBytes"].clone(),
        "capacity.changed" => {
            m.s["capacity"] =
                json!({"maxWriters":e["maxWriters"],"computedWriters":e["computedWriters"]});
            if num(e, "maxWriters") > num(e, "computedWriters") {
                let id = text(&m.s["run"], "id").to_owned();
                m.note("notify", &id, "capacity-exceeded");
            }
        }
        "timer" => {
            super::lead::timer(m);
            timers(m);
        }
        "budget.refused" => match text(e, "scope") {
            "run" => {
                m.quiesce(None);
                m.s["run"]["budgetAvailable"] = json!(false);
                m.s["run"]["status"] = json!("paused");
                m.emit("pause", json!({"target":m.s["run"]["id"]}));
            }
            "section" => {
                let j = list(&m.s, "sections")
                    .iter()
                    .position(|s| s["key"] == e["target"])
                    .ok_or_else(invalid)?;
                m.quiesce(Some(j));
                m.s["sections"][j]["budgetAvailable"] = json!(false);
                m.s["sections"][j]["status"] = json!("paused");
                m.emit("pause", json!({"target":e["target"]}));
            }
            other => {
                let i = list(&m.s, "packages")
                    .iter()
                    .position(|p| p["key"] == e["target"])
                    .ok_or_else(invalid)?;
                if other == "package" {
                    m.s["packages"][i]["budgetAvailable"] = json!(false);
                    m.decision(i, "package-budget");
                } else {
                    m.hold(i, other == "agent", num(e, "resetAt"));
                }
            }
        },
        "budget.changed" => match text(e, "scope") {
            "run" => m.s["run"]["budgetAvailable"] = e["available"].clone(),
            "section" => {
                let j = list(&m.s, "sections")
                    .iter()
                    .position(|s| s["key"] == e["target"])
                    .ok_or_else(invalid)?;
                m.s["sections"][j]["budgetAvailable"] = e["available"].clone();
                if e["available"] == true && m.s["sections"][j]["status"] == "paused" {
                    m.s["sections"][j]["status"] = json!("open");
                }
            }
            "package" => {
                let i = list(&m.s, "packages")
                    .iter()
                    .position(|p| p["key"] == e["target"])
                    .ok_or_else(invalid)?;
                m.s["packages"][i]["budgetAvailable"] = e["available"].clone();
            }
            _ => return Err(invalid()),
        },
        "section.summary"
        | "team.section.merge"
        | "section.merge.done"
        | "section.merge.conflict" => section_event(m, e)?,
        "restart" => {
            if e["reconciled"] != true {
                m.s["run"]["status"] = json!("paused");
                m.emit("pause", json!({"target":m.s["run"]["id"]}));
                return Ok(());
            }
            for i in 0..list(&m.s, "packages").len() {
                let p = m.s["packages"][i].clone();
                if !list(e, "livePackages").contains(&p["key"])
                    && matches!(
                        text(&p, "status"),
                        "writing" | "fixing" | "syncing" | "checking" | "reviewing"
                    )
                {
                    m.s["packages"][i]["writerEpoch"] = json!(num(&p, "writerEpoch") + 1);
                    m.invalidate(i);
                    m.status(i, "interrupted");
                } else if p["status"] == "merging" {
                    m.status(i, "queued");
                }
            }
            // In-flight outbox actions are replayed by PT-4b before this reconciled event.
        }
        _ => return Err(invalid()),
    }
    Ok(())
}
fn package_event(m: &mut Machine, e: &Value, i: usize) -> Result<(), ToolError> {
    let p = m.s["packages"][i].clone();
    let status = text(&p, "status");
    let kind = text(e, "kind");
    if state::terminal(&p) {
        return Ok(());
    }
    if kind == "writer.stopped" {
        m.s["packages"][i]["stopPending"] = json!(false);
    }
    if matches!(status, "needs-decision" | "blocked") && kind != "person.decided" {
        return Ok(());
    }
    match kind {
        "worktree.ready" if status == "ready" => {
            m.s["packages"][i]["worktreeReady"] = json!(true);
            m.status(i, "interrupted");
        }
        "worktree.unavailable" => {
            m.stop(i);
            m.invalidate(i);
            m.status(i, "blocked");
            m.s["packages"][i]["worktreeReady"] = json!(false);
            let key = text(&p, "key");
            m.note("ask-person", key, "worktree-unavailable");
            m.s["packages"][i]["personPending"] = json!(true);
        }
        "worker.returned" if matches!(status, "writing" | "fixing") => {
            m.s["packages"][i]["rateLimitExhaustions"] = json!(0);
            m.invalidate(i);
            m.s["packages"][i]["treeHash"] = e["treeHash"].clone();
            m.s["packages"][i]["workerMet"] = e["met"].clone();
            if e["committedClean"] != true {
                m.fix(i, "uncommitted-return");
                return Ok(());
            }
            if p["syncPending"] == true && m.s["packages"][i]["syncMode"] != "notify-only" {
                m.s["packages"][i]["syncReturnStatus"] = json!("checking");
                m.status(i, "syncing");
                m.package_action("sync-worktree", i);
            } else {
                m.status(i, "checking");
                m.package_action("run-checks", i);
            }
        }
        "checks.finished" if status == "checking" => {
            let j = state::section(&m.s, i).ok_or_else(invalid)?;
            if p["treeHash"] != e["treeHash"] || m.s["sections"][j]["head"] != e["sectionHead"] {
                m.invalidate(i);
                m.package_action("run-checks", i);
                return Ok(());
            }
            m.s["packages"][i]["checks"] = e["checks"].clone();
            m.s["packages"][i]["checksTree"] = e["treeHash"].clone();
            m.s["packages"][i]["checksHead"] = e["sectionHead"].clone();
            if p["resumeAfterChecks"] == true && state::checks_executable_green(&m.s, i) {
                m.s["packages"][i]["resumeAfterChecks"] = json!(false);
                m.s["packages"][i]["writerEpoch"] = json!(num(&p, "writerEpoch") + 1);
                m.start(i, true);
            } else if state::checks_green(&m.s, i) {
                m.review(i);
            } else {
                m.fix(i, "checks-failed-or-unavailable");
            }
        }
        "review.verdict" if status == "reviewing" => {
            if e["treeHash"] != p["treeHash"] || !state::checks_green(&m.s, i) {
                return Ok(());
            }
            m.s["packages"][i]["reviewRounds"] = json!(num(&p, "reviewRounds") + 1);
            if e["disputed"] == true {
                m.s["packages"][i]["hasDispute"] = json!(true);
                m.s["packages"][i]["disputes"] = json!(if p["lastFinding"] == e["findingHash"] {
                    num(&p, "disputes") + 1
                } else {
                    1
                });
            }
            if (e["verdict"] == "pass" && e["disputed"] == false && e["findingHash"].is_null())
                || list(&p, "acceptedFindings").contains(&e["findingHash"])
            {
                m.s["packages"][i]["reviewTree"] = e["treeHash"].clone();
                m.status(i, "queued");
                if let Some(q) = m.s["mergeQueue"].as_array_mut() {
                    q.push(p["key"].clone());
                }
            } else {
                let repeated =
                    if !e["findingHash"].is_null() && e["findingHash"] == p["lastFinding"] {
                        num(&p, "sameFindingRounds") + 1
                    } else {
                        1
                    };
                m.s["packages"][i]["sameFindingRounds"] = json!(repeated);
                m.s["packages"][i]["lastFinding"] = e["findingHash"].clone();
                if num(&m.s["packages"][i], "reviewRounds") >= 5
                    || repeated >= 3
                    || num(&m.s["packages"][i], "disputes") >= 2
                {
                    m.decision(i, "review-needs-decision");
                } else {
                    m.fix(i, "review-findings");
                }
            }
        }
        "team.merge.confirm" if status == "queued" => {
            let j = state::section(&m.s, i).ok_or_else(invalid)?;
            if p["treeHash"] == e["treeHash"]
                && m.s["sections"][j]["head"] == e["sectionHead"]
                && state::checks_green(&m.s, i)
                && p["reviewTree"] == p["treeHash"]
            {
                m.s["packages"][i]["mergeConfirmation"] =
                    json!({"treeHash":e["treeHash"],"sectionHead":e["sectionHead"]});
                m.s["packages"][i]["personPending"] = json!(false);
            }
        }
        "package.merge.done" if status == "merging" && e["treeHash"] == p["treeHash"] => {
            let j = state::section(&m.s, i).ok_or_else(invalid)?;
            m.status(i, "merged-to-section");
            m.dequeue(i);
            m.s["sections"][j]["head"] = e["sectionHead"].clone();
            m.package_action("remove-worktree", i);
            for k in 0..list(&m.s, "packages").len() {
                if k == i || state::terminal(&m.s["packages"][k]) {
                    continue;
                }
                m.s["packages"][k]["mergeConfirmation"] = Value::Null;
                if list(e, "affected").contains(&m.s["packages"][k]["key"]) {
                    m.s["packages"][k]["syncPending"] = json!(true);
                    let key = text(&m.s["packages"][k], "key").to_owned();
                    m.note("post-message", &key, "section-merge-impact");
                }
            }
        }
        "package.merge.conflict" if status == "merging" => m.fix(i, "merge-conflict"),
        "safe-point"
            if matches!(status, "writing" | "fixing")
                && p["syncPending"] == true
                && e["committedClean"] == true
                && m.s["packages"][i]["syncMode"] == "auto" =>
        {
            m.s["packages"][i]["syncReturnStatus"] = json!(status);
            m.invalidate(i);
            m.status(i, "syncing");
            m.package_action("sync-worktree", i);
        }
        "sync.finished" if status == "syncing" => {
            m.s["packages"][i]["resumeAfterChecks"] = json!(p["syncReturnStatus"] != "checking");
            m.invalidate(i);
            m.s["packages"][i]["syncPending"] = json!(false);
            m.s["packages"][i]["treeHash"] = e["treeHash"].clone();
            m.status(i, "checking");
            m.package_action("run-checks", i);
        }
        "sync.conflict" if status == "syncing" => {
            let count = num(&p, "syncConflicts") + 1;
            m.s["packages"][i]["syncConflicts"] = json!(count);
            if count >= 2 || e["outsideOwns"] == true {
                m.decision(i, "sync-conflict");
            } else {
                m.fix(i, "sync-conflict");
            }
        }
        "person.decided" if status == "needs-decision" || status == "blocked" => {
            m.s["packages"][i]["personPending"] = json!(false);
            match text(e, "decision") {
                "cancel" => {
                    m.stop(i);
                    m.status(i, "cancelled");
                    m.dequeue(i);
                }
                "accept-residual" => {
                    if !p["lastFinding"].is_null()
                        && !list(&p, "acceptedFindings").contains(&p["lastFinding"])
                    {
                        if let Some(findings) =
                            m.s["packages"][i]["acceptedFindings"].as_array_mut()
                        {
                            findings.push(p["lastFinding"].clone());
                        }
                    }
                    m.s["packages"][i]["checks"] = json!([]);
                    m.invalidate(i);
                    m.status(i, "interrupted");
                }
                "retry" | "resume" => {
                    m.invalidate(i);
                    m.status(i, "interrupted");
                }
                _ => return Err(invalid()),
            }
        }
        "failure" => failure(m, e, i),
        "quota.result" if status == "holding" => {
            m.s["packages"][i]["hold"]["pollPending"] = json!(false);
            if e["available"] == true {
                m.s["packages"][i]["hold"] = Value::Null;
                m.status(i, "interrupted");
            }
        }
        "person.hold" if status == "holding" => {
            m.s["packages"][i]["hold"]["veto"] = json!(true);
            m.s["packages"][i]["hold"]["keepUntil"] = e["until"].clone();
        }
        "person.reassign" => {
            if m.eligible_role(i, text(e, "member"), text(&p, "activeRole")) {
                m.begin_handover(i, text(e, "member"));
            } else {
                return Err(invalid());
            }
        }
        "writer.stopped" if status == "handover" && p["handoverPhase"] == "stopping" => {
            m.s["packages"][i]["handoverPhase"] = json!("committing");
            m.package_action("commit-handover", i);
        }
        "handover.committed" if status == "handover" && p["handoverPhase"] == "committing" => {
            let target = text(&p, "handoverTo");
            if m.eligible_role(i, target, text(&p, "activeRole")) {
                let field = if p["activeRole"] == "reviewer" {
                    "reviewer"
                } else {
                    "writer"
                };
                m.s["packages"][i][field] = json!(target);
                m.s["packages"][i]["handoverTo"] = Value::Null;
                m.s["packages"][i]["handoverPhase"] = json!("none");
                m.status(i, "interrupted");
            } else {
                m.decision(i, "handover-candidate-unavailable");
            }
        }
        "package.sync.set" => {
            m.s["packages"][i]["syncMode"] = e["mode"].clone();
        }

        _ => {}
    }
    Ok(())
}
fn failure(m: &mut Machine, e: &Value, i: usize) {
    let p = m.s["packages"][i].clone();
    if e["role"] != p["activeRole"] {
        return;
    }
    let mut class = text(e, "class");
    if class != "rate-limit" {
        m.s["packages"][i]["rateLimitExhaustions"] = json!(0);
    }
    if class == "rate-limit" {
        if e["retryBudgetExhausted"] == true {
            m.s["packages"][i]["rateLimitExhaustions"] = json!(num(&p, "rateLimitExhaustions") + 1)
        }
        class = if num(e, "retryAfterMs") >= num(&m.s["timers"], "pollIntervalMs")
            || num(&m.s["packages"][i], "rateLimitExhaustions") >= 2
        {
            "quota"
        } else {
            "transient"
        };
    }
    match class {
        "quota" => m.hold(
            i,
            true,
            num(&m.s["run"], "now").saturating_add(num(e, "retryAfterMs")),
        ),
        "permission" => {
            m.stop(i);
            m.status(i, "blocked");
            m.s["packages"][i]["personPending"] = json!(true);
            m.note("ask-person", text(&p, "key"), "permission");
        }
        "auth" => m.decision(i, "authentication"),
        "crash" => {
            if num(&p, "crashRetries") >= 1 {
                m.decision(i, "repeated-crash");
            } else {
                m.s["packages"][i]["crashRetries"] = json!(1);
                let member = if p["activeRole"] == "reviewer" {
                    text(&p, "reviewer")
                } else {
                    text(&p, "writer")
                };
                m.begin_handover(i, member);
            }
        }
        "deterministic" => {
            if e["canContinue"] == true {
                m.stop(i);
                m.status(i, "interrupted");
                m.note("notify", text(&p, "key"), "partial-result-retained");
            } else {
                m.decision(i, "deterministic-failure");
            }
        }
        _ => {
            if num(&p, "retries") >= num(&m.s["timers"], "retryLimit") {
                m.decision(i, "retry-exhausted");
            } else {
                m.s["packages"][i]["retries"] = json!(num(&p, "retries") + 1);
                m.s["packages"][i]["retryAt"] = json!(num(&m.s["run"], "now").saturating_add(
                    num(e, "retryAfterMs").max(1000_u64 << num(&p, "retries").min(16))
                ));
                m.stop(i);
                m.status(i, "interrupted");
            }
        }
    }
}
fn timers(m: &mut Machine) {
    if m.s["run"]["status"] != "running" {
        return;
    }
    let now = num(&m.s["run"], "now");
    for i in 0..list(&m.s, "packages").len() {
        let p = m.s["packages"][i].clone();
        if p["status"] != "holding" {
            continue;
        }
        let h = &p["hold"];
        let veto = h["veto"] == true && (h["keepUntil"].is_null() || num(h, "keepUntil") > now);
        if h["allowHandover"] == true && !veto && now >= num(h, "handoverAt") {
            let candidate = list(&m.s, "members")
                .iter()
                .find(|member| {
                    member["id"] != p["writer"]
                        && member["id"] != p["reviewer"]
                        && m.eligible_role(i, text(member, "id"), text(&p, "activeRole"))
                })
                .map(|member| text(member, "id").to_owned());
            if let Some(member) = candidate {
                m.begin_handover(i, &member);
            } else {
                m.decision(i, "no-handover-candidate");
            }
            continue;
        }
        if now >= num(h, "nextPollAt")
            && now >= num(h, "resetAt")
            && h["pollPending"] == false
            && m.s["run"]["budgetAvailable"] == true
            && p["budgetAvailable"] == true
        {
            m.s["packages"][i]["hold"]["nextPollAt"] =
                json!(now.saturating_add(num(&m.s["timers"], "pollIntervalMs")));
            m.s["packages"][i]["hold"]["pollPending"] = json!(true);
            m.package_action("poll-quota", i);
        }
    }
}
fn section_event(m: &mut Machine, e: &Value) -> Result<(), ToolError> {
    let j = list(&m.s, "sections")
        .iter()
        .position(|s| s["key"] == e["section"])
        .ok_or_else(invalid)?;
    let section = m.s["sections"][j].clone();
    match text(e, "kind") {
        "section.summary"
            if section["status"] == "summarizing" && e["treeHash"] == section["head"] =>
        {
            m.s["sections"][j]["summaryTree"] = e["treeHash"].clone();
            m.s["sections"][j]["status"] = json!("awaiting-merge");
        }
        "team.section.merge"
            if section["status"] == "awaiting-merge"
                && e["treeHash"] == section["head"]
                && e["targetHead"] == section["targetHead"] =>
        {
            m.s["sections"][j]["confirmation"] =
                json!({"treeHash":e["treeHash"],"targetHead":e["targetHead"]});
            m.s["sections"][j]["personPending"] = json!(false);
        }
        "section.merge.done"
            if section["status"] == "merging" && e["treeHash"] == section["head"] =>
        {
            m.s["sections"][j]["status"] = json!("merged");
            m.s["sections"][j]["personPending"] = json!(false);
            for k in 0..list(&m.s, "sections").len() {
                m.s["sections"][k]["targetHead"] = e["targetHead"].clone();
                m.s["sections"][k]["confirmation"] = Value::Null;
            }
        }
        "section.merge.conflict" if section["status"] == "merging" => {
            m.s["sections"][j]["status"] = json!("awaiting-merge");
            m.s["sections"][j]["confirmation"] = Value::Null;
            m.s["sections"][j]["personPending"] = json!(true);
            m.note(
                "ask-person",
                text(&section, "key"),
                "section-merge-conflict",
            );
        }
        _ => {}
    }
    Ok(())
}
fn pump(m: &mut Machine) {
    if m.s["run"]["status"] != "running"
        || m.s["run"]["approved"] != true
        || m.s["lead"]["status"] != "active"
        || m.s["run"]["manualPaused"] == true
        || m.s["run"]["budgetAvailable"] != true
    {
        return;
    }
    // Stable plan order, not event delivery order, decides admission and section merge proposals.
    for j in 0..list(&m.s, "sections").len() {
        let section = m.s["sections"][j].clone();
        if section["status"] == "paused" || section["budgetAvailable"] != true {
            continue;
        }
        let order = list(&m.s["plan"], "sections")
            .iter()
            .find(|s| s["key"] == section["key"])
            .map(|s| list(s, "mergeOrder").to_vec())
            .unwrap_or_default();
        for key in order {
            let Some(i) = list(&m.s, "packages").iter().position(|p| p["key"] == key) else {
                continue;
            };
            let p = m.s["packages"][i].clone();
            if matches!(text(&p, "status"), "merged-to-section" | "decided") {
                continue;
            }
            if p["status"] != "queued" || p["budgetAvailable"] != true {
                break;
            }
            if !state::checks_green(&m.s, i) || p["reviewTree"] != p["treeHash"] {
                break;
            }
            if p["syncPending"] == true && m.s["packages"][i]["syncMode"] != "notify-only" {
                m.invalidate(i);
                m.s["packages"][i]["syncReturnStatus"] = json!("checking");
                m.status(i, "syncing");
                m.package_action("sync-worktree", i);
                break;
            }
            if p["checksHead"] != section["head"] {
                m.invalidate(i);
                m.status(i, "checking");
                m.package_action("run-checks", i);
                break;
            }
            let confirmed = p["mergeConfirmation"]["treeHash"] == p["treeHash"]
                && p["mergeConfirmation"]["sectionHead"] == section["head"];
            if confirmed || state::autonomous(&m.s, i) {
                m.status(i, "merging");
                m.s["packages"][i]["personPending"] = json!(false);
                m.emit("merge-into-section",json!({"package":key,"writerEpoch":p["writerEpoch"],"treeHash":p["treeHash"],"sectionHead":section["head"]}));
            } else if p["personPending"] != true {
                m.s["packages"][i]["personPending"] = json!(true);
                m.note(
                    "ask-person",
                    key.as_str().unwrap_or("package"),
                    "merge-confirmation",
                );
            }
            break;
        }
        let members: Vec<_> = (0..list(&m.s, "packages").len())
            .filter(|&i| state::section(&m.s, i) == Some(j))
            .collect();
        if !members.is_empty()
            && members.iter().all(|&i| {
                matches!(
                    text(&m.s["packages"][i], "status"),
                    "merged-to-section" | "decided"
                )
            })
        {
            if section["status"] == "open" {
                m.s["sections"][j]["status"] = json!("summarizing");
                m.note("lead-turn", text(&section, "key"), "section-summary");
            }
            if section["status"] == "awaiting-merge"
                && section["summaryTree"] == section["head"]
                && (0..j).all(|k| m.s["sections"][k]["status"] == "merged")
            {
                let closed = members
                    .iter()
                    .any(|&i| m.s["packages"][i]["lane"] == "closed");
                let confirmed = section["confirmation"]["treeHash"] == section["head"]
                    && section["confirmation"]["targetHead"] == section["targetHead"];
                if confirmed
                    || !closed
                        && m.s["run"]["targetDeploys"] == false
                        && m.s["run"]["scope"]["kind"] == "auto"
                        && members.iter().all(|&i| state::autonomous(&m.s, i))
                {
                    m.s["sections"][j]["status"] = json!("merging");
                    m.s["sections"][j]["personPending"] = json!(false);
                    m.emit("merge-section",json!({"section":section["key"],"treeHash":section["head"],"targetHead":section["targetHead"]}));
                } else if section["personPending"] != true {
                    m.s["sections"][j]["personPending"] = json!(true);
                    m.note(
                        "ask-person",
                        text(&section, "key"),
                        "section-merge-confirmation",
                    );
                }
            }
        }
    }
    for i in 0..list(&m.s, "packages").len() {
        let p = m.s["packages"][i].clone();
        if !matches!(text(&p, "status"), "planned" | "interrupted") {
            continue;
        }
        let Some(j) = state::section(&m.s, i) else {
            continue;
        };
        if list(state::plan(&m.s, i), "dependsOn").iter().any(|d| {
            list(&m.s, "packages").iter().any(|other| {
                other["key"] == d["package"]
                    && matches!(text(other, "status"), "failed" | "cancelled")
            })
        }) {
            m.status(i, "blocked");
            m.s["packages"][i]["personPending"] = json!(true);
            let key = text(&p, "key");
            m.note("lead-turn", key, "dependency-replan");
            continue;
        }
        if !state::scoped(&m.s, i)
            || !state::dependencies_ready(&m.s, i)
            || state::pending(&m.s) >= 3
            || m.s["sections"][j]["budgetAvailable"] != true
            || m.s["sections"][j]["status"] == "paused"
            || p["budgetAvailable"] != true
            || num(&m.s["disk"], "freeBytes") < num(&m.s["disk"], "minFreeBytes")
        {
            continue;
        }
        if list(&m.s, "packages")
            .iter()
            .filter(|p| state::active(p))
            .count()
            >= num(&m.s["capacity"], "maxWriters") as usize
            || !m.eligible_role(
                i,
                if p["activeRole"] == "reviewer" {
                    text(&p, "reviewer")
                } else {
                    text(&p, "writer")
                },
                text(&p, "activeRole"),
            )
        {
            continue;
        }
        if p["stopPending"] == true || num(&p, "retryAt") > num(&m.s["run"], "now") {
            continue;
        }
        if list(&m.s, "packages")
            .iter()
            .filter(|p| state::active(p))
            .count()
            >= num(&m.s["capacity"], "computedWriters") as usize
        {
            let id = text(&m.s["run"], "id").to_owned();
            m.note("notify", &id, "capacity-exceeded");
        }
        if p["worktreeReady"] == true {
            if p["activeRole"] == "reviewer" && state::checks_green(&m.s, i) {
                m.review(i);
            } else {
                m.start(i, true);
            }
        } else {
            m.status(i, "ready");
            m.package_action("create-worktree", i);
        }
    }
    if list(&m.s, "sections")
        .iter()
        .all(|s| s["status"] == "merged")
    {
        m.s["run"]["status"] = json!("done");
    }
}
