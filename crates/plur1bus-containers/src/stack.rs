use crate::*;
use std::time::{Duration, Instant};
pub struct StackManager<'a> {
    pub runtime: &'a dyn ContainerRuntime,
    pub services: Vec<Service>,
    pub health_timeout: Duration,
    pub poll_interval: Duration,
}
impl<'a> StackManager<'a> {
    pub fn new(runtime: &'a dyn ContainerRuntime, services: Vec<Service>) -> Self {
        Self {
            runtime,
            services,
            health_timeout: Duration::from_secs(120),
            poll_interval: Duration::from_millis(500),
        }
    }
    fn configured(&self, s: &Service) -> Result<Service> {
        let mut service = s.clone();
        for c in &s.connections {
            let dependency = self
                .services
                .iter()
                .find(|v| v.name == c.service)
                .ok_or("missing connection dependency")?;
            if !self
                .owned(dependency)?
                .is_some_and(|v| v.running && v.healthy)
            {
                return Err("connection dependency is not healthy".into());
            }
            let host = self.runtime.address(&c.service, &s.network)?;
            service
                .env
                .retain(|env| !env.starts_with(&format!("{}=", c.env)));
            service.env.push(format!(
                "{}={}://{}:{}{}",
                c.env, c.scheme, host, c.port, c.path
            ));
        }
        Ok(service)
    }
    fn owned(&self, s: &Service) -> Result<Option<ContainerStatus>> {
        let v = self.runtime.inspect(s)?;
        if v.as_ref().is_some_and(|v| !v.owned) {
            return Err(format!(
                "{} exists without stack ownership; refusing mutation",
                s.name
            ));
        }
        Ok(v)
    }
    fn gate(&self, s: &Service) -> Result<()> {
        let deadline = Instant::now() + self.health_timeout;
        loop {
            if self.owned(s)?.is_some_and(|v| v.running && v.healthy) {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(format!("{} did not pass health gate", s.name));
            }
            std::thread::sleep(self.poll_interval);
        }
    }
    pub fn up(&self) -> Result<()> {
        for s in &self.services {
            s.validate()?;
        }
        self.runtime.ensure_running()?;
        let mut created = Vec::new();
        let mut started = Vec::new();
        let result = (|| {
            for s in &self.services {
                self.runtime.network(&s.network)?;
                for m in s.mounts.iter().filter(|m| !m.bind) {
                    self.runtime.volume(&m.source)?;
                }
                if let Some(v) = self.owned(s)? {
                    if canonical_image(&v.image) != canonical_image(&s.image) {
                        return Err(format!("{} uses another image; use upgrade_image", s.name));
                    }
                    if v.running {
                        self.gate(s)?;
                        continue;
                    }
                } else {
                    self.runtime.create(&self.configured(s)?)?;
                    created.push(s);
                }
                self.runtime.start(&s.name)?;
                started.push(s);
                self.gate(s)?;
            }
            Ok(())
        })();
        if let Err(e) = result {
            let mut cleanup = Vec::new();
            for s in started.iter().rev() {
                if let Err(e) = self.runtime.stop(&s.name) {
                    cleanup.push(e);
                }
            }
            for s in created.iter().rev() {
                if let Err(e) = self.runtime.remove(&s.name) {
                    cleanup.push(e);
                }
            }
            return Err(format!(
                "up failed: {e}; cleanup: {cleanup:?}; persistent volumes retained"
            ));
        }
        Ok(())
    }
    pub fn down(&self) -> Result<()> {
        // Preflight ownership for the entire stack before stopping any service.
        for s in &self.services {
            self.owned(s)?;
        }
        for s in self.services.iter().rev() {
            if let Some(v) = self.owned(s)? {
                if v.running {
                    self.runtime.stop(&s.name)?;
                }
                self.runtime.remove(&s.name)?;
            }
        }
        let mut networks = std::collections::BTreeSet::new();
        for s in &self.services {
            networks.insert(s.network.clone());
            if s.egress {
                networks.insert(format!("{}-egress", s.network));
            }
        }
        for n in networks {
            self.runtime.remove_network(&n)?;
        }
        Ok(())
    }
    pub fn status(&self) -> Result<Vec<(String, Option<ContainerStatus>)>> {
        self.services
            .iter()
            .map(|s| self.runtime.inspect(s).map(|v| (s.name.clone(), v)))
            .collect()
    }
    pub fn logs(&self, name: &str) -> Result<LogStream> {
        let s = self
            .services
            .iter()
            .find(|s| s.name == name)
            .ok_or("unknown stack service")?;
        self.owned(s)?.ok_or("service absent")?;
        self.runtime.logs(name)
    }
    /// Image-only replacement. Persistent state is retained, NOT snapshot/migrated here.
    /// Images requiring schema migration must use the future AJ orchestrator instead.
    pub fn upgrade_image(&self, name: &str, image: &str) -> Result<()> {
        let s = self
            .services
            .iter()
            .find(|s| s.name == name)
            .ok_or("unknown stack service")?;
        let old = self.owned(s)?.ok_or("service absent")?;
        if !old.running || !old.healthy {
            return Err("old image must be running and healthy before replacement".into());
        }
        let mut next = s.clone();
        next.image = image.into();
        next.validate()?;
        let next = self.configured(&next)?;
        if !self.runtime.image_available(image)? {
            self.runtime.pull(image)?;
        } // Finish fetch before touching the running service.
        self.runtime.stop(name)?;
        if let Err(e) = self.runtime.remove(name) {
            let restart = self.runtime.start(name);
            return Err(format!("remove failed: {e}; restart: {restart:?}"));
        }
        let update = self
            .runtime
            .create(&next)
            .and_then(|_| self.runtime.start(name))
            .and_then(|_| self.gate(&next));
        if let Err(e) = update {
            let rollback = (|| {
                if let Some(v) = self.owned(&next)? {
                    if v.running {
                        self.runtime.stop(name)?;
                    }
                    self.runtime.remove(name)?;
                }
                let mut previous = s.clone();
                previous.image = old.image;
                self.runtime.create(&self.configured(&previous)?)?;
                self.runtime.start(name)?;
                self.gate(&previous)
            })();
            return Err(format!("upgrade failed: {e}; rollback: {rollback:?}"));
        }
        Ok(())
    }
}
/// Read-only bind diagnosis. Never chown arbitrary host directories or state trees.
pub fn diagnose_uid_gid(actual_uid: u32, actual_gid: u32, writable: bool) -> Result<()> {
    if actual_uid != 10001 || actual_gid != 10001 || !writable {
        Err(format!("state ownership {actual_uid}:{actual_gid}, writable={writable}; expected 10001:10001. Use a runtime volume or initialise its root; check rootless UID mapping. Do not recursively chown a macOS virtiofs state bind."))
    } else {
        Ok(())
    }
}
