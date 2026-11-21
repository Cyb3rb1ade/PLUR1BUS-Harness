//! `collab/capacity.ts` (D124): CPU and memory are measured soft bounds for how many writers run at once on this machine;
//! disk admission belongs to the provisioner-backed scheduler. All arithmetic is in doubles, as in JavaScript, so a
//! configuration that divides by zero or measures nothing gives the same `Infinity`/`NaN` answers (`NaN` printed as `null`).
use super::limits::DEFAULT_WRITERS_PER_PROJECT;

/// `CapacityFacts.settings`: `collaboration.teams.capacity`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CapacitySettings {
    /// Cores one writer needs.
    pub cores_per_writer: f64,
    /// Bytes one writer needs.
    pub memory_per_writer: f64,
    /// An explicit override of the slot count.
    pub max_writers: Option<f64>,
}

/// `CapacityFacts`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CapacityFacts {
    /// Cores the machine has.
    pub cores: f64,
    /// Memory that is free now.
    pub available_memory: f64,
    /// Memory the machine has.
    pub total_memory: Option<f64>,
    /// The configuration.
    pub settings: CapacitySettings,
}

/// `WriterCapacity`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WriterCapacity {
    /// What the measured resources allow (at least 1, unless a division gave `NaN`).
    pub computed: f64,
    /// The slots shared across projects.
    pub slots: f64,
    /// Whether `slots` overcommits the hardware.
    pub exceeded: bool,
}

/// `Math.max`: `NaN` when either side is.
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

/// `Math.min`: `NaN` when either side is.
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

/// `writerCapacity(perProject, facts, runningLocalWriters)`: shared CPU/memory admission; the service enforces each project's
/// writer count separately.
pub fn writer_capacity(
    per_project: i64,
    facts: &CapacityFacts,
    running_local_writers: i64,
) -> WriterCapacity {
    // Existing writers already consumed part of the measured free memory; do not count their reservation twice.
    let memory = js_min(
        facts.total_memory.unwrap_or(9_007_199_254_740_991.0),
        facts.available_memory + running_local_writers as f64 * facts.settings.memory_per_writer,
    );
    let computed = js_max(
        1.0,
        js_min(
            (facts.cores / facts.settings.cores_per_writer).floor(),
            (memory / facts.settings.memory_per_writer).floor(),
        ),
    );
    // A changed project limit can explicitly overcommit hardware, but a smaller project cannot narrow the machine's shared
    // capacity for unrelated projects. An explicit capacity override can.
    let slots = facts.settings.max_writers.unwrap_or_else(|| {
        js_max(
            computed,
            if per_project == DEFAULT_WRITERS_PER_PROJECT {
                0.0
            } else {
                per_project as f64
            },
        )
    });
    WriterCapacity {
        computed,
        slots,
        exceeded: slots > computed,
    }
}
