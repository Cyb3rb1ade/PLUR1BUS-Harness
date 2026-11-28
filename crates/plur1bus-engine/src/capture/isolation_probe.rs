//! Test-only timings for the synthetic owner-isolation fixtures.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

type Trace = (Instant, Vec<String>);
static TRACES: Mutex<BTreeMap<PathBuf, Trace>> = Mutex::new(BTreeMap::new());

pub(crate) struct Probe(PathBuf);

impl Probe {
    pub(crate) fn start(root: &Path) -> Self {
        let mut traces = TRACES
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert!(traces
            .insert(root.to_path_buf(), (Instant::now(), Vec::new()))
            .is_none());
        Self(root.to_path_buf())
    }

    pub(crate) fn report(&self) -> String {
        let traces = TRACES
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        traces
            .get(&self.0)
            .map(|(_, events)| events.join("\n"))
            .unwrap_or_default()
    }
}

impl Drop for Probe {
    fn drop(&mut self) {
        TRACES
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&self.0);
    }
}

pub(crate) fn event(path: &Path, step: &str, detail: impl std::fmt::Display) {
    let mut traces = TRACES
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    for (_, (start, events)) in traces.iter_mut().filter(|(root, _)| path.starts_with(root)) {
        if events.len() < 256 {
            events.push(format!(
                "+{} ms [{:?}] {step} {detail}",
                start.elapsed().as_millis(),
                std::thread::current().id()
            ));
        }
    }
}

pub(crate) fn budget(remaining: Option<Duration>) -> impl std::fmt::Display {
    remaining.map_or_else(
        || "unbounded".to_owned(),
        |time| format!("remaining={} ms", time.as_millis()),
    )
}
