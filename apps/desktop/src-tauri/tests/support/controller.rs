#![allow(dead_code)]
use async_trait::async_trait;
use plur1bus_desktop::{controller::Health, runtime::*};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    sync::Mutex,
    time::Duration,
};
#[derive(Default)]
pub struct State {
    pub containers: BTreeMap<String, ContainerSpec>,
    pub running: BTreeSet<String>,
    pub volumes: BTreeSet<String>,
    pub calls: Vec<String>,
    pub fail_once: Option<String>,
    pub image: bool,
    pub wrong_digest: bool,
    pub runtime_down: bool,
    pub pause_start: bool,
    pub published: BTreeSet<u16>,
}
pub type ExecHook = std::sync::Arc<dyn Fn(&[&str]) -> ExecOutput + Send + Sync>;
pub struct FakeRuntime {
    pub exec_hook: Mutex<Option<ExecHook>>,
    pub state: Mutex<State>,
    info: RuntimeInfo,
}
impl FakeRuntime {
    pub fn new(kind: RuntimeKind) -> Self {
        Self {
            exec_hook: Mutex::new(None),
            state: Mutex::new(State::default()),
            info: RuntimeInfo {
                kind,
                endpoint: "fixture-local".into(),
                version: "1.3.0".into(),
                engine: "synthetic".into(),
            },
        }
    }
    pub fn with_endpoint(mut self, endpoint: &str) -> Self {
        self.info.endpoint = endpoint.into();
        self
    }
    fn call(&self, c: &str) -> Result<(), RuntimeError> {
        let mut s = self.state.lock().unwrap();
        s.calls.push(c.into());
        let normalised = if c.starts_with("volume:") && c.ends_with("-state") {
            "volume:plur1bus-state"
        } else if c.starts_with("volume:") && c.ends_with("-models") {
            "volume:plur1bus-models"
        } else {
            c
        };
        if s.fail_once.as_deref() == Some(normalised) {
            s.fail_once = None;
            return Err(RuntimeError::Failed("injected".into()));
        }
        Ok(())
    }
}
pub struct Healthy;
#[async_trait]
impl Health for Healthy {
    async fn ready(&self, _port: u16) -> bool {
        true
    }
}
#[async_trait]
impl Runtime for FakeRuntime {
    fn info(&self) -> &RuntimeInfo {
        &self.info
    }
    async fn ping(&self) -> Result<(), RuntimeError> {
        if self.state.lock().unwrap().runtime_down {
            Err(RuntimeError::Stopped)
        } else {
            Ok(())
        }
    }
    async fn ensure_started(&self) -> Result<(), RuntimeError> {
        self.call("ensure-started")?;
        self.ping().await
    }
    async fn image_present(&self, _digest: &str) -> Result<bool, RuntimeError> {
        Ok(self.state.lock().unwrap().image)
    }
    async fn image_load(&self, _tar: &Path) -> Result<String, RuntimeError> {
        self.call("load")?;
        let mut s = self.state.lock().unwrap();
        s.image = true;
        Ok(if s.wrong_digest {
            format!("sha256:{}", "a".repeat(64))
        } else {
            format!("sha256:{}", "0".repeat(64))
        })
    }
    async fn image_pull(&self, _reference: &str, _digest: &str) -> Result<(), RuntimeError> {
        self.call("pull")?;
        self.state.lock().unwrap().image = true;
        Ok(())
    }
    async fn volume_ensure(
        &self,
        name: &str,
        _size: u32,
        _labels: &Labels,
    ) -> Result<(), RuntimeError> {
        self.call(&format!("volume:{name}"))?;
        self.state.lock().unwrap().volumes.insert(name.into());
        Ok(())
    }
    async fn volume_remove(&self, name: &str) -> Result<(), RuntimeError> {
        self.call(&format!("remove-volume:{name}"))?;
        self.state.lock().unwrap().volumes.remove(name);
        Ok(())
    }
    async fn network_ensure(&self, _name: &str, _internal: bool) -> Result<(), RuntimeError> {
        self.call("network")
    }

    async fn published_ports(&self, _except: &str) -> Result<BTreeSet<u16>, RuntimeError> {
        Ok(self.state.lock().unwrap().published.clone())
    }
    async fn image_remove(&self, _digest: &str) -> Result<(), RuntimeError> {
        self.call("remove-image")?;
        self.state.lock().unwrap().image = false;
        Ok(())
    }
    async fn network_remove(&self, _name: &str) -> Result<(), RuntimeError> {
        self.call("remove-network")
    }
    async fn restart_system(&self) -> Result<(), RuntimeError> {
        self.call("restart-system")
    }
    async fn create(&self, spec: &ContainerSpec) -> Result<(), RuntimeError> {
        self.call("create")?;
        spec.validate()?;
        let mut s = self.state.lock().unwrap();
        if s.containers.contains_key(&spec.name) {
            return Err(RuntimeError::Conflict("container".into()));
        }
        s.containers.insert(spec.name.clone(), spec.clone());
        Ok(())
    }
    async fn start(&self, name: &str) -> Result<(), RuntimeError> {
        self.call("start")?;
        let pause = self.state.lock().unwrap().pause_start;
        if pause {
            std::future::pending::<()>().await;
        }
        self.state.lock().unwrap().running.insert(name.into());
        Ok(())
    }
    async fn stop(&self, name: &str, timeout: Duration) -> Result<(), RuntimeError> {
        self.call(&format!("stop:{}", timeout.as_secs()))?;
        self.state.lock().unwrap().running.remove(name);
        Ok(())
    }
    async fn rename(&self, from: &str, to: &str) -> Result<(), RuntimeError> {
        self.call("rename")?;
        let mut s = self.state.lock().unwrap();
        let mut v = s
            .containers
            .remove(from)
            .ok_or_else(|| RuntimeError::NotFoundObject("container".into()))?;
        v.name = to.into();
        s.containers.insert(to.into(), v);
        Ok(())
    }
    async fn remove(&self, name: &str) -> Result<(), RuntimeError> {
        self.call("remove")?;
        let mut s = self.state.lock().unwrap();
        s.containers.remove(name);
        s.running.remove(name);
        Ok(())
    }
    async fn state(&self, name: &str) -> Result<ContainerState, RuntimeError> {
        let s = self.state.lock().unwrap();
        Ok(s.containers
            .get(name)
            .map(|c| ContainerState {
                exists: true,
                running: s.running.contains(name),
                image_digest: Some(c.image_digest.clone()),
                labels: c.labels.clone(),
                ..Default::default()
            })
            .unwrap_or_default())
    }
    async fn list_labeled(&self, _label: &str) -> Result<Vec<String>, RuntimeError> {
        Ok(self
            .state
            .lock()
            .unwrap()
            .containers
            .keys()
            .cloned()
            .collect())
    }
    async fn logs_tail(&self, _name: &str, _lines: u32) -> Result<String, RuntimeError> {
        Ok("synthetic log".into())
    }
    async fn exec(
        &self,
        _name: &str,
        argv: &[&str],
        _stdin: Option<&[u8]>,
        _timeout: Duration,
    ) -> Result<ExecOutput, RuntimeError> {
        self.call(&format!("exec:{}", argv.join(" ")))?;
        if let Some(hook) = self.exec_hook.lock().unwrap().as_ref() {
            return Ok(hook(argv));
        }
        Ok(ExecOutput{code:0,stdout:br#"{"schema":"daemon.status/1","supervisor":{"process":{"state":"running"}},"children":[{"kind":"core","process":{"state":"ready"}}]}"#.to_vec(),stderr:vec![]})
    }
    async fn run_oneshot(
        &self,
        _spec: &ContainerSpec,
        _timeout: Duration,
    ) -> Result<ExecOutput, RuntimeError> {
        self.call("oneshot")?;
        Ok(ExecOutput {
            code: 0,
            stdout: vec![],
            stderr: vec![],
        })
    }
}
