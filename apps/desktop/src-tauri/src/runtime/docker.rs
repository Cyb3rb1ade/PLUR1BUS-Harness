use super::{detect::Endpoint, spec::ContainerSpec, *};
use bollard::{errors::Error, models::ContainerCreateBody, query_parameters::*, Docker};
use futures_util::TryStreamExt;
use serde_json::json;
use tokio::io::AsyncWriteExt;
pub struct DockerRuntime {
    client: Docker,
    info: RuntimeInfo,
}
pub fn map_error(e: Error) -> RuntimeError {
    use std::error::Error as _;
    let mut source = e.source();
    while let Some(cause) = source {
        if let Some(io) = cause.downcast_ref::<std::io::Error>() {
            match io.kind() {
                std::io::ErrorKind::PermissionDenied => {
                    return RuntimeError::NoAccess("docker-group-root-equivalent".into())
                }
                std::io::ErrorKind::NotFound => return RuntimeError::NotFound,
                _ => {}
            }
        }
        source = cause.source()
    }
    match e {
        Error::RequestTimeoutError => RuntimeError::Timeout("engine-api"),
        Error::DockerResponseServerError {
            status_code: 404, ..
        } => RuntimeError::NotFoundObject("runtime-object".into()),
        Error::DockerResponseServerError {
            status_code: 409, ..
        } => RuntimeError::Conflict("runtime-object".into()),
        Error::IOError { err } if err.kind() == std::io::ErrorKind::PermissionDenied => {
            RuntimeError::NoAccess("docker-group-root-equivalent".into())
        }
        Error::IOError { err } if err.kind() == std::io::ErrorKind::NotFound => {
            RuntimeError::NotFound
        }
        _ => RuntimeError::Failed("engine-api".into()),
    }
}
impl DockerRuntime {
    pub async fn connect(endpoint: &Endpoint) -> Result<Self, RuntimeError> {
        let mut client = match endpoint {
            #[cfg(unix)]
            Endpoint::Unix(p) => Docker::connect_with_unix(
                &p.to_string_lossy(),
                2,
                &bollard::ClientVersion {
                    major_version: 1,
                    minor_version: 41,
                },
            ),
            #[cfg(windows)]
            Endpoint::Pipe(p) => Docker::connect_with_named_pipe(
                p,
                2,
                &bollard::ClientVersion {
                    major_version: 1,
                    minor_version: 41,
                },
            ),
            #[allow(unreachable_patterns)]
            _ => return Err(RuntimeError::NotFound),
        }
        .map_err(map_error)?;
        let version = tokio::time::timeout(Duration::from_secs(2), async {
            client.ping().await.map_err(map_error)?;
            client.version().await.map_err(map_error)
        })
        .await
        .map_err(|_| RuntimeError::Timeout("probe"))??;
        if version.os.as_deref() != Some("linux") {
            return Err(RuntimeError::WrongMode);
        }
        let api = version
            .api_version
            .as_deref()
            .ok_or_else(|| RuntimeError::Failed("version-shape".into()))?;
        if api_parts(api) < api_parts("1.41") {
            return Err(RuntimeError::TooOld {
                found: api.into(),
                min: "1.41".into(),
            });
        }
        let engine = version
            .platform
            .map(|p| p.name)
            .or_else(|| {
                version
                    .components
                    .and_then(|c| c.into_iter().next().map(|v| v.name))
            })
            .unwrap_or_else(|| "Docker-compatible".into());
        client.set_timeout(Duration::from_secs(300));
        Ok(Self {
            client,
            info: RuntimeInfo {
                kind: RuntimeKind::Docker,
                endpoint: endpoint.to_string(),
                version: version.version.unwrap_or_default(),
                engine,
            },
        })
    }
}
fn api_parts(v: &str) -> Vec<u32> {
    v.split('.').map(|v| v.parse().unwrap_or(0)).collect()
}
pub fn create_body(spec: &ContainerSpec) -> Result<ContainerCreateBody, RuntimeError> {
    spec.validate()?;
    let mounts: Vec<_> = spec
        .volumes
        .iter()
        .map(|(name, path, ro)| json!({"Type":"volume","Source":name,"Target":path,"ReadOnly":ro}))
        .collect();
    let bindings = spec
        .host_port
        .map(|p| json!({"18700/tcp":[{"HostIp":"127.0.0.1","HostPort":p.to_string()}]}));
    let mut body = json!({"Image":spec.image_digest,"User":"10001:10001","Env":spec.env.iter().map(|(k,v)|format!("{k}={v}")).collect::<Vec<_>>(),"Labels":spec.labels,"StopTimeout":150,"HostConfig":{"ReadonlyRootfs":true,"CapDrop":["ALL"],"SecurityOpt":["no-new-privileges"],"PidsLimit":1024,"RestartPolicy":{"Name":if spec.restart {"unless-stopped"}else{"no"}},"Tmpfs":{"/tmp":""},"Memory":u64::from(spec.memory_mib)*1024*1024,"NanoCpus":u64::from(spec.cpus)*1_000_000_000,"Mounts":mounts,"NetworkMode":spec.network.as_deref().unwrap_or("none")}});
    if let Some(bindings) = bindings {
        body["HostConfig"]["PortBindings"] = bindings;
        body["ExposedPorts"] = json!({"18700/tcp":{}})
    }
    if let Some(cmd) = &spec.cmd {
        body["Cmd"] = json!(cmd);
        body["Entrypoint"] = json!([])
    }
    serde_json::from_value(body).map_err(|_| RuntimeError::Failed("container-body".into()))
}
const OUTPUT_LIMIT: usize = 8 * 1024 * 1024;
async fn bounded_json<S, T>(stream: S, deadline: Duration) -> Result<Vec<T>, RuntimeError>
where
    S: futures_util::Stream<Item = Result<T, Error>>,
    T: serde::Serialize,
{
    tokio::time::timeout(deadline, async {
        let mut stream = Box::pin(stream);
        let mut events = vec![];
        let mut bytes = 0;
        while let Some(event) = stream.try_next().await.map_err(map_error)? {
            bytes += serde_json::to_vec(&event)
                .map_err(|_| RuntimeError::Failed("engine-stream-shape".into()))?
                .len();
            if bytes > OUTPUT_LIMIT || events.len() >= 32768 {
                return Err(RuntimeError::Failed("engine-output-limit".into()));
            }
            events.push(event)
        }
        Ok(events)
    })
    .await
    .map_err(|_| RuntimeError::Timeout("engine-stream"))?
}
struct OwnedCleanup {
    client: Docker,
    name: String,
    armed: bool,
}
impl Drop for OwnedCleanup {
    fn drop(&mut self) {
        if self.armed {
            if let Ok(handle) = tokio::runtime::Handle::try_current() {
                let client = self.client.clone();
                let name = self.name.clone();
                handle.spawn(async move {
                    let _ = tokio::time::timeout(
                        Duration::from_secs(10),
                        client.remove_container(
                            &name,
                            Some(
                                RemoveContainerOptionsBuilder::default()
                                    .force(true)
                                    .v(false)
                                    .build(),
                            ),
                        ),
                    )
                    .await;
                });
            }
        }
    }
}
impl DockerRuntime {
    async fn capture_logs(&self, name: &str, tail: &str) -> Result<ExecOutput, RuntimeError> {
        tokio::time::timeout(Duration::from_secs(10), async {
            let mut stream = self.client.logs(
                name,
                Some(
                    LogsOptionsBuilder::default()
                        .stdout(true)
                        .stderr(true)
                        .tail(tail)
                        .build(),
                ),
            );
            let mut output = ExecOutput {
                code: 0,
                stdout: vec![],
                stderr: vec![],
            };
            while let Some(log) = stream.try_next().await.map_err(map_error)? {
                match log {
                    bollard::container::LogOutput::StdErr { message } => {
                        output.stderr.extend_from_slice(&message)
                    }
                    _ => output.stdout.extend_from_slice(&log.into_bytes()),
                }
                if output.stdout.len() + output.stderr.len() > OUTPUT_LIMIT {
                    return Err(RuntimeError::Failed("engine-output-limit".into()));
                }
            }
            Ok(output)
        })
        .await
        .map_err(|_| RuntimeError::Timeout("engine-stream"))?
    }
}
#[async_trait]
impl Runtime for DockerRuntime {
    fn info(&self) -> &RuntimeInfo {
        &self.info
    }
    async fn ping(&self) -> Result<(), RuntimeError> {
        self.client.ping().await.map(|_| ()).map_err(map_error)
    }
    async fn ensure_started(&self) -> Result<(), RuntimeError> {
        self.ping().await.map_err(|_| RuntimeError::Stopped)
    }
    async fn image_present(&self, digest: &str) -> Result<bool, RuntimeError> {
        match self.client.inspect_image(digest).await {
            Ok(v) => Ok(v.repo_digests.unwrap_or_default().iter().any(|d| {
                d.rsplit('@').next() == Some(digest.rsplit('@').next().unwrap_or(digest))
            })),
            Err(Error::DockerResponseServerError {
                status_code: 404, ..
            }) => Ok(false),
            Err(e) => Err(map_error(e)),
        }
    }
    async fn image_load(&self, tar: &Path) -> Result<String, RuntimeError> {
        tokio::time::timeout(Duration::from_secs(300), async {
            let file = tokio::fs::File::open(tar)
                .await
                .map_err(|_| RuntimeError::Failed("image-archive-read".into()))?;
            let events = bounded_json(
                self.client
                    .import_image_stream(
                        ImportImageOptionsBuilder::default().quiet(false).build(),
                        tokio_util::io::ReaderStream::new(file),
                        None,
                    )
                    .map_ok(
                        |event| json!({"stream":event.stream,"status":event.status,"id":event.id}),
                    ),
                Duration::from_secs(300),
            )
            .await?;
            let image = events
                .iter()
                .filter_map(|e| e.get("stream").and_then(|v| v.as_str()))
                .find_map(|s| {
                    s.trim()
                        .strip_prefix("Loaded image: ")
                        .or_else(|| s.trim().strip_prefix("Loaded image ID: "))
                })
                .ok_or_else(|| RuntimeError::Failed("image-load-digest".into()))?;
            let inspected = self.client.inspect_image(image).await.map_err(map_error)?;
            inspected
                .repo_digests
                .and_then(|d| d.first().cloned())
                .filter(|d| spec::valid_digest(d))
                .map(|d| d.rsplit('@').next().unwrap_or(&d).to_owned())
                .ok_or_else(|| RuntimeError::Failed("image-load-digest".into()))
        })
        .await
        .map_err(|_| RuntimeError::Timeout("image-load"))?
    }
    async fn image_pull(&self, reference: &str, digest: &str) -> Result<(), RuntimeError> {
        if !spec::valid_digest(digest) {
            return Err(RuntimeError::Failed("invalid-image-digest".into()));
        }
        let pinned = format!(
            "{}@{}",
            reference.split('@').next().unwrap_or(reference),
            digest
        );
        bounded_json(
            self.client.create_image(
                Some(
                    CreateImageOptionsBuilder::default()
                        .from_image(&pinned)
                        .build(),
                ),
                None,
                None,
            ),
            Duration::from_secs(300),
        )
        .await?;
        if self.image_present(&pinned).await? {
            Ok(())
        } else {
            Err(RuntimeError::Failed("image-digest-mismatch".into()))
        }
    }
    async fn volume_ensure(
        &self,
        name: &str,
        _size_gib: u32,
        labels: &Labels,
    ) -> Result<(), RuntimeError> {
        match self.client.inspect_volume(name).await {
            Ok(v) => {
                if labels.iter().all(|(k, val)| v.labels.get(k) == Some(val)) {
                    return Ok(());
                }
                return Err(RuntimeError::Conflict("foreign-volume".into()));
            }
            Err(Error::DockerResponseServerError {
                status_code: 404, ..
            }) => {}
            Err(e) => return Err(map_error(e)),
        }
        let body: bollard::models::VolumeCreateRequest =
            serde_json::from_value(json!({"Name":name,"Labels":labels}))
                .map_err(|_| RuntimeError::Failed("volume-body".into()))?;
        self.client
            .create_volume(body)
            .await
            .map(|_| ())
            .map_err(map_error)
    }
    async fn volume_present(&self, name: &str, labels: &Labels) -> Result<bool, RuntimeError> {
        match self.client.inspect_volume(name).await {
            Ok(v) => Ok(labels
                .iter()
                .all(|(k, value)| v.labels.get(k) == Some(value))),
            Err(Error::DockerResponseServerError {
                status_code: 404, ..
            }) => Ok(false),
            Err(e) => Err(map_error(e)),
        }
    }
    async fn volume_remove_owned(&self, name: &str, labels: &Labels) -> Result<(), RuntimeError> {
        match self.client.inspect_volume(name).await {
            Ok(v)
                if labels
                    .iter()
                    .all(|(k, value)| v.labels.get(k) == Some(value)) =>
            {
                self.volume_remove(name).await
            }
            Ok(_) => Err(RuntimeError::Conflict("foreign-volume".into())),
            Err(Error::DockerResponseServerError {
                status_code: 404, ..
            }) => Ok(()),
            Err(e) => Err(map_error(e)),
        }
    }
    async fn volume_remove(&self, name: &str) -> Result<(), RuntimeError> {
        self.client
            .remove_volume(name, None::<RemoveVolumeOptions>)
            .await
            .map_err(map_error)
    }
    async fn network_ensure(&self, name: &str, internal: bool) -> Result<(), RuntimeError> {
        match self.client.inspect_network(name, None).await {
            Ok(v) => {
                if v.labels
                    .as_ref()
                    .and_then(|l| l.get("app.plur1bus.role"))
                    .map(String::as_str)
                    == Some("network")
                    && v.internal == Some(internal)
                {
                    return Ok(());
                }
                return Err(RuntimeError::Conflict("foreign-network".into()));
            }
            Err(Error::DockerResponseServerError {
                status_code: 404, ..
            }) => {}
            Err(e) => return Err(map_error(e)),
        }
        let body = serde_json::from_value(
            json!({"Name":name,"Internal":internal,"Labels":{"app.plur1bus.role":"network"}}),
        )
        .map_err(|_| RuntimeError::Failed("network-body".into()))?;
        self.client
            .create_network(body)
            .await
            .map(|_| ())
            .map_err(map_error)
    }

    async fn network_ensure_labeled(
        &self,
        name: &str,
        internal: bool,
        labels: &Labels,
    ) -> Result<(), RuntimeError> {
        match self.client.inspect_network(name, None).await {
            Ok(v) => {
                if v.labels
                    .as_ref()
                    .and_then(|l| l.get("app.plur1bus.role"))
                    .map(String::as_str)
                    == Some("network")
                    && v.internal == Some(internal)
                {
                    return Ok(());
                }
                return Err(RuntimeError::Conflict("foreign-network".into()));
            }
            Err(Error::DockerResponseServerError {
                status_code: 404, ..
            }) => {}
            Err(e) => return Err(map_error(e)),
        }
        let body = serde_json::from_value(json!({"Name":name,"Internal":internal,"Labels":labels}))
            .map_err(|_| RuntimeError::Failed("network-body".into()))?;
        self.client
            .create_network(body)
            .await
            .map(|_| ())
            .map_err(map_error)
    }
    async fn published_ports(
        &self,
        except: &str,
    ) -> Result<std::collections::BTreeSet<u16>, RuntimeError> {
        tokio::time::timeout(Duration::from_secs(2), async {
            let all = self
                .client
                .list_containers(Some(
                    ListContainersOptionsBuilder::default().all(true).build(),
                ))
                .await
                .map_err(map_error)?;
            if all.len() > 512 {
                return Err(RuntimeError::Failed("port-inventory-limit".into()));
            }
            let mut ports = std::collections::BTreeSet::new();
            for c in all {
                if c.names
                    .as_ref()
                    .is_some_and(|n| n.iter().any(|n| n.trim_start_matches('/') == except))
                {
                    continue;
                }
                let id =
                    c.id.ok_or_else(|| RuntimeError::Failed("port-inventory-shape".into()))?;
                let v = self
                    .client
                    .inspect_container(&id, None)
                    .await
                    .map_err(map_error)?;
                let h = v
                    .host_config
                    .ok_or_else(|| RuntimeError::Failed("port-inventory-shape".into()))?;
                for bindings in h.port_bindings.unwrap_or_default().into_values().flatten() {
                    for b in bindings {
                        if let Some(port) = b.host_port.and_then(|s| s.parse::<u16>().ok()) {
                            ports.insert(port);
                        }
                    }
                }
            }
            Ok(ports)
        })
        .await
        .map_err(|_| RuntimeError::Timeout("port-inventory"))?
    }
    async fn image_remove(&self, digest: &str) -> Result<(), RuntimeError> {
        self.client
            .remove_image(
                digest,
                Some(RemoveImageOptionsBuilder::default().force(false).build()),
                None,
            )
            .await
            .map(|_| ())
            .map_err(map_error)
    }
    async fn network_remove(&self, name: &str) -> Result<(), RuntimeError> {
        let n = self
            .client
            .inspect_network(name, None)
            .await
            .map_err(map_error)?;
        if n.labels
            .as_ref()
            .and_then(|l| l.get("app.plur1bus.role"))
            .map(String::as_str)
            != Some("network")
        {
            return Err(RuntimeError::Conflict("foreign-network".into()));
        }
        self.client.remove_network(name).await.map_err(map_error)
    }
    async fn create(&self, spec: &ContainerSpec) -> Result<(), RuntimeError> {
        self.client
            .create_container(
                Some(
                    CreateContainerOptionsBuilder::default()
                        .name(&spec.name)
                        .build(),
                ),
                create_body(spec)?,
            )
            .await
            .map(|_| ())
            .map_err(map_error)
    }
    async fn start(&self, name: &str) -> Result<(), RuntimeError> {
        self.client
            .start_container(name, None)
            .await
            .map_err(map_error)
    }
    async fn stop(&self, name: &str, timeout: Duration) -> Result<(), RuntimeError> {
        self.client
            .stop_container(
                name,
                Some(
                    StopContainerOptionsBuilder::default()
                        .t(timeout
                            .as_secs()
                            .try_into()
                            .map_err(|_| RuntimeError::Failed("stop-timeout".into()))?)
                        .build(),
                ),
            )
            .await
            .map_err(map_error)
    }
    async fn rename(&self, from: &str, to: &str) -> Result<(), RuntimeError> {
        self.client
            .rename_container(
                from,
                RenameContainerOptionsBuilder::default().name(to).build(),
            )
            .await
            .map_err(map_error)
    }
    async fn remove(&self, name: &str) -> Result<(), RuntimeError> {
        self.client
            .remove_container(
                name,
                Some(
                    RemoveContainerOptionsBuilder::default()
                        .force(true)
                        .v(false)
                        .build(),
                ),
            )
            .await
            .map_err(map_error)
    }
    async fn state(&self, name: &str) -> Result<ContainerState, RuntimeError> {
        match self.client.inspect_container(name, None).await {
            Ok(v) => Ok(ContainerState {
                exists: true,
                running: v.state.as_ref().and_then(|s| s.running).unwrap_or(false),
                exit_code: v
                    .state
                    .and_then(|s| s.exit_code)
                    .and_then(|c| c.try_into().ok()),
                image_digest: v.config.as_ref().and_then(|c| c.image.clone()),
                labels: v
                    .config
                    .and_then(|c| c.labels)
                    .unwrap_or_default()
                    .into_iter()
                    .collect(),
                ip: v.network_settings.and_then(|n| n.networks).and_then(|n| {
                    n.into_values()
                        .find_map(|n| n.ip_address.and_then(|s| s.parse().ok()))
                }),
            }),
            Err(Error::DockerResponseServerError {
                status_code: 404, ..
            }) => Ok(ContainerState::default()),
            Err(e) => Err(map_error(e)),
        }
    }
    async fn list_labeled(&self, label: &str) -> Result<Vec<String>, RuntimeError> {
        let filters =
            std::collections::HashMap::from([("label".to_owned(), vec![label.to_owned()])]);
        self.client
            .list_containers(Some(
                ListContainersOptionsBuilder::default()
                    .all(true)
                    .filters(&filters)
                    .build(),
            ))
            .await
            .map(|v| {
                v.into_iter()
                    .flat_map(|v| v.names.unwrap_or_default())
                    .map(|n| n.trim_start_matches('/').into())
                    .collect()
            })
            .map_err(map_error)
    }
    async fn logs_tail(&self, name: &str, lines: u32) -> Result<String, RuntimeError> {
        let output = self
            .capture_logs(name, &lines.min(1000).to_string())
            .await?;
        let mut bytes = output.stdout;
        bytes.extend(output.stderr);
        Ok(String::from_utf8_lossy(&bytes).into())
    }
    async fn exec(
        &self,
        name: &str,
        argv: &[&str],
        stdin: Option<&[u8]>,
        timeout: Duration,
    ) -> Result<ExecOutput, RuntimeError> {
        tokio::time::timeout(timeout, async {
            let created = self
                .client
                .create_exec(
                    name,
                    bollard::exec::CreateExecOptions {
                        attach_stdin: Some(stdin.is_some()),
                        attach_stdout: Some(true),
                        attach_stderr: Some(true),
                        cmd: Some(argv.to_vec()),
                        ..Default::default()
                    },
                )
                .await
                .map_err(map_error)?;
            let mut result = ExecOutput {
                code: 0,
                stdout: vec![],
                stderr: vec![],
            };
            if let bollard::exec::StartExecResults::Attached {
                mut output,
                mut input,
            } = self
                .client
                .start_exec(&created.id, None)
                .await
                .map_err(map_error)?
            {
                if let Some(bytes) = stdin {
                    input
                        .write_all(bytes)
                        .await
                        .map_err(|_| RuntimeError::Failed("exec-stdin".into()))?;
                    input
                        .shutdown()
                        .await
                        .map_err(|_| RuntimeError::Failed("exec-stdin".into()))?
                }
                while let Some(log) = output.try_next().await.map_err(map_error)? {
                    match log {
                        bollard::container::LogOutput::StdErr { message } => {
                            result.stderr.extend_from_slice(&message)
                        }
                        _ => result.stdout.extend_from_slice(&log.into_bytes()),
                    }
                    if result.stdout.len() + result.stderr.len() > 8 * 1024 * 1024 {
                        return Err(RuntimeError::Failed("exec-output-limit".into()));
                    }
                }
            }
            result.code = self
                .client
                .inspect_exec(&created.id)
                .await
                .map_err(map_error)?
                .exit_code
                .and_then(|c| c.try_into().ok())
                .ok_or_else(|| RuntimeError::Failed("exec-incomplete".into()))?;
            Ok(result)
        })
        .await
        .map_err(|_| RuntimeError::Timeout("exec"))?
    }
    async fn run_oneshot(
        &self,
        spec: &ContainerSpec,
        timeout: Duration,
    ) -> Result<ExecOutput, RuntimeError> {
        if spec.network.as_deref() != Some("none") || spec.restart || spec.host_port.is_some() {
            return Err(RuntimeError::Failed("oneshot-policy".into()));
        }
        self.create(spec).await?;
        let mut guard = OwnedCleanup {
            client: self.client.clone(),
            name: spec.name.clone(),
            armed: true,
        };
        let result = tokio::time::timeout(timeout, async {
            self.start(&spec.name).await?;
            let mut waiting = self.client.wait_container(
                &spec.name,
                Some(
                    WaitContainerOptionsBuilder::default()
                        .condition("not-running")
                        .build(),
                ),
            );
            let code = match waiting.try_next().await {
                Ok(Some(v)) => v.status_code,
                Err(Error::DockerContainerWaitError { code, .. }) => code,
                Err(e) => return Err(map_error(e)),
                Ok(None) => return Err(RuntimeError::Failed("oneshot-incomplete".into())),
            };
            let mut output = self.capture_logs(&spec.name, "all").await?;
            output.code = code
                .try_into()
                .map_err(|_| RuntimeError::Failed("oneshot-exit-code".into()))?;
            Ok(output)
        })
        .await
        .map_err(|_| RuntimeError::Timeout("oneshot"))
        .and_then(|r| r);
        let cleanup = self.remove(&spec.name).await;
        if cleanup.is_ok() {
            guard.armed = false
        }
        match result {
            Ok(o) => {
                cleanup?;
                Ok(o)
            }
            Err(e) => Err(e),
        }
    }
}

#[cfg(test)]
mod stream_tests {
    use super::*;
    #[tokio::test]
    async fn stalled_body_has_a_total_deadline() {
        let stream = futures_util::stream::pending::<Result<serde_json::Value, Error>>();
        assert!(matches!(
            bounded_json(stream, Duration::from_millis(5)).await,
            Err(RuntimeError::Timeout("engine-stream"))
        ));
    }
    #[tokio::test]
    async fn oversized_output_is_refused() {
        let stream = futures_util::stream::iter(vec![Ok(json!("x".repeat(8 * 1024 * 1024 + 1)))]);
        assert!(matches!(
            bounded_json(stream, Duration::from_secs(2)).await,
            Err(RuntimeError::Failed(_))
        ));
    }
}
