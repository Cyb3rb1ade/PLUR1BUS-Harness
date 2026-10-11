use super::*;
use std::{
    collections::BTreeSet,
    net::{Ipv4Addr, TcpListener},
};
impl Controller {
    pub async fn install(
        &self,
        res: Resources,
        progress: impl Fn(InstallStep),
    ) -> Result<Installed, CtlError> {
        let _guard = self.mutation.lock().await;
        self.require_settled_upgrade()?;
        res.validate()?;
        let previous = self.installed()?;
        self.runtime.ensure_started().await?;
        progress(InstallStep::Image);
        let digest = self.acquire().await?;
        let mut installed = previous.unwrap_or(Installed {
            runtime: self.info().kind,
            endpoint: self.info().endpoint.clone(),
            container: self.names.container.clone(),
            port: 18700,
            image_digest: digest.clone(),
            resources: res.clone(),
            installed_version: self.bundle.version.clone(),
            step: InstallStep::Image,
        });
        if installed.image_digest != digest {
            return Err(CtlError::ImageDigest);
        }
        self.set_desired_running(true)?;
        installed.resources = res;
        installed.image_digest = digest.clone();
        for step in [InstallStep::Volumes, InstallStep::Network] {
            installed.step = step;
            self.save(&installed)?;
            progress(step);
            match step {
                InstallStep::Volumes => {
                    self.runtime
                        .volume_ensure(&self.names.state, 64, &self.resource_labels("state"))
                        .await?;
                    self.runtime
                        .volume_ensure(&self.names.models, 32, &self.resource_labels("models"))
                        .await?
                }
                InstallStep::Network => {
                    self.runtime
                        .network_ensure_labeled(
                            &self.names.network,
                            false,
                            &self.labels("network", &digest),
                        )
                        .await?
                }
                _ => {}
            }
        }
        installed.step = InstallStep::Container;
        self.save(&installed)?;
        progress(InstallStep::Container);
        let state = self.runtime.state(&installed.container).await?;
        if state.exists {
            if state.labels.get("app.plur1bus.role").map(String::as_str) != Some("harness")
                || state.labels.get("app.plur1bus.image.digest") != Some(&digest)
            {
                return Err(CtlError::Runtime(RuntimeError::Conflict(
                    "foreign-container".into(),
                )));
            }
            if state.running {
                self.runtime
                    .stop(&installed.container, Duration::from_secs(150))
                    .await?
            }
            self.runtime.remove(&installed.container).await?
        }
        let reservation = pick_port(
            installed.port,
            &self.runtime.published_ports(&installed.container).await?,
        )?;
        installed.port = reservation
            .local_addr()
            .map_err(|_| CtlError::PortBusy)?
            .port();
        self.save(&installed)?;
        self.runtime.create(&self.spec(&installed)).await?;
        installed.step = InstallStep::Start;
        self.save(&installed)?;
        progress(InstallStep::Start);
        drop(reservation);
        self.runtime.start(&installed.container).await?;
        self.wait_ready(installed.port).await?;
        installed.step = InstallStep::Done;
        self.save(&installed)?;
        progress(InstallStep::Done);
        Ok(installed)
    }
    pub(crate) async fn wait_ready(&self, port: u16) -> Result<(), CtlError> {
        tokio::time::timeout(Duration::from_secs(300), async {
            loop {
                if self.health.ready(port).await {
                    let daemon = self
                        .exec_json(
                            &["plur1bus", "daemon", "status", "--json"],
                            Duration::from_secs(10),
                        )
                        .await?;
                    if daemon_is_ready(&daemon) {
                        return Ok(());
                    }
                }
                tokio::time::sleep(Duration::from_secs(1)).await
            }
        })
        .await
        .map_err(|_| CtlError::StartTimeout)?
    }
    pub async fn start(&self) -> Result<(), CtlError> {
        self.start_internal(true).await
    }
    pub(crate) async fn start_internal(&self, manual: bool) -> Result<(), CtlError> {
        let _guard = self.mutation.lock().await;
        self.require_settled_upgrade()?;
        if manual {
            self.set_desired_running(true)?;
            self.watcher
                .lock()
                .map_err(|_| CtlError::Health)?
                .manual_start()
        }
        self.runtime.ensure_started().await?;
        let mut i = self.installed()?.ok_or(CtlError::NotInstalled)?;
        let state = self.runtime.state(&i.container).await?;
        if state.running {
            return self.wait_ready(i.port).await;
        }
        if state.exists
            && state.labels.get("app.plur1bus.role").map(String::as_str) != Some("harness")
        {
            return Err(CtlError::Runtime(RuntimeError::Conflict(
                "foreign-container".into(),
            )));
        }
        let reservation = pick_port(i.port, &self.runtime.published_ports(&i.container).await?)?;
        let port = reservation
            .local_addr()
            .map_err(|_| CtlError::PortBusy)?
            .port();
        if port != i.port || !state.exists {
            if state.exists {
                self.runtime.remove(&i.container).await?
            }
            i.port = port;
            self.save(&i)?;
            self.runtime.create(&self.spec(&i)).await?
        }
        drop(reservation);
        self.runtime.start(&i.container).await?;
        self.wait_ready(i.port).await
    }
    pub async fn stop(&self) -> Result<(), CtlError> {
        let _guard = self.mutation.lock().await;
        self.set_desired_running(false)?;
        let i = self.installed()?.ok_or(CtlError::NotInstalled)?;
        let state = self.runtime.state(&i.container).await?;
        if state.exists
            && state.labels.get("app.plur1bus.role").map(String::as_str) != Some("harness")
        {
            return Err(CtlError::Runtime(RuntimeError::Conflict(
                "foreign-container".into(),
            )));
        }
        self.runtime
            .stop(&i.container, Duration::from_secs(150))
            .await?;
        Ok(())
    }
    pub async fn status(&self) -> HarnessStatus {
        if self.watcher.lock().is_ok_and(|w| w.is_crashed()) {
            return HarnessStatus::Crashed {
                exit_code: None,
                log_tail: self.logs_tail(200).await.unwrap_or_default(),
            };
        }
        let i = match self.installed() {
            Ok(Some(i)) => i,
            Ok(None) => return HarnessStatus::NotInstalled,
            Err(_) => return HarnessStatus::RuntimeDown,
        };
        if self.runtime.ping().await.is_err() {
            return HarnessStatus::RuntimeDown;
        }
        let Ok(state) = self.runtime.state(&i.container).await else {
            return HarnessStatus::RuntimeDown;
        };
        if !state.exists {
            return HarnessStatus::NotInstalled;
        }
        if !state.running {
            return HarnessStatus::Stopped;
        }
        if self.health.ready(i.port).await
            && self
                .exec_json(
                    &["plur1bus", "daemon", "status", "--json"],
                    Duration::from_secs(10),
                )
                .await
                .ok()
                .is_some_and(|v| daemon_is_ready(&v))
        {
            HarnessStatus::Ready { port: i.port }
        } else {
            HarnessStatus::Starting
        }
    }
}
pub(crate) fn pick_port(
    preferred: u16,
    published: &BTreeSet<u16>,
) -> Result<TcpListener, CtlError> {
    let order = std::iter::once(preferred).chain(18700..=18799);
    for port in order {
        if !(18700..=18799).contains(&port) || published.contains(&port) {
            continue;
        }
        if let Ok(socket) = TcpListener::bind((Ipv4Addr::LOCALHOST, port)) {
            return Ok(socket);
        }
    }
    Err(CtlError::PortBusy)
}

impl Controller {
    pub async fn uninstall(
        &self,
        level: UninstallLevel,
        confirmation: Option<&str>,
        tokens: &dyn crate::secrets::TokenStore,
        store: &crate::connections::Store,
        progress: impl Fn(UninstallStep),
    ) -> Result<(), CtlError> {
        if level == UninstallLevel::Everything && confirmation != Some("plur1bus-state") {
            return Err(CtlError::Invalid);
        }
        let _guard = self.mutation.lock().await;
        let Some(i) = self.installed()? else {
            progress(UninstallStep::Done);
            return Ok(());
        };
        let rows = store
            .load()
            .map_err(|_| CtlError::Storage)?
            .into_iter()
            .filter(|c| {
                c.kind == crate::connections::Kind::Bundled
                    && c.bundled
                        .as_ref()
                        .is_some_and(|b| b.container == i.container && b.endpoint == i.endpoint)
            })
            .collect::<Vec<_>>();
        if level == UninstallLevel::Everything
            && tokens.kind() != crate::secrets::StoreKind::Keychain
            && rows.iter().any(|c| {
                c.pending_keychain_cleanup
                    || c.credential_provenance
                        != crate::connections::CredentialProvenance::MemoryOnly
            })
        {
            return Err(CtlError::Storage);
        }
        let state = self.runtime.state(&i.container).await?;
        if state.exists {
            if state.labels.get("app.plur1bus.role").map(String::as_str) != Some("harness")
                || state.labels.get("app.plur1bus.image.digest") != Some(&i.image_digest)
            {
                return Err(CtlError::Runtime(RuntimeError::Conflict(
                    "foreign-container".into(),
                )));
            }
            progress(UninstallStep::Container);
            if state.running {
                self.runtime
                    .stop(&i.container, Duration::from_secs(150))
                    .await?
            }
            self.runtime.remove(&i.container).await?
        }
        progress(UninstallStep::Network);
        match self.runtime.network_remove(&self.names.network).await {
            Ok(()) | Err(RuntimeError::NotFoundObject(_)) => {}
            Err(e) => return Err(e.into()),
        }
        if level != UninstallLevel::AppOnly {
            progress(UninstallStep::Images);
            self.runtime.image_remove(&i.image_digest).await?
        }
        if level == UninstallLevel::Everything {
            progress(UninstallStep::Volumes);
            self.runtime
                .volume_remove_owned(&self.names.state, &self.resource_labels("state"))
                .await?;
            self.runtime
                .volume_remove_owned(&self.names.models, &self.resource_labels("models"))
                .await?;
            progress(UninstallStep::Keychain);
            for row in rows {
                store
                    .remove(row.id, tokens)
                    .map_err(|_| CtlError::Storage)?
            }
        }
        std::fs::remove_file(self.dir.join("installed.json")).map_err(|_| CtlError::Storage)?;
        progress(UninstallStep::Done);
        Ok(())
    }
    pub async fn set_memory(&self, gib: u8) -> Result<(), CtlError> {
        if !(2..=16).contains(&gib) {
            return Err(CtlError::Invalid);
        }
        let _guard = self.mutation.lock().await;
        self.require_settled_upgrade()?;
        self.set_desired_running(true)?;
        self.watcher
            .lock()
            .map_err(|_| CtlError::Health)?
            .manual_start();
        let mut i = self.installed()?.ok_or(CtlError::NotInstalled)?;
        let state = self.runtime.state(&i.container).await?;
        if state.exists
            && state.labels.get("app.plur1bus.role").map(String::as_str) != Some("harness")
        {
            return Err(CtlError::Runtime(RuntimeError::Conflict(
                "foreign-container".into(),
            )));
        }
        if state.running {
            self.runtime
                .stop(&i.container, Duration::from_secs(150))
                .await?
        }
        if state.exists {
            self.runtime.remove(&i.container).await?
        }
        i.resources.memory_mib = u32::from(gib) * 1024;
        i.step = InstallStep::Container;
        let reservation = pick_port(i.port, &self.runtime.published_ports(&i.container).await?)?;
        i.port = reservation
            .local_addr()
            .map_err(|_| CtlError::PortBusy)?
            .port();
        self.save(&i)?;
        self.runtime.create(&self.spec(&i)).await?;
        drop(reservation);
        self.runtime.start(&i.container).await?;
        self.wait_ready(i.port).await?;
        i.step = InstallStep::Done;
        self.save(&i)?;
        Ok(())
    }
}
