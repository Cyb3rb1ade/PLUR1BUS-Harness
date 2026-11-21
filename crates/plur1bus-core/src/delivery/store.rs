//! `state/delivery.sqlite`: the one table the `DeliveryTargets` constructor creates with `CREATE TABLE IF NOT EXISTS` on every
//! open. No `user_version`; the schema text is the TypeScript text byte for byte (`sqlite_master` of a file made here must
//! equal one made there). Private file before SQLite touches it, the platform's owner-only hook must confirm it
//! (`delivery permissions unavailable` otherwise), WAL, `synchronous = FULL`.
use super::DeliveryError;
use crate::private_store;
use plur1bus_store::{Journal, OwnerSpec, Schema, Store, StoreSpec, Synchronous};
use std::path::Path;

/// The statement of the constructor.
pub const TABLES: &str =
    "CREATE TABLE IF NOT EXISTS delivery_targets(id TEXT PRIMARY KEY, value TEXT NOT NULL)";

/// Opens (and creates) the store. `secure_path` is `createSecurePath()(path, { mode: 0o600 }).applied`; without one, Unix
/// applies mode 0600 and any other platform refuses to open.
pub fn open(
    path: &Path,
    secure_path: Option<&dyn Fn(&Path) -> bool>,
) -> Result<Store, DeliveryError> {
    private_store::prepare_owner_only(path, secure_path).map_err(|error| match error {
        private_store::PrepareError::Io(e) => {
            DeliveryError::Store(format!("cannot prepare the delivery store: {e}"))
        }
        private_store::PrepareError::Permissions => {
            DeliveryError::Store("delivery permissions unavailable".into())
        }
    })?;
    let owner = OwnerSpec {
        store: StoreSpec {
            synchronous: Synchronous::Full,
            ..StoreSpec::new("delivery", 0)
        },
        journal: Journal::Wal,
        // The TypeScript store neither reads nor writes `user_version`.
        schema: Schema::Unversioned,
        create: true,
    };
    let store = Store::open_owner(path, &owner)?;
    store.conn().execute_batch(TABLES)?;
    Ok(store)
}
