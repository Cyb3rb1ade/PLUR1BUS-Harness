use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

use crate::{
    adapters::Observer,
    jobs::{Error, Progress, Result, Stage},
};

use super::{Environment, Launch, Session};

const MAX_MESSAGE: usize = 1024 * 1024;

pub(super) struct Reply {
    pub(super) outcome: Result<Value>,
    pub(super) reusable: bool,
}

pub(super) fn check(env: &impl Environment, deadline: Instant) -> Result<()> {
    if env.cancelled() {
        Err(Error::Cancelled)
    } else if Instant::now() >= deadline {
        Err(Error::Timeout)
    } else {
        Ok(())
    }
}

pub(super) fn encode(message: &impl Serialize) -> Result<Vec<u8>> {
    let mut line = serde_json::to_vec(message).map_err(|_| Error::InvalidResponse)?;
    line.push(b'\n');
    Ok(line)
}

pub(super) fn oneshot(
    host: &impl Environment,
    line: &[u8],
    observer: &mut dyn Observer,
    deadline: Instant,
) -> Result<Value> {
    check(host, deadline)?;
    let mut child = host.launch(Launch::OneShot, deadline)?;
    child.send(line, deadline)?;
    child.close_input(deadline)?;
    let mut finished = None;
    let mut remaining = MAX_MESSAGE;
    loop {
        check(host, deadline)?;
        let outcome = child.receive(remaining, deadline);
        check(host, deadline)?;
        let Some(line) = outcome? else { break };
        remaining = remaining
            .checked_sub(line.len())
            .ok_or(Error::InvalidResponse)?;
        match frame(&line, None)? {
            Frame::Progress(fraction) => observe(observer, fraction)?,
            Frame::Terminal(value) => {
                if finished.replace(Ok(value)).is_some() {
                    return Err(Error::InvalidResponse);
                }
            }
            Frame::Error(error) => {
                let error = if error == Error::ContentPolicy {
                    error
                } else {
                    Error::BackendUnavailable
                };
                if finished.replace(Err(error)).is_some() {
                    return Err(Error::InvalidResponse);
                }
            }
        }
    }
    let succeeded = child.finish(deadline)?;
    check(host, deadline)?;
    let result = finished.ok_or(Error::BackendUnavailable)?;
    if result.is_ok() && !succeeded {
        return Err(Error::BackendUnavailable);
    }
    result
}

pub(super) fn jsonl(
    host: &impl Environment,
    child: &mut impl Session,
    id: &str,
    line: &[u8],
    observer: &mut dyn Observer,
    deadline: Instant,
    grace: Duration,
) -> Reply {
    if let Err(error) = check(host, deadline) {
        return Reply {
            outcome: Err(error),
            reusable: true,
        };
    }
    if let Err(error) = child.send(line, deadline) {
        return Reply {
            outcome: Err(error),
            reusable: false,
        };
    }
    loop {
        if let Err(error) = check(host, deadline) {
            return abort(child, id, grace, error);
        }
        let frame = child.receive(MAX_MESSAGE, deadline);
        if let Err(error) = check(host, deadline) {
            return abort(child, id, grace, error);
        }
        match frame.and_then(|line| parse(line, id)) {
            Ok(Frame::Terminal(value)) => {
                return Reply {
                    outcome: Ok(value),
                    reusable: true,
                }
            }
            Ok(Frame::Error(error)) => {
                return Reply {
                    outcome: Err(error),
                    reusable: true,
                }
            }
            Err(error) => {
                return Reply {
                    outcome: Err(error),
                    reusable: false,
                }
            }
            Ok(Frame::Progress(fraction)) => {
                if let Err(error) = observe(observer, fraction) {
                    return abort(child, id, grace, error);
                }
            }
        }
    }
}

fn abort(child: &mut impl Session, id: &str, grace: Duration, initial: Error) -> Reply {
    #[derive(Serialize)]
    struct Cancel<'a> {
        op: &'static str,
        target: &'a str,
    }
    let end = Instant::now() + grace;
    let send = encode(&Cancel {
        op: "cancel",
        target: id,
    })
    .and_then(|line| child.send(&line, end));
    if send.is_ok() {
        while Instant::now() < end {
            match child
                .receive(MAX_MESSAGE, end)
                .and_then(|line| parse(line, id))
            {
                Ok(Frame::Error(Error::ContentPolicy)) => {
                    return Reply {
                        outcome: Err(Error::ContentPolicy),
                        reusable: true,
                    }
                }
                Ok(Frame::Error(_) | Frame::Terminal(_)) => {
                    return Reply {
                        outcome: Err(initial),
                        reusable: true,
                    }
                }
                Ok(Frame::Progress(_)) => {}
                Err(_) => break,
            }
        }
    }
    Reply {
        outcome: Err(initial),
        reusable: false,
    }
}

fn parse(line: Option<Vec<u8>>, id: &str) -> Result<Frame> {
    let line = line.ok_or(Error::BackendUnavailable)?;
    frame(&line, Some(id))
}

enum Frame {
    Progress(f64),
    Terminal(Value),
    Error(Error),
}

fn frame(line: &[u8], id: Option<&str>) -> Result<Frame> {
    if line.len() > MAX_MESSAGE {
        return Err(Error::InvalidResponse);
    }
    let value: Value = serde_json::from_slice(line).map_err(|_| Error::InvalidResponse)?;
    if id.is_some_and(|id| value["id"] != id) {
        return Err(Error::InvalidResponse);
    }
    match value["type"].as_str() {
        Some("progress") => value["fraction"]
            .as_f64()
            .filter(|ratio| (0.0..=1.0).contains(ratio))
            .map(Frame::Progress)
            .ok_or(Error::InvalidResponse),
        Some("result" | "models") => Ok(Frame::Terminal(value)),
        Some("error") => Ok(Frame::Error(match value["code"].as_str() {
            Some("content_policy") => Error::ContentPolicy,
            Some("cancelled") => Error::Cancelled,
            Some("invalid_request" | "model_not_found") => Error::UnsupportedParameter,
            _ => Error::BackendUnavailable,
        })),
        _ => Err(Error::InvalidResponse),
    }
}

fn observe(observer: &mut dyn Observer, fraction: f64) -> Result<()> {
    observer.progress(Progress {
        fraction,
        stage: Some(Stage::Running),
    })
}
