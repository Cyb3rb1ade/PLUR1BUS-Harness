//! Process-only bounded pipe loop. Blocking stdin/stdout threads cannot outlive the worker's absolute deadline.
use crate::protocol::{self, Connect, Mode, Request};
use crate::{Failure, ReadonlySession};
use serde_json::{json, Value};
use std::io::Write;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot};
use zeroize::Zeroize;

struct SecretFrame(Vec<u8>);
impl Drop for SecretFrame {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

fn input() -> mpsc::Receiver<Result<SecretFrame, Failure>> {
    let (sender, receiver) = mpsc::channel(1);
    std::thread::spawn(move || {
        let mut input = std::io::stdin().lock();
        let mut count = 0;
        loop {
            let cap = match count {
                0 => protocol::CONNECT_BYTES,
                1 => protocol::KEY_BYTES,
                _ => protocol::METADATA_BYTES,
            };
            let result = match protocol::read_frame(&mut input, cap) {
                Ok(Some(frame)) => Ok(SecretFrame(frame)),
                Ok(None) => break,
                Err(error) => Err(error),
            };
            let failed = result.is_err();
            if sender.blocking_send(result).is_err() || failed {
                break;
            }
            count += 1;
        }
    });
    receiver
}

struct Output {
    metadata: Vec<u8>,
    data: Option<Vec<u8>>,
    done: oneshot::Sender<Result<(), Failure>>,
}

fn output() -> std::sync::mpsc::SyncSender<Output> {
    let (sender, receiver) = std::sync::mpsc::sync_channel::<Output>(1);
    std::thread::spawn(move || {
        let mut output = std::io::stdout().lock();
        for message in receiver {
            let result =
                protocol::write_frame(&mut output, &message.metadata, protocol::METADATA_BYTES)
                    .and_then(|()| match &message.data {
                        Some(bytes) => {
                            protocol::write_frame(&mut output, bytes, protocol::READ_BYTES as usize)
                        }
                        None => Ok(()),
                    })
                    .and_then(|()| output.flush().map_err(|_| Failure::Unavailable));
            let failed = result.is_err();
            let _ = message.done.send(result);
            if failed {
                break;
            }
        }
    });
    sender
}

async fn before<T>(
    deadline: Instant,
    future: impl std::future::Future<Output = T>,
) -> Result<T, Failure> {
    tokio::time::timeout_at(deadline.into(), future)
        .await
        .map_err(|_| Failure::Timeout)
}

async fn send(
    output: &std::sync::mpsc::SyncSender<Output>,
    value: &Value,
    data: Option<Vec<u8>>,
    cap: usize,
    deadline: Instant,
) -> Result<(), Failure> {
    let metadata = serde_json::to_vec(value).map_err(|_| Failure::Protocol)?;
    if metadata.len() > cap {
        return Err(Failure::Limit);
    }
    let (done, wait) = oneshot::channel();
    output
        .try_send(Output {
            metadata,
            data,
            done,
        })
        .map_err(|_| Failure::Unavailable)?;
    before(deadline, wait)
        .await?
        .map_err(|_| Failure::Unavailable)?
}

fn error(error: Failure, id: Option<u64>) -> Value {
    let mut value = json!({"v":1,"ok":false,"code":error.code(),"reason":error.reason()});
    if let Some(id) = id {
        value["id"] = json!(id);
    }
    value
}

async fn receive(
    input: &mut mpsc::Receiver<Result<SecretFrame, Failure>>,
    deadline: Instant,
) -> Result<SecretFrame, Failure> {
    before(deadline, input.recv())
        .await?
        .ok_or(Failure::InvalidRequest)?
}

fn ready(identity: &crate::HostIdentity) -> Value {
    json!({"v":1,"ok":true,"hostKeySha256":identity.host_key_sha256,"hostKeyAlgorithm":identity.host_key_algorithm})
}

async fn dispatch(
    session: &mut ReadonlySession,
    request: Request,
) -> Result<(Value, Option<Vec<u8>>), Failure> {
    let mut value = json!({"v":1,"id":request.id(),"ok":true});
    let mut data = None;
    match request {
        Request::Stat { path, .. } => {
            value["metadata"] =
                serde_json::to_value(session.stat(&path).await?).map_err(|_| Failure::Protocol)?;
        }
        Request::Lstat { path, .. } => {
            value["metadata"] =
                serde_json::to_value(session.lstat(&path).await?).map_err(|_| Failure::Protocol)?;
        }
        Request::Readdir { path, .. } => {
            value["entries"] = json!(session.readdir(&path).await?);
        }
        Request::Read {
            path,
            offset,
            length,
            ..
        } => {
            let bytes = session.read(&path, offset, length).await?;
            value["bytes"] = json!(bytes.len());
            data = Some(bytes);
        }
        Request::Realpath { path, .. } => {
            value["path"] = json!(session.realpath(&path).await?);
        }
        Request::Readlink { path, .. } => {
            value["path"] = json!(session.readlink(&path).await?);
        }
        Request::Close { .. } => return Err(Failure::InvalidRequest),
    }
    Ok((value, data))
}

async fn serve(
    mut session: ReadonlySession,
    config: &Connect,
    input: &mut mpsc::Receiver<Result<SecretFrame, Failure>>,
    output: &std::sync::mpsc::SyncSender<Output>,
    deadline: Instant,
) -> Result<(), Failure> {
    loop {
        let next = before(deadline, input.recv()).await?;
        let Some(frame) = next else {
            return before(deadline, session.close()).await?;
        };
        let frame = frame?;
        if frame.0.len() > config.limits.metadata_bytes {
            return Err(Failure::Limit);
        }
        let request: Request =
            serde_json::from_slice(&frame.0).map_err(|_| Failure::InvalidRequest)?;
        let id = request.id();
        if matches!(request, Request::Close { .. }) {
            before(deadline, session.close()).await??;
            return send(
                output,
                &json!({"v":1,"id":id,"ok":true}),
                None,
                config.limits.metadata_bytes,
                deadline,
            )
            .await;
        }
        match dispatch(&mut session, request).await {
            Ok((value, data)) => {
                send(output, &value, data, config.limits.metadata_bytes, deadline).await?
            }
            Err(failure) => {
                send(
                    output,
                    &error(failure, Some(id)),
                    None,
                    config.limits.metadata_bytes,
                    deadline,
                )
                .await?
            }
        }
    }
}

async fn setup(
    input: &mut mpsc::Receiver<Result<SecretFrame, Failure>>,
    output: &std::sync::mpsc::SyncSender<Output>,
) -> Result<(), Failure> {
    let first = receive(input, Instant::now() + Duration::from_secs(10)).await?;
    let config: Connect = serde_json::from_slice(&first.0).map_err(|_| Failure::InvalidRequest)?;
    let (_, deadline) = config.validate()?;
    if config.mode == Mode::ProbeHostKey {
        let identity = before(deadline, ReadonlySession::probe(&config)).await??;
        return send(
            output,
            &ready(&identity),
            None,
            config.limits.metadata_bytes,
            deadline,
        )
        .await;
    }
    let pinned = before(
        deadline,
        crate::connection::PinnedConnection::prepare(&config),
    )
    .await??;
    let mut verified = ready(&pinned.identity);
    verified["phase"] = json!("host-key-verified");
    send(
        output,
        &verified,
        None,
        config.limits.metadata_bytes,
        deadline,
    )
    .await?;
    let mut key = receive(input, deadline).await?;
    let session = before(
        deadline,
        ReadonlySession::authenticate(&config, pinned, &mut key.0),
    )
    .await??;
    drop(key);
    send(
        output,
        &ready(session.host_identity()),
        None,
        config.limits.metadata_bytes,
        deadline,
    )
    .await?;
    serve(session, &config, input, output, deadline).await
}

async fn run() -> Result<(), Failure> {
    let mut input = input();
    let output = output();
    let result = setup(&mut input, &output).await;
    if let Err(failure) = result {
        let _ = send(
            &output,
            &error(failure, None),
            None,
            protocol::METADATA_BYTES,
            Instant::now() + Duration::from_secs(1),
        )
        .await;
    }
    result
}

/// Dedicated helper entry: never called by a supervisor parser; private pipe workers exit with fixed framed errors.
pub fn run_worker() -> ! {
    std::panic::set_hook(Box::new(|_| {}));
    let result = std::panic::catch_unwind(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .map_err(|_| Failure::Unavailable)?
            .block_on(run())
    });
    std::process::exit(if matches!(result, Ok(Ok(()))) { 0 } else { 2 })
}
