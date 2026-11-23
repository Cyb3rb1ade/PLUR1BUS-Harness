#![allow(clippy::unwrap_used, reason = "in-process registry ports")]

use std::{
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use plur1bus_mcp::{
    registry::{Connection, Definition, Host, Phase, Registry, RegistryError, Scope, Transport},
    session::{Call, Error},
};
use serde_json::{json, Value};

#[derive(Default)]
struct TestConnection(AtomicBool);
impl Connection for TestConnection {
    fn protocol(&self) -> &str {
        "2025-11-25"
    }
    fn closed(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
    fn close(&self) -> Result<(), Error> {
        self.0.store(true, Ordering::Release);
        Ok(())
    }
    fn invoke(&self, _: Call, _: Instant) -> Result<Value, Error> {
        Ok(json!({"tools":[{"name":"fixture"}]}))
    }
}

#[derive(Default)]
struct TestHost(AtomicUsize, AtomicBool);
impl Host for TestHost {
    fn admit(&self, _: &Definition) -> Result<(), Error> {
        if self.1.load(Ordering::Acquire) {
            Err(Error::AuthRequired)
        } else {
            Ok(())
        }
    }

    fn open(
        &self,
        _: &Definition,
        _: Option<&str>,
        _: Instant,
    ) -> Result<Arc<dyn Connection>, Error> {
        self.0.fetch_add(1, Ordering::AcqRel);
        Ok(Arc::new(TestConnection::default()))
    }
}

fn def(scope: Scope) -> Definition {
    Definition {
        name: "fixture".into(),
        scope,
        transport: Transport::Http,
        idle_for: Duration::from_millis(10),
        cache_for: Duration::from_secs(30),
        max_result_bytes: 1024,
    }
}

#[test]
fn private_names_stay_private_and_idle_caches_do_not_restart_a_peer() {
    let host = Arc::new(TestHost::default());
    let registry = Registry::new(host.clone());
    registry
        .register(def(Scope::Agent("agent-a".into())))
        .unwrap();
    assert_eq!(
        registry.status("fixture", "agent-b").err(),
        Some(RegistryError::NotRegistered)
    );
    assert_eq!(
        registry.register(def(Scope::Installation)).err(),
        Some(RegistryError::Conflict)
    );
    assert_eq!(
        registry.status("fixture", "agent-a").unwrap().phase,
        Phase::Stopped
    );
    assert_eq!(host.0.load(Ordering::Acquire), 0);

    let deadline = Instant::now() + Duration::from_secs(2);
    assert_eq!(
        registry
            .list_tools("fixture", "agent-a", false, deadline)
            .unwrap()["tools"][0]["name"],
        "fixture"
    );
    assert_eq!(registry.status("fixture", "agent-a").unwrap().starts, 1);
    registry
        .tick(Instant::now() + Duration::from_secs(1), deadline)
        .unwrap();
    assert_eq!(
        registry.status("fixture", "agent-a").unwrap().phase,
        Phase::Stopped
    );
    registry
        .list_tools("fixture", "agent-a", false, deadline)
        .unwrap();
    assert_eq!(host.0.load(Ordering::Acquire), 1);
    registry
        .list_tools("fixture", "agent-a", true, deadline)
        .unwrap();
    assert_eq!(host.0.load(Ordering::Acquire), 2);
}

struct DelayedHost {
    arrived: std::sync::mpsc::SyncSender<()>,
    resume: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
    late: Arc<TestConnection>,
    starts: AtomicUsize,
}
impl Host for DelayedHost {
    fn open(
        &self,
        _: &Definition,
        _: Option<&str>,
        deadline: Instant,
    ) -> Result<Arc<dyn Connection>, Error> {
        if self.starts.fetch_add(1, Ordering::AcqRel) == 0 {
            self.arrived.send(()).unwrap();
            self.resume
                .lock()
                .unwrap()
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .map_err(|_| Error::Timeout)?;
            Ok(self.late.clone())
        } else {
            Ok(Arc::new(TestConnection::default()))
        }
    }
}

#[test]
fn a_late_start_after_reload_closes_the_old_session_and_cannot_fill_the_new_cache() {
    let (arrived, wait) = std::sync::mpsc::sync_channel(1);
    let (resume, proceed) = std::sync::mpsc::sync_channel(1);
    let host = Arc::new(DelayedHost {
        arrived,
        resume: std::sync::Mutex::new(proceed),
        late: Arc::new(TestConnection::default()),
        starts: AtomicUsize::new(0),
    });
    let registry = Registry::new(host.clone());
    registry.register(def(Scope::Installation)).unwrap();
    std::thread::scope(|threads| {
        let request = threads.spawn(|| {
            registry.list_tools(
                "fixture",
                "agent-a",
                false,
                Instant::now() + Duration::from_secs(3),
            )
        });
        wait.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(
            registry.status("fixture", "agent-a").unwrap().phase,
            Phase::Starting
        );
        registry.reload(def(Scope::Installation)).unwrap();
        assert_eq!(
            registry.status("fixture", "agent-a").unwrap().phase,
            Phase::Stopped
        );
        resume.send(()).unwrap();
        assert_eq!(
            request.join().unwrap().err(),
            Some(RegistryError::NotRegistered)
        );
        assert!(host.late.0.load(Ordering::Acquire));
    });
    assert!(!registry.status("fixture", "agent-a").unwrap().cache_fresh);
    registry
        .list_tools(
            "fixture",
            "agent-a",
            false,
            Instant::now() + Duration::from_secs(2),
        )
        .unwrap();
    assert_eq!(host.starts.load(Ordering::Acquire), 2);
}

#[test]
fn fresh_tool_cache_requires_current_host_admission() {
    let host = Arc::new(TestHost::default());
    let registry = Registry::new(host.clone());
    registry
        .register(def(Scope::Agent("agent-a".into())))
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(1);
    let listing = registry
        .list_tools("fixture", "agent-a", false, deadline)
        .unwrap();
    assert_eq!(listing["tools"][0]["name"], "fixture");
    host.1.store(true, Ordering::Release);
    assert!(registry
        .list_tools("fixture", "agent-a", false, deadline)
        .is_err());
    assert_eq!(host.0.load(Ordering::Acquire), 1);
    host.1.store(false, Ordering::Release);
    assert!(registry
        .list_tools("fixture", "agent-a", false, Instant::now())
        .is_err());
    assert_eq!(
        registry
            .list_tools("fixture", "agent-a", false, deadline)
            .unwrap(),
        listing
    );
}
