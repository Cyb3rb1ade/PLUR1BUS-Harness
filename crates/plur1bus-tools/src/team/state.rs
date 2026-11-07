//! Invariants and selectors over the schema-validated transition snapshot.
use super::{hash, invalid, list, num, text};
use crate::ToolError;
use serde_json::Value;
use std::collections::BTreeSet;
pub(super) fn validate(s: &Value) -> Result<(), ToolError> {
    if !s["run"]["targetDeploys"].is_boolean() {
        return Err(invalid());
    }
    if s["run"]["approved"] == true
        && (s["run"]["scope"].is_null()
            || (s["run"]["scope"]["kind"] == "auto" && s["run"]["autoAllowed"] != true))
    {
        return Err(invalid());
    }
    if !list(s, "members")
        .iter()
        .any(|m| m["id"] == s["lead"]["member"] && list(m, "roles").iter().any(|r| r == "lead"))
    {
        return Err(invalid());
    }
    let packages = list(s, "packages");
    let plans = list(&s["plan"], "packages");
    let sections = list(s, "sections");
    if s["run"]["planHash"] != hash(&s["plan"])
        || packages.len() != plans.len()
        || sections.len() != list(&s["plan"], "sections").len()
    {
        return Err(invalid());
    }
    for (rows, key) in [
        (packages, "key"),
        (sections, "key"),
        (list(s, "members"), "id"),
    ] {
        if rows
            .iter()
            .map(|p| text(p, key))
            .collect::<BTreeSet<_>>()
            .len()
            != rows.len()
        {
            return Err(invalid());
        }
    }
    if plans.iter().any(|p| {
        !packages.iter().any(|r| r["key"] == p["key"])
            || !sections.iter().any(|r| r["key"] == p["section"])
    }) || packages
        .iter()
        .any(|p| !list(s, "members").iter().any(|m| m["id"] == p["writer"]))
    {
        return Err(invalid());
    }
    if list(&s["plan"], "sections")
        .iter()
        .any(|planned| !sections.iter().any(|row| row["key"] == planned["key"]))
    {
        return Err(invalid());
    }
    if packages.iter().any(|p| {
        (!p["reviewer"].is_null()
            && (p["reviewer"] == p["writer"]
                || !list(s, "members").iter().any(|m| {
                    m["id"] == p["reviewer"]
                        && list(m, "roles").iter().any(|role| role == "reviewer")
                })))
            || (p["activeRole"] == "reviewer" && p["reviewer"].is_null())
    }) {
        return Err(invalid());
    }
    if list(s, "mergeQueue")
        .iter()
        .any(|k| !packages.iter().any(|p| &p["key"] == k))
    {
        return Err(invalid());
    }
    if list(s, "mergeQueue")
        .iter()
        .filter_map(Value::as_str)
        .collect::<BTreeSet<_>>()
        .len()
        != list(s, "mergeQueue").len()
    {
        return Err(invalid());
    }
    Ok(())
}
pub(super) fn plan(s: &Value, i: usize) -> &Value {
    list(&s["plan"], "packages")
        .iter()
        .find(|p| p["key"] == s["packages"][i]["key"])
        .unwrap_or(&Value::Null)
}
pub(super) fn section(s: &Value, i: usize) -> Option<usize> {
    list(s, "sections")
        .iter()
        .position(|r| r["key"] == plan(s, i)["section"])
}
pub(super) fn scoped(s: &Value, i: usize) -> bool {
    let scope = &s["run"]["scope"];
    match text(scope, "kind") {
        "auto" | "plan" => true,
        "package" => scope["package"] == s["packages"][i]["key"],
        "section" => {
            let sections = list(&s["plan"], "sections");
            let through = sections.iter().position(|r| r["key"] == scope["through"]);
            let current = sections
                .iter()
                .position(|r| r["key"] == plan(s, i)["section"]);
            matches!((current,through),(Some(a),Some(b)) if a<=b)
        }
        _ => false,
    }
}
pub(super) fn active(p: &Value) -> bool {
    matches!(
        text(p, "status"),
        "ready"
            | "writing"
            | "fixing"
            | "checking"
            | "reviewing"
            | "syncing"
            | "holding"
            | "handover"
            | "merging"
    )
}
pub(super) fn terminal(p: &Value) -> bool {
    matches!(
        text(p, "status"),
        "merged-to-section" | "cancelled" | "failed" | "decided"
    )
}
pub(super) fn dependencies_ready(s: &Value, i: usize) -> bool {
    list(plan(s, i), "dependsOn").iter().all(|d| {
        list(s, "packages").iter().any(|p| {
            p["key"] == d["package"]
                && matches!(
                    text(p, "status"),
                    "queued" | "merging" | "merged-to-section" | "decided"
                )
        })
    })
}
pub(super) fn checks_executable_green(s: &Value, i: usize) -> bool {
    let p = &s["packages"][i];
    let checks = list(plan(s, i), "checks");
    let outcomes = list(p, "checks");
    if p["treeHash"].is_null() || p["treeHash"] != p["checksTree"] || checks.len() != outcomes.len()
    {
        return false;
    }
    if checks.iter().enumerate().any(|(idx, c)| {
        outcomes
            .iter()
            .filter(|o| {
                num(o, "checkIndex") == idx as u64
                    && o["criterion"] == c["criterion"]
                    && o["status"] == "passed"
            })
            .count()
            != 1
    }) {
        return false;
    }
    true
}
pub(super) fn checks_green(s: &Value, i: usize) -> bool {
    if !checks_executable_green(s, i) {
        return false;
    }
    let p = &s["packages"][i];
    let checks = list(plan(s, i), "checks");
    list(plan(s, i), "doneWhen")
        .iter()
        .enumerate()
        .all(|(idx, _)| {
            if checks.iter().any(|c| num(c, "criterion") == idx as u64) {
                true
            } else {
                list(p, "workerMet").get(idx) == Some(&Value::Bool(true))
            }
        })
}
pub(super) fn autonomous(s: &Value, i: usize) -> bool {
    let p = &s["packages"][i];
    if !scoped(s, i) || s["run"]["scope"]["kind"] == "package" || p["lane"] == "closed" {
        return false;
    }
    if p["lane"] == "wide" {
        return checks_green(s, i)
            && num(p, "fixRounds") <= 2
            && p["hasDispute"] == false
            && p["hadNeedsDecision"] == false
            && p["revertRate"].as_f64().is_some_and(|r| r < 0.1);
    }
    true
}
pub(super) fn pending(s: &Value) -> usize {
    usize::from(s["lead"]["personPending"] == true)
        + list(s, "packages")
            .iter()
            .filter(|p| p["personPending"] == true)
            .count()
        + list(s, "sections")
            .iter()
            .filter(|p| p["personPending"] == true)
            .count()
}
