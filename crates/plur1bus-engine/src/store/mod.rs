//! Node-compatible persisted memory stores.
pub mod atomic_write;
pub mod checkpoint;
pub mod directory;
pub mod filter;
pub mod identity;
pub mod lance;
pub mod ledger;
pub mod ledger_types;
pub mod neo_files;
pub mod paths;
pub mod pool;
pub mod row;
pub mod schema_version;
pub mod sqlite;
pub mod state_file;
pub use filter::RowFilter;
pub use lance::{IdentityStatus, OpenMode, Store};
pub use schema_version::StoreSchemaVersion;

pub use row::{RowPatch, Scored};

pub use pool::StorePool;

impl From<std::io::Error> for crate::contract::StoreError {
    fn from(error: std::io::Error) -> Self {
        Self::Io { kind: error.kind() }
    }
}
