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
/// The most a damaged key file is read and compared before it is replaced; a larger file stays `Corrupt`.
const DAMAGED_MAX: usize = 4096;

/// What ties the partitions of one `engine.jobs.run` call together in the ledger. Either way the history shows the
/// runs as one entry, so it never tells how many people a call ran for.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Batch<'a> {
    /// A scheduler's due. Calls for the same due share it, and a person's completed run answers a repeat.
    Due(&'a str),
    /// A call that named no due, under a marker of its own. Nothing is remembered for a later call.
    Call(&'a str),
}

pub(super) struct Partition {
    pub token: String,
    pub due: String,
    pub idempotency: Option<String>,
}

impl Registry {
    pub(super) fn partition(
        &self,
        request: &RequestContext,
        job: JobName,
        batch: Batch<'_>,
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
        let (domain, value, repeatable) = match batch {
            Batch::Due(value) => ("engine-job-due-v1", value, true),
            Batch::Call(value) => ("engine-job-call-v1", value, false),
        };
        let due = digest(&key, domain, &[request.agent_id.as_str(), &job, value])?;
        let idempotency = repeatable
            .then(|| digest(&key, "engine-job-idempotency-v1", &[&token, &job, &due]))
            .transpose()?;
        Ok(Partition {
            token,
            due,
            idempotency,
        })
    }

    /// The installation's key, created on first use. A key file that does not hold exactly one key (empty, cut short,
    /// or with bytes added, up to `DAMAGED_MAX`) is a lost key: it is replaced under the lease like a missing one, so
    /// the runs recorded under the old key are no longer recognised and each due runs once more. Failing instead
    /// would stop every scoped job of the installation until someone removed the file by hand.
    fn partition_key(&self, cancel: &Cancel) -> Result<[u8; KEY_SIZE], EngineError> {
        if let Some(key) =
            whole_key(io::read(&self.root, KEY_FILE, DAMAGED_MAX, cancel)?.as_deref())
        {
            return Ok(key);
        }
        self.root.restrict_private()?;
        let lease = kernel_lease::acquire(&self.root, "job-partitions", cancel, &mut || {})?;
        let stored = io::read(&self.root, KEY_FILE, DAMAGED_MAX, cancel)?;
        if let Some(key) = whole_key(stored.as_deref()) {
            return Ok(key);
        }
        let mut key = [0; KEY_SIZE];
        getrandom::fill(&mut key).map_err(|_| StoreError::Unavailable)?;
        io::replace(
            &self.root,
            KEY_FILE,
            stored.as_deref(),
            &key,
            DAMAGED_MAX,
            cancel,
            &|| {
                cancel.check()?;
                lease.check(&self.root)?;
                Ok(())
            },
        )?;
        self.root.sync_entries()?;
        Ok(key)
    }
}

/// The stored bytes as a key, when they are exactly one.
fn whole_key(stored: Option<&[u8]>) -> Option<[u8; KEY_SIZE]> {
    stored?.try_into().ok()
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

    struct Maintenance {
        calls: Arc<AtomicUsize>,
        blocked: String,
        entered: std::sync::mpsc::SyncSender<()>,
        release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
        hold: std::sync::atomic::AtomicBool,
    }
    impl JobBody for Maintenance {
        fn name(&self) -> JobName {
            JobName::AutoAcceptStale
        }
        fn run(&self, context: &JobContext, _cancel: &Cancel) -> Result<JobReport, EngineError> {
            let owner = &context.authority()?.request().owner_user_id;
            if owner == &self.blocked && self.hold.swap(false, Ordering::SeqCst) {
                self.entered.send(()).unwrap();
                self.release
                    .lock()
                    .unwrap()
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .unwrap();
            }
            self.calls.fetch_add(1, Ordering::SeqCst);
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
        let (entered, did_enter) = std::sync::mpsc::sync_channel(0);
        let (release, did_release) = std::sync::mpsc::sync_channel(1);
        registry
            .bind_scoped(Arc::new(Maintenance {
                calls: calls.clone(),
                blocked: crate::context::harness_user_principal("synthetic-person-a"),
                entered,
                release: std::sync::Mutex::new(did_release),
                hold: std::sync::atomic::AtomicBool::new(true),
            }))
            .unwrap();
        let attempt_in = |name: &str, batch: Batch<'_>| {
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
            registry.run_partitioned(authority, &RunOptions::default(), &cancel, &cancel, batch)
        };
        let attempt = |name: &str| attempt_in(name, Batch::Due("fixed-due"));
        let execute = |name: &str| attempt(name).unwrap();
        let (first, second) = std::thread::scope(|tasks| {
            let a = tasks.spawn(|| execute("synthetic-person-a"));
            did_enter
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
            let b = execute("synthetic-person-b");
            release.send(()).unwrap();
            (a.join().unwrap(), b)
        });
        assert_eq!(first.outcome, JobOutcome::Completed);
        assert_eq!(execute("synthetic-person-a").run_id, first.run_id);
        assert_eq!(second.outcome, JobOutcome::Completed);
        assert_ne!(second.run_id, first.run_id);
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
        // A key file that does not hold exactly one key is a lost key too, never a failure of every scoped run.
        let mut last = retried.run_id;
        for (round, damaged) in [vec![], vec![7; KEY_SIZE - 1], vec![7; KEY_SIZE + 1]]
            .into_iter()
            .enumerate()
        {
            std::fs::write(root.path().join(KEY_FILE), damaged).unwrap();
            let again = execute("synthetic-person-a");
            assert_ne!(again.run_id, last, "round {round}");
            assert_eq!(
                std::fs::read(root.path().join(KEY_FILE)).unwrap().len(),
                KEY_SIZE,
                "round {round}"
            );
            assert_eq!(
                execute("synthetic-person-a").run_id,
                again.run_id,
                "round {round}"
            );
            assert_eq!(calls.load(Ordering::SeqCst), 4 + round, "round {round}");
            last = again.run_id;
        }
        // A call without a due is one history entry however many people it ran for, and no later call is answered
        // from it.
        // History entries, and those among them that sum two people's runs.
        let entries = || {
            let history = registry
                .history(
                    &agent,
                    serde_json::from_value(serde_json::json!({})).unwrap(),
                )
                .unwrap();
            let both = history
                .iter()
                .filter(|run| run.counts.get("changed").and_then(|n| n.as_u64()) == Some(2))
                .count();
            (history.len(), both)
        };
        let ((before, both), ran) = (entries(), calls.load(Ordering::SeqCst));
        let a = attempt_in("synthetic-person-a", Batch::Call("call-1")).unwrap();
        let b = attempt_in("synthetic-person-b", Batch::Call("call-1")).unwrap();
        assert_ne!(a.run_id, b.run_id);
        assert_eq!(entries(), (before + 1, both + 1));
        let next = attempt_in("synthetic-person-b", Batch::Call("call-2")).unwrap();
        assert_ne!(next.run_id, b.run_id);
        assert_eq!(entries(), (before + 2, both + 1));
        assert_eq!(calls.load(Ordering::SeqCst), ran + 3);
        // Beyond the bound the file is left alone and the run fails as before.
        std::fs::write(root.path().join(KEY_FILE), vec![7; DAMAGED_MAX + 1]).unwrap();
        assert!(attempt("synthetic-person-a").is_err());
        assert_eq!(
            std::fs::read(root.path().join(KEY_FILE)).unwrap().len(),
            DAMAGED_MAX + 1
        );
    }
}
