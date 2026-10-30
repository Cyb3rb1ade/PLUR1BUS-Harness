//! Private, bounded credentials for one packaged-child spawn. No value is stored in a child spec or slot.
use crate::paths::Layout;
#[cfg(windows)]
use plur1bus_rpc::Endpoint;
use plur1bus_rpc::{transport, trust};
use std::collections::BTreeSet;
use std::fmt;
use std::io::Write;
use std::process::Command;
use std::time::{Duration, Instant};

const MAX_PAYLOAD: usize = 1024 * 1024;
const MAX_VALUE: usize = 64 * 1024;
const MAX_SLOTS: usize = 256;

/// Preserve the host's existing runtime selection before dropping its ambient PATH. Packages cannot choose this
/// program: the module launcher supplies it from the host Node locator.
pub fn executable(program: &std::path::Path) -> Option<std::path::PathBuf> {
    if program.is_absolute() || program.components().count() > 1 {
        return program.canonicalize().ok().filter(|path| path.is_file());
    }
    for directory in std::env::split_paths(&std::env::var_os("PATH")?) {
        let path = directory.join(program);
        #[cfg(windows)]
        let path = if path.extension().is_none() {
            path.with_extension("exe")
        } else {
            path
        };
        if path.is_file() {
            return path.canonicalize().ok();
        }
    }
    None
}

#[derive(Debug, PartialEq, Eq)]
pub enum Failure {
    Denied,
    NeedsSetup,
    Invalid,
    Unavailable,
}

/// Deliberately neither Clone nor a value-revealing Debug representation.
pub struct SpawnEnvironment {
    slots: Vec<(String, String)>,
}
impl fmt::Debug for SpawnEnvironment {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SpawnEnvironment")
            .field("slots", &self.slots.len())
            .finish_non_exhaustive()
    }
}
impl SpawnEnvironment {
    pub fn apply(&self, command: &mut Command, data: &std::path::Path) {
        command.env_clear();
        #[cfg(unix)]
        command.env("PATH", "/usr/bin:/bin").env("LANG", "C.UTF-8");
        #[cfg(windows)]
        if let Some(root) = std::env::var_os("SystemRoot") {
            command
                .env("PATH", std::path::Path::new(&root).join("System32"))
                .env("SystemRoot", root);
        }
        command
            .envs(self.slots.iter().map(|(key, value)| (key, value)))
            .env("P1X_DATA", data);
    }
}

fn decode_packet(packet: &[u8], windows: bool) -> Result<SpawnEnvironment, Failure> {
    if packet.len() < 7 {
        return Err(Failure::Invalid);
    }
    let length = u32::from_be_bytes(packet[..4].try_into().map_err(|_| Failure::Invalid)?) as usize;
    if length > MAX_PAYLOAD || length + 4 != packet.len() {
        return Err(Failure::Invalid);
    }
    let status = packet[4];
    let count = u16::from_be_bytes([packet[5], packet[6]]) as usize;
    if status > 4 || count > MAX_SLOTS {
        return Err(Failure::Invalid);
    }
    if status != 0 {
        if count != 0 || length != 3 {
            return Err(Failure::Invalid);
        }
        return Err(match status {
            1 => Failure::Denied,
            2 => Failure::NeedsSetup,
            3 => Failure::Invalid,
            _ => Failure::Unavailable,
        });
    }
    let mut cursor = 7;
    let mut slots = Vec::with_capacity(count);
    let mut seen = BTreeSet::new();
    for _ in 0..count {
        let key_length = u16::from_be_bytes(
            take(packet, &mut cursor, 2)?
                .try_into()
                .map_err(|_| Failure::Invalid)?,
        ) as usize;
        let key = std::str::from_utf8(take(packet, &mut cursor, key_length)?)
            .map_err(|_| Failure::Invalid)?;
        let slot = key.strip_prefix("P1X_SECRET_").ok_or(Failure::Invalid)?;
        if !crate::ext::runtime::valid_slot(slot)
            || !seen.insert(if windows {
                key.to_ascii_uppercase()
            } else {
                key.to_string()
            })
        {
            return Err(Failure::Invalid);
        }
        let value_length = u32::from_be_bytes(
            take(packet, &mut cursor, 4)?
                .try_into()
                .map_err(|_| Failure::Invalid)?,
        ) as usize;
        if value_length > MAX_VALUE {
            return Err(Failure::Invalid);
        }
        let value = std::str::from_utf8(take(packet, &mut cursor, value_length)?)
            .map_err(|_| Failure::Invalid)?;
        if value.contains('\0') {
            return Err(Failure::Invalid);
        }
        slots.push((key.to_string(), value.to_string()));
    }
    if cursor != packet.len() {
        return Err(Failure::Invalid);
    }
    Ok(SpawnEnvironment { slots })
}

fn take<'a>(packet: &'a [u8], cursor: &mut usize, count: usize) -> Result<&'a [u8], Failure> {
    let end = cursor.checked_add(count).ok_or(Failure::Invalid)?;
    let result = packet.get(*cursor..end).ok_or(Failure::Invalid)?;
    *cursor = end;
    Ok(result)
}

/// The stream stays alive only until Command.spawn completes; ACK or disconnect revokes every temporary Core lease.
pub struct SpawnLease {
    pub environment: SpawnEnvironment,
    stream: Option<Box<dyn transport::Stream>>,
}
impl fmt::Debug for SpawnLease {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SpawnLease")
            .field("environment", &self.environment)
            .finish_non_exhaustive()
    }
}
impl SpawnLease {
    pub fn spawned(mut self) -> Result<(), Failure> {
        if let Some(stream) = self.stream.as_mut() {
            stream
                .write_all(&[0x06])
                .map_err(|_| Failure::Unavailable)?;
            stream.flush().map_err(|_| Failure::Unavailable)?;
        }
        Ok(())
    }
}

fn revision(layout: &Layout, name: &str) -> Result<crate::ext::state::ItemRecord, Failure> {
    let state = crate::ext::state::read(&crate::ext::paths::ExtPaths::of(layout))
        .map_err(|_| Failure::Unavailable)?;
    let record = state
        .items
        .get(name)
        .filter(|r| !r.removed_by_user && matches!(r.kind.as_str(), "module" | "channel"))
        .ok_or(Failure::Invalid)?;
    if !crate::ext::overlays::rehash(layout, record).ok {
        return Err(Failure::Invalid);
    }
    Ok(record.clone())
}

pub fn acquire(layout: &Layout, name: &str) -> Result<SpawnLease, Failure> {
    let before = revision(layout, name)?;
    let allowed =
        crate::ext::runtime::declared_slots(&before.capabilities).map_err(|_| Failure::Invalid)?;
    if allowed.is_empty() {
        return Ok(SpawnLease {
            environment: SpawnEnvironment { slots: vec![] },
            stream: None,
        });
    }
    let address = crate::paths::extension_secrets_address(
        &layout.home,
        if cfg!(windows) { "windows" } else { "posix" },
    );
    trust::verify_address(&address).map_err(|_| Failure::Unavailable)?;
    let mut stream =
        transport::connect(&address, Duration::from_secs(2)).map_err(|_| Failure::Unavailable)?;
    #[cfg(windows)]
    if layout.recorded_pid(Endpoint::Core).is_none()
        || stream.peer_pid() != layout.recorded_pid(Endpoint::Core)
    {
        return Err(Failure::Denied);
    }
    #[cfg(unix)]
    {
        // SAFETY: geteuid has no preconditions and does not mutate state.
        trust::check_peer_uid(stream.peer_uid(), unsafe { libc::geteuid() })
            .map_err(|_| Failure::Denied)?;
    }
    let token = layout
        .read_token_file(&layout.core_token())
        .map_err(|_| Failure::Unavailable)?;
    let mut request =
        serde_json::to_vec(&serde_json::json!({"v":1,"token":token.trim(),"name":name}))
            .map_err(|_| Failure::Invalid)?;
    request.push(b'\n');
    if request.len() > 4096 {
        return Err(Failure::Invalid);
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .map_err(|_| Failure::Unavailable)?;
    stream
        .write_all(&request)
        .map_err(|_| Failure::Unavailable)?;
    stream.flush().map_err(|_| Failure::Unavailable)?;
    let mut header = [0u8; 4];
    read_before(&mut *stream, &mut header, deadline)?;
    let length = u32::from_be_bytes(header) as usize;
    if !(3..=MAX_PAYLOAD).contains(&length) {
        return Err(Failure::Invalid);
    }
    let mut packet = Vec::with_capacity(length + 4);
    packet.extend(header);
    packet.resize(length + 4, 0);
    read_before(&mut *stream, &mut packet[4..], deadline)?;
    let environment = decode_packet(&packet, cfg!(windows))?;
    if environment.slots.iter().any(|(key, _)| {
        !allowed
            .iter()
            .any(|slot| key == &format!("P1X_SECRET_{slot}"))
    }) {
        return Err(Failure::Invalid);
    }
    let after = revision(layout, name)?;
    if serde_json::to_value(&before).ok() != serde_json::to_value(&after).ok() {
        return Err(Failure::Unavailable);
    }
    Ok(SpawnLease {
        environment,
        stream: Some(stream),
    })
}

/// Development modules keep their existing environment contract. A corrupted state still fails closed for every
/// module identified by verified-install cache metadata, matching the supervisor's startup overlay policy.
pub fn for_module(layout: &Layout, name: &str) -> Result<Option<SpawnLease>, Failure> {
    let paths = crate::ext::paths::ExtPaths::of(layout);
    match crate::ext::state::read(&paths) {
        Ok(state) => {
            if state.items.get(name).is_some_and(|r| {
                !r.removed_by_user && matches!(r.kind.as_str(), "module" | "channel")
            }) {
                acquire(layout, name).map(Some)
            } else {
                Ok(None)
            }
        }
        Err(_) => {
            let packaged = std::fs::read_dir(&paths.cache)
                .into_iter()
                .flatten()
                .flatten()
                .any(|entry| {
                    entry
                        .path()
                        .extension()
                        .is_some_and(|extension| extension == "json")
                        && std::fs::read(entry.path())
                            .ok()
                            .and_then(|bytes| {
                                serde_json::from_slice::<serde_json::Value>(&bytes).ok()
                            })
                            .is_some_and(|metadata| {
                                metadata["manifest"]["name"] == name
                                    && matches!(
                                        metadata["manifest"]["kind"].as_str(),
                                        Some("module" | "channel")
                                    )
                            })
                });
            if packaged {
                Err(Failure::Invalid)
            } else {
                Ok(None)
            }
        }
    }
}

fn read_before(
    stream: &mut dyn transport::Stream,
    mut buffer: &mut [u8],
    deadline: Instant,
) -> Result<(), Failure> {
    while !buffer.is_empty() {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|d| !d.is_zero())
            .ok_or(Failure::Unavailable)?;
        stream
            .set_read_timeout(Some(remaining))
            .map_err(|_| Failure::Unavailable)?;
        let read = stream.read(buffer).map_err(|_| Failure::Unavailable)?;
        if read == 0 {
            return Err(Failure::Unavailable);
        }
        buffer = &mut buffer[read..];
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn unhex(text: &str) -> Vec<u8> {
        text.as_bytes()
            .chunks_exact(2)
            .map(|p| u8::from_str_radix(std::str::from_utf8(p).unwrap(), 16).unwrap())
            .collect()
    }
    fn packet(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut body = vec![0];
        body.extend_from_slice(&(entries.len() as u16).to_be_bytes());
        for (key, value) in entries {
            body.extend_from_slice(&(key.len() as u16).to_be_bytes());
            body.extend_from_slice(key.as_bytes());
            body.extend_from_slice(&(value.len() as u32).to_be_bytes());
            body.extend_from_slice(value.as_bytes());
        }
        let mut result = (body.len() as u32).to_be_bytes().to_vec();
        result.extend(body);
        result
    }

    #[test]
    fn consumes_the_shared_core_wire_vectors_with_bounded_fixed_failures() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../packages/core/test/fixtures/extension-spawn-secrets.json"
        ))
        .unwrap();
        assert_eq!(fixture["limits"]["payloadBytes"], MAX_PAYLOAD);
        assert_eq!(fixture["limits"]["valueBytes"], MAX_VALUE);
        assert_eq!(fixture["limits"]["slots"], MAX_SLOTS);
        for vector in fixture["valid"].as_array().unwrap() {
            let result = decode_packet(&unhex(vector["hex"].as_str().unwrap()), false);
            match vector["status"].as_u64().unwrap() {
                0 => {
                    let env = result.unwrap();
                    let values: serde_json::Map<String, Value> = env
                        .slots
                        .into_iter()
                        .map(|(k, v)| (k, Value::String(v)))
                        .collect();
                    assert_eq!(Value::Object(values), vector["env"]);
                }
                code => {
                    let expected = match code {
                        1 => Failure::Denied,
                        2 => Failure::NeedsSetup,
                        3 => Failure::Invalid,
                        _ => Failure::Unavailable,
                    };
                    assert_eq!(result.unwrap_err(), expected);
                }
            }
        }
        for vector in fixture["invalid"].as_array().unwrap() {
            assert_eq!(
                decode_packet(&unhex(vector["hex"].as_str().unwrap()), false).unwrap_err(),
                Failure::Invalid,
                "{}",
                vector["name"]
            );
        }
    }

    #[test]
    fn refuses_duplicate_keys_and_windows_case_collisions() {
        assert_eq!(
            decode_packet(
                &packet(&[("P1X_SECRET_key", "a"), ("P1X_SECRET_key", "b")]),
                false
            )
            .unwrap_err(),
            Failure::Invalid
        );
        let variants = packet(&[("P1X_SECRET_key", "a"), ("P1X_SECRET_KEY", "b")]);
        assert!(decode_packet(&variants, false).is_ok());
        assert_eq!(
            decode_packet(&variants, true).unwrap_err(),
            Failure::Invalid
        );
    }

    #[test]
    fn environment_debug_is_redacted_and_a_real_child_receives_only_minimal_and_leased_values() {
        let env = SpawnEnvironment {
            slots: vec![("P1X_SECRET_apiKey".into(), "a7-private-child-marker".into())],
        };
        assert!(!format!("{env:?}").contains("marker"));
        let node = std::env::var_os("PLUR1BUS_NODE")
            .map(std::path::PathBuf::from)
            .or_else(|| {
                std::env::split_paths(&std::env::var_os("PATH")?)
                    .map(|p| p.join(if cfg!(windows) { "node.exe" } else { "node" }))
                    .find(|p| p.is_file())
            })
            .expect("Node is required; run test:prep");
        let data = tempfile::tempdir().unwrap();
        let mut command = Command::new(node);
        command
            .env("AMBIENT_SECRET_CANARY", "ambient-marker")
            .env("OTHER_UNDECLARED_KEY", "ambient-marker");
        command.args(["-e","process.stdout.write(JSON.stringify({secret:process.env.P1X_SECRET_apiKey==='a7-private-child-marker',ambient:'AMBIENT_SECRET_CANARY' in process.env,other:'OTHER_UNDECLARED_KEY' in process.env,data:!!process.env.P1X_DATA}))"]);
        env.apply(&mut command, data.path());
        let output = command.output().unwrap();
        assert!(output.status.success());
        let value: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(
            value,
            serde_json::json!({"secret":true,"ambient":false,"other":false,"data":true})
        );
        assert!(!String::from_utf8_lossy(&output.stdout).contains("marker"));
        assert!(output.stderr.is_empty());
    }
}
