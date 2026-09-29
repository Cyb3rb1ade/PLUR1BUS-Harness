//! Where extension state lives under `<home>/extensions` (spec §6.2, X1-R16, X1-R17, X1-R19).
use crate::paths::Layout;
use std::path::PathBuf;

/// The directories and files of the extension store. Inspections live in `run/inspect/`, never under `extensions/`
/// (X1-R16), so a refusal leaves `extensions/` byte-identical.
#[derive(Clone, Debug)]
pub struct ExtPaths {
    /// `<home>/extensions`.
    pub root: PathBuf,
    /// `extensions/state.json`.
    pub state: PathBuf,
    /// `extensions/cache/<sha256>.p1x`: the package bytes of the installed and the previous version.
    pub cache: PathBuf,
    /// `extensions/staging/`: created on demand, removed when a refusal leaves it empty.
    pub staging: PathBuf,
    /// `extensions/trash/<trashId>/` (X1-R19).
    pub trash: PathBuf,
    /// `extensions/catalog/revocations.json`: written only by X4 after signature checks; X1 never writes it (X1-R17).
    pub revocations: PathBuf,
    /// `<home>/run/inspect/`: `<inspectionId>.{p1x,json}` for the inspection TTL (X1-R16).
    pub inspect: PathBuf,
}

impl ExtPaths {
    pub fn of(layout: &Layout) -> ExtPaths {
        let root = layout.extensions();
        ExtPaths {
            state: root.join("state.json"),
            cache: root.join("cache"),
            staging: root.join("staging"),
            trash: root.join("trash"),
            revocations: root.join("catalog").join("revocations.json"),
            inspect: layout.run().join("inspect"),
            root,
        }
    }

    /// `extensions/cache/<sha256>.p1x`.
    pub fn cached(&self, sha256: &str) -> PathBuf {
        self.cache.join(format!("{sha256}.p1x"))
    }

    /// `extensions/cache/<sha256>.json`: `{manifest, trust, scripts}` of the cached package as the worker's inspection
    /// found them, written at install so `ext.show` never opens package bytes in the supervisor (X1-R2).
    pub fn cached_meta(&self, sha256: &str) -> PathBuf {
        self.cache.join(format!("{sha256}.json"))
    }
}
