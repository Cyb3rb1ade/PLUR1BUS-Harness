//! Thin host commands over the runtime ports. Host records never contain runtime credentials.
use crate::{cli::ContainerCmd, output::Out, paths::Layout};
use plur1bus_containers::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader, Write},
    time::Duration,
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HostInstall {
    pub schema: String,
    pub runtime: RuntimeKind,
    pub services: Vec<Service>,
    pub version: String,
    pub channel: String,
    pub store_schema: u32,
    pub health_timeout_ms: u64,
    #[serde(default)]
    pub sidecars: BTreeMap<String, SidecarConfig>,
    /// Written before replacement; restored by the next host command after interruption.
    pub previous: Option<Vec<Service>>,
    pub previous_version: Option<String>,
    #[serde(default)]
    pub pending: bool,
}
pub(crate) fn path(layout: &Layout) -> std::path::PathBuf {
    layout.home.join("container-install.json")
}
pub(crate) fn read(layout: &Layout) -> Result<HostInstall> {
    let state: HostInstall =
        serde_json::from_slice(&std::fs::read(path(layout)).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    if state.schema != "plur1bus.container-install/1"
        || state.services.is_empty()
        || state.health_timeout_ms == 0
        || state.health_timeout_ms > 600_000
    {
        return Err("invalid host container installation".into());
    }
    for s in &state.services {
        s.validate()?;
    }
    Ok(state)
}
pub(crate) fn save(layout: &Layout, state: &HostInstall) -> Result<()> {
    if !layout.home.exists() {
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&layout.home).map_err(|e| e.to_string())?;
    }
    let tmp = layout
        .home
        .join(format!("container-install.tmp-{}", std::process::id()));
    let mut f = crate::audit::create_private(&tmp, true).map_err(|e| e.to_string())?;
    f.write_all(&serde_json::to_vec_pretty(state).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    drop(f);
    std::fs::rename(tmp, path(layout)).map_err(|e| e.to_string())
}
pub(crate) fn runtime(kind: RuntimeKind) -> Box<dyn ContainerRuntime> {
    match kind {
        RuntimeKind::Docker => Box::new(DockerRuntime::discover()),
        RuntimeKind::Apple => {
            let mut r = AppleContainerRuntime::local();
            if std::env::var("PLUR1BUS_ALLOW_TEST_INTERNALS").as_deref() == Ok("1") {
                if let Some(cli) = std::env::var_os("PLUR1BUS_TEST_CONTAINER_CLI") {
                    r = AppleContainerRuntime::new(cli, Platform::MacArm, 26);
                }
            }
            Box::new(r)
        }
    }
}
pub(crate) fn detections() -> Vec<Detection> {
    [RuntimeKind::Apple, RuntimeKind::Docker]
        .iter()
        .map(|k| runtime(*k).detect())
        .collect()
}
pub(crate) fn fail(out: &Out, reason: &str, message: &str) -> ! {
    out.fail("E_NOT_AVAILABLE", message, json!({"reason":reason}), 1)
}
/// Name of the one service that carries the harness core; the search wiring below lands on it.
const HARNESS: &str = "plur1bus-harness";
/// What the core reads (`packages/core/src/sidecars/web-search.ts`): the sidecar's URL and whether it is bundled or remote.
const SEARXNG_URL_ENV: &str = "PLUR1BUS_SEARXNG_URL";
const SEARXNG_MODE_ENV: &str = "PLUR1BUS_SEARXNG_MODE";

/// Hands the selected SearXNG to the harness so `web.search` can use it. Idempotent, so an install record written
/// before this wiring existed gets it on its next `container up` without a reinstall.
///
/// * bundled: a `Connection`, which the stack resolves to the sidecar's private address once the sidecar is healthy
///   (the same mechanism SearXNG uses for Valkey), plus the mode;
/// * remote: the configured URL as it is (a remote sidecar is not on the container network, so no private-IP rule applies);
/// * off or absent: nothing.
pub(crate) fn wire_searxng(
    services: &mut [Service],
    searxng: Option<&SidecarConfig>,
) -> Result<()> {
    let bundled_port = services
        .iter()
        .find(|s| s.name == "plur1bus-searxng")
        .map(|s| s.port);
    let Some(harness) = services.iter_mut().find(|s| s.name == HARNESS) else {
        return Ok(());
    };
    harness.env.retain(|e| {
        !e.starts_with(&format!("{SEARXNG_URL_ENV}="))
            && !e.starts_with(&format!("{SEARXNG_MODE_ENV}="))
    });
    harness.connections.retain(|c| c.env != SEARXNG_URL_ENV);
    let Some(config) = searxng else {
        return Ok(());
    };
    match config.mode {
        SidecarMode::Off => {}
        SidecarMode::Bundled => {
            let port = bundled_port.ok_or("bundled SearXNG service missing")?;
            harness.env.push(format!("{SEARXNG_MODE_ENV}=bundled"));
            harness.connections.push(Connection {
                env: SEARXNG_URL_ENV.into(),
                service: "plur1bus-searxng".into(),
                scheme: "http".into(),
                port,
                path: String::new(),
            });
        }
        SidecarMode::Remote => {
            let url = resolve_endpoint("searxng", config, None)?
                .ok_or("remote SearXNG endpoint absent")?;
            harness.env.push(format!("{SEARXNG_MODE_ENV}=remote"));
            harness.env.push(format!("{SEARXNG_URL_ENV}={url}"));
        }
    }
    Ok(())
}

/// What the stack publishes on the host and the warnings that go with it. Shared by install and `container status`.
pub(crate) fn exposure(services: &[Service]) -> (Vec<PublishedPort>, Vec<String>) {
    (
        services.iter().flat_map(published_ports).collect(),
        bind_warnings(services),
    )
}

pub(crate) fn manager<'a>(r: &'a dyn ContainerRuntime, state: &HostInstall) -> StackManager<'a> {
    let mut services = state.services.clone();
    // A record that no longer wires cleanly is left as it is: the stack then fails on its own validation, not here.
    let _ = wire_searxng(&mut services, state.sidecars.get("searxng"));
    let mut m = StackManager::new(r, services);
    m.health_timeout = Duration::from_millis(state.health_timeout_ms);
    m
}
pub(crate) fn recover(
    layout: &Layout,
    state: &mut HostInstall,
    r: &dyn ContainerRuntime,
) -> Result<()> {
    if !state.pending {
        return Ok(());
    }
    let previous = state
        .previous
        .clone()
        .ok_or("interrupted update has no previous services")?;
    // Stop only our containers; volumes survive. Restore the exact saved service definitions.
    manager(r, state).down()?;
    state.services = previous;
    manager(r, state).up()?;
    state.version = state
        .previous_version
        .clone()
        .ok_or("interrupted update has no previous version")?;
    state.pending = false;
    save(layout, state)
}
pub(crate) fn sidecar_endpoints(state: &HostInstall) -> Result<BTreeMap<String, Option<String>>> {
    state
        .sidecars
        .iter()
        .map(|(id, config)| {
            let bundled = if config.mode == SidecarMode::Bundled {
                let service = state
                    .services
                    .iter()
                    .find(|s| s.name == format!("plur1bus-{id}"))
                    .ok_or("bundled service missing")?;
                let address = match runtime(state.runtime).address(&service.name, &service.network)
                {
                    Ok(v) => v,
                    Err(_) => return Ok((id.clone(), None)),
                };
                Some(format!(
                    "{}://{address}:{}{}",
                    if id == "valkey" { "valkey" } else { "http" },
                    service.port,
                    if id == "valkey" { "/0" } else { "" }
                ))
            } else {
                None
            };
            resolve_endpoint(id, config, bundled.as_deref()).map(|url| (id.clone(), url))
        })
        .collect()
}
pub(crate) fn check_remote(state: &HostInstall) -> Result<()> {
    let endpoints = sidecar_endpoints(state)?;
    for (id, c) in &state.sidecars {
        if c.mode == SidecarMode::Remote {
            HttpHealthProbe.check(
                endpoints[id].as_deref().ok_or("missing remote endpoint")?,
                c,
            )?;
        }
    }
    Ok(())
}
pub fn run(out: &Out, layout: &Layout, sub: ContainerCmd) {
    crate::commands::refuse_in_container(out, "container");
    let _lock = if matches!(sub, ContainerCmd::Up | ContainerCmd::Down) {
        Some(lock(layout).unwrap_or_else(|e| fail(out, "container-busy", &e)))
    } else {
        None
    };
    let mut state = match read(layout) {
        Ok(v) => v,
        Err(e) if matches!(sub, ContainerCmd::Status) && !path(layout).exists() => {
            let v = json!({"installed":false,"detections":detections()});
            out.ok("container.status/1", &v, || {
                format!("container distribution not installed: {e}")
            });
            return;
        }
        Err(e) => fail(out, "container-not-installed", &e),
    };
    let r = runtime(state.runtime);
    let schema = match &sub {
        ContainerCmd::Status => "container.status/1",
        ContainerCmd::Up => "container.up/1",
        ContainerCmd::Down => "container.down/1",
        ContainerCmd::Logs { .. } => "container.logs/1",
    };
    let result = (|| -> Result<Value> {
        if !matches!(sub, ContainerCmd::Status) {
            recover(layout, &mut state, r.as_ref())?;
        }
        let stack = manager(r.as_ref(), &state);
        match sub {
            ContainerCmd::Status => {
                let (published, warnings) = exposure(&state.services);
                for w in &warnings {
                    eprintln!("warning: {w}");
                }
                Ok(
                    json!({"installed":true,"runtime":r.detect(),"services":stack.status()?,"sidecars":sidecar_endpoints(&state)?,"published":published,"warnings":warnings,"recoveryPending":state.pending}),
                )
            }
            ContainerCmd::Up => {
                check_remote(&state)?;
                stack.up()?;
                Ok(json!({"services":stack.status()?}))
            }
            ContainerCmd::Down => {
                stack.down()?;
                Ok(json!({"stopped":true,"stateRetained":true}))
            }
            ContainerCmd::Logs { service } => {
                let stream = stack.logs(&service)?;
                // Docker logs are demultiplexed by the transport; each line is a JSON document.
                for line in BufReader::new(stream).lines() {
                    let line = line.map_err(|e| e.to_string())?;
                    out.ok(schema, &json!({"service":service,"line":line}), || {
                        line.clone()
                    });
                }
                Ok(Value::Null)
            }
        }
    })();
    match result {
        Ok(v) if !v.is_null() => out.ok(schema, &v, || v.to_string()),
        Ok(_) => (),
        Err(e) => fail(out, "container-runtime", &e),
    }
}

/// Advisory file lock survives crashes without a stale lock directory.
pub(crate) fn lock(layout: &Layout) -> Result<std::fs::File> {
    if !layout.home.exists() {
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&layout.home).map_err(|e| e.to_string())?;
    }
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(layout.home.join("container.lock"))
        .map_err(|e| e.to_string())?;
    file.try_lock()
        .map_err(|e| format!("another container operation is active: {e}"))?;
    Ok(file)
}

pub(crate) fn platform() -> Platform {
    if std::env::var("PLUR1BUS_ALLOW_TEST_INTERNALS").as_deref() == Ok("1")
        && std::env::var_os("PLUR1BUS_TEST_CONTAINER_CLI").is_some()
    {
        Platform::MacArm
    } else {
        Platform::current()
    }
}
