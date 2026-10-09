//! Stand-in for the one `Layout` method `install/manifest.rs` uses (`crates/plur1bus/src/paths.rs` pulls in the whole
#![allow(dead_code)]
//! supervisor). Only the reader and writer of the manifest file touch it; no target calls them.
use std::path::PathBuf;

pub struct Layout {
    pub home: PathBuf,
}

impl Layout {
    pub fn new(home: PathBuf) -> Self {
        Self { home }
    }
    pub fn install_manifest(&self) -> PathBuf {
        self.home.join("manifest.json")
    }
}
