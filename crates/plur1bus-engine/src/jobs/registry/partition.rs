//! Scoped job identities are derived from a private installation-local key.
use super::Registry;
use crate::{
    context::RequestContext,
    contract::{Cancel, EngineError, JobName, StoreError},
    jobs::ledger::io,
    store::kernel_lease,
};
use hmac::{Hmac, Mac};
use sha2::Sha256;

const KEY_FILE: &str = "partition.key";
const KEY_SIZE: usize = 32;

pub(super) struct Partition {
    pub token: String,
    pub due: Option<String>,
    pub idempotency: Option<String>,
}

impl Registry {
    pub(super) fn partition(
        &self,
        request: &RequestContext,
        job: JobName,
        due: Option<&str>,
        cancel: &Cancel,
    ) -> Result<Partition, EngineError> {
        let key = self.partition_key(cancel)?;
        let token = digest(
            &key,
            "engine-job-partition-v1",
            &[
                request.agent_id.as_str(),
                &request.workspace_key,
                &request.owner_user_id,
            ],
        )?;
        let job = job.to_string();
        let due = due
            .map(|value| {
                digest(
                    &key,
                    "engine-job-due-v1",
                    &[request.agent_id.as_str(), &job, value],
                )
            })
            .transpose()?;
        let idempotency = due
            .as_ref()
            .map(|value| digest(&key, "engine-job-idempotency-v1", &[&token, &job, value]))
            .transpose()?;
        Ok(Partition {
            token,
            due,
            idempotency,
        })
    }

    fn partition_key(&self, cancel: &Cancel) -> Result<[u8; KEY_SIZE], EngineError> {
        if let Some(key) = io::read(&self.root, KEY_FILE, KEY_SIZE, cancel)? {
            return key.try_into().map_err(|_| StoreError::Corrupt.into());
        }
        self.root.restrict_private()?;
        let lease = kernel_lease::acquire(&self.root, "job-partitions", cancel, &mut || {})?;
        if let Some(key) = io::read(&self.root, KEY_FILE, KEY_SIZE, cancel)? {
            return key.try_into().map_err(|_| StoreError::Corrupt.into());
        }
        let mut key = [0; KEY_SIZE];
        getrandom::fill(&mut key).map_err(|_| StoreError::Unavailable)?;
        io::replace(&self.root, KEY_FILE, None, &key, KEY_SIZE, cancel, &|| {
            cancel.check()?;
            lease.check(&self.root)?;
            Ok(())
        })?;
        self.root.sync_entries()?;
        Ok(key)
    }
}

fn digest(key: &[u8; KEY_SIZE], domain: &str, fields: &[&str]) -> Result<String, EngineError> {
    let mut hmac = Hmac::<Sha256>::new_from_slice(key).map_err(|_| StoreError::Corrupt)?;
    for part in std::iter::once(domain).chain(fields.iter().copied()) {
        hmac.update(&(part.len() as u64).to_be_bytes());
        hmac.update(part.as_bytes());
    }
    Ok(format!("{:x}", hmac.finalize().into_bytes()))
}

pub(crate) fn opaque(value: &crate::text::json::TolerantJsonValue) -> bool {
    use crate::text::json::TolerantJsonValue::String;
    matches!(value, String(token) if {
        let token = token.to_utf8_lossy();
        token.len() == 64 && token.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "fixture setup and assertions")]
    use super::*;
    use crate::{
        contract::{AgentContext, JobOutcome, JobRegistry, RunOptions},
        jobs::{
            authority::JobAuthority,
            registry::{JobBody, JobContext, JobReport},
        },
    };
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    struct Maintenance(Arc<AtomicUsize>);
    impl JobBody for Maintenance {
        fn name(&self) -> JobName {
            JobName::AutoAcceptStale
        }
        fn run(&self, context: &JobContext, _cancel: &Cancel) -> Result<JobReport, EngineError> {
            assert!(!context.authority()?.request().owner_user_id.is_empty());
            self.0.fetch_add(1, Ordering::SeqCst);
            context.note_count("changed", 1)?;
            Ok(JobReport::completed())
        }
    }

    #[test]
    fn completion_and_key_loss_are_isolated_from_other_private_partitions() {
        use crate::{
            context::RouteVocabulary,
            contract::testing::FakeHost,
            contract::{AgentId, Principal},
        };
        let root = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let workspace = root.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let agent: AgentId = "main".parse().unwrap();
        let host = FakeHost::new(
            root.path().to_owned(),
            crate::contract::EngineConfig::default(),
        );
        host.set_workspace(&agent, workspace.clone());
        let job = JobName::AutoAcceptStale;
        let cancel = Cancel::never();
        let calls = Arc::new(AtomicUsize::new(0));
        let registry = Registry::new(root.path(), Arc::new(|| 1_768_305_600_000)).unwrap();
        registry
            .bind_scoped(Arc::new(Maintenance(calls.clone())))
            .unwrap();
        let execute = |name: &str| {
            let user = crate::context::harness_user_principal(name);
            let principal: Principal = serde_json::from_value(serde_json::json!({
                "agentId":"main","workspace": format!("workspace-dir:v1:{}",workspace.display()),
                "user": user,"channel":"telegram","accountId":"fixture",
                "chat":{"id":"fixture","kind":"direct"},"trust":"proved",
            }))
            .unwrap();
            let context: AgentContext =
                serde_json::from_value(serde_json::json!({"origin":"cron","background":true}))
                    .unwrap();
            let authority = JobAuthority::from_host(
                &host,
                job,
                &agent,
                principal,
                context,
                RouteVocabulary::shared(),
            )
            .unwrap();
            registry
                .run_partitioned(
                    authority,
                    &RunOptions::default(),
                    &cancel,
                    &cancel,
                    Some("fixed-due"),
                )
                .unwrap()
        };
        let first = execute("synthetic-person-a");
        assert_eq!(first.outcome, JobOutcome::Completed);
        assert_eq!(execute("synthetic-person-a").run_id, first.run_id);
        assert_ne!(execute("synthetic-person-b").run_id, first.run_id);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        let history = registry
            .history(
                &agent,
                serde_json::from_value(serde_json::json!({})).unwrap(),
            )
            .unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].counts["changed"].as_u64(), Some(2));
        assert!(history[0].idempotency_key.is_none());
        let ledger = std::fs::read_to_string(root.path().join("main/ledger.jsonl")).unwrap();
        assert!(
            !ledger.contains("synthetic-person")
                && !ledger.contains("user:v2:")
                && !ledger.contains("fixed-due")
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(root.path().join(KEY_FILE))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        std::fs::remove_file(root.path().join(KEY_FILE)).unwrap();
        let retried = execute("synthetic-person-a");
        assert_ne!(retried.run_id, first.run_id);
        assert_eq!(execute("synthetic-person-a").run_id, retried.run_id);
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }
}
