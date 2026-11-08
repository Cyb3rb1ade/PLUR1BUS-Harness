//! Durable S2 compare-and-set checkpoints, isolated by actual principal and physical workspace.
//! Ownerless Node hook state is not adopted; an explicit proven migration remains required.
use super::{
    merged::{optional, Layout},
    watermark::{self, Watermark},
};
use crate::{
    capture::wal::kernel_lock,
    context::RequestContext,
    contract::{AgentContext, Cancel, EngineError, HostServices, Principal, StoreError},
    store::{directory::TrustedDirectory, state_file::StateFile},
    text::{
        js::JsString,
        json::{parse_json, write_json, TolerantJsonValue as Json},
    },
};
use chrono::{SecondsFormat, TimeZone, Utc};
use sha2::{Digest, Sha256};
use std::{io::Read, path::Path, sync::Arc};
const MAX_BYTES: u64 = 4 * 1024 * 1024;
const MAX_SESSION_UNITS: usize = 4096;
const MAX_COUNTER: u64 = 9_007_199_254_740_991;
/// Typed checkpoint mutations. Counts must remain exact JavaScript safe integers.
#[derive(Clone, Copy)]
pub enum Change {
    /// Advance or reset from the caller's previously observed baseline.
    Advance {
        /// Previously observed count.
        baseline: u64,
        /// Completed message count, or compacted count when the baseline still matches.
        to: u64,
    },
    /// Record failures only if the baseline still owns the current count.
    Failure {
        /// Previously observed count.
        baseline: u64,
        /// Consecutive post-processing failures for this baseline.
        failures: u64,
    },
}
/// Acknowledgement after durable application, or an unchanged stale completion.
pub struct Applied {
    /// False means the compare-and-set rejected stale work without rewriting state.
    pub applied: bool,
    /// Current session state after the decision.
    pub watermark: Watermark,
}
struct Binding {
    workspace: TrustedDirectory,
    proof: Json,
    layout: Layout,
    file: String,
}
/// Composition-owned Neo root and host. Every call rebuilds actual request authority.
pub struct SessionStore {
    root: TrustedDirectory,
    host: Arc<dyn HostServices>,
}
impl SessionStore {
    /// Open an existing trusted Neo root without creating directories or lease files.
    pub fn open(root: &Path, host: Arc<dyn HostServices>) -> Result<Self, StoreError> {
        Ok(Self {
            root: TrustedDirectory::open(root)?,
            host,
        })
    }
    fn bind(&self, p: &Principal, a: &AgentContext) -> Result<Binding, EngineError> {
        self.root.assert_unchanged()?;
        let first = self
            .host
            .workspace_dir(&p.agent_id)?
            .ok_or(StoreError::InvalidInput)?;
        let ctx = RequestContext::build(p, a, self.host.as_ref())?;
        if self.host.workspace_dir(&p.agent_id)?.as_ref() != Some(&first)
            || ctx.workspace_key.is_empty()
        {
            return Err(StoreError::InvalidInput.into());
        }
        let workspace = TrustedDirectory::open(&first)?;
        let physical = workspace.path().to_str().ok_or(StoreError::InvalidInput)?;
        let root = self.root.path().to_str().ok_or(StoreError::InvalidInput)?;
        let mut proof = object(vec![
            ("version", num(1)),
            ("agentId", text(&ctx.agent_id.to_string())),
            ("ownerUserId", text(&ctx.owner_user_id)),
            ("workspaceIdentity", text(&ctx.workspace_key)),
            ("workspaceDirectory", text(physical)),
            ("neoRoot", text(root)),
        ]);
        let digest = format!("{:x}", Sha256::digest(write_json(&proof).as_bytes()));
        // Address by logical ownership, but validate physical identities inside the file.
        // A replaced/restored directory must fail closed rather than silently start at zero.
        if let Json::Object(fields) = &mut proof {
            fields.push((
                JsString::from("workspaceFileIdentity"),
                identity(&workspace),
            ));
            fields.push((JsString::from("neoRootFileIdentity"), identity(&self.root)));
        }
        workspace.assert_unchanged()?;
        Ok(Binding {
            workspace,
            proof,
            layout: Layout::for_key(&ctx.workspace_key),
            file: format!("native-hook-state-{digest}.json"),
        })
    }
    fn directory(&self, b: &Binding, create: bool) -> Result<Option<TrustedDirectory>, StoreError> {
        if create {
            return Ok(Some(
                self.root
                    .create_child("workspaces")?
                    .create_child(&b.layout.canonical)?,
            ));
        }
        let Some(parent) = optional(self.root.open_child("workspaces"))? else {
            return Ok(None);
        };
        optional(parent.open_child(&b.layout.canonical))
    }
    /// Read a checkpoint without any file or lock creation. Ownerless legacy state fails closed.
    pub fn read(
        &self,
        p: &Principal,
        a: &AgentContext,
        session: &JsString,
        cancel: &Cancel,
    ) -> Result<Watermark, EngineError> {
        check_session(session)?;
        cancel.check()?;
        let binding = self.bind(p, a)?;
        let state = load(self.directory(&binding, false)?.as_ref(), &binding, cancel)?;
        binding.workspace.assert_unchanged()?;
        self.root.assert_unchanged()?;
        cancel.check()?;
        Ok(watermark::read_session(&state, session))
    }
    /// Reread under the kernel lease, apply the S2 plan and fsync before acknowledging.
    /// No cancellation cut after the atomic commit claims that durable progress was rolled back.
    pub fn apply(
        &self,
        p: &Principal,
        a: &AgentContext,
        session: &JsString,
        change: Change,
        cancel: &Cancel,
    ) -> Result<Applied, EngineError> {
        check_session(session)?;
        cancel.check()?;
        let (baseline, value) = match change {
            Change::Advance { baseline, to } => (baseline, to),
            Change::Failure { baseline, failures } => (baseline, failures),
        };
        if baseline > MAX_COUNTER || value > MAX_COUNTER {
            return Err(StoreError::InvalidInput.into());
        }
        self.transaction(p, a, session, cancel, &|| Ok(()), |transaction| {
            let now = Utc
                .timestamp_millis_opt(self.host.now_ms())
                .single()
                .ok_or(StoreError::InvalidInput)?
                .to_rfc3339_opts(SecondsFormat::Millis, true);
            let now = JsString::from(now.as_str());
            let patch = match change {
                Change::Advance { .. } => watermark::plan_advance(
                    transaction.state(),
                    session,
                    &num(baseline),
                    &num(value),
                    &now,
                )?,
                Change::Failure { .. } => watermark::plan_failure(
                    transaction.state(),
                    session,
                    &num(baseline),
                    &num(value),
                    &now,
                )?,
            };
            let Some(patch) = patch else {
                return Ok(Applied {
                    applied: false,
                    watermark: watermark::read_session(transaction.state(), session),
                });
            };
            let mut state = transaction.state().clone();
            let Json::Object(patch) = patch else {
                return Err(StoreError::Corrupt.into());
            };
            for (key, value) in patch {
                let Json::Object(fields) = &mut state else {
                    return Err(StoreError::Corrupt.into());
                };
                if let Some((_, old)) = fields.iter_mut().find(|(k, _)| k == &key) {
                    *old = value;
                } else {
                    fields.push((key, value));
                }
            }
            transaction.commit(state)?;
            Ok(Applied {
                applied: true,
                watermark: watermark::read_session(transaction.state(), session),
            })
        })
    }
    /// Internal composition holds the same checkpoint lease through dependent durable writes.
    /// Lock order is Neo writer, then checkpoint. External policy is rechecked before commit.
    pub(super) fn transaction<T>(
        &self,
        p: &Principal,
        a: &AgentContext,
        session: &JsString,
        cancel: &Cancel,
        external: &dyn Fn() -> Result<(), EngineError>,
        action: impl FnOnce(&mut Checkpoint<'_>) -> Result<T, EngineError>,
    ) -> Result<T, EngineError> {
        check_session(session)?;
        cancel.check()?;
        external()?;
        let binding = self.bind(p, a)?;
        load(self.directory(&binding, false)?.as_ref(), &binding, cancel)?;
        let directory = self
            .directory(&binding, true)?
            .ok_or(StoreError::Unavailable)?;
        let locks = directory.create_child(".native-hook-leases")?;
        let lease = kernel_lock::acquire(&locks, &binding.file, cancel, &mut || {})?;
        let check = || -> Result<(), EngineError> {
            cancel.check()?;
            external()?;
            if self.bind(p, a)?.proof != binding.proof {
                return Err(StoreError::InvalidInput.into());
            }
            lease.check(&locks)?;
            directory.assert_unchanged()?;
            binding.workspace.assert_unchanged()?;
            Ok(())
        };
        check()?;
        let state = load(Some(&directory), &binding, cancel)?;
        let validate = |state: &Json| -> Result<(), EngineError> {
            watermark::validate_state(state)?;
            let record = object(vec![
                ("ownership", binding.proof.clone()),
                ("agentEnd", state.clone()),
            ]);
            if write_json(&record).len() as u64 + 1 > MAX_BYTES {
                return Err(StoreError::InvalidInput.into());
            }
            Ok(())
        };
        let write = |state: &Json| {
            validate(state)?;
            check()?;
            let record = object(vec![
                ("ownership", binding.proof.clone()),
                ("agentEnd", state.clone()),
            ]);
            StateFile::<Json>::store(&directory.path().join(&binding.file), &record)?;
            directory.assert_unchanged()?;
            self.root.assert_unchanged()?;
            Ok(())
        };
        action(&mut Checkpoint {
            state,
            validate: &validate,
            write: &write,
        })
    }
}
/// Only constructible while the principal's checkpoint lease is held.
pub(super) struct Checkpoint<'a> {
    state: Json,
    validate: &'a dyn Fn(&Json) -> Result<(), EngineError>,
    write: &'a dyn Fn(&Json) -> Result<(), EngineError>,
}
impl Checkpoint<'_> {
    pub(super) fn state(&self) -> &Json {
        &self.state
    }
    pub(super) fn validate(&self, next: &Json) -> Result<(), EngineError> {
        (self.validate)(next)
    }
    pub(super) fn commit(&mut self, next: Json) -> Result<(), EngineError> {
        (self.write)(&next)?;
        self.state = next;
        Ok(())
    }
}

fn check_session(session: &JsString) -> Result<(), StoreError> {
    if session.as_utf16_units().len() > MAX_SESSION_UNITS {
        Err(StoreError::InvalidInput)
    } else {
        Ok(())
    }
}
fn load(
    directory: Option<&TrustedDirectory>,
    binding: &Binding,
    cancel: &Cancel,
) -> Result<Json, EngineError> {
    cancel.check()?;
    let Some(directory) = directory else {
        return Ok(Json::Object(vec![]));
    };
    let Some(mut file) = optional(directory.open_file(&binding.file))? else {
        // Existing Node counters do not prove which principal owns their session history.
        if optional(directory.open_file("hook-state.json"))?.is_some() {
            return Err(StoreError::Unavailable.into());
        }
        return Ok(Json::Object(vec![]));
    };
    super::vectors::ordinary(&file)?;
    if file.metadata().map_err(StoreError::from)?.len() > MAX_BYTES {
        return Err(StoreError::Corrupt.into());
    }
    let mut bytes = Vec::new();
    let mut chunk = [0; 64 * 1024];
    loop {
        cancel.check()?;
        let count = file.read(&mut chunk).map_err(StoreError::from)?;
        if count == 0 {
            break;
        }
        if bytes.len() + count > MAX_BYTES as usize {
            return Err(StoreError::Corrupt.into());
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    let value = parse_json(std::str::from_utf8(&bytes).map_err(|_| StoreError::Corrupt)?)
        .map_err(|_| StoreError::Corrupt)?;
    if exact(&value, "ownership")? != &binding.proof {
        return Err(StoreError::Corrupt.into());
    }
    let state = exact(&value, "agentEnd")?;
    watermark::validate_state(state)?;
    directory.assert_unchanged()?;
    cancel.check()?;
    Ok(state.clone())
}
fn exact<'a>(value: &'a Json, name: &str) -> Result<&'a Json, StoreError> {
    let Json::Object(fields) = value else {
        return Err(StoreError::Corrupt);
    };
    let mut found = fields.iter().filter(|(k, _)| k == &JsString::from(name));
    let value = found.next().ok_or(StoreError::Corrupt)?;
    if found.next().is_some() {
        return Err(StoreError::Corrupt);
    }
    Ok(&value.1)
}
fn object(fields: Vec<(&str, Json)>) -> Json {
    Json::Object(
        fields
            .into_iter()
            .map(|(k, v)| (JsString::from(k), v))
            .collect(),
    )
}
fn text(v: &str) -> Json {
    Json::String(JsString::from(v))
}
fn num(v: u64) -> Json {
    Json::Number(v.to_string())
}

fn identity(directory: &TrustedDirectory) -> Json {
    let (volume, file) = directory.identity_parts();
    text(&format!("{volume:x}:{file:x}"))
}
