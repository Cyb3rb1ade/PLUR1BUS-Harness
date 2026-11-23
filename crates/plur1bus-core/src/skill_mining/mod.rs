//! Evidence-only workflow mining and explicitly reviewed skill proposals.

pub mod artifact;
pub mod evidence;
pub mod miner;
pub mod proposals;
pub mod review;

use crate::collab::CollabError;
use serde::{Deserialize, Serialize};

type R<T> = Result<T, CollabError>;

/// Exact scope bound by the trusted caller for this operation.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    /// Stored session owner, derived by the host from the authenticated caller.
    pub owner: String,
    /// Agent that executed the workflow.
    pub agent_id: String,
    /// Session's private or project scope.
    pub scope: String,
}

fn text_id(s: &str, max: usize) -> bool {
    !s.is_empty() && s.encode_utf16().count() <= max && !s.chars().any(char::is_control)
}

fn valid_scope(scope: &Scope) -> bool {
    [&scope.owner, &scope.agent_id, &scope.scope]
        .into_iter()
        .all(|id| text_id(id, 256))
}

fn tool_name(name: &str) -> bool {
    name.len() <= 64
        && name.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && name.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-')
        })
}

fn tool_version(version: &str) -> bool {
    version.len() == 64
        && version
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn open_ledger(
    path: &std::path::Path,
    name: &'static str,
    ddl: &str,
    secure: Option<&dyn Fn(&std::path::Path) -> bool>,
) -> R<plur1bus_store::Store> {
    use crate::collab::CollabErrorCode;
    use plur1bus_store::{Journal, OwnerSpec, Schema, StoreSpec};

    if path != std::path::Path::new(":memory:") {
        crate::private_store::prepare_versioned(path, secure).map_err(|err| {
            let message = match err {
                crate::private_store::PrepareError::Io(_) => "cannot prepare private skill ledger",
                crate::private_store::PrepareError::Permissions => {
                    "cannot protect private skill ledger"
                }
            };
            CollabError::new(CollabErrorCode::Storage, message)
        })?;
    }
    let db = crate::private_store::open_versioned(
        path,
        &OwnerSpec {
            store: StoreSpec::new(name, 0),
            journal: Journal::Unchanged,
            schema: Schema::Steps(&[]),
            create: true,
        },
        || -> R<()> {
            if !crate::private_store::protect_compatible(path, secure) {
                return Err(CollabError::new(
                    CollabErrorCode::Storage,
                    "cannot protect private skill ledger",
                ));
            }
            Ok(())
        },
    )?;
    db.conn().execute_batch(ddl)?;
    Ok(db)
}
