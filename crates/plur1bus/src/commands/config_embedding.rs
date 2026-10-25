//! The memory engine's models in `plur1bus config set` (docs/embedding-migration.md). Before a change that touches them is
//! written, the running core says what it does (`admin.embedding.check`): a model the engine could not load is refused, a
//! change that keeps the vector space or lands on a store without data is written like any other, and one that moves a store
//! with data runs the re-embedding migration instead, in the foreground, or in the core's background with `--background`.
//! The migration's switch writes the new embedding, so the command itself writes nothing then. Without a core nothing can be
//! checked: the change is written as before and a warning says so, because a configuration the core cannot start with must
//! stay fixable from the CLI.
use crate::commands::memory::connect;
use crate::commands::memory_reembed::{call, describe_plan_then, start};
use crate::commands::module::confirm;
use crate::output::{say_err, Failure, Out};
use crate::paths::Layout;
use serde_json::{json, Value};
use std::time::Duration;

const METHOD: &str = "admin.embedding.check";
/// The check reads the configuration and the store directory; it never waits for the engine.
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);

fn within(key: &str, root: &str) -> bool {
    key == root
        || key
            .strip_prefix(root)
            .is_some_and(|rest| rest.starts_with('.'))
}

/// Keys that can change the embedding's vector space.
fn touches_embedding(changes: &[(String, Value)]) -> bool {
    changes
        .iter()
        .any(|(k, _)| k == "engine" || within(k, "engine.embedding"))
}

/// Keys a change sets beside the embedding (`engine` given as a whole object). A move writes only the embedding through the
/// migration's switch, so these would be dropped; the caller refuses the move instead.
fn besides_embedding(changes: &[(String, Value)]) -> Vec<String> {
    changes
        .iter()
        .flat_map(|(k, v)| match (k.as_str(), v.as_object()) {
            ("engine", Some(o)) => o
                .keys()
                .filter(|sub| sub.as_str() != "embedding")
                .map(|sub| format!("engine.{sub}"))
                .collect(),
            _ if within(k, "engine.embedding") => Vec::new(),
            _ => vec![k.clone()],
        })
        .collect()
}

/// Keys the core checks first: the embedding, the reranker (its licence gate) and what a non-commercial model's licence
/// acceptance rests on (`embedding.*`, `engine.modelPreparation`).
pub(crate) fn touches_memory_models(changes: &[(String, Value)]) -> bool {
    touches_embedding(changes)
        || changes.iter().any(|(k, _)| {
            ["engine.reranker", "engine.modelPreparation", "embedding"]
                .iter()
                .any(|root| within(k, root))
        })
}

/// What the core said about the changes; `None` when no core answered the check, so the caller writes as before.
pub(crate) fn check(out: &Out, layout: &Layout, changes: &[(String, Value)]) -> Option<Value> {
    let unchecked = |why: &str| {
        // The models the engine runs are its own business; only a change of the embedding can strand a store with data.
        if touches_embedding(changes) {
            say_err(&format!(
                "warning: the change to the memory engine's embedding is not checked ({why}); the engine checks it at its next \
                 start, and a store with data embedded with another model stays unusable until it is moved: plur1bus memory reembed"
            ));
        }
        None
    };
    let mut c = match connect(layout, CHECK_TIMEOUT) {
        Ok(c) => c,
        Err(e) => return unchecked(&format!("no core answers: {e}")),
    };
    if !c.supports(METHOD) {
        return unchecked("the running core is older than this CLI");
    }
    let items: Vec<Value> = changes
        .iter()
        .map(|(k, v)| json!({ "key": k, "value": v }))
        .collect();
    match c.call(METHOD, json!({ "changes": items })) {
        Ok(v) => Some(v),
        Err(e) => out.from_rpc_error(&e),
    }
}

fn model_line(m: &Value) -> String {
    format!(
        "{} ({}, {} dimensions)",
        m["model"].as_str().unwrap_or("?"),
        m["provider"].as_str().unwrap_or("?"),
        m["dimensions"]
    )
}

/// Said before a move whose run cannot reach its switch with this engine (`canSwitch` false).
const NO_SWITCH: &str = "note: this engine cannot validate a re-embedded generation yet, so the run stops before the switch and the \
     current model stays active; the copy is kept, and plur1bus memory reembed --run finishes it once the engine can";

/// The confirmation question of a move: the two models, how many rows and what leaves the machine.
fn question(check: &Value, plan: &Value) -> String {
    let target = &check["target"];
    let mut q = format!(
        "this change moves the memory store from {} to {}: re-embed {} rows",
        check["current"]["model"].as_str().unwrap_or("?"),
        target["model"].as_str().unwrap_or("?"),
        plan["plan"]["rows"]
    );
    if plan["plan"]["cloud"].is_object() {
        q.push_str(&format!(
            "; every card text is sent to {}",
            target["provider"].as_str().unwrap_or("?")
        ));
    }
    q.push_str(" (the current store stays active until the switch)?");
    q
}

/// The move in words: both models, the engine's plan and, when the run cannot reach its switch, why.
fn describe_move(check: &Value, plan: &Value, next: &str) -> String {
    let mut s = format!(
        "this change moves the memory store to another embedding model:\n  {} -> {}\n{}",
        model_line(&check["current"]),
        model_line(&check["target"]),
        describe_plan_then(plan, next)
    );
    if check["canSwitch"] != true {
        s.push('\n');
        s.push_str(NO_SWITCH);
    }
    s
}

/// Runs the move `check` describes (effect `move`): the engine's plan (with `--dry-run` that is all, printed as
/// `memory.reembed.plan/1`), the confirmation, then the run with its switch, followed in the foreground or, with
/// `background`, left to the core. Returns false when the engine finds nothing to re-embed after all (the store already
/// has the target's vector space): the caller then writes the change as usual.
pub(crate) fn move_store(
    out: &Out,
    layout: &Layout,
    check: &Value,
    yes: bool,
    dry_run: bool,
    background: bool,
    changes: &[(String, Value)],
) -> bool {
    let others = besides_embedding(changes);
    if !others.is_empty() {
        out.fail(
            "E_INVALID_PARAMS",
            &format!(
                "this change moves the memory store to another embedding model, and the move writes only the embedding: set {} \
                 in a separate config set (before or after the move)",
                others.join(", ")
            ),
            json!({ "reason": "move-with-other-changes", "keys": others }),
        );
    }
    let plan = call(out, layout, "admin.reembed.plan", check["target"].clone());
    let then = "plur1bus config set without --dry-run moves it (--background leaves the re-embedding to the core)";
    let describe = || describe_move(check, &plan, if dry_run { then } else { "" });
    if plan["probe"]["verdict"] == "incompatible" {
        out.ok_but_failed(
            "memory.reembed.plan/1",
            &plan,
            describe,
            Failure::new(
                "E_CONFLICT",
                "incompatible-model",
                "the store cannot move to this embedding model (see the probe)",
            ),
        );
    }
    if plan["plan"].is_null() {
        return false;
    }
    if dry_run {
        out.ok("memory.reembed.plan/1", &plan, describe);
        return true;
    }
    if !out.json {
        say_err(&describe());
    }
    confirm(out, &question(check, &plan), yes);
    if !background && !out.json {
        say_err("re-embedding in the foreground; Ctrl-C leaves it running in the core (plur1bus memory reembed --status)");
    }
    start(
        out,
        layout,
        true,
        !background,
        &format!(
            "it continues in the core and switches to {} by itself when it is done; follow it with: plur1bus memory reembed --status",
            check["target"]["model"].as_str().unwrap_or("?")
        ),
    );
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(ks: &[&str]) -> Vec<(String, Value)> {
        ks.iter().map(|k| (k.to_string(), json!(1))).collect()
    }

    #[test]
    fn a_move_names_what_it_would_not_write() {
        let c = |k: &str, v: Value| vec![(k.to_string(), v)];
        assert!(besides_embedding(&c("engine.embedding.local.model", json!("m"))).is_empty());
        assert!(
            besides_embedding(&c("engine.embedding", json!({ "local": { "model": "m" } })))
                .is_empty()
        );
        assert!(besides_embedding(&c("engine", json!({ "embedding": {} }))).is_empty());
        assert_eq!(
            besides_embedding(&c(
                "engine",
                json!({ "embedding": {}, "recallMinScore": 0.4, "reranker": {} })
            )),
            vec![
                "engine.recallMinScore".to_string(),
                "engine.reranker".to_string()
            ]
        );
    }

    #[test]
    fn only_the_memory_models_are_checked() {
        for k in [
            "engine",
            "engine.embedding",
            "engine.embedding.local.model",
            "engine.reranker.local",
            "engine.modelPreparation",
            "embedding.useClass",
        ] {
            assert!(touches_memory_models(&keys(&[k])), "{k}");
        }
        for k in [
            "engine.recallMinScore",
            "engine.embeddingCache",
            "memory.embedding.privacyAck",
            "embeddings",
            "agents.main",
        ] {
            assert!(!touches_memory_models(&keys(&[k])), "{k}");
        }
        assert!(touches_embedding(&keys(&["engine.embedding.local.model"])));
        assert!(!touches_embedding(&keys(&[
            "embedding.useClass",
            "engine.reranker"
        ])));
    }

    #[test]
    fn a_move_names_both_models_the_rows_and_a_missing_switch() {
        let check = json!({ "effect": "move", "canSwitch": false,
            "current": { "provider": "local-transformers", "model": "intfloat/multilingual-e5-small", "dimensions": 384 },
            "target": { "provider": "local-transformers", "model": "google/embeddinggemma-2", "dimensions": 768 } });
        let plan = json!({ "plan": { "rows": 15 } });
        let q = question(&check, &plan);
        assert!(q.starts_with("this change moves the memory store from intfloat/multilingual-e5-small to google/embeddinggemma-2: re-embed 15 rows"), "{q}");
        assert!(!q.contains("card text"), "{q}");
        assert!(describe_move(&check, &plan, "").contains("cannot validate"));
        let mut switchable = check.clone();
        switchable["canSwitch"] = json!(true);
        assert!(!describe_move(&switchable, &plan, "").contains("cannot validate"));
    }

    #[test]
    fn a_cloud_move_says_what_leaves_the_machine() {
        let check = json!({ "canSwitch": true, "current": { "model": "intfloat/multilingual-e5-small" },
            "target": { "provider": "openrouter", "model": "qwen/qwen3-embedding-8b" } });
        let q = question(
            &check,
            &json!({ "plan": { "rows": 3, "cloud": { "provider": "openrouter" } } }),
        );
        assert!(q.contains("every card text is sent to openrouter"), "{q}");
    }
}
