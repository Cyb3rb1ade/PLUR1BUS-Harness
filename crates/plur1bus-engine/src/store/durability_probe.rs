//! Test-only count of explicit capture durability barriers, across the engine's worker threads.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Mutex,
};

type Counts = BTreeMap<&'static str, usize>;
static ACTIVE: Mutex<BTreeMap<PathBuf, Counts>> = Mutex::new(BTreeMap::new());

#[allow(
    clippy::unwrap_used,
    reason = "a failed test probe lock is a test failure"
)]
pub(crate) fn record(path: &Path, kind: &'static str) {
    for (root, counts) in ACTIVE.lock().unwrap().iter_mut() {
        if path.starts_with(root) {
            *counts.entry(kind).or_default() += 1;
        }
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
            .insert(root.to_path_buf(), BTreeMap::new())
            .is_none());
        Self(root.to_path_buf())
    }

    pub(crate) fn counts(&self) -> Counts {
        ACTIVE.lock().unwrap().get(&self.0).unwrap().clone()
    }
}

impl Drop for Probe {
    fn drop(&mut self) {
        if let Ok(mut active) = ACTIVE.lock() {
            active.remove(&self.0);
        }
    }
}
