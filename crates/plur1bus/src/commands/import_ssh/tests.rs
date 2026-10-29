//! CLI transport-policy regression tests.
use super::*;
use crate::cli::{Cli, Cmd};
use clap::Parser;

#[test]
fn endpoint_parser_normalizes_dns_and_bracketed_ipv6_without_shell_or_password_syntax() {
    let endpoint = parse_endpoint("reader@Example.COM:2222").unwrap();
    assert_eq!(
        (
            endpoint.user.as_str(),
            endpoint.host.as_str(),
            endpoint.port
        ),
        ("reader", "example.com", 2222)
    );
    let ipv6 = parse_endpoint("reader@[2001:db8::1]:2200").unwrap();
    assert_eq!((ipv6.host.as_str(), ipv6.port), ("2001:db8::1", 2200));
    assert_eq!(parse_endpoint("reader@host").unwrap().port, 22);
    assert_eq!(
        parse_endpoint("reader@host").unwrap().id(),
        parse_endpoint("reader@HOST:22").unwrap().id()
    );
    for invalid in [
        "host",
        "@host",
        "reader@",
        "user:password@host",
        "reader@a@b",
        "reader@host:0",
        "reader@host:65536",
        "reader@host:+22",
        "reader@2001:db8::1",
        "reader@[::1]:",
        "reader@[::1]suffix",
        "reader@host/path",
        "reader@host\n",
        "reader@-host",
        "reader@a..b",
        "reader@host..",
        "reader@127.1",
    ] {
        assert!(
            parse_endpoint(invalid).is_err(),
            "invalid endpoint accepted"
        );
    }
    assert!(parse_endpoint(&format!("reader@{}", "a".repeat(254))).is_err());
    assert!(parse_endpoint(&format!("{}@host", "u".repeat(129))).is_err());
}

#[test]
fn ssh_arguments_are_additive_and_key_material_is_not_a_cli_input() {
    let cli = Cli::try_parse_from(["plur1bus", "import", "ssh", "--key", "generate"]).unwrap();
    let Cmd::Import(args) = cli.cmd else {
        panic!("import")
    };
    assert!(is_ssh(&args));
    assert!(Cli::try_parse_from(["plur1bus", "import", "ssh", "--password", "secret"]).is_err());
    assert!(Cli::try_parse_from(["plur1bus", "import", "ssh", "--private-key", "/file"]).is_err());
}

struct Scripted {
    replies: std::collections::VecDeque<(&'static str, serde_json::Value)>,
    calls: Vec<(Server, String, serde_json::Value)>,
}
impl RpcPort for Scripted {
    fn call(
        &mut self,
        server: Server,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, Failure> {
        self.calls.push((server, method.into(), params));
        let (expected, reply) = self.replies.pop_front().expect("unexpected RPC mutation");
        assert_eq!(method, expected);
        Ok(reply)
    }
}
fn cli(values: &[&str]) -> ImportArgs {
    let mut argv = vec!["plur1bus", "import"];
    argv.extend_from_slice(values);
    let Cmd::Import(args) = Cli::try_parse_from(argv).unwrap().cmd else {
        panic!("import")
    };
    args
}
#[test]
fn preflight_refusal_is_raw_and_never_starts_the_supervisor_apply() {
    use serde_json::json;
    let args = cli(&[
        "hermes",
        "--ssh",
        "reader@host",
        "--connection",
        "source",
        "--source",
        "/source",
        "--apply",
    ]);
    let refusal = json!({"planId":"00000000-0000-4000-8000-000000000002","runId":"00000000-0000-4000-8000-000000000003","ok":false,"issues":[{"code":"E_CONFLICT","reason":"busy"}],"future":{"retained":true}});
    let mut port=Scripted{replies:[
        ("admin.import.ssh.connections.list",json!({"connections":[{"id":"source","host":"host","port":22,"user":"reader","roots":["/source"],"allowPrivate":false,"hostKey":{"sha256":format!("SHA256:{}","A".repeat(43))}}]})),
        ("admin.import.detect",json!({"sourceId":"00000000-0000-4000-8000-000000000001"})),
        ("admin.import.plan",json!({"planId":"00000000-0000-4000-8000-000000000002"})),
        ("admin.import.preflight",refusal.clone()),
    ].into(),calls:vec![]};
    let result = execute(&args, &mut port).unwrap();
    assert_eq!(result.value, refusal);
    assert_eq!(result.schema, "import.ssh.preflight/1");
    assert!(!result.success);
    assert_eq!(
        port.calls[1].2,
        json!({"source":{"kind":"ssh","family":"hermes","connectionId":"source","path":"/source"}})
    );
    assert!(port.calls.iter().all(|call| call.0 == Server::Core));
}
#[test]
fn unsupported_legacy_force_is_refused_before_any_ssh_or_config_rpc() {
    let args = cli(&[
        "hermes",
        "--ssh",
        "reader@host",
        "--source",
        "/source",
        "--force",
    ]);
    let mut port = Scripted {
        replies: [].into(),
        calls: vec![],
    };
    assert!(matches!(
        execute(&args, &mut port),
        Err(Failure::Invalid("ssh-option-unsupported"))
    ));
    assert!(port.calls.is_empty());
}

#[test]
fn admin_operations_refuse_ignored_target_options_and_noncanonical_source_paths_before_rpc() {
    for values in [
        vec![
            "ssh",
            "--run-status",
            "00000000-0000-4000-8000-000000000003",
            "--ssh",
            "reader@host",
        ],
        vec![
            "ssh",
            "--connection",
            "source",
            "--source",
            "/source",
            "--apply",
        ],
        vec!["ssh", "--connection", "source", "--map", "/source=/target"],
        vec![
            "hermes",
            "--ssh",
            "reader@host",
            "--source",
            "/source/../outside",
        ],
        vec![
            "hermes",
            "--ssh",
            "reader@host",
            "--connection",
            "source\n",
            "--source",
            "/source",
        ],
    ] {
        let args = cli(&values);
        let mut port = Scripted {
            replies: [].into(),
            calls: vec![],
        };
        assert!(matches!(
            execute(&args, &mut port),
            Err(Failure::Invalid(_))
        ));
        assert!(port.calls.is_empty());
    }
}

#[test]
fn resume_uses_the_sealed_original_plan_and_a_fresh_ticket_without_ssh_reads() {
    use serde_json::json;
    let args = cli(&[
        "ssh",
        "--resume",
        "00000000-0000-4000-8000-000000000003",
        "--apply",
    ]);
    let mut port=Scripted{replies:[
        ("admin.import.status",json!({"run":{"planId":"00000000-0000-4000-8000-000000000002"}})),
        ("admin.import.preflight",json!({"ok":true,"preflightId":"00000000-0000-4000-8000-000000000004"})),
        ("admin.import.apply",json!({"runId":"00000000-0000-4000-8000-000000000003","state":"queued","future":{"retained":true}})),
    ].into(),calls:vec![]};
    let result = execute(&args, &mut port).unwrap();
    assert_eq!(result.schema, "import.ssh.apply/1");
    assert_eq!(result.value["future"]["retained"], true);
    assert_eq!(port.calls[0].0, Server::Supervisor);
    assert_eq!(port.calls[1].0, Server::Core);
    assert_eq!(port.calls[2].0, Server::Supervisor);
    assert_eq!(
        port.calls[2].2,
        json!({"planId":"00000000-0000-4000-8000-000000000002","preflightId":"00000000-0000-4000-8000-000000000004","resume":true})
    );
}

#[test]
fn host_trust_passes_only_the_explicit_connection_probe_and_fingerprint() {
    use serde_json::json;
    let fingerprint = format!("SHA256:{}", "A".repeat(43));
    let probe = "P".repeat(43);
    let args = cli(&[
        "ssh",
        "--connection",
        "source",
        "--trust-host-key",
        &fingerprint,
        "--probe-id",
        &probe,
    ]);
    let reply = json!({"connection":{"id":"source"},"future":{"retained":true}});
    let mut port = Scripted {
        replies: [("admin.import.ssh.hostKey.trust", reply.clone())].into(),
        calls: vec![],
    };
    let result = execute(&args, &mut port).unwrap();
    assert_eq!(result.value, reply);
    assert_eq!(
        port.calls[0].2,
        json!({"connectionId":"source","probeId":probe,"hostKeySha256":fingerprint})
    );
}

#[test]
fn full_apply_binds_the_detected_source_plan_and_one_use_preflight_before_supervisor_dispatch() {
    use serde_json::json;
    let args = cli(&[
        "hermes",
        "--connection",
        "source",
        "--source",
        "/nested/state",
        "--apply",
        "--on-conflict",
        "skip",
        "--map",
        "profile=work:agent=main",
        "--merge-profiles",
    ]);
    let mut port=Scripted{replies:[
        ("admin.import.ssh.connections.list",json!({"connections":[{"id":"source","host":"host","port":22,"user":"reader","roots":["/"],"allowPrivate":false}]})),
        ("admin.import.detect",json!({"sourceId":"00000000-0000-4000-8000-000000000001"})),
        ("admin.import.plan",json!({"planId":"00000000-0000-4000-8000-000000000002"})),
        ("admin.import.preflight",json!({"ok":true,"preflightId":"00000000-0000-4000-8000-000000000004"})),
        ("admin.import.apply",json!({"runId":"00000000-0000-4000-8000-000000000003","state":"queued"})),
    ].into(),calls:vec![]};
    assert_eq!(
        execute(&args, &mut port).unwrap().schema,
        "import.ssh.apply/1"
    );
    assert_eq!(
        port.calls[2].2,
        json!({"sourceId":"00000000-0000-4000-8000-000000000001","options":{"onConflict":"skip","mapProfiles":[{"profile":"work","agentId":"main"}],"mergeProfiles":true}})
    );
    assert_eq!(
        port.calls[3].2,
        json!({"planId":"00000000-0000-4000-8000-000000000002"})
    );
    assert_eq!(port.calls[4].0, Server::Supervisor);
    assert_eq!(
        port.calls[4].2,
        json!({"planId":"00000000-0000-4000-8000-000000000002","preflightId":"00000000-0000-4000-8000-000000000004"})
    );
}

#[test]
fn readonly_detect_reuses_existing_authority_and_preserves_the_raw_projection() {
    use serde_json::json;
    let args = cli(&[
        "hermes",
        "--connection",
        "source",
        "--source",
        "/source",
        "--detect",
    ]);
    let report =
        json!({"sourceId":"00000000-0000-4000-8000-000000000001","future":{"retained":true}});
    let mut port=Scripted{replies:[
        ("admin.import.ssh.connections.list",json!({"connections":[{"id":"source","host":"host","port":22,"user":"reader","roots":["/source"],"allowPrivate":true}]})),
        ("admin.import.detect",report.clone()),
    ].into(),calls:vec![]};
    let result = execute(&args, &mut port).unwrap();
    assert_eq!(result.value, report);
    assert_eq!(result.schema, "import.ssh.detect/1");
}

#[test]
fn rollback_is_preflight_only_until_apply_and_never_reopens_the_source() {
    use serde_json::json;
    for apply in [false, true] {
        let mut values = vec![
            "ssh",
            "--rollback-run",
            "00000000-0000-4000-8000-000000000003",
        ];
        if apply {
            values.push("--apply");
        }
        let args = cli(&values);
        let preflight = json!({"ok":true,"preflightId":"00000000-0000-4000-8000-000000000004"});
        let mut replies = std::collections::VecDeque::from([
            (
                "admin.import.status",
                json!({"run":{"planId":"00000000-0000-4000-8000-000000000002"}}),
            ),
            ("admin.import.preflight", preflight.clone()),
        ]);
        if apply {
            replies.push_back((
                "admin.import.rollback",
                json!({"runId":"00000000-0000-4000-8000-000000000003","state":"queued"}),
            ));
        }
        let mut port = Scripted {
            replies,
            calls: vec![],
        };
        let result = execute(&args, &mut port).unwrap();
        assert_eq!(
            port.calls[1].2,
            json!({"planId":"00000000-0000-4000-8000-000000000002","operation":"rollback"})
        );
        if apply {
            assert_eq!(result.schema, "import.ssh.rollback/1");
            assert_eq!(port.calls.len(), 3);
        } else {
            assert_eq!(result.schema, "import.ssh.preflight/1");
            assert_eq!(result.value, preflight);
            assert_eq!(port.calls.len(), 2);
        }
    }
}

#[test]
fn central_egress_changes_require_explicit_owner_consent_and_preserve_existing_policy() {
    let args = cli(&[
        "ssh",
        "--ssh",
        "reader@Host.Example:2222",
        "--source",
        "/source",
        "--allow-egress",
    ]);
    let mut port = Scripted { replies: [
        ("config.get", json!({"value":{"allowHosts":["existing.example"],"allowPorts":[443]},"revision":"existing-revision"})),
        ("config.set", json!({"applied":true})),
        ("admin.import.ssh.connections.list", json!({"connections":[]})),
        ("admin.import.ssh.connections.set", json!({"connection":{"id":"source"}})),
    ].into(), calls: vec![] };
    assert!(execute(&args, &mut port).is_ok());
    assert_eq!(
        port.calls[0],
        (
            Server::Supervisor,
            "config.get".into(),
            json!({"key":"egress"})
        )
    );
    assert_eq!(
        port.calls[1],
        (
            Server::Supervisor,
            "config.set".into(),
            json!({"ifRevision":"existing-revision","changes":[
                {"key":"egress.allowHosts","value":["existing.example","host.example"]},
                {"key":"egress.allowPorts","value":[443,2222]}
            ]})
        )
    );
    for values in [
        vec![
            "hermes",
            "--ssh",
            "reader@host",
            "--source",
            "/source",
            "--detect",
            "--allow-egress",
        ],
        vec!["ssh", "--key", "status", "--allow-egress"],
    ] {
        let mut no_calls = Scripted {
            replies: [].into(),
            calls: vec![],
        };
        assert!(execute(&cli(&values), &mut no_calls).is_err());
        assert!(no_calls.calls.is_empty());
    }
}
