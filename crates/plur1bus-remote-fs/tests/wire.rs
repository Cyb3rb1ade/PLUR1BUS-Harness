//! The native helper accepts only bounded, framed read-only requests and emits fixed redacted failures (E1/E8).
use serde_json::{json, Value};
use std::io::Write;
use std::process::{Command, Stdio};

fn frame(bytes: &[u8]) -> Vec<u8> {
    let mut out = (bytes.len() as u32).to_be_bytes().to_vec();
    out.extend_from_slice(bytes);
    out
}

fn run(bytes: &[u8]) -> std::process::Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_plur1bus-remote-fs"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let _ = child.stdin.take().unwrap().write_all(bytes);
    child.wait_with_output().unwrap()
}

fn error(output: std::process::Output, reason: &str) {
    assert!(!output.status.success());
    assert!(
        output.stderr.is_empty(),
        "helper never prints backend diagnostics"
    );
    assert!(
        output.stdout.len() >= 4,
        "helper must emit one framed fixed error"
    );
    let length = u32::from_be_bytes(output.stdout[..4].try_into().unwrap()) as usize;
    assert_eq!(output.stdout.len(), length + 4);
    let value: Value = serde_json::from_slice(&output.stdout[4..]).unwrap();
    assert_eq!(
        value,
        json!({"v":1,"ok":false,"code":"E_INVALID_PARAMS","reason":reason})
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains("PRIVATE-CANARY"));
}

#[test]
fn unknown_modes_and_key_fields_never_echo_the_request_or_execute_a_command() {
    error(
        run(&frame(
            &serde_json::to_vec(&json!({"v":1,"mode":"exec","command":"PRIVATE-CANARY"})).unwrap(),
        )),
        "invalid-request",
    );
    error(
        run(&frame(
            &serde_json::to_vec(&json!({"v":1,"mode":"connect","privateKey":"PRIVATE-CANARY"}))
                .unwrap(),
        )),
        "invalid-request",
    );
}

#[test]
fn oversized_and_truncated_connect_frames_are_refused_before_allocating_the_claimed_body() {
    error(run(&u32::MAX.to_be_bytes()), "invalid-request");
    error(run(&[0, 0, 0, 7, b'{']), "invalid-request");
}

#[test]
fn hostnames_are_refused_so_the_native_helper_never_resolves_a_destination() {
    let value = json!({"v":1,"mode":"probeHostKey","ip":"PRIVATE-CANARY.example","port":22,"deadlineMs":9999999999999_u64});
    error(
        run(&frame(&serde_json::to_vec(&value).unwrap())),
        "invalid-request",
    );
}
