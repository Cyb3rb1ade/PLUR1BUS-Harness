use super::{glob, hash, list, num, text};
use crate::ToolError;
use serde_json::{json, Value};
use std::collections::{BTreeSet, VecDeque};

fn finding(kind: &str, p: &Value, other: Option<&Value>, detail: &str, blocking: bool) -> Value {
    let mut f = json!({"kind":kind,"package":p["key"],"detail":detail,"blocking":blocking});
    if let Some(other) = other {
        f["other"] = other["key"].clone();
    }
    f
}
fn graph(packages: &[Value]) -> Vec<Vec<usize>> {
    packages
        .iter()
        .map(|p| {
            list(p, "dependsOn")
                .iter()
                .filter_map(|d| packages.iter().position(|o| o["key"] == d["package"]))
                .collect()
        })
        .collect()
}
fn critical(
    packages: &[Value],
    deps: &[Vec<usize>],
    removed: Option<(usize, usize)>,
) -> Option<u64> {
    let mut done = vec![false; packages.len()];
    let mut end = vec![0_u64; packages.len()];
    for _ in packages {
        let mut progress = false;
        for i in 0..packages.len() {
            if done[i] {
                continue;
            }
            let ds: Vec<_> = deps[i]
                .iter()
                .filter(|&&d| removed != Some((i, d)))
                .copied()
                .collect();
            if ds.iter().all(|&d| done[d]) {
                end[i] = ds
                    .iter()
                    .map(|&d| end[d])
                    .max()
                    .unwrap_or(0)
                    .checked_add(num(&packages[i]["estimate"], "wallTimeMs"))?;
                done[i] = true;
                progress = true;
            }
        }
        if !progress {
            break;
        }
    }
    done.iter()
        .all(|v| *v)
        .then(|| end.into_iter().max().unwrap_or(0))
}
fn fanout(deps: &[Vec<usize>], source: usize) -> usize {
    let mut seen = BTreeSet::new();
    let mut q = VecDeque::from([source]);
    while let Some(n) = q.pop_front() {
        for (i, d) in deps.iter().enumerate() {
            if d.contains(&n) && i != source && seen.insert(i) {
                q.push_back(i)
            }
        }
    }
    seen.len()
}
// JSON is a YAML subset. Other workflow syntax stays unknown until a reviewed parser is added;
// an unknown/unreadable workflow is deliberately deployment-capable, never an allow signal.
fn workflow_deploys(workflow: &Value, branch: &str) -> bool {
    let Some(content) = workflow["content"].as_str() else {
        return true;
    };
    let Ok(value) = serde_json::from_str::<Value>(content) else {
        return true;
    };
    let Some(root) = value.as_object() else {
        return true;
    };
    if !root.contains_key("on") || !root.contains_key("jobs") {
        return true;
    }
    let known_events = [
        "push",
        "pull_request",
        "pull_request_target",
        "workflow_dispatch",
        "workflow_call",
        "workflow_run",
        "schedule",
        "release",
        "create",
        "delete",
        "issues",
        "issue_comment",
        "merge_group",
        "repository_dispatch",
        "check_run",
        "check_suite",
        "deployment",
        "deployment_status",
        "discussion",
        "discussion_comment",
        "fork",
        "gollum",
        "label",
        "milestone",
        "page_build",
        "public",
        "registry_package",
        "status",
        "watch",
    ];
    if root.keys().any(|k| {
        ![
            "name",
            "run-name",
            "on",
            "jobs",
            "permissions",
            "env",
            "defaults",
            "concurrency",
        ]
        .contains(&k.as_str())
    }) || !value["jobs"].is_object()
    {
        return true;
    }
    let on = &value["on"];
    let names: Vec<&str> = match on {
        Value::String(name) => vec![name],
        Value::Array(names) => names.iter().map(|n| n.as_str().unwrap_or("")).collect(),
        Value::Object(names) => names.keys().map(String::as_str).collect(),
        _ => return true,
    };
    if names.is_empty() || names.iter().any(|name| !known_events.contains(name)) {
        return true;
    }
    let push = match on {
        Value::String(s) => s == "push",
        Value::Array(events) => {
            if events.iter().any(|e| !e.is_string()) {
                return true;
            }
            events.iter().any(|e| e == "push")
        }
        Value::Object(events) => {
            if let Some(push) = events.get("push") {
                if push.is_null() {
                    true
                } else if let Some(options) = push.as_object() {
                    if options.keys().any(|k| {
                        !matches!(
                            k.as_str(),
                            "branches"
                                | "branches-ignore"
                                | "paths"
                                | "paths-ignore"
                                | "tags"
                                | "tags-ignore"
                        )
                    }) {
                        return true;
                    }
                    if let Some(branches) = options.get("branches") {
                        let Some(branches) = branches.as_array() else {
                            return true;
                        };
                        if branches
                            .iter()
                            .any(|b| !glob::valid(b.as_str().unwrap_or("")))
                        {
                            return true;
                        }
                        branches
                            .iter()
                            .any(|b| glob::matches(b.as_str().unwrap_or(""), branch))
                    } else {
                        true
                    }
                } else {
                    return true;
                }
            } else {
                false
            }
        }
        _ => return true,
    };
    if !push {
        return false;
    }
    // A push workflow is executable code and may deploy via an opaque action or script.
    // Without a proof of its effects, assume deployment even when its name says "test".
    true
}
fn closed_pattern(pattern: &str) -> bool {
    const CLOSED: &[&str] = &[
        "**/migrations/**",
        "**/migration/**",
        ".github/**",
        ".gitlab-ci.yml",
        "**/Dockerfile",
        "**/Containerfile",
        "containers/**",
        "deploy/**",
        "infra/**",
        "infrastructure/**",
        "terraform/**",
        "**/release/**",
        "**/publish/**",
        "**/permissions/**",
        "**/rbac/**",
        "**/auth/**",
        "**/authorization/**",
        "**/acl/**",
        "**/.env",
        "**/kubernetes/**",
        "**/k8s/**",
        "**/helm/**",
        "**/secrets/**",
        "**/config/**",
        "**/config.schema.json",
        "**/package.json",
        "**/Cargo.toml",
        "**/.npmrc",
        "**/compose.yaml",
        "**/compose.yml",
        "**/CODEOWNERS",
        "**/branch-protection/**",
    ];
    !glob::valid(pattern)
        || CLOSED
            .iter()
            .any(|p| glob::intersects(&p.to_ascii_lowercase(), &pattern.to_ascii_lowercase()))
        || pattern.split('/').any(|s| {
            let s = s.to_ascii_lowercase();
            s.starts_with(".env")
                || s.contains("secret")
                || s.contains("deploy")
                || s.contains("migration")
                || s.contains("permission")
                || s.contains("release")
                || s.contains("publish")
                || s.contains("credential")
                || s.contains("branch-protection")
        })
}
pub(super) fn check(input: &Value) -> Result<Value, ToolError> {
    let plan = &input["plan"];
    let packages = list(plan, "packages");
    let sections = list(plan, "sections");
    let deps = graph(packages);
    let mut findings = Vec::new();
    let first = packages.first().ok_or_else(super::invalid)?;
    if packages
        .iter()
        .map(|p| text(p, "key"))
        .collect::<BTreeSet<_>>()
        .len()
        != packages.len()
        || sections
            .iter()
            .map(|s| text(s, "key"))
            .collect::<BTreeSet<_>>()
            .len()
            != sections.len()
    {
        findings.push(finding("invalid-plan", first, None, "duplicate key", true));
    }
    let critical_path = critical(packages, &deps, None);
    if critical_path.is_none() {
        findings.push(finding(
            "cycle",
            first,
            None,
            "cyclic dependency or critical-path overflow",
            true,
        ));
    }
    for s in sections {
        let expected: BTreeSet<_> = packages
            .iter()
            .filter(|p| p["section"] == s["key"])
            .map(|p| text(p, "key"))
            .collect();
        let order = list(s, "mergeOrder");
        let actual: BTreeSet<_> = order.iter().filter_map(Value::as_str).collect();
        if expected != actual || actual.len() != order.len() {
            findings.push(finding(
                "merge-order",
                first,
                None,
                "section merge order must contain each package exactly once",
                true,
            ));
        }
    }
    let mut overlaps = 0;
    for (i, p) in packages.iter().enumerate() {
        let section = sections.iter().position(|s| s["key"] == p["section"]);
        if section.is_none() || serde_json::to_vec(p).map_err(|_| super::invalid())?.len() > 2000 {
            findings.push(finding(
                "invalid-plan",
                p,
                None,
                "unknown section or D104 brief exceeds 2000 UTF-8 bytes",
                true,
            ));
        }
        if text(p, "taskClass").starts_with("code-")
            && !list(p, "checks")
                .iter()
                .any(|c| matches!(text(c, "kind"), "command" | "tests"))
        {
            findings.push(finding(
                "missing-check",
                p,
                None,
                "coding package requires command or tests check",
                true,
            ));
        }
        if list(p, "checks")
            .iter()
            .any(|c| num(c, "criterion") as usize >= list(p, "doneWhen").len())
        {
            findings.push(finding(
                "invalid-plan",
                p,
                None,
                "check criterion is outside doneWhen",
                true,
            ));
        }
        if list(p, "dependsOn")
            .iter()
            .map(|d| text(d, "package"))
            .collect::<BTreeSet<_>>()
            .len()
            != list(p, "dependsOn").len()
        {
            findings.push(finding(
                "invalid-plan",
                p,
                None,
                "duplicate dependency",
                true,
            ));
        }
        for d in list(p, "dependsOn") {
            let Some((j, other)) = packages
                .iter()
                .enumerate()
                .find(|(_, o)| o["key"] == d["package"])
            else {
                findings.push(finding("invalid-plan", p, None, "unknown dependency", true));
                continue;
            };
            let before = sections.iter().position(|s| s["key"] == other["section"]);
            if before > section {
                findings.push(finding(
                    "later-section",
                    p,
                    Some(other),
                    "dependency in later section",
                    true,
                ));
            }
            if before == section {
                if let Some(s) = section {
                    let order = list(&sections[s], "mergeOrder");
                    let a = order.iter().position(|k| k == &other["key"]);
                    let b = order.iter().position(|k| k == &p["key"]);
                    if a.is_none() || b.is_none() || a >= b {
                        findings.push(finding(
                            "merge-order",
                            p,
                            Some(other),
                            "dependency must merge first",
                            true,
                        ));
                    }
                }
            }
            let justified = !text(d, "reason").trim().is_empty();
            let crossing = list(&p["interfaces"], "consumes")
                .iter()
                .any(|c| list(&other["interfaces"], "provides").contains(c));
            let carries = list(d, "carries").iter().any(|c| {
                !text(c, "value").trim().is_empty()
                    && (text(c, "kind") == "symbol"
                        || (glob::valid(text(c, "value")) && !text(c, "value").contains('*')))
            });
            let false_edge = if text(d, "kind") == "order" {
                !justified
            } else {
                !crossing && !carries
            };
            if false_edge {
                let mut f = finding(
                    "false-edge",
                    p,
                    Some(other),
                    "no crossing interface, carried artifact, or order reason",
                    !justified,
                );
                f["savedWallTimeMs"] = json!(critical_path
                    .unwrap_or(0)
                    .saturating_sub(critical(packages, &deps, Some((i, j))).unwrap_or(0)));
                findings.push(f);
            }
        }
        for other in packages.iter().skip(i + 1) {
            if list(p, "owns")
                .iter()
                .filter(|o| text(o, "mode") == "own")
                .any(|a| {
                    list(other, "owns")
                        .iter()
                        .filter(|o| text(o, "mode") == "own")
                        .any(|b| glob::intersects(text(a, "glob"), text(b, "glob")))
                })
            {
                overlaps += 1;
                findings.push(finding(
                    "own-overlap",
                    p,
                    Some(other),
                    "exclusive ownership languages intersect",
                    true,
                ));
            }
        }
        if list(p, "owns")
            .iter()
            .any(|o| !glob::valid(text(o, "glob")))
        {
            findings.push(finding(
                "invalid-plan",
                p,
                None,
                "invalid ownership path",
                true,
            ));
        }
    }
    let config = &input["config"];
    let branch = text(plan, "targetBranch");
    let deploy = list(config, "deployBranches").iter().any(|b| {
        !glob::valid(b.as_str().unwrap_or("")) || glob::matches(b.as_str().unwrap_or(""), branch)
    }) || list(input, "workflows")
        .iter()
        .any(|w| workflow_deploys(w, branch));
    let unknown_files = list(input, "files")
        .iter()
        .any(|f| !glob::valid(text(f, "path")) || text(f, "path").contains('*'));
    let lanes: Vec<_> = packages
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let mut reasons = Vec::new();
            if p["dataDeletion"] == true {
                reasons.push("data deletion")
            };
            if deploy {
                reasons.push("deploying or unknown workflow/branch")
            };
            if unknown_files {
                reasons.push("ambiguous path")
            }
            if list(p, "owns").iter().any(|o| {
                closed_pattern(text(o, "glob"))
                    || list(config, "closedPaths").iter().any(|g| {
                        !glob::valid(g.as_str().unwrap_or(""))
                            || glob::intersects(text(o, "glob"), g.as_str().unwrap_or(""))
                    })
            }) {
                reasons.push("protected path class")
            }
            let lane = if !reasons.is_empty() {
                "closed"
            } else if fanout(&deps, i) >= 5 {
                reasons.push("impact fan-out at least five");
                "wide"
            } else if list(input, "files").iter().any(|f| {
                f.get("section").is_some()
                    && f["section"] != p["section"]
                    && list(p, "owns")
                        .iter()
                        .any(|o| glob::matches(text(o, "glob"), text(f, "path")))
            }) {
                reasons.push("file outside own section");
                "wide"
            } else {
                "contained"
            };
            json!({"package":p["key"],"lane":lane,"reasons":reasons})
        })
        .collect();
    let pairs = packages.len() * (packages.len() - 1) / 2;
    Ok(
        json!({"planHash":hash(plan),"policyHash":hash(config),"findings":findings,"lanes":lanes,"overlapScore":if overlaps==0{json!(0)}else{json!(f64::from(overlaps)/pairs as f64)},"criticalPathMs":critical_path.unwrap_or(0)}),
    )
}
