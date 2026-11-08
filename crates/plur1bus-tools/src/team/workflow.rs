//! Conservative merge-trigger analysis over JSON supplied by the trusted shell.
use super::{glob, list, text};
use serde_json::{Map, Value};

const EVENTS: &[&str] = &[
    "push",
    "pull_request",
    "pull_request_target",
    "merge_group",
    "workflow_run",
    "workflow_dispatch",
    "workflow_call",
    "schedule",
    "release",
    "create",
    "delete",
    "issues",
    "issue_comment",
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

fn intersects(pattern: &str, branch: &str, section: bool) -> bool {
    !glob::valid(pattern)
        || !glob::valid(branch)
        || if section {
            glob::intersects(pattern, branch)
        } else {
            glob::matches(pattern, branch)
        }
}

// Unknown filters never prove a workflow cannot run. For a section language we
// discard it only when one exclusion covers the whole language; partial overlap
// remains possible deployment. More expressive GitHub globs are conservatively unknown.
fn branches(options: &Map<String, Value>, branch: &str, section: bool) -> bool {
    let read = |key| -> Result<Option<Vec<&str>>, ()> {
        options
            .get(key)
            .map(|v| {
                let values = v.as_array().ok_or(())?;
                if values.is_empty() {
                    return Err(());
                }
                values
                    .iter()
                    .map(|x| x.as_str().filter(|s| glob::valid(s)).ok_or(()))
                    .collect()
            })
            .transpose()
    };
    let (Ok(allow), Ok(deny)) = (read("branches"), read("branches-ignore")) else {
        return true;
    };
    if allow.is_some() && deny.is_some() {
        return true;
    }
    if let Some(allow) = allow {
        return allow.iter().any(|p| intersects(p, branch, section));
    }
    if let Some(deny) = deny {
        return !deny.iter().any(|p| {
            if section {
                *p == "**" || *p == branch
            } else {
                glob::matches(p, branch)
            }
        });
    }
    true
}

fn parsed(workflow: &Value) -> Option<Value> {
    let value: Value = serde_json::from_str(workflow["content"].as_str()?).ok()?;
    let root = value.as_object()?;
    if !root.contains_key("on")
        || !value["jobs"].is_object()
        || root.keys().any(|k| {
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
        })
    {
        return None;
    }
    Some(value)
}

fn triggers(value: &Value) -> Option<Vec<(&str, &Value)>> {
    let out: Vec<_> = match &value["on"] {
        Value::String(name) => vec![(name.as_str(), &Value::Null)],
        Value::Array(names) => names
            .iter()
            .map(|n| Some((n.as_str()?, &Value::Null)))
            .collect::<Option<_>>()?,
        Value::Object(events) => events.iter().map(|(k, v)| (k.as_str(), v)).collect(),
        _ => return None,
    };
    if out.is_empty() || out.iter().any(|(name, _)| !EVENTS.contains(name)) {
        return None;
    }
    Some(out)
}

struct Workflows {
    values: Vec<Option<Value>>,
}
impl Workflows {
    fn deploys(
        &self,
        index: usize,
        branch: &str,
        section: bool,
        visiting: &mut Vec<usize>,
        memo: &mut [Option<bool>],
    ) -> bool {
        if let Some(result) = memo[index] {
            return result;
        }
        if visiting.contains(&index) {
            return true;
        }
        let Some(value) = &self.values[index] else {
            return true;
        };
        let Some(triggers) = triggers(value) else {
            return true;
        };
        visiting.push(index);
        let result = triggers
            .into_iter()
            .any(|(name, options)| self.trigger(name, options, branch, section, visiting, memo));
        visiting.pop();
        memo[index] = Some(result);
        result
    }
    fn trigger(
        &self,
        name: &str,
        options: &Value,
        branch: &str,
        section: bool,
        visiting: &mut Vec<usize>,
        memo: &mut [Option<bool>],
    ) -> bool {
        if ![
            "push",
            "pull_request",
            "pull_request_target",
            "merge_group",
            "workflow_run",
        ]
        .contains(&name)
        {
            return false;
        }
        // Owner ruling: the shell never protects or queues section branches.
        if section && name == "merge_group" {
            return false;
        }
        let empty = Map::new();
        let options = if options.is_null() {
            &empty
        } else if let Some(v) = options.as_object() {
            v
        } else {
            return true;
        };
        let known: &[&str] = match name {
            "push" => &[
                "branches",
                "branches-ignore",
                "paths",
                "paths-ignore",
                "tags",
                "tags-ignore",
            ],
            "workflow_run" => &["branches", "branches-ignore", "types", "workflows"],
            "merge_group" => &["branches", "branches-ignore", "types"],
            _ => &[
                "branches",
                "branches-ignore",
                "paths",
                "paths-ignore",
                "types",
            ],
        };
        if options.keys().any(|k| !known.contains(&k.as_str())) {
            return true;
        }
        if !branches(options, branch, section) {
            return false;
        }
        if let Some(types) = options.get("types") {
            if !types.is_array()
                || types
                    .as_array()
                    .is_some_and(|a| a.is_empty() || a.iter().any(|t| !t.is_string()))
            {
                return true;
            }
        }
        if matches!(name, "pull_request" | "pull_request_target") {
            return options
                .get("types")
                .and_then(Value::as_array)
                .is_some_and(|types| types.iter().any(|t| t == "closed"));
        }
        if name != "workflow_run" {
            return true;
        }
        let Some(refs) = options.get("workflows").and_then(Value::as_array) else {
            return true;
        };
        if refs.is_empty() {
            return true;
        }
        refs.iter().any(|reference| {
            let Some(name) = reference.as_str().filter(|s| !s.is_empty()) else {
                return true;
            };
            let matches: Vec<_> = self
                .values
                .iter()
                .enumerate()
                .filter(|(_, v)| v.as_ref().is_some_and(|v| v["name"] == name))
                .map(|(i, _)| i)
                .collect();
            matches.len() != 1 || self.deploys(matches[0], branch, section, visiting, memo)
        })
    }
}

pub(super) fn reasons(
    workflows: &[Value],
    config: &Value,
    branch: &str,
    section: bool,
) -> Vec<String> {
    let parsed = Workflows {
        values: workflows.iter().map(parsed).collect(),
    };
    let mut reasons: Vec<_> = list(config, "deployBranches")
        .iter()
        .filter(|b| intersects(b.as_str().unwrap_or(""), branch, section))
        .map(|b| {
            format!(
                "configured deploy branch: {}",
                b.as_str().unwrap_or("unknown")
            )
        })
        .collect();
    let mut memo = vec![None; workflows.len()];
    reasons.extend(
        workflows
            .iter()
            .enumerate()
            .filter(|(i, _)| parsed.deploys(*i, branch, section, &mut Vec::new(), &mut memo))
            .map(|(_, w)| format!("deploying or unknown workflow: {}", text(w, "path"))),
    );
    reasons
}
