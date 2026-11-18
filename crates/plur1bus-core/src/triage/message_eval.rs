//! The evaluation of a message classifier against gold (`packages/core/src/triage/message-eval.ts`): segmentation F1
//! and the share of tasks that got a smaller class than they need. Independent of the tool-call evaluation and its
//! gate. A missing prediction counts as under-provisioned.
use super::{triage, ModelClass, TriageOptions};
use crate::approvals::js_json::J;

/// One gold task of a message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GoldTask {
    /// Start of the span, in UTF-16 code units.
    pub start: usize,
    /// End of the span.
    pub end: usize,
    /// The category the task must carry.
    pub category: String,
    /// The smallest class that does the task.
    pub minimum_class: ModelClass,
}

/// One evaluation message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MessageEvalCase {
    /// The case id.
    pub id: String,
    /// The message.
    pub message: String,
    /// Its gold tasks.
    pub gold: Vec<GoldTask>,
}

/// The result of an evaluation.
#[derive(Clone, Debug, PartialEq)]
pub struct MessageEval {
    /// Messages evaluated.
    pub messages: usize,
    /// Gold tasks.
    pub expected: usize,
    /// Predicted tasks.
    pub predicted: usize,
    /// Gold tasks whose exact span was predicted.
    pub matched: usize,
    /// Gold tasks without a prediction or with too small a class.
    pub under: usize,
    /// Matched tasks that carry the gold category.
    pub categories: usize,
    /// Messages whose classification failed or did not validate.
    pub failed: usize,
    /// `2 * matched / (expected + predicted)`; 1 when there is nothing to segment.
    pub segmentation_f1: f64,
    /// `under / expected`.
    pub under_provisioning: f64,
    /// At least 60 messages, no failure, F1 of at least 0.9 and at most 0.05 under-provisioned.
    pub passed: bool,
}

/// `evaluateMessages(cases, classify)`. `classify` answers `None` where the TypeScript port rejects.
pub fn evaluate_messages(
    cases: &[MessageEvalCase],
    mut classify: impl FnMut(&MessageEvalCase) -> Option<J>,
) -> MessageEval {
    let (mut expected, mut predicted, mut matched, mut under, mut categories, mut failed) =
        (0, 0, 0, 0, 0, 0);
    for row in cases {
        let decision = classify(row).and_then(|raw| {
            triage(
                &row.message,
                &TriageOptions {
                    classified: Some(&raw),
                    cost: None,
                    active_task: None,
                },
            )
            .ok()
        });
        let tasks = match &decision {
            Some(d) => d.tasks(),
            None => {
                failed += 1;
                Vec::new()
            }
        };
        expected += row.gold.len();
        predicted += tasks.len();
        for gold in &row.gold {
            let task = tasks
                .iter()
                .find(|t| t.start == gold.start && t.end == gold.end);
            if let Some(task) = task {
                matched += 1;
                if task.categories.contains(&gold.category) {
                    categories += 1;
                }
            }
            if task.is_none_or(|t| t.chosen_class < gold.minimum_class) {
                under += 1;
            }
        }
    }
    let segmentation_f1 = if expected + predicted > 0 {
        2.0 * matched as f64 / (expected + predicted) as f64
    } else {
        1.0
    };
    let under_provisioning = if expected > 0 {
        under as f64 / expected as f64
    } else {
        0.0
    };
    MessageEval {
        messages: cases.len(),
        expected,
        predicted,
        matched,
        under,
        categories,
        failed,
        segmentation_f1,
        under_provisioning,
        passed: cases.len() >= 60
            && failed == 0
            && segmentation_f1 >= 0.9
            && under_provisioning <= 0.05,
    }
}
