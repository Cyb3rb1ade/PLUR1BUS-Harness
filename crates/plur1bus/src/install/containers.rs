//! Container-mode installer runs on the host; runtime downloads require their own consent.
use crate::{cli::ContainerOptions, container_commands as host, output::Out, paths::Layout};
use plur1bus_containers::*;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::{self, IsTerminal, Write},
};

fn confirm(out: &Out, non_interactive: bool, question: &str) {
    if non_interactive {
        return;
    }
    if out.json || !io::stdin().is_terminal() {
        host::fail(
            out,
            "confirmation-required",
            &format!("{question} Use --non-interactive after reviewing --container-plan."),
        );
    }
    print!("{question} [y/N] ");
    let _ = io::stdout().flush();
    let mut answer = String::new();
    let _ = io::stdin().read_line(&mut answer);
    if !matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes") {
        host::fail(out, "declined", "installation cancelled");
    }
}
fn preference(s: &str) -> Result<Option<RuntimeKind>> {
    match s {
        "auto" => Ok(None),
        "apple" => Ok(Some(RuntimeKind::Apple)),
        "docker" => Ok(Some(RuntimeKind::Docker)),
        _ => Err("unknown runtime".into()),
    }
}
fn config(layout: &Layout) -> Result<Value> {
    if !layout.config_path().exists() {
        return Ok(json!({}));
    }
    let raw = std::fs::read(layout.config_path()).map_err(|e| e.to_string())?;
    plur1bus_config::parse(std::str::from_utf8(&raw).map_err(|e| e.to_string())?)
        .map_err(|e| format!("config: {e:?}"))
}
/// Construct sidecar services without creating any runtime resources.
pub(crate) fn services(
    layout: &Layout,
    image: &str,
    cfg: &Value,
    selections: &[String],
) -> Result<(Vec<Service>, BTreeMap<String, SidecarConfig>)> {
    let mut configs: BTreeMap<String, SidecarConfig> =
        serde_json::from_value(cfg.get("sidecars").cloned().unwrap_or(json!({})))
            .map_err(|e| e.to_string())?;
    for choice in selections {
        let (id, mode) = choice
            .split_once('=')
            .ok_or("sidecar expects ID=MODE or ID=URL")?;
        if !["searxng", "valkey"].contains(&id) {
            return Err("unknown bundled sidecar".into());
        }
        let mut c = SidecarConfig::off();
        match mode {
            "off" => (),
            "bundled" => c.mode = SidecarMode::Bundled,
            url => {
                c.mode = SidecarMode::Remote;
                c.url = Some(url.into());
            }
        }
        resolve_endpoint(id, &c, Some("http://bundled:8080"))?;
        configs.insert(id.into(), c);
    }
    let mut harness = Service::harness(image);
    if let Some(v) = cfg["containers"]["stateVolume"].as_str() {
        harness.state_volume = v.into();
        harness.mounts[0].source = v.into();
    }
    if let Some(v) = cfg["containers"]["bindAddress"].as_str() {
        harness.bind = v.parse().map_err(|_| "invalid bind address")?;
    }
    // The bind address only has something to bind once a host port is published. The API stays behind authentication.
    if let Some(v) = cfg["containers"].get("apiPort") {
        let port = v
            .as_u64()
            .filter(|p| (1024..=65535).contains(p))
            .ok_or("containers.apiPort must be an integer from 1024 to 65535")?;
        harness.publish = Some(port as u16);
    }
    harness.validate()?;
    let mut all = vec![];
    // Bundled SearXNG has a bundled Valkey dependency. A remote/off SearXNG creates neither.
    if configs
        .get("searxng")
        .is_some_and(|c| c.mode == SidecarMode::Bundled)
    {
        configs.entry("valkey".into()).or_insert_with(|| {
            let mut c = SidecarConfig::off();
            c.mode = SidecarMode::Bundled;
            c
        });
        if configs["valkey"].mode == SidecarMode::Off {
            return Err("bundled SearXNG requires bundled or remote Valkey".into());
        }
    }
    for (id, manifest) in [
        (
            "valkey",
            include_str!("../../../../containers/sidecars/valkey/manifest.json"),
        ),
        (
            "searxng",
            include_str!("../../../../containers/sidecars/searxng/manifest.json"),
        ),
    ] {
        if !configs
            .get(id)
            .is_some_and(|c| c.mode == SidecarMode::Bundled)
        {
            continue;
        }
        let m: SidecarManifest = serde_json::from_str(manifest).map_err(|e| e.to_string())?;
        let mut s = m.service()?;
        if id == "valkey" {
            s.entrypoint = vec!["/bin/busybox".into()];
            s.command = [
                "setpriv",
                "--no-new-privs",
                "--",
                "valkey-server",
                "--save",
                "",
                "--appendonly",
                "no",
            ]
            .map(String::from)
            .to_vec();
            s.tmpfs
                .push("/data:rw,nosuid,size=32m,uid=999,gid=999".into());
        } else {
            s.egress = true;
            s.entrypoint = vec!["/usr/local/searxng/.venv/bin/python".into()];
            s.command = vec!["-c".into(), "import ctypes,os,sys; r=ctypes.CDLL(None).prctl(38,1,0,0,0); sys.exit(77) if r else os.execv('/usr/local/searxng/entrypoint.sh',['/usr/local/searxng/entrypoint.sh'])".into()];
            s.env = vec![
                "SEARXNG_SETTINGS_PATH=/etc/searxng/settings.yml".into(),
                "GRANIAN_HOST=0.0.0.0".into(),
            ];
            if configs["valkey"].mode == SidecarMode::Remote {
                let endpoint = resolve_endpoint("valkey", &configs["valkey"], None)?
                    .ok_or("remote Valkey endpoint absent")?;
                if !endpoint.starts_with("valkey://") && !endpoint.starts_with("redis://") {
                    return Err("remote Valkey needs valkey://HOST:PORT/0 (over Tailscale)".into());
                }
                s.env.push(format!("SEARXNG_VALKEY_URL={endpoint}"));
            } else {
                s.connections.push(Connection {
                    env: "SEARXNG_VALKEY_URL".into(),
                    service: "plur1bus-valkey".into(),
                    scheme: "valkey".into(),
                    port: 6379,
                    path: "/0".into(),
                });
            }
            s.tmpfs
                .push("/var/cache/searxng:rw,nosuid,size=64m,uid=977,gid=977".into());
            s.mounts.push(Mount {
                source: layout
                    .home
                    .join("container-sidecars/config")
                    .to_string_lossy()
                    .into_owned(),
                target: "/etc/searxng".into(),
                bind: true,
                read_only: true,
            });
        }
        all.push(s);
    }
    all.push(harness);
    host::wire_searxng(&mut all, configs.get("searxng"))?;
    Ok((all, configs))
}
fn write_settings(layout: &Layout) -> Result<()> {
    let private = layout.home.join("container-sidecars");
    std::fs::create_dir_all(&private).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&private, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    let dir = private.join("config");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("settings.yml");
    if path.exists() {
        return Ok(());
    }
    let mut secret = [0u8; 32];
    getrandom::fill(&mut secret).map_err(|e| e.to_string())?;
    let hex: String = secret.iter().map(|b| format!("{b:02x}")).collect();
    let settings = include_str!("../../../../containers/sidecars/searxng/settings.yml")
        .replace("secret_key: \"\"", &format!("secret_key: \"{hex}\""));
    // The private parent protects host secrets; mount only the readable child directory.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;
    }
    std::fs::write(path, settings).map_err(|e| e.to_string())
}
pub fn run(
    out: &Out,
    layout: &Layout,
    mut opts: ContainerOptions,
    non_interactive: bool,
    channel: &str,
) -> ! {
    crate::commands::refuse_in_container(out, "install --container");
    let result = (|| -> Result<Value> {
        let _lock = if opts.plan {
            None
        } else {
            Some(host::lock(layout)?)
        };
        if host::path(layout).exists() {
            return Err(
                "container distribution already installed; use container up or update".into(),
            );
        }
        let cfg = config(layout)?;
        let preferred = preference(
            opts.runtime
                .as_deref()
                .or(cfg["containers"]["runtime"].as_str())
                .unwrap_or("auto"),
        )?;
        let (image, version) = match opts
            .image
            .as_deref()
            .or(cfg["containers"]["image"].as_str())
        {
            Some(image) => (image.to_string(), env!("CARGO_PKG_VERSION").to_string()),
            None if opts.image_from.is_some() => (
                "plur1bus-harness:local".into(),
                env!("CARGO_PKG_VERSION").into(),
            ),
            None => crate::update::containers::install_offer(
                layout,
                channel,
                opts.manifest.as_deref(),
                false,
            )?,
        };
        let image = image.as_str();
        if opts.image_from.is_none() {
            validate_digest_image(image)?;
        }
        let source = opts
            .image_from
            .clone()
            .map(ImageSource::Offline)
            .unwrap_or_else(|| ImageSource::Online(image.into()));
        let mut detected = host::detections();
        if preferred == Some(RuntimeKind::Apple)
            && (host::platform() != Platform::MacArm
                || detected
                    .iter()
                    .any(|d| d.kind == RuntimeKind::Apple && d.state == RuntimeState::Unsupported))
        {
            return Err("configured Apple runtime is unsupported on this host".into());
        }
        let planning_platform =
            if preferred == Some(RuntimeKind::Docker) && host::platform() == Platform::MacArm {
                Platform::MacIntel
            } else {
                host::platform()
            };
        let planning_detections: Vec<_> = detected
            .iter()
            .filter(|d| preferred.is_none_or(|k| d.kind == k))
            .cloned()
            .collect();
        let plan = plan_install(planning_platform, &planning_detections, source);
        if !opts.plan
            && !non_interactive
            && !out.json
            && io::stdin().is_terminal()
            && opts.sidecars.is_empty()
            && cfg.get("sidecars").is_none()
        {
            print!("SearXNG search sidecar (off/bundled/remote) [off]: ");
            let _ = io::stdout().flush();
            let mut choice = String::new();
            io::stdin()
                .read_line(&mut choice)
                .map_err(|e| e.to_string())?;
            let value = match choice.trim() {
                "" | "off" => "off".to_string(),
                "bundled" => "bundled".to_string(),
                "remote" => {
                    print!("Remote HTTP(S) host and port: ");
                    let _ = io::stdout().flush();
                    let mut url = String::new();
                    io::stdin().read_line(&mut url).map_err(|e| e.to_string())?;
                    url.trim().to_string()
                }
                _ => return Err("choose off, bundled or remote".into()),
            };
            opts.sidecars.push(format!("searxng={value}"));
        }
        let (services, sidecars) = services(layout, image, &cfg, &opts.sidecars)?;
        let (published, warnings) = host::exposure(&services);
        for w in &warnings {
            eprintln!("warning: {w}");
        }
        if opts.plan {
            return Ok(
                json!({"plan":plan,"detections":detected,"services":services,"sidecars":sidecars,"published":published,"warnings":warnings}),
            );
        }
        if !out.json {
            println!(
                "{}",
                serde_json::to_string_pretty(&plan).map_err(|e| e.to_string())?
            );
        }
        if !warnings.is_empty() {
            // A port on a non-loopback address is a decision, not a default: it gets its own question.
            confirm(
                out,
                non_interactive,
                &format!("{} Publish it anyway?", warnings.join(" ")),
            );
        }
        confirm(
            out,
            non_interactive,
            "Continue with container installation?",
        );
        if preferred != Some(RuntimeKind::Docker)
            && host::platform() == Platform::MacArm
            && detected
                .iter()
                .any(|d| d.kind == RuntimeKind::Apple && d.state == RuntimeState::Stopped)
        {
            host::runtime(RuntimeKind::Apple).ensure_running()?;
            detected = host::detections();
        }
        let selected = match select_runtime(preferred, host::platform(), &detected) {
            Ok(v) => v,
            Err(e) => {
                let consent = if opts.accept_runtime_download {
                    true
                } else if !non_interactive && !out.json && io::stdin().is_terminal() {
                    println!("Runtime licence: Docker Engine https://github.com/moby/moby/blob/master/LICENSE ; Docker Desktop https://www.docker.com/legal/docker-subscription-service-agreement/ ; Apple Container Apache-2.0 https://github.com/apple/container/blob/1.5.0/LICENSE");
                    confirm(
                        out,
                        false,
                        "Continue and download the official runtime installer?",
                    );
                    true
                } else {
                    false
                };
                if consent {
                    download_runtime(
                        host::platform(),
                        layout,
                        plan.steps.contains(&InstallStep::BundleApple)
                            && preferred != Some(RuntimeKind::Docker),
                    )?;
                }
                return Err(format!("{e}. Runtime required; licence: https://www.docker.com/legal/docker-subscription-service-agreement/ . Review --container-plan, then use --accept-runtime-download and complete the official installer; retry afterwards."));
            }
        };
        let signed_offer = opts.image.is_none()
            && cfg["containers"]["image"].as_str().is_none()
            && opts.image_from.is_none();
        if signed_offer {
            let verified = crate::update::containers::install_offer(
                layout,
                channel,
                opts.manifest.as_deref(),
                true,
            )?;
            if verified != (image.to_string(), version.clone()) {
                return Err("release changed while preparing installation; retry".into());
            }
        }
        let r = host::runtime(selected);
        let state = host::HostInstall {
            schema: "plur1bus.container-install/1".into(),
            runtime: selected,
            services,
            version,
            channel: channel.into(),
            store_schema: 1,
            health_timeout_ms: cfg["containers"]["healthTimeoutMs"]
                .as_u64()
                .unwrap_or(120000),
            sidecars,
            previous: None,
            previous_version: None,
            pending: false,
        };
        host::check_remote(&state)?;
        if state
            .sidecars
            .get("searxng")
            .is_some_and(|c| c.mode == SidecarMode::Bundled)
        {
            write_settings(layout)?;
        }
        if let Some(tar) = opts.image_from {
            r.load(&tar)?;
        } else {
            r.pull(image)?;
        }
        for s in state
            .services
            .iter()
            .filter(|s| s.name != "plur1bus-harness")
        {
            if !r.image_available(&s.image)? {
                r.pull(&s.image)?;
            }
        }
        host::manager(r.as_ref(), &state).up()?;
        host::save(layout, &state)?;
        if signed_offer {
            crate::update::guard::record_seen(layout, channel, &state.version)?;
        }
        Ok(
            json!({"installed":true,"runtime":selected,"services":state.services,"sidecars":host::sidecar_endpoints(&state)?,"published":published,"warnings":warnings}),
        )
    })();
    match result {
        Ok(v) => {
            out.ok("container.install/1", &v, || {
                if opts.plan {
                    "container installation plan prepared (use --json for details)".into()
                } else {
                    "container installation complete".into()
                }
            });
            std::process::exit(0)
        }
        Err(e) => host::fail(out, "container-install", &e),
    }
}
fn download_runtime(platform: Platform, layout: &Layout, apple: bool) -> Result<()> {
    let (url, filename) = match platform {
        Platform::MacArm if apple => ("https://github.com/apple/container/releases/download/1.5.0/container-1.5.0-installer-signed.pkg", "apple-container.pkg"),
        Platform::MacArm => ("https://desktop.docker.com/mac/main/arm64/Docker.dmg", "docker.dmg"),
        Platform::Windows => ("https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe", "docker-installer.exe"),
        Platform::MacIntel => ("https://desktop.docker.com/mac/main/amd64/Docker.dmg", "docker.dmg"),
        Platform::Linux => ("https://get.docker.com", "install-docker.sh"),
    };
    download_official(url, &layout.home.join(filename))
}
fn download_official(url: &str, into: &std::path::Path) -> Result<()> {
    // Explicit consent precedes this download. The OS validates the vendor-signed installer.
    std::fs::create_dir_all(into.parent().ok_or("installer path")?).map_err(|e| e.to_string())?;
    let mut response = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(900))
        .build()
        .map_err(|e| e.to_string())?
        .get(url)
        .send()
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let mut file = crate::audit::create_private(into, true).map_err(|e| e.to_string())?;
    io::copy(&mut response, &mut file).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    eprintln!(
        "Official installer downloaded to {}. Open it to complete runtime installation.",
        into.display()
    );
    Ok(())
}
