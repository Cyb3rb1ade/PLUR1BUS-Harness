//! The on-disk role record (`state/role.json`): a strict loader that never fails open and a saver that never
//! overwrites a corrupt file or lets an epoch go backwards within a cluster.
use super::model::{RoleError, RoleRecord};
use std::io::Read;
use std::path::Path;

/// Upper bound for the record file; a larger file is treated as corrupt.
pub const MAX_RECORD_BYTES: u64 = 65_536;

// `Valid` carries the record by value on purpose: callers match on it and build it in tests.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Loaded {
    /// No record: the node is standalone.
    Missing,
    Valid(RoleRecord),
    /// Something is there but unusable. `detail` is a short reason, never file contents.
    Corrupt {
        detail: String,
    },
}

fn corrupt(detail: &str) -> Loaded {
    Loaded::Corrupt {
        detail: detail.to_string(),
    }
}

/// Reads and validates the record. Never panics; every doubt is `Corrupt`.
pub fn load(path: &Path) -> Loaded {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Loaded::Missing,
        Err(e) => return corrupt(&format!("cannot stat the record ({:?})", e.kind())),
    };
    if !meta.file_type().is_file() {
        return corrupt("the record is not a regular file");
    }
    if meta.len() > MAX_RECORD_BYTES {
        return corrupt("the record is too large");
    }
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) => return corrupt(&format!("cannot open the record ({:?})", e.kind())),
    };
    let mut bytes = Vec::new();
    if let Err(e) = file.take(MAX_RECORD_BYTES + 1).read_to_end(&mut bytes) {
        return corrupt(&format!("cannot read the record ({:?})", e.kind()));
    }
    if bytes.len() as u64 > MAX_RECORD_BYTES {
        return corrupt("the record is too large");
    }
    let Ok(text) = std::str::from_utf8(&bytes) else {
        return corrupt("the record is not valid UTF-8");
    };
    let rec: RoleRecord = match serde_json::from_str(text) {
        Ok(r) => r,
        Err(e) => {
            return corrupt(&format!(
                "the record does not parse ({:?} at line {} column {})",
                e.classify(),
                e.line(),
                e.column()
            ))
        }
    };
    match rec.validate() {
        Ok(()) => Loaded::Valid(rec),
        Err(e) => corrupt(&format!("the record is invalid ({})", e.reason())),
    }
}

/// Validates `rec`, checks it against what is on disk and writes it atomically (0600).
pub fn save(path: &Path, rec: &RoleRecord) -> Result<(), RoleError> {
    rec.validate()?;
    match load(path) {
        Loaded::Corrupt { detail } => return Err(RoleError::RecordCorrupt { detail }),
        Loaded::Missing => {}
        Loaded::Valid(old) => {
            if old.node_id != rec.node_id {
                return Err(RoleError::InvalidInput { field: "nodeId" });
            }
            if rec.cluster_id.is_some() && rec.cluster_id == old.cluster_id {
                if rec.epoch < old.epoch {
                    return Err(RoleError::StaleEpoch {
                        got: rec.epoch,
                        highest: old.epoch,
                    });
                }
                if rec.highest_seen_epoch < old.highest_seen_epoch {
                    return Err(RoleError::StaleEpoch {
                        got: rec.highest_seen_epoch,
                        highest: old.highest_seen_epoch,
                    });
                }
            }
        }
    }
    let mut bytes =
        serde_json::to_vec_pretty(rec).map_err(|_| RoleError::InvalidInput { field: "record" })?;
    bytes.push(b'\n');
    if bytes.len() as u64 > MAX_RECORD_BYTES {
        return Err(RoleError::InvalidInput { field: "record" });
    }
    crate::ext::state::write_private_atomic(path, &bytes).map_err(|e| RoleError::Io {
        detail: format!("cannot write the record ({:?})", e.kind()),
    })
}
