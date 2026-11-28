//! Test-only count of explicit capture durability barriers, across the engine's worker threads.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Mutex,
};

type Counts = BTreeMap<&'static str, usize>;
type SyncCallback = (&'static str, Box<dyn FnOnce() + Send>);

#[derive(Default)]
struct Observation {
    counts: Counts,
    on_sync: Option<SyncCallback>,
}

static ACTIVE: Mutex<BTreeMap<PathBuf, Observation>> = Mutex::new(BTreeMap::new());

#[allow(
    clippy::unwrap_used,
    reason = "a failed test probe lock is a test failure"
)]
pub(crate) fn record(path: &Path, kind: &'static str) {
    let mut on_sync = None;
    {
        let mut active = ACTIVE.lock().unwrap();
        for (root, observation) in active.iter_mut() {
            if !path.starts_with(root) {
                continue;
            }
            *observation.counts.entry(kind).or_default() += 1;
            if path == root.as_path()
                && observation
                    .on_sync
                    .as_ref()
                    .is_some_and(|(event, _)| *event == kind)
            {
                on_sync = observation.on_sync.take();
            }
        }
    }
    if let Some((_, callback)) = on_sync {
        callback();
    }
}

pub(crate) struct Probe(PathBuf);

#[allow(
    clippy::unwrap_used,
    reason = "a failed test probe lock is a test failure"
)]
impl Probe {
    pub(crate) fn start(root: &Path) -> Self {
        assert!(ACTIVE
            .lock()
            .unwrap()
            .insert(root.to_path_buf(), Observation::default())
            .is_none());
        Self(root.to_path_buf())
    }

    /// Run once after the real sync for this exact file or directory has succeeded.
    pub(crate) fn after_sync(&self, kind: &'static str, callback: impl FnOnce() + Send + 'static) {
        let mut active = ACTIVE.lock().unwrap();
        let entry = active.get_mut(&self.0).unwrap();
        assert!(entry.on_sync.replace((kind, Box::new(callback))).is_none());
    }

    pub(crate) fn counts(&self) -> Counts {
        ACTIVE.lock().unwrap().get(&self.0).unwrap().counts.clone()
    }
}

impl Drop for Probe {
    fn drop(&mut self) {
        if let Ok(mut active) = ACTIVE.lock() {
            active.remove(&self.0);
        }
    }
}
