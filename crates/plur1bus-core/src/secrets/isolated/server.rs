//! The helper's side (`secrets/isolated-server.ts`): one backend, one request after the other.
//!
//! The process owns the blocking work: a keychain that asks the user, a file system that hangs. It reads a request, runs
//! it against its backend and writes the reply; it ends when its input ends (the parent closed the pipe or is gone).
//! Nothing but frames is ever written to its output.
use super::protocol::{
    encode_frame, operation_failed, probe_to_json, read_frame, unknown_operation, write_bytes,
    BackendDescription, Operation, PROTOCOL,
};
use crate::secrets::backend::SecretBackend;
use crate::secrets::error::SecretError;
use crate::secrets::types::SecretMeta;
use serde_json::{json, Map, Value};
use std::io::{self, Read, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};

/// The backend a helper serves, made at its first request.
type Served = Option<(BackendDescription, Box<dyn SecretBackend>)>;

/// Serves requests from `input` until it ends. `create` makes the backend of the first request's description; a later
/// request that names another backend is refused (one helper serves one backend).
///
/// A message that is not a request (no id, no argument list) is passed over, as TypeScript passes it over. Whatever an
/// operation fails with that is not a `SecretError`, a panic included, is answered `secret backend operation failed`.
pub fn serve<R: Read, W: Write>(
    mut input: R,
    mut output: W,
    mut create: impl FnMut(&BackendDescription) -> Box<dyn SecretBackend>,
) -> io::Result<()> {
    let mut served: Served = None;
    while let Some(message) = read_frame(&mut input)? {
        let Some(id) = message.get("id").and_then(Value::as_u64) else {
            continue;
        };
        let Some(args) = message.get("args").and_then(Value::as_array) else {
            continue;
        };
        let mut registrations: Vec<String> = Vec::new();
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            run(&message, args, &mut served, &mut create, &mut registrations)
        }))
        .unwrap_or_else(|_| Err(operation_failed()));
        let reply = |outcome: Result<Option<Value>, SecretError>, registrations: &[String]| {
            let mut reply = Map::new();
            reply.insert("id".into(), json!(id));
            reply.insert("registrations".into(), json!(registrations));
            match outcome {
                Ok(Some(value)) => {
                    reply.insert("value".into(), value);
                }
                Ok(None) => {}
                Err(error) => {
                    reply.insert("error".into(), error.to_json());
                }
            }
            Value::Object(reply)
        };
        // An answer no frame can hold (a list beyond every expectation) is a failure the caller hears about.
        let frame = encode_frame(&reply(outcome, &registrations))
            .or_else(|| encode_frame(&reply(Err(operation_failed()), &[])))
            .ok_or_else(|| io::Error::other("no reply fits a frame"))?;
        write_bytes(&mut output, &frame)?;
    }
    Ok(())
}

fn run(
    message: &Value,
    args: &[Value],
    served: &mut Served,
    create: &mut impl FnMut(&BackendDescription) -> Box<dyn SecretBackend>,
    registrations: &mut Vec<String>,
) -> Result<Option<Value>, SecretError> {
    if message.get("protocol").and_then(Value::as_str) != Some(PROTOCOL) {
        return Err(operation_failed());
    }
    let description = message
        .get("backend")
        .and_then(BackendDescription::from_json)
        .ok_or_else(operation_failed)?;
    if served.as_ref().is_some_and(|(of, _)| *of != description) {
        return Err(operation_failed());
    }
    let (_, backend) = served.get_or_insert_with(|| {
        let backend = create(&description);
        (description, backend)
    });
    let operation = message
        .get("operation")
        .and_then(Value::as_str)
        .and_then(Operation::from_wire)
        .ok_or_else(unknown_operation)?;

    // An argument of another type than the operation takes is a broken caller, not a `SecretError` of the backend.
    let text = |n: usize| {
        args.get(n)
            .and_then(Value::as_str)
            .ok_or_else(operation_failed)
    };
    let optional_text = |n: usize| match args.get(n) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value.as_str().map(Some).ok_or_else(operation_failed),
    };
    let time = |value: &Value| {
        value
            .as_i64()
            .or_else(|| {
                value
                    .as_f64()
                    .filter(|ms| ms.is_finite())
                    .map(|ms| ms as i64)
            })
            .ok_or_else(operation_failed)
    };
    let ms = |n: usize| args.get(n).ok_or_else(operation_failed).and_then(time);
    let optional_ms = |n: usize| match args.get(n) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => time(value).map(Some),
    };
    let mut register = |value: &str| registrations.push(value.to_owned());

    Ok(match operation {
        Operation::Probe => Some(probe_to_json(&backend.probe()?)),
        Operation::Get => Some(json!(backend.get(text(0)?)?)),
        Operation::List => Some(Value::Array(
            backend.list()?.iter().map(SecretMeta::to_json).collect(),
        )),
        Operation::Put => Some(
            backend
                .put(
                    text(0)?,
                    text(1)?,
                    ms(2)?,
                    optional_text(3)?,
                    optional_text(4)?,
                    Some(&mut register),
                )?
                .to_json(),
        ),
        Operation::Describe => Some(
            backend
                .describe(
                    text(0)?,
                    text(1)?,
                    ms(2)?,
                    optional_text(3)?,
                    Some(&mut register),
                )?
                .to_json(),
        ),
        Operation::Delete => Some(json!(backend.delete(text(0)?, optional_ms(1)?)?)),
        // A backend without tombstones has none (`b.tombstones?.() ?? {}`) and clears none.
        Operation::Tombstones => Some(match backend.tombstones() {
            Some(tombstones) => json!(tombstones?),
            None => json!({}),
        }),
        Operation::ClearTombstone => {
            if let Some(cleared) = backend.clear_tombstone(text(0)?) {
                cleared?;
            }
            None
        }
    })
}
