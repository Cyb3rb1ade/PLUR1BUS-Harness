//! Pure Node capture admission, runtime configuration, pressure and bounded-queue policy.

use std::collections::VecDeque;

use serde::Serialize;
use serde_json::Value;

use crate::text::js;

/// Normalized capture-owned fields of Node's runtime configuration, in Node field order.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeConfig {
    /// Budget measured from worker start, excluding time waiting in the agent queue.
    pub capture_timeout_ms: u64,
    /// Maximum unsettled workers for each agent.
    pub max_concurrent_capture_per_agent: usize,
    /// Default priority for background work.
    pub background_priority: Priority,
    /// Soft depth cap; explicit work may exceed it.
    pub max_queue_depth_capture_per_agent: usize,
    /// Whether the pressure callback controls admission.
    pub pressure_gate_enabled: bool,
    /// Warning RSS threshold in bytes.
    pub rss_warning_bytes: u64,
    /// Critical RSS threshold in bytes.
    pub rss_critical_bytes: u64,
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            capture_timeout_ms: 60_000,
            max_concurrent_capture_per_agent: 1,
            background_priority: Priority::Low,
            max_queue_depth_capture_per_agent: 10,
            pressure_gate_enabled: true,
            rss_warning_bytes: 3_221_225_472,
            rss_critical_bytes: 4_831_838_208,
        }
    }
}

impl RuntimeConfig {
    /// Apply Node's Number/coercion, positive-check then floor behavior to a JSON runtime block.
    #[must_use]
    pub fn from_value(value: &Value) -> Self {
        let defaults = Self::default();
        Self {
            capture_timeout_ms: positive_int(
                &value["captureTimeoutMs"],
                defaults.capture_timeout_ms,
            ),
            max_concurrent_capture_per_agent: positive_int(
                &value["maxConcurrentCapturePerAgent"],
                defaults.max_concurrent_capture_per_agent as u64,
            ) as usize,
            background_priority: if value["backgroundPriority"] == "normal" {
                Priority::Normal
            } else {
                Priority::Low
            },
            max_queue_depth_capture_per_agent: positive_int(
                &value["maxQueueDepthCapturePerAgent"],
                defaults.max_queue_depth_capture_per_agent as u64,
            ) as usize,
            pressure_gate_enabled: value["pressureGateEnabled"] != false,
            rss_warning_bytes: positive_int(&value["rssWarningBytes"], defaults.rss_warning_bytes),
            rss_critical_bytes: positive_int(
                &value["rssCriticalBytes"],
                defaults.rss_critical_bytes,
            ),
        }
    }
}

fn positive_int(value: &Value, fallback: u64) -> u64 {
    let number = match value {
        Value::Number(value) => value.as_f64(),
        Value::String(value) => js::js_trim(value).parse::<f64>().ok(),
        Value::Bool(value) => Some(if *value { 1.0 } else { 0.0 }),
        _ => None,
    };
    number
        .filter(|number| number.is_finite() && *number > 0.0)
        .map_or(fallback, |number| number.floor() as u64)
}

/// Stable scheduler priority: smaller values run first, preserving enqueue order for ties.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    /// Explicit urgent work.
    High,
    /// Explicit/default user work.
    Normal,
    /// Deferrable work.
    Low,
}

impl Priority {
    /// Node treats any unrecognized priority name as low.
    #[must_use]
    pub fn from_name(value: &str) -> Self {
        match value {
            "high" => Self::High,
            "normal" => Self::Normal,
            _ => Self::Low,
        }
    }
}

/// Captured RSS classification, including Node's content-free reason text.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PressureSnapshot {
    /// `ok`, `warning` or `critical`.
    pub level: PressureLevel,
    /// Explanation containing only process byte counts.
    pub reason: String,
    /// Resident-set size supplied by the host process sampler.
    pub rss_bytes: u64,
    /// Used managed heap, when the host has one.
    pub heap_used_bytes: u64,
    /// Threshold applied by the selected branch.
    pub threshold_bytes: u64,
}

/// Runtime-pressure policy category.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PressureLevel {
    /// Admit work without pressure shedding.
    Ok,
    /// Shed low-priority work.
    Warning,
    /// Shed all background and low-priority work.
    Critical,
}

impl PressureSnapshot {
    /// The exact disabled-gate value returned by Node.
    #[must_use]
    pub fn disabled() -> Self {
        Self {
            level: PressureLevel::Ok,
            reason: "pressure gate disabled".into(),
            rss_bytes: 0,
            heap_used_bytes: 0,
            threshold_bytes: 0,
        }
    }

    /// Classify supplied memory counts, checking critical before warning as Node does.
    #[must_use]
    pub fn measure(rss: u64, heap: u64, warning: u64, critical: u64) -> Self {
        let (level, threshold, reason) = if rss >= critical {
            (
                PressureLevel::Critical,
                critical,
                format!(
                    "RSS {} GiB >= critical {} GiB (heapUsed {} GiB)",
                    gib_string(rss),
                    gib_string(critical),
                    gib_string(heap),
                ),
            )
        } else if rss >= warning {
            (
                PressureLevel::Warning,
                warning,
                format!(
                    "RSS {} GiB >= warning {} GiB (heapUsed {} GiB)",
                    gib_string(rss),
                    gib_string(warning),
                    gib_string(heap),
                ),
            )
        } else {
            (
                PressureLevel::Ok,
                warning,
                format!(
                    "RSS {} GiB below warning {} GiB",
                    gib_string(rss),
                    gib_string(warning),
                ),
            )
        };
        Self {
            level,
            reason,
            rss_bytes: rss,
            heap_used_bytes: heap,
            threshold_bytes: threshold,
        }
    }

    /// Apply the Node warning/critical priority rules.
    #[must_use]
    pub fn skips(&self, background: bool, priority: Priority) -> bool {
        match self.level {
            PressureLevel::Ok => false,
            PressureLevel::Warning => priority == Priority::Low,
            PressureLevel::Critical => background || priority == Priority::Low,
        }
    }
}

fn gib_string(bytes: u64) -> String {
    // RSS and configured byte counts are integer inputs. Exact rational rounding retains
    // Node's toFixed(2) tie-up rule (0.125 GiB => "0.13"), unlike Rust's tie-to-even formatter.
    const GIB: u128 = 1_073_741_824;
    let hundredths = (u128::from(bytes) * 100 + GIB / 2) / GIB;
    format!("{}.{:02}", hundredths / 100, hundredths % 100)
}

/// The three flags returned by Node's bounded queue, in its field order.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct PushResult {
    /// The new item was appended.
    pub accepted: bool,
    /// An existing background/low item was removed first.
    pub evicted: bool,
    /// The new background/low item could not be admitted.
    pub dropped: bool,
}

/// A queue push also returns ownership of any evicted work so its receipt can be settled.
pub struct BoundedPush<T> {
    /// Node's admission flags.
    pub result: PushResult,
    /// The oldest eligible item removed from the queue.
    pub evicted: Option<T>,
    /// A refused incoming item, retained for receipt settlement.
    pub rejected: Option<T>,
}

struct QueueItem<T> {
    value: T,
    background: bool,
    priority: Priority,
}

/// Node's soft bounded queue: explicit work is never discarded to enforce the depth cap.
pub struct BoundedQueue<T> {
    depth: Option<usize>,
    items: VecDeque<QueueItem<T>>,
}

impl<T> BoundedQueue<T> {
    /// A zero depth is unbounded, matching `makeBoundedQueue({ maxDepth: 0 })`.
    #[must_use]
    pub fn new(depth: usize) -> Self {
        Self {
            depth: (depth > 0).then_some(depth),
            items: VecDeque::new(),
        }
    }

    /// Append work, evicting only an existing low-priority background item for a similar arrival.
    pub fn push(&mut self, value: T, background: bool, priority: Priority) -> BoundedPush<T> {
        let mut evicted = None;
        if self.depth.is_some_and(|depth| self.items.len() >= depth)
            && background
            && priority == Priority::Low
        {
            if let Some(index) = self
                .items
                .iter()
                .position(|item| item.background && item.priority == Priority::Low)
            {
                evicted = self.items.remove(index).map(|item| item.value);
            } else {
                return BoundedPush {
                    result: PushResult {
                        accepted: false,
                        evicted: false,
                        dropped: true,
                    },
                    evicted: None,
                    rejected: Some(value),
                };
            }
        }
        let result = PushResult {
            accepted: true,
            evicted: evicted.is_some(),
            dropped: false,
        };
        self.items.push_back(QueueItem {
            value,
            background,
            priority,
        });
        BoundedPush {
            result,
            evicted,
            rejected: None,
        }
    }

    /// Pending values in insertion order.
    pub fn values(&self) -> impl Iterator<Item = &T> {
        self.items.iter().map(|item| &item.value)
    }

    /// Number of pending jobs; active jobs are held separately.
    #[must_use]
    pub fn len(&self) -> usize {
        self.items.len()
    }

    /// Whether there is no pending work.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub(super) fn take_next(&mut self) -> Option<T> {
        let index = self
            .items
            .iter()
            .enumerate()
            .min_by_key(|(index, item)| (item.priority, *index))?
            .0;
        self.items.remove(index).map(|item| item.value)
    }
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::String(value) => !value.is_empty(),
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        _ => true,
    }
}

fn lower_first(values: &[&Value]) -> String {
    let value = values.iter().find(|value| truthy(value));
    let text = match value {
        Some(Value::String(value)) => value.clone(),
        Some(value) => value.to_string(),
        None => String::new(),
    };
    js::js_to_lower_case(&text)
}

/// Node's generic hook-background detector; explicit contract AgentContext takes precedence in accept.
#[must_use]
pub fn is_background_turn(event: &Value, context: &Value) -> bool {
    let session = lower_first(&[
        &context["sessionKey"],
        &event["sessionKey"],
        &event["sessionId"],
        &event["runId"],
    ]);
    let origin = lower_first(&[
        &event["origin"],
        &event["source"],
        &context["origin"],
        &context["source"],
    ]);
    let kind = lower_first(&[
        &event["kind"],
        &event["type"],
        &context["kind"],
        &context["type"],
    ]);
    let trigger = lower_first(&[&event["trigger"], &context["trigger"]]);
    let prompt = lower_first(&[&event["prompt"]]);
    matches!(origin.as_str(), "cron" | "internal")
        || matches!(kind.as_str(), "cron" | "heartbeat" | "background")
        || matches!(
            trigger.as_str(),
            "cron" | "heartbeat" | "background" | "manual"
        )
        || session.contains(":cron:")
        || session.contains(":heartbeat")
        || prompt.contains("[cron:")
        || prompt.contains("heartbeat_ok")
}

/// Internal/background captures never receive recall's explicit-memory-command carve-out.
#[must_use]
pub fn should_skip_auto_capture(event: &Value, context: &Value) -> bool {
    if is_background_turn(event, context) {
        return true;
    }
    let session = lower_first(&[
        &context["sessionKey"],
        &event["sessionKey"],
        &event["sessionId"],
        &event["runId"],
    ]);
    let origin = lower_first(&[
        &event["origin"],
        &event["source"],
        &context["origin"],
        &context["source"],
    ]);
    let kind = lower_first(&[
        &event["kind"],
        &event["type"],
        &context["kind"],
        &context["type"],
    ]);
    let prompt = lower_first(&[&event["prompt"]]);
    session.contains(":active-memory:")
        || [&session, &origin, &kind].iter().any(|value| {
            ["background", "dreaming", "promotion"]
                .iter()
                .any(|part| value.contains(part))
        })
        || ["short_term_promotion_dream", "light_sleep", "rem_sleep"]
            .iter()
            .any(|name| {
                prompt.contains(&format!(
                    "__{}_memory_core_{name}__",
                    ["open", "claw"].concat()
                ))
            })
        || prompt.contains("[cron:")
        || prompt.contains("heartbeat_ok")
}
