//! Message triage (D105; plan P4-42, P4-K K9a), ported from `packages/core/src/triage/`: the model class of a task
//! from a class distribution and the cost preference, the conservative rule classifier, the validation of a
//! classifier's decision, the per-scope runtime with its fallback, and the evaluation of a classifier against gold.
//! A library: nothing in the running core calls it yet.
//!
//! A classifier is an outside port (a model may return anything), and the message is untrusted user text. A decision
//! is therefore held as the JSON it arrived as ([`J`], member order kept) and checked member by member the way
//! TypeScript checks it, so a malformed decision takes the same branch on both sides; no error carries the message.
//! Offsets are UTF-16 code units, as the classifier prompt promises ("exact JavaScript UTF-16 indices").
//!
//! - [`classes`]: the classes and the profile table;
//! - [`rules`]: the rule classifier (keyword rules and segmentation, with JavaScript's regular-expression semantics);
//! - [`runtime`]: one decision per message and scope, with task boundaries and the rule fallback;
//! - [`message_eval`]: segmentation F1 and under-provisioning against gold.
pub mod classes;
pub mod message_eval;
pub mod rules;
pub mod runtime;

#[cfg(test)]
mod vectors;

use crate::approvals::js_json::J;
use crate::js::utf16_len;
pub use classes::{ModelClass, MODEL_CLASSES};
pub use rules::rule_classifier;
use std::fmt;

/// How much the owner wants to pay for certainty: the tolerated probability mass above the chosen class.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CostPreference {
    /// Tolerates 0.35 above the class.
    Economy,
    /// Tolerates 0.2 (the default).
    Balanced,
    /// Tolerates 0.1.
    Quality,
}

impl CostPreference {
    /// `THRESHOLD[cost]`.
    pub fn threshold(self) -> f64 {
        match self {
            CostPreference::Economy => 0.35,
            CostPreference::Balanced => 0.2,
            CostPreference::Quality => 0.1,
        }
    }

    /// The threshold as JavaScript prints it in a rule's reason.
    pub(crate) fn threshold_text(self) -> &'static str {
        match self {
            CostPreference::Economy => "0.35",
            CostPreference::Balanced => "0.2",
            CostPreference::Quality => "0.1",
        }
    }

    /// The TypeScript spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            CostPreference::Economy => "economy",
            CostPreference::Balanced => "balanced",
            CostPreference::Quality => "quality",
        }
    }
}

/// Why a decision or a distribution was refused. The texts are TypeScript's; none holds the message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TriageError {
    /// The class distribution has a member that is not a nonnegative finite number, or does not sum to 1.
    Distribution,
    /// The confidence is not a number in 0..=1.
    Confidence,
    /// Not an object with the schema, a known shape and a task list.
    Decision,
    /// A task's span, id, effort, reason, summary or dependency is wrong.
    Segmentation,
    /// A task's categories are not one to three category ids with probabilities summing to 1.
    Categories,
    /// TypeScript fails here with a `TypeError` of the engine (a task without a class distribution).
    Type,
}

impl fmt::Display for TriageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            TriageError::Distribution => "invalid model class distribution",
            TriageError::Confidence => "invalid confidence",
            TriageError::Decision => "invalid triage decision",
            TriageError::Segmentation => "invalid task segmentation or dependency",
            TriageError::Categories => "invalid category distribution",
            TriageError::Type => "malformed triage decision",
        })
    }
}

impl std::error::Error for TriageError {}

/// `chooseClass`: the smallest class whose above-class probability is at most the threshold of the cost preference;
/// a confidence below 0.5 raises it by one; frontier is the cap.
pub fn choose_class(
    distribution: [f64; 4],
    cost: CostPreference,
    confidence: f64,
) -> Result<ModelClass, TriageError> {
    let sum = distribution.iter().fold(0.0, |n, p| n + p);
    if distribution.iter().any(|p| !p.is_finite() || *p < 0.0) || (sum - 1.0).abs() > 1e-6 {
        return Err(TriageError::Distribution);
    }
    if !confidence.is_finite() || !(0.0..=1.0).contains(&confidence) {
        return Err(TriageError::Confidence);
    }
    // The tail of the last class is empty, so an index is always found.
    let index = (0..4)
        .find(|i| distribution[i + 1..].iter().fold(0.0, |n, p| n + p) <= cost.threshold() + 1e-10)
        .unwrap_or(3);
    Ok(MODEL_CLASSES[(index + usize::from(confidence < 0.5)).min(3)])
}

/// `chooseClass` over members as a classifier sent them: a member that is not a number makes the distribution
/// invalid, a missing confidence is 1 (the default parameter), a distribution that is absent or `null` is the
/// `TypeError` case.
pub fn choose_class_j(
    distribution: Option<&J>,
    cost: CostPreference,
    confidence: Option<&J>,
) -> Result<ModelClass, TriageError> {
    let distribution = match distribution {
        None | Some(J::Null) => return Err(TriageError::Type),
        Some(d) => d,
    };
    let mut values = [f64::NAN; 4];
    for (slot, class) in values.iter_mut().zip(MODEL_CLASSES) {
        // `Number.isFinite` of anything that is not a number is false, which NaN stands for here.
        *slot = distribution
            .get(class.as_str())
            .and_then(J::as_f64)
            .unwrap_or(f64::NAN);
    }
    let confidence = match confidence {
        None => 1.0,
        Some(c) => c.as_f64().unwrap_or(f64::NAN),
    };
    choose_class(values, cost, confidence)
}

/// `escalate`: one class up, once; a set flag or the frontier class changes nothing.
pub fn escalate(current: ModelClass, already_escalated: bool) -> ModelClass {
    if already_escalated {
        current
    } else {
        MODEL_CLASSES[(current.index() + 1).min(3)]
    }
}

/// `applyAtBoundary`: a recommendation is adopted only at a task boundary.
pub fn apply_at_boundary(
    current: ModelClass,
    recommended: ModelClass,
    at_task_boundary: bool,
) -> ModelClass {
    if at_task_boundary {
        recommended
    } else {
        current
    }
}

/// The shape of a decision.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shape {
    /// Conversation, no task.
    Chat,
    /// One task.
    Single,
    /// Several tasks.
    Multi,
    /// A continuation of the active task.
    Followup,
}

impl Shape {
    fn parse(text: &str) -> Option<Shape> {
        match text {
            "chat" => Some(Shape::Chat),
            "single" => Some(Shape::Single),
            "multi" => Some(Shape::Multi),
            "followup" => Some(Shape::Followup),
            _ => None,
        }
    }
}

/// The effort of a task.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Effort {
    /// Low.
    Low,
    /// Medium.
    Medium,
    /// High.
    High,
}

impl Effort {
    /// The TypeScript spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Effort::Low => "low",
            Effort::Medium => "medium",
            Effort::High => "high",
        }
    }

    fn parse(text: &str) -> Option<Effort> {
        match text {
            "low" => Some(Effort::Low),
            "medium" => Some(Effort::Medium),
            "high" => Some(Effort::High),
            _ => None,
        }
    }
}

/// The members of a validated task that the core reads.
#[derive(Clone, Debug, PartialEq)]
pub struct TaskView {
    /// The task id.
    pub id: String,
    /// Start of the span in the message, in UTF-16 code units.
    pub start: usize,
    /// End of the span (exclusive).
    pub end: usize,
    /// The category ids, in the decision's order.
    pub categories: Vec<String>,
    /// The class, recomputed by the harness.
    pub chosen_class: ModelClass,
    /// The effort.
    pub effort: Effort,
    /// The classifier's confidence; NaN when the decision carried none (TypeScript: `undefined`).
    pub confidence: f64,
}

/// A triage decision (`plur1bus.triage/1`) that passed [`triage`], or that the rule classifier made. It keeps the JSON
/// as the classifier wrote it (unknown members included, as TypeScript's `structuredClone` does), with `chosenClass`
/// recomputed.
#[derive(Clone, Debug, PartialEq)]
pub struct TriageDecision(pub(crate) J);

const SCHEMA: &str = "plur1bus.triage/1";

impl TriageDecision {
    fn empty(shape: &str) -> Self {
        TriageDecision(J::obj([
            ("schema", J::s(SCHEMA)),
            ("shape", J::s(shape)),
            ("tasks", J::Arr(Vec::new())),
        ]))
    }

    /// The decision as JSON, members in the order `JSON.stringify` prints them.
    pub fn as_j(&self) -> &J {
        &self.0
    }

    /// The shape.
    pub fn shape(&self) -> Shape {
        self.0
            .get("shape")
            .and_then(J::as_str)
            .and_then(Shape::parse)
            .unwrap_or(Shape::Chat)
    }

    /// The number of tasks.
    pub fn task_count(&self) -> usize {
        match self.0.get("tasks") {
            Some(J::Arr(tasks)) => tasks.len(),
            _ => 0,
        }
    }

    /// The tasks.
    pub fn tasks(&self) -> Vec<TaskView> {
        let Some(J::Arr(tasks)) = self.0.get("tasks") else {
            return Vec::new();
        };
        tasks
            .iter()
            .map(|t| {
                let text = |key: &str| t.get(key).and_then(J::as_str).unwrap_or_default();
                let index = |key: &str| t.get(key).and_then(J::as_f64).unwrap_or(0.0) as usize;
                TaskView {
                    id: text("id").to_owned(),
                    start: index("start"),
                    end: index("end"),
                    categories: t
                        .get("categories")
                        .map(|c| c.members().into_iter().map(|(k, _)| k.to_owned()).collect())
                        .unwrap_or_default(),
                    chosen_class: ModelClass::parse(text("chosenClass"))
                        .unwrap_or(ModelClass::Frontier),
                    effort: Effort::parse(text("effort")).unwrap_or(Effort::High),
                    confidence: t.get("confidence").and_then(J::as_f64).unwrap_or(f64::NAN),
                }
            })
            .collect()
    }
}

/// Options of [`triage`].
#[derive(Clone, Copy, Default)]
pub struct TriageOptions<'a> {
    /// The classifier's answer for this message; `None` runs the rule classifier.
    pub classified: Option<&'a J>,
    /// The cost preference; `None` is balanced.
    pub cost: Option<CostPreference>,
    /// The id of the active task; an empty id counts as none, as in TypeScript.
    pub active_task: Option<&'a str>,
}

/// JavaScript truthiness of a member that may be absent.
fn truthy(v: Option<&J>) -> bool {
    match v {
        None | Some(J::Null) => false,
        Some(J::Bool(b)) => *b,
        Some(J::Num(n)) => *n != 0.0 && !n.is_nan(),
        Some(J::Str(s)) => !s.is_empty(),
        Some(J::Arr(_) | J::Obj(_)) => true,
    }
}

/// `Number.isSafeInteger` of a member.
fn safe_integer(v: Option<&J>) -> Option<f64> {
    v.and_then(J::as_f64)
        .filter(|n| n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0)
}

/// `/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/`.
fn is_category_id(key: &str) -> bool {
    let part = |p: &str| {
        let mut bytes = p.bytes();
        bytes.next().is_some_and(|b| b.is_ascii_lowercase())
            && bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    };
    // Neither part can hold a dot, so the first dot is the separator.
    key.split_once('.').is_some_and(|(a, b)| part(a) && part(b))
}

/// `triage(message, options)`: the decision for one message. With an active task, a closed set of continuation words
/// is a follow-up and nothing is classified. A classifier's answer is checked before anything reads its tasks, and
/// the class of every task is recomputed from its distribution and the cost preference.
pub fn triage(message: &str, options: &TriageOptions<'_>) -> Result<TriageDecision, TriageError> {
    if options.active_task.is_some_and(|id| !id.is_empty()) && rules::is_followup(message) {
        return Ok(TriageDecision::empty("followup"));
    }
    let cost = options.cost.unwrap_or(CostPreference::Balanced);
    let mut result = match options.classified {
        Some(raw) => {
            if matches!(raw.get("tasks"), Some(J::Arr(tasks)) if tasks.len() > 32) {
                return Err(TriageError::Decision);
            }
            raw.clone()
        }
        None => rule_classifier(message, cost).0,
    };
    let shape_ok = result
        .get("shape")
        .and_then(J::as_str)
        .is_some_and(|s| Shape::parse(s).is_some());
    if result.get("schema").and_then(J::as_str) != Some(SCHEMA) || !shape_ok {
        return Err(TriageError::Decision);
    }
    let message_len = utf16_len(message) as f64;
    let J::Obj(members) = &mut result else {
        return Err(TriageError::Decision);
    };
    let Some((_, J::Arr(tasks))) = members.iter_mut().find(|(k, _)| k == "tasks") else {
        return Err(TriageError::Decision);
    };
    let mut ids: Vec<String> = Vec::new();
    let mut previous_end = 0.0;
    for t in tasks.iter_mut() {
        let (start, end) = (safe_integer(t.get("start")), safe_integer(t.get("end")));
        let effort_ok = t
            .get("effort")
            .and_then(J::as_str)
            .is_some_and(|e| Effort::parse(e).is_some());
        let depends_ok = match t.get("dependsOn") {
            Some(J::Arr(list)) => list.iter().all(|d| {
                d.as_str()
                    .is_some_and(|d| ids.iter().any(|known| known == d))
            }),
            _ => false,
        };
        let (Some(start), Some(end), Some(id)) = (start, end, t.get("id").and_then(J::as_str))
        else {
            return Err(TriageError::Segmentation);
        };
        if !effort_ok
            || t.get("reason").and_then(J::as_str).is_none()
            || id.is_empty()
            || ids.iter().any(|known| known == id)
            || start < previous_end
            || end <= start
            || end > message_len
            || !truthy(t.get("summary"))
            || !depends_ok
        {
            return Err(TriageError::Segmentation);
        }
        let id = id.to_owned();
        let categories_ok = match t.get("categories") {
            Some(c @ J::Obj(_)) => {
                let entries = c.members();
                let values: Vec<f64> = entries
                    .iter()
                    .map(|(_, v)| v.as_f64().unwrap_or(f64::NAN))
                    .collect();
                !entries.is_empty()
                    && entries.len() <= 3
                    && entries.iter().all(|(k, _)| is_category_id(k))
                    && values.iter().all(|p| p.is_finite() && *p >= 0.0)
                    && (values.iter().fold(0.0, |a, b| a + b) - 1.0).abs() <= 1e-6
            }
            _ => false,
        };
        if !categories_ok {
            return Err(TriageError::Categories);
        }
        let class = choose_class_j(t.get("modelClass"), cost, t.get("confidence"))?;
        t.set("chosenClass", J::s(class.as_str()));
        ids.push(id);
        previous_end = end;
    }
    Ok(TriageDecision(result))
}

/// `triageWithClassifier`: a follow-up in an active task never reaches the classifier; any other message does, once,
/// and its answer is validated as in [`triage`]. `Err(Err(e))` is the classifier's own failure.
pub fn triage_with_classifier<E>(
    message: &str,
    classifier: impl FnOnce(&str, CostPreference) -> Result<J, E>,
    cost: Option<CostPreference>,
    active_task: Option<&str>,
) -> Result<TriageDecision, Result<TriageError, E>> {
    if active_task.is_some_and(|id| !id.is_empty()) {
        let decision = triage(
            message,
            &TriageOptions {
                classified: None,
                cost,
                active_task,
            },
        )
        .map_err(Ok)?;
        if decision.shape() == Shape::Followup {
            return Ok(decision);
        }
    }
    let raw = classifier(message, cost.unwrap_or(CostPreference::Balanced)).map_err(Err)?;
    triage(
        message,
        &TriageOptions {
            classified: Some(&raw),
            cost,
            active_task,
        },
    )
    .map_err(Ok)
}
