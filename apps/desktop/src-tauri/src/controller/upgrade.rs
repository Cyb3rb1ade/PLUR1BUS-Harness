//! The manual and unattended paths share one cold-snapshot transaction.
use super::{
    bundle::{Arch, Bundle},
    journal::{Journal, RestorePhase, Snapshot, Step},
    *,
};
use crate::{
    connections::Connection,
    secrets::{token_account, SecretString, TokenStore},
    updates::Kind,
};
use semver::Version;
use serde::Serialize;
use serde_json::Value;
#[derive(Debug, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Outcome {
    Upgraded {
        to: Version,
    },
    RolledBack {
        failed_step: Step,
        from: Version,
        to: Version,
    },
    RecoveryFailed {
        diagnostic: String,
    },
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GateReport {
    pub ready: bool,
    pub meta_ok: bool,
    pub token_ok: bool,
    pub firstaid_ok: bool,
    pub smoke_ok: bool,
    pub failures: Vec<String>,
}
/// Injectable origin-bound authentication probe; never writes or rotates a device credential.
#[async_trait::async_trait]
pub trait UpgradeProbe: Send + Sync {
    async fn check(
        &self,
        conn: &Connection,
        token: &SecretString,
        version: &Version,
    ) -> Result<(), &'static str>;
}
pub struct NativeUpgradeProbe;
#[async_trait::async_trait]
impl UpgradeProbe for NativeUpgradeProbe {
    async fn check(
        &self,
        conn: &Connection,
        token: &SecretString,
        version: &Version,
    ) -> Result<(), &'static str> {
        let client = crate::client::HarnessClient::from_connection(conn)
            .await
            .map_err(|_| "meta")?;
        let meta = client.meta().await.map_err(|_| "meta")?;
        if meta.version != version.to_string() || meta.installation_id != conn.installation_id {
            return Err("meta");
        }
        client
            .whoami(&conn.installation_id, token)
            .await
            .map_err(|_| "token")
    }
}
fn healthy(v: &Value) -> bool {
    v["schema"] == "1staid.check/1"
        && v["checks"].as_array().is_some_and(|a| {
            !a.is_empty()
                && a.iter()
                    .all(|r| matches!(r["status"].as_str(), Some("ok" | "warn" | "skip")))
        })
}
fn row<'a>(v: &'a Value, id: &str) -> Result<&'a Value, CtlError> {
    v["checks"]
        .as_array()
        .and_then(|a| a.iter().find(|r| r["id"] == id))
        .map(|r| &r["detail"])
        .ok_or(CtlError::Health)
}
fn parse_snapshot(v: Value, volume: String) -> Result<Snapshot, CtlError> {
    if v["schema"] != "state.snapshot/1" {
        return Err(CtlError::Health);
    }
    let s = Snapshot {
        volume,
        manifest_sha256: v["manifestSha256"].as_str().ok_or(CtlError::Health)?.into(),
        created_at: v["createdAt"].as_str().ok_or(CtlError::Health)?.into(),
        bytes: v["bytes"].as_u64().ok_or(CtlError::Health)?,
        file_count: v["fileCount"].as_u64().ok_or(CtlError::Health)?,
    };
    if s.manifest_sha256.len() != 64 || !s.manifest_sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(CtlError::Health);
    }
    Ok(s)
}
impl Controller {
    #[cfg(debug_assertions)]
    pub fn with_upgrade_probe(mut self, probe: Arc<dyn UpgradeProbe>, timeout: Duration) -> Self {
        self.upgrade_probe = probe;
        self.upgrade_timeout = timeout;
        self
    }
    pub(crate) fn resource_labels(&self, role: &str) -> crate::runtime::Labels {
        let mut labels = crate::runtime::Labels::from([("app.plur1bus.role".into(), role.into())]);
        if let Some(id) = &self.names.test {
            labels.insert("app.plur1bus.test".into(), id.clone());
        }
        labels
    }
    pub(crate) fn require_settled_upgrade(&self) -> Result<(), CtlError> {
        if self
            .upgrade_journal()?
            .is_some_and(|j| !j.step.terminal() || j.step == Step::RecoveryFailed)
        {
            Err(CtlError::Health)
        } else {
            Ok(())
        }
    }
    pub fn upgrade_journal(&self) -> Result<Option<Journal>, CtlError> {
        let j = Journal::load(&self.dir)?;
        if let Some(j) = &j {
            if j.previous.container != self.names.container
                || j.previous.runtime != self.info().kind
                || j.previous.endpoint != self.info().endpoint
                || !(18700..=18799).contains(&j.previous.port)
                || j.snapshot
                    .as_ref()
                    .is_some_and(|s| s.volume != format!("{}-pre-{}", self.names.state, j.from))
                || j.failed_snapshot
                    .as_ref()
                    .is_some_and(|s| s.volume != format!("{}-failed-{}", self.names.state, j.to))
                || j.cleanup
                    .as_ref()
                    .is_some_and(|s| !s.volume.starts_with(&format!("{}-pre-", self.names.state)))
                || j.cleanup_failed
                    .as_ref()
                    .is_some_and(|s| !s.starts_with(&format!("{}-failed-", self.names.state)))
            {
                return Err(CtlError::Storage);
            }
        }
        Ok(j)
    }
    fn checkpoint(&self, j: &mut Journal, step: Step, ui: &impl Fn(Step)) -> Result<(), CtlError> {
        j.step = step;
        j.save(&self.dir)?;
        ui(step);
        Ok(())
    }
    fn restore_checkpoint(
        &self,
        j: &mut Journal,
        phase: RestorePhase,
        step: Step,
        ui: &impl Fn(Step),
    ) -> Result<(), CtlError> {
        j.restore_phase = phase;
        self.checkpoint(j, step, ui)
    }
    async fn upgrade_exec(&self, i: &Installed, argv: &[&str]) -> Result<Value, CtlError> {
        let state = self.runtime.state(&i.container).await?;
        if !state.exists
            || state.labels.get("app.plur1bus.role").map(String::as_str) != Some("harness")
            || state.labels.get("app.plur1bus.image.digest") != Some(&i.image_digest)
        {
            return Err(CtlError::Runtime(RuntimeError::Conflict(
                "foreign-container".into(),
            )));
        }
        if argv.first() != Some(&"plur1bus")
            || crate::contract::exec::classify(&argv[1..]).is_none()
        {
            return Err(CtlError::Invalid);
        }
        decode(
            self.runtime
                .exec(&i.container, argv, None, Duration::from_secs(30))
                .await?,
        )
    }
    async fn oneshot(
        &self,
        digest: &str,
        cmd: &[&str],
        volumes: Vec<(String, String, bool)>,
    ) -> Result<Value, CtlError> {
        if cmd.first() != Some(&"plur1bus") || crate::contract::exec::classify(&cmd[1..]).is_none()
        {
            return Err(CtlError::Invalid);
        }
        let mut spec = crate::runtime::spec::oneshot_spec(
            digest,
            cmd.iter().map(|s| (*s).into()).collect(),
            volumes,
        );
        spec.labels = self.labels("upgrade-worker", digest);
        decode(
            self.runtime
                .run_oneshot(&spec, Duration::from_secs(300))
                .await?,
        )
    }
    async fn snapshot_state(&self, j: &Journal, volume: &str) -> Result<Snapshot, CtlError> {
        self.runtime
            .volume_ensure(volume, 64, &self.resource_labels("snapshot"))
            .await?;
        let v = self
            .oneshot(
                &j.from_digest,
                &[
                    "plur1bus", "state", "snapshot", "--src", "/src", "--dst", "/dst", "--json",
                ],
                vec![
                    (self.names.state.clone(), "/src".into(), true),
                    (volume.into(), "/dst".into(), false),
                ],
            )
            .await?;
        let s = parse_snapshot(v, volume.into())?;
        self.verify_snapshot(j, &s).await?;
        Ok(s)
    }
    async fn verify_snapshot(&self, j: &Journal, s: &Snapshot) -> Result<(), CtlError> {
        let v = self
            .oneshot(
                &j.from_digest,
                &["plur1bus", "state", "verify", "--dir", "/snap", "--json"],
                vec![(s.volume.clone(), "/snap".into(), true)],
            )
            .await?;
        if v["schema"] != "state.verify/1"
            || v["ok"] != true
            || v["manifestSha256"] != s.manifest_sha256
        {
            return Err(CtlError::Health);
        }
        Ok(())
    }
    fn target_install(&self, j: &Journal) -> Installed {
        let mut i = j.previous.clone();
        i.image_digest = j.to_digest.clone();
        i.installed_version = j.to.to_string();
        i
    }
    pub async fn gate(
        &self,
        i: &Installed,
        tokens: &dyn TokenStore,
        conn: &Connection,
    ) -> GateReport {
        let mut r = GateReport {
            ready: false,
            meta_ok: false,
            token_ok: false,
            firstaid_ok: false,
            smoke_ok: false,
            failures: vec![],
        };
        let run = async {
            loop {
                if self.health.ready(i.port).await
                    && daemon_is_ready(
                        &self
                            .upgrade_exec(i, &["plur1bus", "daemon", "status", "--json"])
                            .await?,
                    )
                {
                    break;
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            r.ready = true;
            let token = tokens
                .get(&token_account(conn.id))
                .map_err(|_| CtlError::Health)?
                .ok_or(CtlError::Health)?;
            let version = Version::parse(&i.installed_version).map_err(|_| CtlError::Invalid)?;
            match self.upgrade_probe.check(conn, &token, &version).await {
                Ok(()) => {
                    r.meta_ok = true;
                    r.token_ok = true
                }
                Err(e) => {
                    r.failures.push(e.into());
                    return Err(CtlError::Health);
                }
            }
            r.firstaid_ok = healthy(
                &self
                    .upgrade_exec(i, &["plur1bus", "1staid", "check", "--json"])
                    .await?,
            );
            if !r.firstaid_ok {
                return Err(CtlError::Health);
            }
            let smoke = self
                .upgrade_exec(i, &["plur1bus", "admin", "smoke", "--json"])
                .await?;
            r.smoke_ok = smoke["schema"] == "admin.smoke/1" && smoke["ok"] == true;
            if !r.smoke_ok {
                return Err(CtlError::Health);
            }
            Ok(())
        };
        match tokio::time::timeout(self.upgrade_timeout, run).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => r.failures.push(e.code().into()),
            Err(_) => r.failures.push("gate-timeout".into()),
        };
        r
    }
    pub async fn upgrade(
        &self,
        to: &Bundle,
        approved: Version,
        kind: Kind,
        tokens: &dyn TokenStore,
        conn: &Connection,
        ui: impl Fn(Step),
    ) -> Result<Outcome, CtlError> {
        let _guard = self.mutation.lock().await;
        let old = self.installed()?.ok_or(CtlError::NotInstalled)?;
        let from = Version::parse(&old.installed_version).map_err(|_| CtlError::Invalid)?;
        if approved != Version::parse(&to.version).map_err(|_| CtlError::Bundle)?
            || approved <= from
            || !to.supported_image_majors.contains(&from.major)
        {
            return Err(CtlError::Bundle);
        }
        let prior = self.upgrade_journal()?;
        if prior
            .as_ref()
            .is_some_and(|j| !j.step.terminal() || j.step == Step::RecoveryFailed)
        {
            return Err(CtlError::Health);
        }
        let mut j = Journal {
            from,
            to: approved,
            from_digest: old.image_digest.clone(),
            to_digest: to
                .digest(Arch::host())
                .map_err(|_| CtlError::Bundle)?
                .into(),
            step: Step::Preflight,
            snapshot: None,
            failed_step: None,
            diagnostic: None,
            previous: old.clone(),
            skipped: false,
            restore_phase: RestorePhase::VerifySnapshot,
            failed_snapshot: None,
            cleanup: prior.as_ref().and_then(|p| p.snapshot.clone()),
            cleanup_failed: prior
                .as_ref()
                .and_then(|p| p.failed_snapshot.as_ref().map(|s| s.volume.clone())),
        };
        self.checkpoint(&mut j, Step::Preflight, &ui)?;
        let preflight = async {
            let pre = self
                .upgrade_exec(&old, &["plur1bus", "1staid", "check", "--json"])
                .await?;
            if !healthy(&pre) {
                return Err(CtlError::Health);
            }
            let storage = row(&pre, "storage")?;
            let used = storage["stateUsedBytes"].as_u64().ok_or(CtlError::Health)?;
            let image = storage["imageBytes"].as_u64().ok_or(CtlError::Health)?;
            let free = storage["freeBytes"].as_u64().ok_or(CtlError::Health)?;
            if free
                < used
                    .checked_mul(6)
                    .and_then(|n| n.checked_add(4))
                    .and_then(|n| n.checked_div(5))
                    .and_then(|n| n.checked_add(image))
                    .ok_or(CtlError::Health)?
            {
                return Err(CtlError::Storage);
            }
            self.acquire_bundle(to).await?;
            Ok(pre)
        }
        .await;
        let pre = match preflight {
            Ok(v) => v,
            Err(e) => {
                if let Some(p) = prior {
                    p.save(&self.dir)?;
                } else {
                    j.failed_step = Some(Step::Preflight);
                    j.diagnostic = Some(e.code().into());
                    j.step = Step::RolledBack;
                    j.save(&self.dir)?;
                }
                return Err(e);
            }
        };
        self.checkpoint(&mut j, Step::Stopping, &ui)?;
        if let Err(e) = self
            .runtime
            .stop(&old.container, Duration::from_secs(150))
            .await
        {
            return self
                .before_swap_failure(&mut j, e.into(), tokens, conn, &ui)
                .await;
        }
        self.checkpoint(&mut j, Step::Snapshotting, &ui)?;
        let volume = format!("{}-pre-{}", self.names.state, j.from);
        match self.snapshot_state(&j, &volume).await {
            Ok(s) => {
                j.snapshot = Some(s);
                j.save(&self.dir)?;
            }
            Err(e) => return self.before_swap_failure(&mut j, e, tokens, conn, &ui).await,
        }
        let result = async {
            // Prune only after the next verified snapshot is durable.
            if let Some(s) = &j.cleanup {
                self.remove_container_owned(&format!("{}-previous", self.names.container), None)
                    .await?;
                self.runtime
                    .volume_remove_owned(&s.volume, &self.resource_labels("snapshot"))
                    .await?;
            }
            if let Some(v) = &j.cleanup_failed {
                self.runtime
                    .volume_remove_owned(v, &self.resource_labels("snapshot"))
                    .await?;
            }
            self.checkpoint(&mut j, Step::Swapping, &ui)?;
            self.runtime
                .rename(
                    &old.container,
                    &format!("{}-previous", self.names.container),
                )
                .await?;
            let target = self.target_install(&j);
            let mut spec = self.spec(&target);
            spec.labels
                .insert("app.plur1bus.version".into(), j.to.to_string());
            spec.env
                .push(("PLUR1BUS_UPGRADE_FROM".into(), j.from.to_string()));
            // Reserve the exact saved port just as the initial installer does.
            // A concurrent local listener must cause rollback, never a silent port change.
            let reservation =
                std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, target.port))
                    .map_err(|_| CtlError::PortBusy)?;
            self.runtime.create(&spec).await?;
            drop(reservation);
            self.runtime.start(&target.container).await?;
            self.checkpoint(&mut j, Step::Migrating, &ui)?;
            tokio::time::timeout(self.upgrade_timeout, async {
                loop {
                    if daemon_is_ready(
                        &self
                            .upgrade_exec(&target, &["plur1bus", "daemon", "status", "--json"])
                            .await?,
                    ) {
                        break Ok::<(), CtlError>(());
                    }
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            })
            .await
            .map_err(|_| CtlError::StartTimeout)??;
            let aid = self
                .upgrade_exec(&target, &["plur1bus", "1staid", "check", "--json"])
                .await?;
            if !healthy(&aid) {
                return Err(CtlError::Health);
            }
            let schemas = row(&aid, "engine.storeSchema")?;
            let current = schemas["current"].as_u64().ok_or(CtlError::Health)?;
            let required = schemas["required"].as_u64().ok_or(CtlError::Health)?;
            let before = row(&pre, "engine.storeSchema")?["current"]
                .as_u64()
                .ok_or(CtlError::Health)?;
            if kind == Kind::Patch && (current != required || current != before) {
                return Err(CtlError::Health);
            }
            if current != required {
                let a = current.to_string();
                let b = required.to_string();
                let migrate = self
                    .upgrade_exec(
                        &target,
                        &[
                            "plur1bus", "admin", "migrate", "--from", &a, "--to", &b, "--yes",
                            "--json",
                        ],
                    )
                    .await?;
                if migrate["schema"] != "admin.migrate/1" || migrate["ok"] != true {
                    return Err(CtlError::Health);
                }
            }
            self.checkpoint(&mut j, Step::Gating, &ui)?;
            if !self.gate(&target, tokens, conn).await.failures.is_empty() {
                return Err(CtlError::Health);
            }
            self.save(&target)?;
            self.checkpoint(&mut j, Step::Done, &ui)?;
            Ok(Outcome::Upgraded { to: j.to.clone() })
        }
        .await;
        match result {
            Ok(o) => Ok(o),
            Err(e) => {
                if j.step == Step::Snapshotting {
                    return self.before_swap_failure(&mut j, e, tokens, conn, &ui).await;
                }
                j.failed_step = Some(j.step);
                j.diagnostic = Some(self.diagnostic(&j, e).await);
                self.restore_checkpoint(
                    &mut j,
                    RestorePhase::VerifySnapshot,
                    Step::RollingBack,
                    &ui,
                )?;
                self.restore(&mut j, tokens, conn, &ui).await
            }
        }
    }
    async fn before_swap_failure(
        &self,
        j: &mut Journal,
        e: CtlError,
        tokens: &dyn TokenStore,
        conn: &Connection,
        ui: &impl Fn(Step),
    ) -> Result<Outcome, CtlError> {
        j.failed_step = Some(j.step);
        j.diagnostic = Some(e.code().into());
        j.skipped = true;
        j.save(&self.dir)?;
        let volume = format!("{}-pre-{}", self.names.state, j.from);
        // A partial cold copy is disposable; live state has never been modified.
        self.runtime
            .volume_remove_owned(&volume, &self.resource_labels("snapshot"))
            .await?;
        self.runtime.start(&j.previous.container).await?;
        if !self
            .gate(&j.previous, tokens, conn)
            .await
            .failures
            .is_empty()
        {
            return self.recovery_failed(j, ui);
        }
        self.save(&j.previous)?;
        self.checkpoint(j, Step::RolledBack, ui)?;
        Ok(rolled(j))
    }
    async fn diagnostic(&self, j: &Journal, e: CtlError) -> String {
        let raw = self
            .runtime
            .logs_tail(&self.names.container, 200)
            .await
            .unwrap_or_default();
        let home = std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
            .unwrap_or_else(|_| "/unavailable".into());
        let f = crate::logging::Formatter::new(
            crate::logging::SecretRegistry::process(),
            Arc::new(crate::logging::CredentialPaths::new(&home)),
            true,
        );
        let logs = f
            .redact_text(&raw)
            .unwrap_or_else(|_| "redaction-unavailable".into());
        // Never persist RuntimeError's arbitrary strings or command arguments.
        let exit = if let CtlError::ExecFailed { code, .. } = e {
            format!(" exit={code}")
        } else {
            String::new()
        };
        let mut value = format!("{:?}: {}{exit}\n{logs}", j.step, e.code());
        while value.len() > 16000 {
            value.pop();
        }
        value
    }
    async fn remove_container_owned(
        &self,
        name: &str,
        digest: Option<&str>,
    ) -> Result<(), CtlError> {
        let s = self.runtime.state(name).await?;
        if !s.exists {
            return Ok(());
        }
        if s.labels.get("app.plur1bus.role").map(String::as_str) != Some("harness")
            || digest.is_some_and(|d| {
                s.labels
                    .get("app.plur1bus.image.digest")
                    .map(String::as_str)
                    != Some(d)
            })
        {
            return Err(CtlError::Health);
        }
        if s.running {
            self.runtime.stop(name, Duration::from_secs(150)).await?;
        }
        self.runtime.remove(name).await?;
        Ok(())
    }
    fn recovery_failed(&self, j: &mut Journal, ui: &impl Fn(Step)) -> Result<Outcome, CtlError> {
        let diagnostic = j
            .diagnostic
            .clone()
            .unwrap_or_else(|| "recovery-failed".into());
        self.checkpoint(j, Step::RecoveryFailed, ui)?;
        Ok(Outcome::RecoveryFailed { diagnostic })
    }
    pub async fn rollback_manual(
        &self,
        confirmed: bool,
        tokens: &dyn TokenStore,
        conn: &Connection,
        ui: impl Fn(Step),
    ) -> Result<Outcome, CtlError> {
        if !confirmed {
            return Err(CtlError::Invalid);
        }
        let _guard = self.mutation.lock().await;
        let mut j = self.upgrade_journal()?.ok_or(CtlError::NotInstalled)?;
        if j.step != Step::Done || j.snapshot.is_none() {
            return Err(CtlError::Invalid);
        }
        let previous = self
            .runtime
            .state(&format!("{}-previous", self.names.container))
            .await?;
        if !previous.exists
            || previous.labels.get("app.plur1bus.image.digest") != Some(&j.from_digest)
        {
            return Err(CtlError::Health);
        }
        if !self
            .runtime
            .volume_present(
                &j.snapshot.as_ref().ok_or(CtlError::Health)?.volume,
                &self.resource_labels("snapshot"),
            )
            .await?
        {
            return Err(CtlError::Health);
        }
        j.failed_step = Some(Step::Done);
        self.restore_checkpoint(&mut j, RestorePhase::VerifySnapshot, Step::RollingBack, &ui)?;
        self.restore(&mut j, tokens, conn, &ui).await
    }
    pub async fn resume(
        &self,
        tokens: &dyn TokenStore,
        conn: &Connection,
        ui: impl Fn(Step),
    ) -> Result<Option<Outcome>, CtlError> {
        let _guard = self.mutation.lock().await;
        let Some(mut j) = self.upgrade_journal()? else {
            return Ok(None);
        };
        if j.step.terminal() {
            return Ok(None);
        }
        if matches!(
            j.step,
            Step::Preflight | Step::Stopping | Step::Snapshotting
        ) {
            let e = CtlError::Cancelled;
            return self
                .before_swap_failure(&mut j, e, tokens, conn, &ui)
                .await
                .map(Some);
        }
        if matches!(j.step, Step::Swapping | Step::Migrating | Step::Gating) {
            j.failed_step = Some(j.step);
            j.diagnostic = Some("interrupted-upgrade".into());
            self.restore_checkpoint(&mut j, RestorePhase::VerifySnapshot, Step::RollingBack, &ui)?;
        }
        self.restore(&mut j, tokens, conn, &ui).await.map(Some)
    }
    async fn restore(
        &self,
        j: &mut Journal,
        tokens: &dyn TokenStore,
        conn: &Connection,
        ui: &impl Fn(Step),
    ) -> Result<Outcome, CtlError> {
        let result = async {
            let snap = j.snapshot.clone().ok_or(CtlError::Health)?;
            let previous = format!("{}-previous", self.names.container);
            let failed = format!("{}-failed-{}", self.names.state, j.to);
            if j.restore_phase == RestorePhase::VerifySnapshot {
                // Verify before even stopping/removing containers: corruption preserves every object.
                self.verify_snapshot(j, &snap).await?;
                let old = self.runtime.state(&previous).await?;
                if !old.exists {
                    let live = self.runtime.state(&self.names.container).await?;
                    if live.labels.get("app.plur1bus.image.digest") == Some(&j.from_digest) {
                        self.runtime.start(&self.names.container).await?;
                        if !self
                            .gate(&j.previous, tokens, conn)
                            .await
                            .failures
                            .is_empty()
                        {
                            return Err(CtlError::Health);
                        }
                        self.save(&j.previous)?;
                        j.skipped = true;
                        self.checkpoint(j, Step::RolledBack, ui)?;
                        return Ok(rolled(j));
                    }
                    return Err(CtlError::Health);
                }
                if old.labels.get("app.plur1bus.role").map(String::as_str) != Some("harness")
                    || old.labels.get("app.plur1bus.image.digest") != Some(&j.from_digest)
                {
                    return Err(CtlError::Health);
                }
                let new = self.runtime.state(&self.names.container).await?;
                if new.exists {
                    if new.labels.get("app.plur1bus.image.digest") != Some(&j.to_digest) {
                        return Err(CtlError::Health);
                    }
                    self.runtime
                        .stop(&self.names.container, Duration::from_secs(150))
                        .await?;
                }
                self.restore_checkpoint(
                    j,
                    RestorePhase::PreserveFailed,
                    Step::RestoringSnapshot,
                    ui,
                )?;
            }
            if j.restore_phase == RestorePhase::PreserveFailed {
                j.failed_snapshot = Some(self.snapshot_state(j, &failed).await?);
                self.restore_checkpoint(
                    j,
                    RestorePhase::VerifyFailed,
                    Step::RestoringSnapshot,
                    ui,
                )?;
            }
            if j.restore_phase == RestorePhase::VerifyFailed {
                self.verify_snapshot(j, j.failed_snapshot.as_ref().ok_or(CtlError::Health)?)
                    .await?;
                self.restore_checkpoint(j, RestorePhase::RemoveNew, Step::RestoringSnapshot, ui)?;
            }
            if j.restore_phase == RestorePhase::RemoveNew {
                self.remove_container_owned(&self.names.container, Some(&j.to_digest))
                    .await?;
                // Remove the stopped previous container too: Engine volumes cannot be replaced while referenced.
                // Its complete spec is journalled, so it can be recreated without touching credentials.
                self.remove_container_owned(&previous, Some(&j.from_digest))
                    .await?;
                self.restore_checkpoint(
                    j,
                    RestorePhase::ReplaceState,
                    Step::RestoringSnapshot,
                    ui,
                )?;
            }
            if j.restore_phase == RestorePhase::ReplaceState {
                self.verify_snapshot(j, &snap).await?;
                self.verify_snapshot(j, j.failed_snapshot.as_ref().ok_or(CtlError::Health)?)
                    .await?;
                self.runtime
                    .volume_remove_owned(&self.names.state, &self.resource_labels("state"))
                    .await?;
                self.runtime
                    .volume_ensure(&self.names.state, 64, &self.resource_labels("state"))
                    .await?;
                self.restore_checkpoint(
                    j,
                    RestorePhase::RestoreState,
                    Step::RestoringSnapshot,
                    ui,
                )?;
            }
            if j.restore_phase == RestorePhase::RestoreState {
                let v = self
                    .oneshot(
                        &j.from_digest,
                        &[
                            "plur1bus",
                            "state",
                            "restore",
                            "--src",
                            "/snap",
                            "--dst",
                            crate::runtime::spec::STATE_MOUNT,
                            "--json",
                        ],
                        vec![
                            (snap.volume.clone(), "/snap".into(), true),
                            (
                                self.names.state.clone(),
                                crate::runtime::spec::STATE_MOUNT.into(),
                                false,
                            ),
                        ],
                    )
                    .await?;
                if v["schema"] != "state.restore/1" || v["ok"] != true {
                    return Err(CtlError::Health);
                }
                self.restore_checkpoint(
                    j,
                    RestorePhase::RenamePrevious,
                    Step::StartingPrevious,
                    ui,
                )?;
            }
            if j.restore_phase == RestorePhase::RenamePrevious {
                if !self.runtime.state(&self.names.container).await?.exists {
                    let mut spec = self.spec(&j.previous);
                    spec.labels
                        .insert("app.plur1bus.version".into(), j.from.to_string());
                    self.runtime.create(&spec).await?;
                }
                self.restore_checkpoint(j, RestorePhase::Start, Step::StartingPrevious, ui)?;
            }
            if j.restore_phase == RestorePhase::Start {
                let s = self.runtime.state(&self.names.container).await?;
                if s.labels.get("app.plur1bus.image.digest") != Some(&j.from_digest) {
                    return Err(CtlError::Health);
                }
                self.runtime.start(&self.names.container).await?;
                self.restore_checkpoint(j, RestorePhase::Gate, Step::GatingPrevious, ui)?;
            }
            if j.restore_phase == RestorePhase::Gate {
                if !self
                    .gate(&j.previous, tokens, conn)
                    .await
                    .failures
                    .is_empty()
                {
                    return Err(CtlError::Health);
                }
                self.save(&j.previous)?;
                j.skipped = true;
                self.restore_checkpoint(j, RestorePhase::Complete, Step::RolledBack, ui)?;
            }
            Ok(rolled(j))
        }
        .await;
        match result {
            Ok(o) => Ok(o),
            Err(e) => {
                if j.diagnostic.is_none() {
                    j.diagnostic = Some(e.code().into());
                }
                self.recovery_failed(j, ui)
            }
        }
    }
}
fn rolled(j: &Journal) -> Outcome {
    Outcome::RolledBack {
        failed_step: j.failed_step.unwrap_or(Step::RollingBack),
        from: j.from.clone(),
        to: j.to.clone(),
    }
}
fn decode(o: crate::runtime::ExecOutput) -> Result<Value, CtlError> {
    if o.code != 0 {
        return Err(CtlError::ExecFailed {
            code: o.code,
            error_code: None,
        });
    }
    if o.stdout.len() > 8 * 1024 * 1024 {
        return Err(CtlError::Invalid);
    }
    serde_json::from_slice(&o.stdout).map_err(|_| CtlError::Invalid)
}
