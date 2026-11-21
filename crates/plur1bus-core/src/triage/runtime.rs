//! One triage decision per message (`packages/core/src/triage/runtime.ts`, `message-eval.ts` is next door): one owner
//! per provider, with explicit task boundaries. A recommendation never switches the class of an active task
//! mid-flight, and a classifier that fails, times out or answers nonsense falls back to the rule classifier, so its
//! absence keeps the rule path's skills and capabilities (N-D4).
//!
//! The classifier is a port. TypeScript races it against a timer; here the port receives the time limit and has to
//! keep it, answering [`ClassifyFailure::Failed`] when it cannot (the flip wires the provider call, which owns the
//! clock). A cancelled turn is not a fallback: it ends the decision.
use super::{
    apply_at_boundary, triage, CostPreference, Effort, ModelClass, Shape, TriageDecision,
    TriageOptions,
};
use crate::approvals::js_json::J;
use std::collections::{BTreeMap, HashMap};

/// The answer of [`MessageTriage::decide`].
#[derive(Clone, Debug, PartialEq)]
pub struct MessageDecision {
    /// The decision.
    pub decision: TriageDecision,
    /// The class of the turn; `None` for a chat message.
    pub model_class: Option<ModelClass>,
    /// The effort of the turn.
    pub effort: Option<Effort>,
    /// Always false here (the field of the TypeScript result).
    pub core_only: bool,
    /// Whether the rule classifier answered in place of the classifier.
    pub fallback: bool,
}

/// The caller's view of the task this message belongs to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskBoundary {
    /// The task id.
    pub id: String,
    /// Whether the message starts at a task boundary.
    pub at_boundary: bool,
}

/// The turn was cancelled (`signal.throwIfAborted()`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Aborted;

/// Why a classifier gave no answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClassifyFailure {
    /// It failed or ran out of time: the rule classifier answers.
    Failed,
}

/// Options of one decision.
pub struct DecideOptions<'a> {
    /// Whether the turn is cancelled, asked before and after the classifier ran.
    pub aborted: &'a dyn Fn() -> bool,
    /// The classifier's time limit in milliseconds; `None` is 2000.
    pub timeout_ms: Option<f64>,
    /// The cost preference.
    pub cost: Option<CostPreference>,
    /// The task boundary; `None` counts as "at a boundary".
    pub task: Option<TaskBoundary>,
    /// Called once when the rule classifier answers instead.
    pub on_fallback: Option<&'a dyn Fn()>,
}

/// The default time limit of a classifier call.
pub const DEFAULT_TIMEOUT_MS: f64 = 2000.0;
/// Most scopes whose active task is retained.
pub const ACTIVE_LIMIT: usize = 1024;

#[derive(Clone)]
struct Active {
    id: String,
    model_class: ModelClass,
    effort: Effort,
}

/// `MessageTriage`: the active task per scope, in insertion order (the oldest scope is forgotten first).
#[derive(Default)]
pub struct MessageTriage {
    active: HashMap<String, (u64, Active)>,
    order: BTreeMap<u64, String>,
    next: u64,
}

impl MessageTriage {
    /// A runtime with no active task.
    pub fn new() -> Self {
        Self::default()
    }

    /// Decides one message of `scope`. `classify` receives the message and the time limit in milliseconds.
    pub fn decide(
        &mut self,
        message: &str,
        scope: &str,
        classify: impl FnOnce(&str, f64) -> Result<J, ClassifyFailure>,
        o: &DecideOptions<'_>,
    ) -> Result<MessageDecision, Aborted> {
        if (o.aborted)() {
            return Err(Aborted);
        }
        let classified = classify(message, o.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS));
        if (o.aborted)() {
            return Err(Aborted);
        }
        let accepted = classified.ok().and_then(|raw| {
            let decision = triage(
                message,
                &TriageOptions {
                    classified: Some(&raw),
                    cost: o.cost,
                    active_task: None,
                },
            )
            .ok()?;
            let count = decision.task_count();
            let shape = decision.shape();
            // The shape and the number of tasks must agree, and a decision without tasks is a chat or a follow-up
            // of a task this scope really has.
            let consistent = count <= 32
                && match shape {
                    Shape::Chat | Shape::Followup => count == 0,
                    Shape::Single => count == 1,
                    Shape::Multi => count >= 2,
                };
            let missing = count == 0
                && shape != Shape::Chat
                && !(shape == Shape::Followup && self.active.contains_key(scope));
            (consistent && !missing).then_some(decision)
        });
        if let Some(decision) = accepted {
            return Ok(self.resolve(decision, scope, o.task.as_ref(), false));
        }
        if let Some(on_fallback) = o.on_fallback {
            on_fallback();
        }
        let previous = self.active.get(scope).map(|(_, a)| a.id.clone());
        let options = TriageOptions {
            classified: None,
            cost: o.cost,
            active_task: previous.as_deref(),
        };
        // The rule classifier's own decision always validates; a chat decision stands in if it ever did not.
        let decision = triage(message, &options).unwrap_or_else(|_| TriageDecision::empty("chat"));
        Ok(self.resolve(decision, scope, o.task.as_ref(), true))
    }

    fn resolve(
        &mut self,
        decision: TriageDecision,
        scope: &str,
        task: Option<&TaskBoundary>,
        fallback: bool,
    ) -> MessageDecision {
        let previous = self.active.get(scope).map(|(_, a)| a.clone());
        if let (Shape::Followup, Some(previous)) = (decision.shape(), &previous) {
            return MessageDecision {
                decision,
                model_class: Some(previous.model_class),
                effort: Some(previous.effort),
                core_only: false,
                fallback,
            };
        }
        let tasks = decision.tasks();
        // The highest class wins; among equals the earlier task.
        let Some(recommended) = tasks.iter().reduce(|a, b| {
            if a.chosen_class >= b.chosen_class {
                a
            } else {
                b
            }
        }) else {
            return MessageDecision {
                decision,
                model_class: None,
                effort: None,
                core_only: false,
                fallback,
            };
        };
        let boundary = task.is_none_or(|t| t.at_boundary);
        let model_class = match &previous {
            Some(p) => apply_at_boundary(p.model_class, recommended.chosen_class, boundary),
            None => recommended.chosen_class,
        };
        let effort = match &previous {
            Some(p) if !boundary => p.effort,
            _ => recommended.effort,
        };
        let id = task.map_or_else(|| recommended.id.clone(), |t| t.id.clone());
        let active = Active {
            id,
            model_class,
            effort,
        };
        match self.active.get_mut(scope) {
            // A scope keeps its place in the order when it is set again.
            Some(slot) => slot.1 = active,
            None => {
                self.next += 1;
                self.order.insert(self.next, scope.to_owned());
                self.active.insert(scope.to_owned(), (self.next, active));
            }
        }
        if self.active.len() > ACTIVE_LIMIT {
            if let Some((_, oldest)) = self.order.pop_first() {
                self.active.remove(&oldest);
            }
        }
        MessageDecision {
            decision,
            model_class: Some(model_class),
            effort: Some(effort),
            core_only: false,
            fallback,
        }
    }
}
