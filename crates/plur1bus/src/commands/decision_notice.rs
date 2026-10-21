//! The decision-model notices of `plur1bus setup` (ADR-015, owner decisions of 2026-10-21).
//!
//! Two non-blocking notices, both pure so a test can inject the OS and the configuration:
//!
//! 1. No usable decision model (no `modelRoles.decision`, and the selected `decision.backend` is not installed): which
//!    features depend on a decision model and what each does without one. The feature list and the fallbacks are the
//!    "Consumers, budgets and conservative result" table of `docs/adr/ADR-015-decision-service.md`; the first three rows
//!    are the D105 triage features the earlier hint already named.
//! 2. Windows with the local Laya backend selected (or `auto`, which may pick it): Laya on Windows CPUs is measured well
//!    above the default budgets, so a cloud decision model is recommended. Nothing is blocked; the local backend stays
//!    selectable.
//!
//! The web wizard keeps the same list in its i18n bundles (`shared.decisionHint.*`, `setup.decision.windows*`).
use crate::commands::model::{decision_role_set, DECISION_ROLE_HOW};
use serde_json::{json, Value};

/// One feature that depends on a decision model: stable id, short name, and what runs without one (ADR-015 table).
pub struct DecisionUse {
    pub id: &'static str,
    pub feature: &'static str,
    pub fallback: &'static str,
}

pub const DECISION_USES: [DecisionUse; 9] = [
    DecisionUse {
        id: "messageTriage",
        feature: "model-based message triage (a message with several tasks is split into tasks)",
        fallback: "the built-in rule triage runs (it only splits at words such as \"then\")",
    },
    DecisionUse {
        id: "toolPreselection",
        feature: "tool pre-selection by task category",
        fallback: "the rules recognise only a few keywords",
    },
    DecisionUse {
        id: "modelClassChoice",
        feature: "model class and reasoning effort per task",
        fallback: "the rules use fixed estimates instead of a probability for each class",
    },
    DecisionUse {
        id: "modelRouting",
        feature: "model routing (D30)",
        fallback: "the fixed or already selected session model is kept; no mid-session change without opt-in",
    },
    DecisionUse {
        id: "toolOutputPruning",
        feature: "tool-output pruning (D33)",
        fallback: "originals are kept; on a timeout, compaction runs without pruning",
    },
    DecisionUse {
        id: "skillSelection",
        feature: "automatic skill choice (D69)",
        fallback: "no additional dynamic skill is injected; explicit pins and blocks stay authoritative",
    },
    DecisionUse {
        id: "memoryPlacement",
        feature: "memory placement and level (D116)",
        fallback: "category placement, with confidentiality set to confidential; a person's override wins",
    },
    DecisionUse {
        id: "memoryZoom",
        feature: "memory zoom recall (D116)",
        fallback: "the existing parallel flat recall",
    },
    DecisionUse {
        id: "compactionChoice",
        feature: "compaction choice",
        fallback: "the existing summary (D23); the append-only history is never edited destructively",
    },
];

/// Backends this build can actually run. ADR-015 F1 defines the configuration only and installs no backend, so the list
/// is empty; a later change that ships one adds its name here (`laya`, `kev`, `jev`).
pub const INSTALLED_BACKENDS: [&str; 0] = [];

/// The Windows measurement quoted in the notice (Windows 11 x64, 2 threads).
pub const WINDOWS_LAYA_NOTICE: &str = "Windows: the local decision backend (Laya) is measured well above the default decision budgets on Windows CPUs (Windows 11 x64, 2 threads: warm p50 about 0.5 s against budgets of 100-200 ms; German accuracy is also weaker).";
pub const WINDOWS_LAYA_RECOMMEND: &str = "Recommended: a cloud decision model (decision.backend jev, or a cloud model as modelRoles.decision; neither works with privacy.localOnly). Setup does not block the local backend: keep it if you prefer, and change it later with `plur1bus config set decision.backend <role|laya|kev|jev|auto>`.";

/// What the notices need to know. `os` is `std::env::consts::OS` in production.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Assessment {
    pub role_set: bool,
    pub backend: String,
    pub backend_unavailable: bool,
    pub no_usable_model: bool,
    pub windows_laya: bool,
}

/// Assesses the configuration (`config` is the whole `config.json` value, `Null` for a new home).
pub fn assess(config: &Value, os: &str, installed: &[&str]) -> Assessment {
    let role_set = decision_role_set(&config["modelRoles"]);
    let backend = config["decision"]["backend"]
        .as_str()
        .unwrap_or("role")
        .to_string();
    let backend_installed = match backend.as_str() {
        "role" => false,
        "auto" => !installed.is_empty(),
        named => installed.contains(&named),
    };
    let backend_unavailable = backend != "role" && !backend_installed;
    Assessment {
        role_set,
        no_usable_model: !role_set && !backend_installed,
        windows_laya: os == "windows" && matches!(backend.as_str(), "laya" | "auto"),
        backend,
        backend_unavailable,
    }
}

/// The `notice` object of the `config` step's `decisionRole` detail; `None` when there is nothing to tell.
pub fn notice_json(a: &Assessment) -> Option<Value> {
    if !a.no_usable_model && !a.backend_unavailable && !a.windows_laya {
        return None;
    }
    let mut notice = json!({ "backend": a.backend });
    if a.no_usable_model {
        notice["uses"] = DECISION_USES
            .iter()
            .map(|u| json!({ "id": u.id, "feature": u.feature, "fallback": u.fallback }))
            .collect();
    }
    if a.backend_unavailable {
        notice["backendUnavailable"] = json!(true);
    }
    if a.windows_laya {
        notice["windowsLaya"] = json!({ "recommend": "cloud", "allowLocal": true });
    }
    Some(notice)
}

/// Human lines for a `notice` object (see [`notice_json`]); empty when it says nothing.
pub fn render(notice: &Value) -> Vec<String> {
    let mut lines = Vec::new();
    if notice["backendUnavailable"] == json!(true) {
        lines.push(format!(
            "note: decision.backend is `{}`, but that backend is not installed; requests use the decision model role (if set) and then each feature's fallback",
            notice["backend"].as_str().unwrap_or("role")
        ));
    }
    if let Some(uses) = notice["uses"].as_array() {
        lines.push(
            "      these features depend on a decision model; without one each runs its fallback:"
                .to_string(),
        );
        for u in uses {
            lines.push(format!(
                "        - {}: {}",
                u["feature"].as_str().unwrap_or_default(),
                u["fallback"].as_str().unwrap_or_default()
            ));
        }
        lines.push(format!("      to enable them, {DECISION_ROLE_HOW}"));
    }
    if notice["windowsLaya"]["recommend"] == json!("cloud") {
        lines.push(format!("note: {WINDOWS_LAYA_NOTICE}"));
        lines.push(format!("      {WINDOWS_LAYA_RECOMMEND}"));
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(notice: &Option<Value>) -> String {
        render(notice.as_ref().unwrap_or(&Value::Null)).join("\n")
    }

    #[test]
    fn no_decision_model_lists_every_feature_with_its_fallback() {
        for config in [
            Value::Null,
            json!({}),
            json!({ "modelRoles": { "decision": " " } }),
        ] {
            let a = assess(&config, "linux", &INSTALLED_BACKENDS);
            assert!(a.no_usable_model && !a.windows_laya && !a.backend_unavailable);
            let notice = notice_json(&a);
            let uses = notice.as_ref().unwrap()["uses"].as_array().unwrap();
            assert_eq!(uses.len(), DECISION_USES.len());
            let shown = text(&notice);
            for u in DECISION_USES.iter() {
                assert!(
                    shown.contains(u.feature) && shown.contains(u.fallback),
                    "{}",
                    u.id
                );
            }
            assert!(shown.contains("config set modelRoles.decision"), "{shown}");
            assert!(!shown.contains("Windows"), "{shown}");
        }
    }

    #[test]
    fn a_set_role_with_the_default_backend_has_nothing_to_say() {
        let config = json!({ "modelRoles": { "decision": "p/small" } });
        let a = assess(&config, "linux", &INSTALLED_BACKENDS);
        assert!(!a.no_usable_model);
        assert_eq!(notice_json(&a), None);
        assert_eq!(
            notice_json(&assess(&config, "windows", &INSTALLED_BACKENDS)),
            None
        );
    }

    #[test]
    fn an_uninstalled_backend_counts_as_no_model_unless_the_role_is_set() {
        let config = json!({ "decision": { "backend": "jev" } });
        let a = assess(&config, "linux", &INSTALLED_BACKENDS);
        assert!(a.backend_unavailable && a.no_usable_model);
        assert!(text(&notice_json(&a))
            .contains("decision.backend is `jev`, but that backend is not installed"));

        let with_role =
            json!({ "decision": { "backend": "jev" }, "modelRoles": { "decision": "p/small" } });
        let a = assess(&with_role, "linux", &INSTALLED_BACKENDS);
        assert!(a.backend_unavailable && !a.no_usable_model);
        let shown = text(&notice_json(&a));
        assert!(
            shown.contains("not installed") && !shown.contains("depend on a decision model"),
            "{shown}"
        );

        // An installed backend is usable without the role.
        let a = assess(&config, "linux", &["jev"]);
        assert!(!a.backend_unavailable && !a.no_usable_model);
        assert_eq!(notice_json(&a), None);
    }

    #[test]
    fn windows_with_laya_recommends_cloud_but_allows_the_local_install() {
        for backend in ["laya", "auto"] {
            let config = json!({ "decision": { "backend": backend }, "modelRoles": { "decision": "p/small" } });
            let a = assess(&config, "windows", &INSTALLED_BACKENDS);
            assert!(a.windows_laya, "{backend}");
            let notice = notice_json(&a).unwrap();
            assert_eq!(
                notice["windowsLaya"],
                json!({ "recommend": "cloud", "allowLocal": true })
            );
            let shown = render(&notice).join("\n");
            assert!(
                shown.contains("warm p50 about 0.5 s against budgets of 100-200 ms"),
                "{shown}"
            );
            assert!(
                shown.contains("Recommended: a cloud decision model"),
                "{shown}"
            );
            assert!(
                shown.contains("does not block the local backend"),
                "{shown}"
            );
        }
        // Installed and chosen on Windows: still the recommendation, no "not installed" line.
        let config = json!({ "decision": { "backend": "laya" } });
        let a = assess(&config, "windows", &["laya"]);
        assert!(a.windows_laya && !a.backend_unavailable && !a.no_usable_model);
    }

    #[test]
    fn laya_elsewhere_and_other_backends_on_windows_get_no_windows_notice() {
        for os in ["linux", "macos"] {
            let a = assess(
                &json!({ "decision": { "backend": "laya" } }),
                os,
                &INSTALLED_BACKENDS,
            );
            assert!(!a.windows_laya, "{os}");
            assert!(!text(&notice_json(&a)).contains("Windows"), "{os}");
        }
        for backend in ["role", "jev", "kev"] {
            let a = assess(
                &json!({ "decision": { "backend": backend } }),
                "windows",
                &INSTALLED_BACKENDS,
            );
            assert!(!a.windows_laya, "{backend}");
        }
    }
}
