use std::{
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
};
#[test]
fn real_stdio_helper_is_bounded_and_has_no_capabilities() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_plur1bus-host"))
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    for method in ["hello", "os.permissions.status", "shutdown"] {
        writeln!(input, "{{\"method\":\"{method}\"}}").unwrap();
        input.flush().unwrap();
        let mut line = String::new();
        output.read_line(&mut line).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&line).unwrap(),
            plur1bus_host::response(method).unwrap()
        );
    }
    assert!(child.wait().unwrap().success());
}
#[test]
fn oversized_stdio_line_exits_without_echoing() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_plur1bus-host"))
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let _ = input.write_all(&vec![b'x'; 65537]);
    drop(input);
    let output = child.wait_with_output().unwrap();
    assert!(output.stdout.is_empty());
    assert!(output.status.success());
}
