//! SSH setup and supervised import orchestration; legacy imports retain their original Node entry.
#[path = "import_ssh/endpoint.rs"]
mod endpoint;
#[path = "import_ssh/port.rs"]
mod port;
use crate::cli::{ImportArgs, ImportSource, ImportSshKey, OnConflict};
use crate::{output::Out, paths::Layout};
use endpoint::{id, metadata_id, parse_endpoint, remote_path, select, uuid};
use port::{Failure, LivePort, RpcPort, Server};
use serde_json::{json, Value};
struct Outcome {
    schema: &'static str,
    value: Value,
    success: bool,
}
fn outcome(schema: &'static str, value: Value) -> Result<Outcome, Failure> {
    if !value.is_object() {
        return Err(Failure::Protocol);
    }
    Ok(Outcome {
        schema,
        value,
        success: true,
    })
}
pub(super) fn run(out: &Out, layout: &Layout, args: &ImportArgs) {
    let mut port = LivePort { out, layout };
    let result = match execute(args, &mut port) {
        Ok(value) => value,
        Err(Failure::Rpc(error)) => out.from_rpc_error(&error),
        Err(Failure::Invalid(reason)) => out.fail(
            "E_INVALID_PARAMS",
            "invalid SSH import options",
            json!({"reason":reason}),
        ),
        Err(Failure::Unavailable(reason)) => out.fail(
            "E_NOT_AVAILABLE",
            "SSH import setup is incomplete",
            json!({"reason":reason}),
        ),
        Err(Failure::Protocol) => out.fail(
            "E_IMPORT_FAILED",
            "SSH import returned invalid metadata",
            json!({"reason":"ssh-protocol"}),
        ),
    };
    out.ok(result.schema, &result.value, || {
        if result.schema.starts_with("import.ssh.key.") && result.value["configured"] == true {
            return result.value["instructions"].as_str().filter(|text| !text.is_empty()).map(str::to_owned)
                .unwrap_or_else(|| "Read-only source setup instructions are unavailable. Update Core and run import ssh --key status again; do not install the bare public key.".into());
        }
        serde_json::to_string_pretty(&result.value).unwrap_or_default()
    });
    if !result.success {
        crate::output::exit(2);
    }
}

fn validate(args: &ImportArgs) -> Result<(), Failure> {
    if args.allow_egress
        && (args.source_type != ImportSource::Ssh
            || args.ssh.is_none()
            || args.source.is_none()
            || args.key.is_some()
            || args.trust_host_key.is_some()
            || args.remove_connection)
    {
        return Err(Failure::Invalid("ssh-egress-consent-setup-only"));
    }
    if args.force
        || args.rollback.is_some()
        || args.max_skill_bytes.is_some()
        || args.adopt_store.is_some()
        || args.adopt_strategy.is_some()
        || args.agent.is_some()
    {
        return Err(Failure::Invalid("ssh-option-unsupported"));
    }
    if args.enable && !args.skills {
        return Err(Failure::Invalid("ssh-skills-required"));
    }
    if let Some(endpoint) = &args.ssh {
        parse_endpoint(endpoint).map_err(Failure::Invalid)?;
    }
    if let Some(connection) = &args.connection {
        id(connection)?;
    }
    if let Some(path) = &args.source {
        remote_path(
            path.to_str()
                .ok_or(Failure::Invalid("ssh-source-required"))?,
        )?;
    }
    if args.profile.as_ref().is_some_and(|profile| {
        profile.is_empty() || profile.len() > 256 || profile.chars().any(char::is_control)
    }) {
        return Err(Failure::Invalid("ssh-profile-invalid"));
    }
    let operations = [
        args.key.is_some(),
        args.probe_host_key,
        args.trust_host_key.is_some(),
        args.remove_connection,
        args.run_status.is_some(),
        args.abort_run.is_some(),
        args.runs,
        args.rollback_run.is_some(),
        args.resume.is_some(),
    ];
    if operations.into_iter().filter(|value| *value).count() > 1
        || args.probe_id.is_some() != args.trust_host_key.is_some()
    {
        return Err(Failure::Invalid("ssh-operation-conflict"));
    }
    let admin = args.source_type == ImportSource::Ssh;
    let mode = operations[..8].iter().any(|value| *value);
    let planning = !args.map.is_empty()
        || args.on_conflict.is_some()
        || args.migrate_secrets
        || args.merge_profiles;
    let target = args.ssh.is_some()
        || args.connection.is_some()
        || args.source.is_some()
        || args.allow_private
        || args.allow_egress;
    let run_control = args.run_status.is_some()
        || args.abort_run.is_some()
        || args.runs
        || args.rollback_run.is_some()
        || args.resume.is_some();
    if mode
        && (!admin
            || args.detect
            || args.skills
            || args.apply && args.rollback_run.is_none()
            || !args.map.is_empty()
            || args.on_conflict.is_some()
            || args.migrate_secrets
            || args.merge_profiles
            || args.profile.is_some())
        || admin
            && (args.detect
                || args.skills
                || args.enable
                || planning
                || args.profile.is_some()
                || args.apply && args.resume.is_none() && args.rollback_run.is_none())
        || args.resume.is_some() && (!args.apply || !admin)
        || run_control && target
        || (args.trust_host_key.is_some() || args.remove_connection)
            && (args.ssh.is_some() || args.source.is_some() || args.allow_private)
    {
        return Err(Failure::Invalid("ssh-operation-conflict"));
    }
    if args.detect && (args.apply || planning)
        || args.skills && (!args.map.is_empty() || args.migrate_secrets || args.merge_profiles)
    {
        return Err(Failure::Invalid("ssh-option-unsupported"));
    }
    if !admin && super::family(args.source_type).is_none() {
        return Err(Failure::Invalid("ssh-family-required"));
    }
    if args.key.is_some()
        && (args.ssh.is_some()
            || args.connection.is_some()
            || args.source.is_some()
            || args.allow_private)
    {
        return Err(Failure::Invalid("ssh-operation-conflict"));
    }
    Ok(())
}

fn options(args: &ImportArgs) -> Result<Value, Failure> {
    let mut options = json!({});
    if let Some(conflict) = args.on_conflict {
        options["onConflict"] = json!(match conflict {
            OnConflict::Skip => "skip",
            OnConflict::Rename => "rename",
            OnConflict::Replace => "replace",
        });
    }
    if args.migrate_secrets {
        options["migrateSecrets"] = json!(true);
    }
    if args.merge_profiles {
        options["mergeProfiles"] = json!(true);
    }
    let mut maps = vec![];
    let mut profiles = vec![];
    for mapping in &args.map {
        let mapping = mapping
            .to_str()
            .filter(|value| value.len() <= 8193 && !value.chars().any(char::is_control))
            .ok_or(Failure::Invalid("ssh-map-invalid"))?;
        if let Some(profile) = mapping.strip_prefix("profile=") {
            let (profile, agent) = profile
                .split_once(":agent=")
                .filter(|(profile, agent)| !profile.is_empty() && !agent.is_empty())
                .ok_or(Failure::Invalid("ssh-map-invalid"))?;
            profiles.push(json!({"profile":profile,"agentId":agent}));
        } else {
            let (from, to) = mapping
                .split_once('=')
                .filter(|(from, to)| {
                    !from.is_empty() && !to.is_empty() && from.len() <= 4096 && to.len() <= 4096
                })
                .ok_or(Failure::Invalid("ssh-map-invalid"))?;
            maps.push(json!({"from":from,"to":to}));
        }
    }
    if maps.len() > 256 || profiles.len() > 256 {
        return Err(Failure::Invalid("ssh-map-limit"));
    }
    if !maps.is_empty() {
        options["maps"] = json!(maps);
    }
    if !profiles.is_empty() {
        options["mapProfiles"] = json!(profiles);
    }
    Ok(options)
}
fn start(
    plan_id: &str,
    port: &mut impl RpcPort,
    resume: bool,
    rollback: Option<&str>,
    apply: bool,
) -> Result<Outcome, Failure> {
    let mut request = json!({"planId":plan_id});
    if rollback.is_some() {
        request["operation"] = json!("rollback");
    }
    let preflight = port.call(Server::Core, "admin.import.preflight", request)?;
    if preflight["ok"] != true || !apply {
        let mut result = outcome("import.ssh.preflight/1", preflight)?;
        result.success = result.value["ok"] == true;
        return Ok(result);
    }
    let ticket = metadata_id(&preflight, "preflightId")?;
    if let Some(run_id) = rollback {
        return outcome(
            "import.ssh.rollback/1",
            port.call(
                Server::Supervisor,
                "admin.import.rollback",
                json!({"runId":run_id,"preflightId":ticket}),
            )?,
        );
    }
    let mut request = json!({"planId":plan_id,"preflightId":ticket});
    if resume {
        request["resume"] = json!(true);
    }
    outcome(
        "import.ssh.apply/1",
        port.call(Server::Supervisor, "admin.import.apply", request)?,
    )
}
fn allow_egress(args: &ImportArgs, port: &mut impl RpcPort) -> Result<(), Failure> {
    let endpoint = parse_endpoint(
        args.ssh
            .as_deref()
            .ok_or(Failure::Invalid("ssh-connection-required"))?,
    )
    .map_err(Failure::Invalid)?;
    // The policy parser represents an exact IPv6 host in brackets; this is TCP, without a URI scheme.
    let host = if endpoint.host.contains(':') {
        format!("[{}]", endpoint.host)
    } else {
        endpoint.host
    };
    let config = port.call(Server::Supervisor, "config.get", json!({"key":"egress"}))?;
    let revision = config["revision"]
        .as_str()
        .filter(|value| !value.is_empty() && value.len() <= 256)
        .ok_or(Failure::Protocol)?;
    let mut hosts = config["value"]["allowHosts"]
        .as_array()
        .filter(|values| {
            values.len() <= 4096
                && values.iter().all(|value| {
                    value
                        .as_str()
                        .is_some_and(|value| !value.is_empty() && value.len() <= 512)
                })
        })
        .ok_or(Failure::Protocol)?
        .clone();
    let mut ports = config["value"]["allowPorts"]
        .as_array()
        .filter(|values| {
            values.len() <= 65535
                && values.iter().all(|value| {
                    value
                        .as_u64()
                        .is_some_and(|value| (1..=65535).contains(&value))
                })
        })
        .ok_or(Failure::Protocol)?
        .clone();
    let mut changed = false;
    if !hosts.iter().any(|value| value == &host) {
        hosts.push(json!(host));
        changed = true;
    }
    if !ports.iter().any(|value| value == endpoint.port) {
        ports.push(json!(endpoint.port));
        changed = true;
    }
    if changed {
        let applied = port.call(
            Server::Supervisor,
            "config.set",
            json!({"ifRevision":revision,"changes":[
                {"key":"egress.allowHosts","value":hosts},{"key":"egress.allowPorts","value":ports}
            ]}),
        )?;
        if applied["applied"] != true {
            return Err(Failure::Protocol);
        }
    }
    Ok(())
}

fn execute(args: &ImportArgs, port: &mut impl RpcPort) -> Result<Outcome, Failure> {
    validate(args)?;
    let planning = options(args)?; // Validate before any connection/configuration mutation.
    if args.allow_egress {
        allow_egress(args, port)?;
    }
    if let Some(action) = args.key {
        let (method, schema) = match action {
            ImportSshKey::Status => ("admin.import.ssh.key.status", "import.ssh.key.status/1"),
            ImportSshKey::Generate => {
                ("admin.import.ssh.key.generate", "import.ssh.key.generate/1")
            }
            ImportSshKey::Rotate => ("admin.import.ssh.key.rotate", "import.ssh.key.rotate/1"),
            ImportSshKey::Delete => ("admin.import.ssh.key.delete", "import.ssh.key.delete/1"),
        };
        return outcome(schema, port.call(Server::Core, method, json!({}))?);
    }
    for (run, method, schema) in [
        (
            &args.run_status,
            "admin.import.status",
            "import.ssh.status/1",
        ),
        (&args.abort_run, "admin.import.abort", "import.ssh.abort/1"),
    ] {
        if let Some(run) = run {
            return outcome(
                schema,
                port.call(Server::Supervisor, method, json!({"runId":uuid(run)?}))?,
            );
        }
    }
    if args.runs {
        return outcome(
            "import.ssh.runs/1",
            port.call(Server::Supervisor, "admin.import.runs", json!({}))?,
        );
    }
    if let Some(run_id) = args.resume.as_ref().or(args.rollback_run.as_ref()) {
        uuid(run_id)?;
        let status = port.call(
            Server::Supervisor,
            "admin.import.status",
            json!({"runId":run_id}),
        )?;
        if super::family(args.source_type)
            .is_some_and(|family| status["run"]["sourceType"] != family)
        {
            return Err(Failure::Invalid("ssh-family-mismatch"));
        }
        let plan = metadata_id(&status["run"], "planId")?;
        return start(
            &plan,
            port,
            args.resume.is_some(),
            args.rollback_run.as_deref(),
            args.apply,
        );
    }
    if let Some(fingerprint) = &args.trust_host_key {
        let connection = args
            .connection
            .as_deref()
            .ok_or(Failure::Invalid("ssh-connection-required"))?;
        let probe = args
            .probe_id
            .as_deref()
            .ok_or(Failure::Invalid("ssh-probe-required"))?;
        let digest = fingerprint
            .strip_prefix("SHA256:")
            .filter(|value| {
                value.len() == 43
                    && value
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"+/".contains(&b))
            })
            .ok_or(Failure::Invalid("ssh-fingerprint-invalid"))?;
        let _ = digest;
        if probe.len() != 43
            || !probe
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        {
            return Err(Failure::Invalid("ssh-probe-invalid"));
        }
        return outcome(
            "import.ssh.host-key.trust/1",
            port.call(
                Server::Core,
                "admin.import.ssh.hostKey.trust",
                json!({"connectionId":connection,"probeId":probe,"hostKeySha256":fingerprint}),
            )?,
        );
    }
    if args.remove_connection {
        let connection = args
            .connection
            .as_deref()
            .ok_or(Failure::Invalid("ssh-connection-required"))?;
        return outcome(
            "import.ssh.connections.delete/1",
            port.call(
                Server::Core,
                "admin.import.ssh.connections.delete",
                json!({"id":connection}),
            )?,
        );
    }
    if args.source_type == ImportSource::Ssh && args.ssh.is_none() && args.connection.is_none() {
        if args.source.is_some() || args.allow_private || args.probe_host_key || args.apply {
            return Err(Failure::Invalid("ssh-connection-required"));
        }
        return outcome(
            "import.ssh.connections/1",
            port.call(Server::Core, "admin.import.ssh.connections.list", json!({}))?,
        );
    }
    let selected = select(
        args,
        port,
        args.source_type == ImportSource::Ssh && !args.probe_host_key,
    )?;
    if args.probe_host_key {
        return outcome(
            "import.ssh.host-key.probe/1",
            port.call(
                Server::Core,
                "admin.import.ssh.hostKey.probe",
                json!({"id":selected.id}),
            )?,
        );
    }
    if args.source_type == ImportSource::Ssh {
        return outcome(
            "import.ssh.connection/1",
            selected.setup.ok_or(Failure::Protocol)?,
        );
    }
    let mut source = json!({"kind":"ssh","family":super::family(args.source_type).ok_or(Failure::Invalid("ssh-family-required"))?,"connectionId":selected.id,"path":selected.path});
    if let Some(profile) = &args.profile {
        source["profile"] = json!(profile);
    }
    let detected = port.call(
        Server::Core,
        "admin.import.detect",
        json!({"source":source}),
    )?;
    if args.detect {
        return outcome("import.ssh.detect/1", detected);
    }
    let source_id = metadata_id(&detected, "sourceId")?;
    if args.skills {
        let mut params = json!({"sourceId":source_id,"apply":args.apply});
        if args.enable {
            params["enable"] = json!(true);
        }
        if let Some(conflict) = planning.get("onConflict") {
            params["onConflict"] = conflict.clone();
        }
        return outcome(
            "import.ssh.skills/1",
            port.call(Server::Core, "admin.import.skills", params)?,
        );
    }
    let mut params = json!({"sourceId":source_id});
    if !planning.as_object().is_some_and(|map| map.is_empty()) {
        params["options"] = planning;
    }
    let plan = port.call(Server::Core, "admin.import.plan", params)?;
    if args.apply {
        return start(&metadata_id(&plan, "planId")?, port, false, None, true);
    }
    outcome("import.ssh.plan/1", plan)
}

pub(super) fn is_ssh(args: &ImportArgs) -> bool {
    args.source_type == ImportSource::Ssh
        || args.ssh.is_some()
        || args.connection.is_some()
        || args.key.is_some()
        || args.allow_private
        || args.allow_egress
        || args.probe_host_key
        || args.trust_host_key.is_some()
        || args.probe_id.is_some()
        || args.remove_connection
        || args.run_status.is_some()
        || args.abort_run.is_some()
        || args.runs
        || args.rollback_run.is_some()
}

#[cfg(test)]
#[path = "import_ssh/tests.rs"]
mod tests;
