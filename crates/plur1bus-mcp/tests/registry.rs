#![allow(clippy::unwrap_used, reason = "in-process registry ports")]

use std::{
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use plur1bus_mcp::{
    registry::{
        Caller, Connection, Definition, Host, Phase, Registry, RegistryError, Scope, Transport,
        Trust,
    },
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
        trust: Trust::default(),
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

#[test]
fn tool_results_replay_the_recorded_provenance_and_content_budget() {
    struct Replay(Value);

    impl Connection for Replay {
        fn protocol(&self) -> &str {
            "2025-11-25"
        }
        fn closed(&self) -> bool {
            false
        }
        fn close(&self) -> Result<(), Error> {
            Ok(())
        }
        fn invoke(&self, _: Call, _: Instant) -> Result<Value, Error> {
            Ok(self.0.clone())
        }
    }

    impl Host for Replay {
        fn open(
            &self,
            _: &Definition,
            _: Option<&str>,
            _: Instant,
        ) -> Result<Arc<dyn Connection>, Error> {
            Ok(Arc::new(Self(self.0.clone())))
        }

        fn redact(&self, _: &Definition, value: &mut Value) {
            let cleaned = value.to_string().replace("sample-marker", "[REDACTED]");
            *value = serde_json::from_str(&cleaned).unwrap();
        }
    }

    let fixture: Value =
        serde_json::from_str(include_str!("../../../fixtures/parity/mcp/provenance.json")).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let input = &case["input"];
        let registry = Registry::new(Arc::new(Replay(input["raw"].clone())));
        let mut definition = def(Scope::Agent("fixture-agent".into()));
        definition.max_result_bytes = usize::try_from(input["maxBytes"].as_u64().unwrap()).unwrap();
        definition.trust = serde_json::from_value(input["trust"].clone()).unwrap();
        registry.register(definition).unwrap();
        let actual = registry.invoke(
            "fixture",
            Caller {
                agent_id: "fixture-agent",
                principal: "fixture-person",
            },
            Call::CallTool {
                name: "summary".into(),
                arguments: Default::default(),
            },
            Instant::now() + Duration::from_secs(2),
        );
        assert_eq!(actual, Ok(case["observed"].clone()), "{}", input["name"]);
    }
}

#[test]
fn result_and_scope_bounds_apply_with_an_existing_connection() {
    let host = Arc::new(TestHost::default());
    let registry = Registry::new(host.clone());
    let mut definition = def(Scope::Agent("fixture-agent".into()));
    definition.max_result_bytes = 4;
    registry.register(definition).unwrap();
    let deadline = || Instant::now() + Duration::from_secs(2);
    assert_eq!(registry.list("fixture-agent").unwrap().len(), 1);
    assert!(registry.list("other-agent").unwrap().is_empty());
    assert_eq!(
        registry.list_tools("fixture", "fixture-agent", true, deadline()),
        Err(RegistryError::ResultLimit)
    );
    assert_eq!(host.0.load(Ordering::Acquire), 1);
    host.1.store(true, Ordering::Release);
    assert_eq!(
        registry.invoke(
            "fixture",
            Caller {
                agent_id: "fixture-agent",
                principal: "fixture-person"
            },
            Call::ListResources,
            deadline()
        ),
        Err(RegistryError::Connection(Error::AuthRequired))
    );
    assert_eq!(host.0.load(Ordering::Acquire), 1);
}
