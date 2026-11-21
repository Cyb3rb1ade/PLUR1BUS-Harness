//! `state/channel-handoff.sqlite`: the four tables the `ChannelHandoff` constructor creates with `CREATE TABLE IF NOT EXISTS`
//! on every open. The file has no `user_version`; the schema text is the TypeScript text byte for byte, because SQLite keeps a
//! `CREATE` statement as written and `sqlite_master` of a file made here must equal one made there.
//!
//! The file is made private before SQLite touches it (directory 0700, file 0600), then the platform's owner-only hook must
//! confirm it: a hand-off store whose permissions cannot be applied is not opened (`handoff permissions unavailable`). WAL,
//! `synchronous = FULL`.
use super::HandoffError;
use crate::private_store;
use plur1bus_store::{Journal, OwnerSpec, Schema, Store, StoreSpec, Synchronous};
use std::path::Path;

/// The four statements of the constructor, in its order.
pub const TABLES: &str = "CREATE TABLE IF NOT EXISTS channel_direct(session_id TEXT PRIMARY KEY, person TEXT NOT NULL, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS channel_handoffs(hash TEXT PRIMARY KEY, person TEXT NOT NULL, session_id TEXT NOT NULL, expires INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS channel_taint(session_id TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS channel_continuations(session_id TEXT PRIMARY KEY, source TEXT NOT NULL)";

/// Opens (and creates) the store. `secure_path` is `createSecurePath()(path, { mode: 0o600 }).applied`; without one, Unix
/// applies mode 0600 and any other platform refuses to open.
pub fn open(
    path: &Path,
    secure_path: Option<&dyn Fn(&Path) -> bool>,
) -> Result<Store, HandoffError> {
    private_store::prepare(path)
        .map_err(|e| HandoffError::Store(format!("cannot prepare the hand-off store: {e}")))?;
    let applied = match secure_path {
        Some(f) => f(path),
        None => private_store::default_secure(path),
    };
    if !applied {
        return Err(HandoffError::Store(
            "handoff permissions unavailable".into(),
        ));
    }
    let owner = OwnerSpec {
        store: StoreSpec {
            synchronous: Synchronous::Full,
            ..StoreSpec::new("channel-handoff", 0)
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
