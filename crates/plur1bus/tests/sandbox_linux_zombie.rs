//! A real namespace limit counts an unreaped payload task until its parent reaps it.
#![cfg(target_os = "linux")]
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::process::ExitStatusExt;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

struct Sandbox {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    done: bool,
}
impl Drop for Sandbox {
    fn drop(&mut self) {
        if !self.done {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

fn start(fixture: &std::path::Path) -> Sandbox {
    let outer = std::fs::read_link("/proc/self/ns/user").unwrap();
    let helper = assert_cmd::cargo::cargo_bin("plur1bus-sandbox-limits");
    let mut child = Command::new("/usr/bin/bwrap")
        .args([
            "--unshare-all",
            "--die-with-parent",
            "--new-session",
            "--cap-drop",
            "ALL",
            "--proc",
            "/proc",
            "--dev",
            "/dev",
            "--ro-bind",
            "/usr",
            "/usr",
            "--ro-bind",
            "/bin",
            "/bin",
            "--ro-bind",
            "/lib",
            "/lib",
            "--ro-bind-try",
            "/lib64",
            "/lib64",
            "--ro-bind",
        ])
        .arg(helper)
        .arg("/run/plur1bus/sandbox-limits")
        .arg("--ro-bind")
        .arg(fixture)
        .arg("/run/plur1bus/zombie-fixture")
        .args([
            "--remount-ro",
            "/",
            "--",
            "/run/plur1bus/sandbox-limits",
            "--tasks-required",
            "3",
        ])
        .arg(outer)
        .args(["--", "/run/plur1bus/zombie-fixture"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let input = child.stdin.take().unwrap();
    let output = BufReader::new(child.stdout.take().unwrap());
    Sandbox {
        child,
        input,
        output,
        done: false,
    }
}

#[test]
fn independent_namespaces_count_unreaped_children_and_allow_forks_after_reap() {
    let temp = tempfile::tempdir().unwrap();
    let fixture = temp.path().join("zombie-nproc");
    let source = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/sandbox/zombie-nproc.c"
    );
    assert!(Command::new("cc")
        .args([source, "-o"])
        .arg(&fixture)
        .status()
        .unwrap()
        .success());
    // The production tasksStep adds one slot for namespace init: 2 payload tasks => RLIMIT_NPROC 3.
    let mut sandboxes = [start(&fixture), start(&fixture)];
    let mut identities = Vec::new();
    for sandbox in &mut sandboxes {
        let mut ready = String::new();
        sandbox.output.read_line(&mut ready).unwrap();
        if ready.is_empty() {
            let status = sandbox.child.wait().unwrap();
            sandbox.done = true;
            let mut stderr = String::new();
            sandbox
                .child
                .stderr
                .take()
                .unwrap()
                .read_to_string(&mut stderr)
                .unwrap();
            panic!("sandbox exited before ready: {status}, {stderr}");
        }
        println!("{ready}");
        let fields: Vec<_> = ready.split_whitespace().collect();
        assert_eq!(fields.len(), 7, "{ready}");
        assert_eq!(&fields[..4], &["ready", "total=3", "payload=2", "errno=11"]);
        let uid = fields[4]
            .strip_prefix("uid=")
            .unwrap()
            .parse::<u32>()
            .unwrap();
        let outside = fields[5]
            .strip_prefix("map-outside=")
            .unwrap()
            .parse::<u32>()
            .unwrap();
        let namespace = fields[6].strip_prefix("userns=").unwrap();
        assert!(namespace.starts_with("user:[") && namespace.ends_with(']'));
        identities.push((uid, outside, namespace.to_owned()));
    }
    println!("caller uid={}", unsafe { libc::getuid() });
    assert_eq!(identities[0].0, identities[1].0);
    assert_eq!(identities[0].1, identities[1].1);
    assert_ne!(identities[0].2, identities[1].2);
    // Both sandboxes remain at capacity; complete the first while the second holds its zombie.
    for sandbox in &mut sandboxes {
        sandbox.input.write_all(b"x").unwrap();
        let mut limited = String::new();
        sandbox.output.read_line(&mut limited).unwrap();
        assert_eq!(limited, "still limited\n");
        sandbox.input.write_all(b"x").unwrap();
        let mut output = String::new();
        sandbox.output.read_to_string(&mut output).unwrap();
        let status = sandbox.child.wait().unwrap();
        sandbox.done = true;
        let mut stderr = String::new();
        sandbox
            .child
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut stderr)
            .unwrap();
        assert_eq!(
            status.code(),
            Some(0),
            "signal={:?}, stderr={stderr}",
            status.signal()
        );
        assert_eq!(output, "after-reap fork succeeded\n");
    }
}
