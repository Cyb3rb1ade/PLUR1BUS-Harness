#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use super::*;
use crate::gate::doubles::{MemoryAudit, Permits, SetClock};
use crate::gate::{Gate, UnverifiedAction};
use plur1bus_core::policy::fs_paths::{PathFs, PathRoot, RealFs};
use plur1bus_core::policy::paths::IcuNfc;

#[test]
fn hostctl_catalog_and_config_match_typescript() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../fixtures/parity/host/hostctl.json"
    ))
    .unwrap();
    assert_eq!(
        Value::Array(Hostctl::<RealFs>::definitions(&Config::default())),
        fixture["tools"]
    );
    for case in fixture["config"].as_array().unwrap() {
        assert_eq!(Config::from_json(&case["input"]).to_json(), case["result"]);
    }
    for case in fixture["literal"].as_array().unwrap() {
        let query = case["query"].as_str().unwrap();
        let answers: Vec<bool> = case["texts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|text| matches(text.as_str().unwrap(), query))
            .collect();
        assert_eq!(json!(answers), case["matches"]);
    }
}

#[test]
fn hostctl_command_rules_match_typescript_refusals() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../fixtures/parity/host/hostctl.json"
    ))
    .unwrap();
    let cases = fixture["commandPolicy"].as_array().unwrap();
    assert!(cases.len() >= 23);
    let who = Caller {
        session_id: Some("fixture-session".into()),
        ..Caller::default()
    };
    let config = Config::from_json(&json!({"shell":{"allowed":true}}));
    for row in cases {
        let operation = match row["operation"].as_str().unwrap() {
            "exec" => catalog::Operation::Exec,
            "shell" => catalog::Operation::Shell,
            other => panic!("unknown operation {other}"),
        };
        let got = eligibility::validate_runtime(
            operation,
            row["input"].as_object().unwrap(),
            &config,
            &who,
            ProcessIdentity::default(),
        )
        .err()
        .map(|failure| failure.code);
        let expected = if row["divergence"] == "K10-D15" {
            json!("DENIED")
        } else {
            row["refusal"].clone()
        };
        assert_eq!(json!(got), expected, "{}", row["name"]);
    }
}

macro_rules! refuses {
    ($test:ident, $op:literal, $args:expr) => {
        #[test]
        fn $test() {
            let input = $args;
            let name = concat!("hostctl.", $op);
            let spec = catalog::Spec::get(name).unwrap();
            assert!(
                args::validate(&Config::default(), spec, &input).is_err(),
                "{name}"
            );
        }
    };
}
refuses!(hostctl_closed_object, "sys.info", json!({"extra":true}));
refuses!(hostctl_requires_path, "fs.read", json!({}));
refuses!(hostctl_checks_object_type, "sys.info", json!([]));
refuses!(
    hostctl_limits_path_units,
    "fs.stat",
    json!({"path":"😀".repeat(2049)})
);
refuses!(
    hostctl_rejects_nul,
    "clipboard.write",
    json!({"text":"a\0b"})
);
refuses!(
    hostctl_requires_literal_query,
    "fs.search",
    json!({"path":".","query":""})
);
refuses!(
    hostctl_limits_title,
    "notify",
    json!({"title":"x".repeat(201)})
);
refuses!(
    hostctl_limits_body,
    "notify",
    json!({"title":"Fixture","body":"x".repeat(2001)})
);
refuses!(
    hostctl_limits_offset,
    "fs.read",
    json!({"path":"note","offset":9_007_199_254_740_992u64})
);
refuses!(
    hostctl_limits_read_bytes,
    "fs.read",
    json!({"path":"note","length":65_537})
);
refuses!(
    hostctl_limits_walk_depth,
    "fs.list",
    json!({"path":".","depth":17})
);
refuses!(
    hostctl_limits_list_results,
    "fs.list",
    json!({"path":".","limit":1001})
);
refuses!(
    hostctl_limits_search_results,
    "fs.search",
    json!({"path":".","query":"note","limit":101})
);
refuses!(
    hostctl_limits_timeout,
    "proc.exec",
    json!({"cwd":".","program":"fixture","timeoutMs":30_001})
);
refuses!(
    hostctl_requires_positive_timeout,
    "proc.exec",
    json!({"cwd":".","program":"fixture","timeoutMs":0})
);
refuses!(
    hostctl_protects_reserved_pid,
    "proc.kill_foreign",
    json!({"pid":1})
);
refuses!(
    hostctl_accepts_only_catalogued_signal,
    "proc.kill_foreign",
    json!({"pid":20,"signal":"OTHER"})
);
refuses!(
    hostctl_accepts_only_catalogued_search_mode,
    "fs.search",
    json!({"path":".","query":"x","mode":"unknown"})
);
refuses!(
    hostctl_requires_standard_input_boolean,
    "proc.write_stdin",
    json!({"id":"fixture","text":"","eof":"true"})
);
refuses!(
    hostctl_limits_argument_count,
    "proc.exec",
    json!({"cwd":".","program":"fixture","args":vec!["";257]})
);
refuses!(
    hostctl_requires_allowlisted_environment_keys,
    "proc.exec",
    json!({"cwd":".","program":"fixture","env":{"UNKNOWN_ENV":"x"}})
);
refuses!(
    hostctl_protects_process_search_path,
    "proc.exec",
    json!({"cwd":".","program":"fixture","env":{"PATH":"fixture"}})
);

#[derive(Default)]
struct EffectsFixture {
    called: Vec<&'static str>,
}

impl Effects for EffectsFixture {
    fn process_identity(&self) -> ProcessIdentity {
        ProcessIdentity {
            pid: 10,
            parent: 9,
            group: Some(10),
        }
    }

    fn apply(&mut self, call: Invocation<'_>) -> Result<Value, Failure> {
        self.called.push(call.name);
        Ok(json!({"fixture": true}))
    }
}

#[test]
fn hostctl_gate_binding_and_begin_audit_precede_the_effect() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap();
    let roots = [PathRoot {
        id: "test".into(),
        path: path.to_str().unwrap().into(),
        identity: None,
    }];
    let policy = Policy {
        roots: &roots,
        deny: &[],
        home: None,
        fs: &RealFs,
        nfc: &IcuNfc,
    };
    let config = Config::default();
    let who = Caller {
        principal: "fixture-person".into(),
        agent_id: "fixture-agent".into(),
        surface: 3,
        session_id: Some("fixture-session".into()),
        ..Default::default()
    };
    let clock = SetClock::at(1000.0);
    let random = plur1bus_core::approvals::OsRandom;
    let classifier = HostClassifier::new("hostctl.sys.info", &config, &policy).unwrap();
    let approve = || {
        Gate::new(
            &[classifier.definition()],
            &clock,
            &mut MemoryAudit::default(),
            &mut Permits::approving(),
        )
        .verify(
            UnverifiedAction {
                tool: "hostctl.sys.info".into(),
                call_id: "call-fixture".into(),
                args: json!({}),
                ..Default::default()
            },
            &who,
        )
        .unwrap()
    };
    let mut effects = EffectsFixture::default();
    let mut processes = ProcessSessions::default();
    let mut audit = MemoryAudit {
        failing: vec!["hostctl.begin".into()],
        ..Default::default()
    };
    let mut host = Hostctl {
        config: &config,
        policy: &policy,
        clock: &clock,
        random: &random,
        audit: &mut audit,
        effects: &mut effects,
        processes: &mut processes,
        aborted: &|| false,
    };
    assert_eq!(host.execute(approve(), &who).unwrap_err().code, "DENIED");
    assert!(effects.called.is_empty());

    let mut audit = MemoryAudit::default();
    let mut host = Hostctl {
        config: &config,
        policy: &policy,
        clock: &clock,
        random: &random,
        audit: &mut audit,
        effects: &mut effects,
        processes: &mut processes,
        aborted: &|| false,
    };
    let changed = Caller {
        session_id: Some("other-session".into()),
        ..who.clone()
    };
    assert_eq!(
        host.execute(approve(), &changed).unwrap_err().code,
        "CHANGED"
    );
    let expired = approve();
    clock.advance(crate::gate::APPROVAL_TTL_MS + 1.0);
    assert_eq!(host.execute(expired, &who).unwrap_err().code, "CHANGED");
    assert_eq!(
        host.execute(approve(), &who).unwrap(),
        json!({"fixture":true})
    );
    assert_eq!(effects.called, ["hostctl.sys.info"]);
    assert_eq!(audit.of("hostctl.begin").len(), 1);
    assert_eq!(audit.of("hostctl.end").len(), 1);

    struct SlowAudit<'a>(&'a SetClock);
    impl AuditPort for SlowAudit<'_> {
        fn record(&mut self, action: &str, _: &Value) -> Result<(), String> {
            if action == "hostctl.begin" {
                self.0.advance(crate::gate::APPROVAL_TTL_MS + 1.0);
            }
            Ok(())
        }
    }
    let mut slow = SlowAudit(&clock);
    let mut host = Hostctl {
        config: &config,
        policy: &policy,
        clock: &clock,
        random: &random,
        audit: &mut slow,
        processes: &mut processes,
        effects: &mut effects,
        aborted: &|| false,
    };
    assert_eq!(host.execute(approve(), &who).unwrap_err().code, "CHANGED");
    assert_eq!(effects.called, ["hostctl.sys.info"]);
}

#[test]
fn hostctl_accepts_exact_valid_boundaries() {
    for (operation, input) in [
        ("hostctl.fs.stat", json!({"path":"😀".repeat(2048)})),
        (
            "hostctl.notify",
            json!({"title":"x".repeat(200),"body":"x".repeat(2000)}),
        ),
        (
            "hostctl.fs.read",
            json!({"path":"note","offset":9_007_199_254_740_991u64,"length":65_536}),
        ),
        (
            "hostctl.fs.list",
            json!({"path":".","depth":16,"limit":1000}),
        ),
        (
            "hostctl.fs.search",
            json!({"path":".","query":"note","limit":100,"mode":"content"}),
        ),
        (
            "hostctl.proc.exec",
            json!({"cwd":".","program":"fixture","timeoutMs":30_000,"args":vec!["";256],"env":{"LANG":"C"}}),
        ),
        (
            "hostctl.proc.write_stdin",
            json!({"id":"fixture","text":"","eof":true}),
        ),
        (
            "hostctl.proc.kill_foreign",
            json!({"pid":2,"signal":"SIGTERM"}),
        ),
    ] {
        let spec = catalog::Spec::get(operation).unwrap();
        assert!(
            args::validate(&Config::default(), spec, &input).is_ok(),
            "{operation}"
        );
    }
}

#[test]
fn hostctl_process_ownership_and_limits_are_bound_to_the_full_caller() {
    let who = Caller {
        principal: "person".into(),
        agent_id: "agent".into(),
        session_id: Some("session".into()),
        ..Caller::default()
    };
    let mut processes = ProcessSessions::default();
    let id = Uuid::from_u128(1);
    processes.reserve(&who, id).unwrap();
    assert!(processes.reserve(&who, id).is_err());
    assert_eq!(processes.owned(&id.to_string(), &who).unwrap(), id);
    for other in [
        Caller {
            principal: "other".into(),
            ..who.clone()
        },
        Caller {
            agent_id: "other".into(),
            ..who.clone()
        },
        Caller {
            session_id: Some("other".into()),
            ..who.clone()
        },
    ] {
        assert!(processes.owned(&id.to_string(), &other).is_err());
        let visible = processes
            .filter_owned(json!({"processes":[{"id":id.to_string()}]}), &other)
            .unwrap();
        assert_eq!(visible, json!({"processes":[]}));
    }
    for n in 2..=32 {
        processes.reserve(&who, Uuid::from_u128(n)).unwrap();
    }
    assert!(processes.reserve(&who, Uuid::from_u128(33)).is_err());
    processes.finished(id);
    processes.reserve(&who, Uuid::from_u128(33)).unwrap();
    assert_eq!(processes.revoke_session("session").len(), 32);
    assert!(processes.owned(&id.to_string(), &who).is_err());
}

#[test]
fn hostctl_verified_file_operations_reuse_the_gate_and_path_executor() {
    use crate::fs::{FsConfig, FsPorts, FsTools};

    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    std::fs::write(root.join("note"), "\u{feff}alpha").unwrap();
    let roots = [PathRoot {
        id: "fixture".into(),
        path: root.to_str().unwrap().into(),
        identity: None,
    }];
    let policy = Policy {
        roots: &roots,
        deny: &[],
        home: None,
        fs: &RealFs,
        nfc: &IcuNfc,
    };
    let config = Config::default();
    let clock = SetClock::at(1.0);
    let random = plur1bus_core::approvals::OsRandom;
    let who = Caller {
        principal: "person".into(),
        agent_id: "agent".into(),
        surface: 3,
        session_id: Some("session".into()),
        ..Default::default()
    };
    let mut audit = MemoryAudit::default();
    let mut processes = ProcessSessions::default();
    let fs = FsTools {
        config: FsConfig {
            roots: roots.to_vec(),
            ..Default::default()
        },
        ports: FsPorts {
            fs: &RealFs,
            nfc: &IcuNfc,
            clock: &clock,
            random: &random,
            aborted: &|| false,
            known_secrets: None,
        },
        after_check: None,
    };
    struct Local<'a> {
        fs: &'a FsTools<'a, RealFs>,
        policy: &'a Policy<'a, RealFs>,
    }
    impl Effects for Local<'_> {
        fn process_identity(&self) -> ProcessIdentity {
            ProcessIdentity::default()
        }
        fn apply(&mut self, call: Invocation<'_>) -> Result<Value, Failure> {
            filesystem::apply(self.fs, self.policy, &call).unwrap()
        }
    }
    let mut effects = Local {
        fs: &fs,
        policy: &policy,
    };
    let mut invoke = |name: &str, args: Value| {
        let classifier = HostClassifier::new(name, &config, &policy).unwrap();
        let approved = Gate::new(
            &[classifier.definition()],
            &clock,
            &mut MemoryAudit::default(),
            &mut Permits::approving(),
        )
        .verify(
            UnverifiedAction {
                tool: name.into(),
                call_id: "call".into(),
                args,
                ..Default::default()
            },
            &who,
        )
        .unwrap_or_else(|error| panic!("{name}: {error:?}"));
        Hostctl {
            config: &config,
            policy: &policy,
            clock: &clock,
            random: &random,
            audit: &mut audit,
            processes: &mut processes,
            effects: &mut effects,
            aborted: &|| false,
        }
        .execute(approved, &who)
    };
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../fixtures/parity/host/hostctl.json"
    ))
    .unwrap();
    std::fs::write(root.join("note"), "alpha note").unwrap();
    for case in fixture["files"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let value = invoke(name, case["input"].clone()).unwrap();
        for (field, expected) in case["output"].as_object().unwrap() {
            assert_eq!(&value[field], expected, "{name} {field}");
        }
    }
    std::fs::write(root.join("note"), "\u{feff}alpha").unwrap();
    assert!(invoke(
        "hostctl.fs.append",
        json!({"path":"note","content":" paragraph"})
    )
    .is_ok());
    assert_eq!(
        std::fs::read_to_string(root.join("note")).unwrap(),
        "\u{feff}alpha paragraph"
    );
    assert!(invoke(
        "hostctl.fs.edit",
        json!({"path":"note","oldText":"alpha","newText":"beta"})
    )
    .is_ok());
    assert_eq!(
        std::fs::read_to_string(root.join("note")).unwrap(),
        "\u{feff}beta paragraph"
    );
    assert!(invoke(
        "hostctl.fs.copy",
        json!({"path":"note","destination":"copy"})
    )
    .is_ok());
    assert_eq!(
        std::fs::read(root.join("note")).unwrap(),
        std::fs::read(root.join("copy")).unwrap()
    );
    assert!(invoke(
        "hostctl.fs.copy",
        json!({"path":"note","destination":"copy"})
    )
    .is_err());
    let result = invoke(
        "hostctl.fs.search",
        json!({"path":".","query":"beta","mode":"content"}),
    )
    .unwrap();
    assert_eq!(result["matches"], json!([{"path":"copy"},{"path":"note"}]));
    #[cfg(any(target_vendor = "apple", target_os = "linux"))]
    {
        invoke("hostctl.fs.mkdir", json!({"path":"folder"})).unwrap();
        let err = invoke(
            "hostctl.fs.move",
            json!({"path":"copy","destination":"note"}),
        )
        .unwrap_err();
        assert_eq!(err.code, "EXISTS");
        assert_eq!(
            std::fs::read(root.join("note")).unwrap(),
            std::fs::read(root.join("copy")).unwrap()
        );
        invoke(
            "hostctl.fs.move",
            json!({"path":"copy","destination":"folder/moved"}),
        )
        .unwrap();
        assert!(!root.join("copy").exists());
        assert_eq!(
            std::fs::read(root.join("note")).unwrap(),
            std::fs::read(root.join("folder/moved")).unwrap()
        );
    }
}

#[test]
fn hostctl_refuses_trash_of_a_nested_root_and_its_parent() {
    let tree = tempfile::tempdir().unwrap();
    let root = tree.path().canonicalize().unwrap();
    std::fs::create_dir_all(root.join("parent").join("nested")).unwrap();
    let roots = [
        PathRoot {
            id: "root".into(),
            path: root.to_str().unwrap().into(),
            identity: None,
        },
        PathRoot {
            id: "nested".into(),
            path: root.join("parent").join("nested").to_str().unwrap().into(),
            identity: None,
        },
    ];
    let policy = Policy {
        roots: &roots,
        deny: &[],
        home: None,
        fs: &RealFs,
        nfc: &IcuNfc,
    };
    for path in [".", "parent", "parent/nested"] {
        let value = json!({"path":path});
        let err = policy
            .prepare(catalog::Operation::Trash, value.as_object().unwrap())
            .err()
            .unwrap();
        assert_eq!(err.code, "DENIED", "{path}");
    }
}

#[test]
fn hostctl_shell_accepts_only_configured_literal_commands() {
    let who = Caller {
        session_id: Some("session".into()),
        ..Caller::default()
    };
    let active = Config::from_json(&json!({"shell":{"allowed":true},"denyPatterns":["blocked"]}));
    let dispatch = |config: &Config, text: &str| {
        let args = json!({"command":text,"cwd":"."});
        eligibility::validate_runtime(
            catalog::Operation::Shell,
            args.as_object().unwrap(),
            config,
            &who,
            ProcessIdentity::default(),
        )
    };
    assert!(dispatch(&Config::default(), "echo fixture").is_err());
    assert!(dispatch(&active, "echo fixture").is_ok());
    assert!(dispatch(&active, "echo fixture; echo second").is_err());
    assert!(dispatch(&active, "echo blocked").is_err());
}

#[test]
fn hostctl_native_clipboard_and_urls_use_typed_ports() {
    struct Native {
        text: String,
        url: Option<String>,
    }
    impl native::Port for Native {
        fn read_clipboard(&mut self, limit: usize, _: &Invocation<'_>) -> Result<String, Failure> {
            assert_eq!(limit, 34);
            Ok(self.text.clone())
        }
        fn write_clipboard(&mut self, text: &str, _: &Invocation<'_>) -> Result<(), Failure> {
            self.text = text.into();
            Ok(())
        }
        fn notify(&mut self, _: &str, _: &str, _: &Invocation<'_>) -> Result<(), Failure> {
            Err(Failure::new("UNAVAILABLE", "Fixture."))
        }
        fn open_url(&mut self, url: &str, _: &Invocation<'_>) -> Result<(), Failure> {
            self.url = Some(url.into());
            Ok(())
        }
        fn sys_info(&mut self, _: &Invocation<'_>) -> Result<native::HostInfo, Failure> {
            Err(Failure::new("UNAVAILABLE", "Fixture."))
        }
    }
    impl Effects for Native {
        fn process_identity(&self) -> ProcessIdentity {
            ProcessIdentity::default()
        }
        fn apply(&mut self, call: Invocation<'_>) -> Result<Value, Failure> {
            native::apply(self, &call, None).unwrap()
        }
    }

    let policy = Policy {
        roots: &[],
        deny: &[],
        home: None,
        fs: &RealFs,
        nfc: &IcuNfc,
    };
    let config = Config::from_json(&json!({"output":{"maxBytes":32}}));
    let clock = SetClock::at(1.0);
    let random = plur1bus_core::approvals::OsRandom;
    let who = Caller {
        principal: "person".into(),
        agent_id: "agent".into(),
        surface: 3,
        session_id: Some("session".into()),
        ..Default::default()
    };
    let mut audit = MemoryAudit::default();
    let mut processes = ProcessSessions::default();
    let mut effects = Native {
        text: "fixture text\r\n".to_owned(),
        url: None,
    };
    let mut invoke = |name: &str, args: Value| {
        let classifier = HostClassifier::new(name, &config, &policy).unwrap();
        let approved = Gate::new(
            &[classifier.definition()],
            &clock,
            &mut MemoryAudit::default(),
            &mut Permits::approving(),
        )
        .verify(
            UnverifiedAction {
                tool: name.into(),
                call_id: "call".into(),
                args,
                ..Default::default()
            },
            &who,
        )
        .unwrap();
        Hostctl {
            config: &config,
            policy: &policy,
            clock: &clock,
            random: &random,
            audit: &mut audit,
            processes: &mut processes,
            effects: &mut effects,
            aborted: &|| false,
        }
        .execute(approved, &who)
        .unwrap()
    };
    assert_eq!(
        invoke("hostctl.clipboard.read", json!({})),
        json!({"text":"fixture text"})
    );
    assert_eq!(
        invoke("hostctl.clipboard.write", json!({"text":"updated"})),
        json!({"bytes":7})
    );
    assert_eq!(
        invoke(
            "hostctl.app.open",
            json!({"target":"https://example.invalid/fixture"})
        ),
        json!({"opened":true})
    );
    assert_eq!(
        effects.url.as_deref(),
        Some("https://example.invalid/fixture")
    );
    for (_, line) in audit.lines {
        let wire = line.to_string();
        assert!(
            !wire.contains("fixture text") && !wire.contains("updated") && !wire.contains("https:")
        );
    }
}

#[test]
fn hostctl_process_port_receives_only_owned_ids_and_bounded_input() {
    use crate::exec::process::SpawnSpec;

    #[derive(Default)]
    struct Fixture {
        registered: Option<Uuid>,
        writes: usize,
    }

    fn result(running: bool) -> ProcessObservation {
        ProcessObservation {
            pid: Some(20),
            output: b"fixture".to_vec(),
            truncated: false,
            timed_out: false,
            running,
            exit_code: if running { None } else { Some(0) },
        }
    }

    impl SessionPort for Fixture {
        fn start(
            &mut self,
            id: Uuid,
            spec: &SpawnSpec,
            _: &Invocation<'_>,
        ) -> Result<ProcessObservation, Failure> {
            assert_eq!(spec.program, "fixture");
            assert_eq!(spec.env, [("LANG".to_owned(), "C".to_owned())]);
            self.registered = Some(id);
            Ok(result(true))
        }
        fn observe(&mut self, id: Uuid, _: &Invocation<'_>) -> Result<ProcessObservation, Failure> {
            assert_eq!(self.registered, Some(id));
            Ok(result(true))
        }
        fn write(
            &mut self,
            id: Uuid,
            bytes: &[u8],
            eof: bool,
            max_pending: usize,
            _: &Invocation<'_>,
        ) -> Result<usize, Failure> {
            assert_eq!(self.registered, Some(id));
            assert_eq!(max_pending, 32);
            assert!(eof);
            self.writes += 1;
            Ok(bytes.len())
        }
        fn stop(&mut self, id: Uuid, _: &Invocation<'_>) -> Result<ProcessObservation, Failure> {
            assert_eq!(self.registered, Some(id));
            Ok(result(false))
        }
    }
    impl Effects for Fixture {
        fn process_identity(&self) -> ProcessIdentity {
            ProcessIdentity::default()
        }
        fn apply(&mut self, call: Invocation<'_>) -> Result<Value, Failure> {
            let base = [
                ("LANG".to_owned(), Some("C".to_owned())),
                ("UNRELATED_ENV".to_owned(), Some("fixture".to_owned())),
            ];
            session(&call, &RealFs, self, &base, None).unwrap()
        }
    }

    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let roots = [PathRoot {
        id: "fixture".into(),
        path: root.to_str().unwrap().into(),
        identity: None,
    }];
    let policy = Policy {
        roots: &roots,
        deny: &[],
        home: None,
        fs: &RealFs,
        nfc: &IcuNfc,
    };
    let config = Config::from_json(&json!({"output":{"maxBytes":32}}));
    let clock = SetClock::at(1.0);
    let random = plur1bus_core::approvals::OsRandom;
    let who = Caller {
        principal: "person".into(),
        agent_id: "agent".into(),
        surface: 3,
        session_id: Some("session".into()),
        ..Default::default()
    };
    let other = Caller {
        principal: "other".into(),
        ..who.clone()
    };
    let mut audit = MemoryAudit::default();
    let mut processes = ProcessSessions::default();
    let mut effects = Fixture::default();
    let mut invoke = |name: &str, args: Value, who: &Caller| {
        let classifier = HostClassifier::new(name, &config, &policy).unwrap();
        let approved = Gate::new(
            &[classifier.definition()],
            &clock,
            &mut MemoryAudit::default(),
            &mut Permits::approving(),
        )
        .verify(
            UnverifiedAction {
                tool: name.into(),
                call_id: "call".into(),
                args,
                ..Default::default()
            },
            who,
        )
        .unwrap();
        Hostctl {
            config: &config,
            policy: &policy,
            clock: &clock,
            random: &random,
            audit: &mut audit,
            processes: &mut processes,
            effects: &mut effects,
            aborted: &|| false,
        }
        .execute(approved, who)
    };
    let started = invoke(
        "hostctl.proc.start",
        json!({"program":"fixture","cwd":"."}),
        &who,
    )
    .unwrap();
    let id = started["id"].clone();
    assert_eq!(
        invoke("hostctl.proc.list", json!({}), &other).unwrap(),
        json!({"processes":[]})
    );
    assert_eq!(
        invoke("hostctl.proc.read_output", json!({"id":id}), &other)
            .unwrap_err()
            .code,
        "DENIED"
    );
    assert_eq!(
        invoke(
            "hostctl.proc.write_stdin",
            json!({"id":id,"text":"sample","eof":true}),
            &who
        )
        .unwrap(),
        json!({"written":6})
    );
    assert_eq!(
        invoke("hostctl.proc.kill", json!({"id":id}), &who).unwrap()["running"],
        false
    );
    assert_eq!(effects.writes, 1);
}

#[test]
fn hostctl_limits_native_directory_enumeration() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().canonicalize().unwrap();
    for file in ["one", "two"] {
        std::fs::write(path.join(file), "fixture").unwrap();
    }
    let directory = RealFs.open_dir(path.to_str().unwrap()).unwrap();
    assert_eq!(RealFs.read_dir_at_bounded(&directory, 1).unwrap().len(), 1);
    assert_eq!(RealFs.read_dir_at(&directory).unwrap().len(), 2);
}
