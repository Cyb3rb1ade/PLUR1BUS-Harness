//! Real guarded-transport preparation regressions with tiny synthetic files and loopback-only servers.

#![allow(clippy::unwrap_used)]
use super::*;
use crate::contract::{AddressRules, Decision, EgressGate, Target};
use crate::transport::SystemResolver;
use std::net::TcpListener;
use std::sync::Arc;

struct Gate;
impl EgressGate for Gate {
    fn decide(&self, target: &Target) -> Decision {
        if target.host == "127.0.0.1" {
            Decision::Allow {
                address_rules: AddressRules {
                    allow_loopback: true,
                    ..AddressRules::default()
                },
            }
        } else {
            Decision::Deny {
                reason: "fixture-local-only".into(),
            }
        }
    }
}
fn client() -> GuardedClient<'static> {
    GuardedClient::new_owned(Arc::new(Gate), Box::new(SystemResolver))
}
fn pin() -> ArtifactFile {
    ArtifactFile {
        path: "onnx/tiny.onnx".into(),
        source_path: None,
        bytes: 3,
        sha256: format!("{:x}", Sha256::digest(b"abc")),
    }
}
fn serve(response: &'static [u8]) -> (String, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}/tiny", listener.local_addr().unwrap());
    let thread = std::thread::spawn(move || {
        let until = Instant::now() + Duration::from_secs(2);
        while Instant::now() < until {
            match listener.accept() {
                Ok((mut socket, _)) => {
                    socket.set_nonblocking(false).unwrap();
                    socket
                        .set_read_timeout(Some(Duration::from_secs(1)))
                        .unwrap();
                    let mut request = [0; 4096];
                    let _ = socket.read(&mut request);
                    let _ = socket.write_all(response);
                    return;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(2))
                }
                Err(_) => return,
            }
        }
    });
    (url, thread)
}
fn directory(path: &Path) -> Directory {
    Directory::open(
        path,
        &Cancel::never(),
        Instant::now() + Duration::from_secs(2),
    )
    .unwrap()
}

#[test]
fn verifies_before_publication_and_reuses_without_a_second_request() {
    let cache = tempfile::tempdir().unwrap();
    let root = directory(cache.path());
    let (url, server) =
        serve(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc");
    let cancel = Cancel::never();
    let deadline = Instant::now() + Duration::from_secs(2);
    assert!(prepare_one(&root, &pin(), &url, &client(), &cancel, deadline).unwrap());
    server.join().unwrap();
    assert_eq!(
        std::fs::read(cache.path().join("onnx/tiny.onnx")).unwrap(),
        b"abc"
    );
    assert!(!prepare_one(&root, &pin(), &url, &client(), &cancel, deadline).unwrap());
    assert_eq!(
        std::fs::read_dir(cache.path().join("onnx"))
            .unwrap()
            .count(),
        1
    );
}

#[test]
fn wrong_hash_oversized_and_truncated_bodies_never_publish() {
    for response in [
        b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nbad".as_slice(),
        b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nabcd".as_slice(),
        b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nab".as_slice(),
    ] {
        let cache = tempfile::tempdir().unwrap();
        let root = directory(cache.path());
        let (url, server) = serve(response);
        assert!(prepare_one(
            &root,
            &pin(),
            &url,
            &client(),
            &Cancel::never(),
            Instant::now() + Duration::from_secs(2)
        )
        .is_err());
        server.join().unwrap();
        assert!(!cache.path().join("onnx/tiny.onnx").exists());
        if let Ok(entries) = std::fs::read_dir(cache.path().join("onnx")) {
            assert_eq!(entries.count(), 0);
        }
    }
}

#[test]
fn production_urls_are_immutable_and_include_exact_original_text_files() {
    let files = pinned_files().unwrap();
    assert_eq!(files.len(), 9);
    for file in &files {
        let url = artifact_url(file).unwrap();
        assert_eq!(url,format!("https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/resolve/daa72c51243991dfcaf9f9137d2c573d8f7790c0/{}",file.path));
    }
    for file in graph_files(MediaGraph::Fusion).unwrap() {
        assert!(files.contains(&file));
    }
    for path in [
        "../outside",
        "/absolute",
        "onnx/../outside",
        "onnx\\escape",
        "onnx/file?query",
    ] {
        let mut file = pin();
        file.path = path.into();
        assert!(artifact_url(&file).is_err());
    }
}

#[test]
fn redirect_hops_remain_subject_to_the_existing_egress_gate() {
    let cache = tempfile::tempdir().unwrap();
    let root = directory(cache.path());
    let (url,server)=serve(b"HTTP/1.1 302 Found\r\nLocation: http://denied.invalid/artifact\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    assert_eq!(
        prepare_one(
            &root,
            &pin(),
            &url,
            &client(),
            &Cancel::never(),
            Instant::now() + Duration::from_secs(2)
        ),
        Err(MediaPrepareError::Transport(TransportError::Denied))
    );
    server.join().unwrap();
    assert_eq!(
        std::fs::read_dir(cache.path().join("onnx"))
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn caller_cancellation_interrupts_a_stalled_body_and_leaves_no_staging_files() {
    let cache = tempfile::tempdir().unwrap();
    let root = directory(cache.path());
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}/slow", listener.local_addr().unwrap());
    let (started, ready) = std::sync::mpsc::sync_channel(1);
    let server = std::thread::spawn(move || {
        let until = Instant::now() + Duration::from_secs(2);
        while Instant::now() < until {
            match listener.accept() {
                Ok((mut socket, _)) => {
                    socket.set_nonblocking(false).unwrap();
                    socket
                        .set_read_timeout(Some(Duration::from_secs(1)))
                        .unwrap();
                    let mut request = [0; 4096];
                    let _ = socket.read(&mut request);
                    socket
                        .write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\na",
                        )
                        .unwrap();
                    started.send(()).unwrap();
                    let _ = socket.read(&mut request);
                    return;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(2))
                }
                Err(_) => return,
            }
        }
    });
    let cancel = Cancel::never();
    let client = client();
    std::thread::scope(|scope| {
        let running = scope.spawn(|| {
            prepare_one(
                &root,
                &pin(),
                &url,
                &client,
                &cancel,
                Instant::now() + Duration::from_secs(2),
            )
        });
        ready.recv_timeout(Duration::from_secs(2)).unwrap();
        let start = Instant::now();
        cancel.cancel();
        assert!(matches!(
            running.join().unwrap(),
            Err(MediaPrepareError::Cancelled(_))
        ));
        assert!(start.elapsed() < Duration::from_millis(500));
    });
    server.join().unwrap();
    assert_eq!(
        std::fs::read_dir(cache.path().join("onnx"))
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn corrupt_existing_files_refuse_instead_of_overwriting_or_fetching() {
    let cache = tempfile::tempdir().unwrap();
    let root = directory(cache.path());
    std::fs::create_dir(cache.path().join("onnx")).unwrap();
    std::fs::write(cache.path().join("onnx/tiny.onnx"), b"bad").unwrap();
    assert_eq!(
        prepare_one(
            &root,
            &pin(),
            "http://denied.invalid/never",
            &client(),
            &Cancel::never(),
            Instant::now() + Duration::from_secs(2)
        ),
        Err(MediaPrepareError::Artifact(MediaError::ArtifactHash {
            file: "onnx/tiny.onnx".into()
        }))
    );
    assert_eq!(
        std::fs::read(cache.path().join("onnx/tiny.onnx")).unwrap(),
        b"bad"
    );
}

#[test]
fn aborted_staging_and_cancelled_hashing_are_bounded_and_cleaned() {
    let cache = tempfile::tempdir().unwrap();
    let root = directory(cache.path());
    let cancel = Cancel::never();
    {
        let mut stage = Stage::new(&root).unwrap();
        stage.file.write_all(b"abc").unwrap();
        cancel.cancel();
        assert!(check(&cancel, Instant::now() + Duration::from_secs(1)).is_err());
    }
    assert_eq!(std::fs::read_dir(cache.path()).unwrap().count(), 0);
    struct CancelReader {
        cancel: Cancel,
        reads: usize,
    }
    impl Read for CancelReader {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            self.reads += 1;
            self.cancel.cancel();
            buffer[0] = b'a';
            Ok(1)
        }
    }
    let cancel = Cancel::never();
    let mut reader = CancelReader {
        cancel: cancel.clone(),
        reads: 0,
    };
    assert!(matches!(
        verify_read(
            &mut reader,
            &pin(),
            &cancel,
            Instant::now() + Duration::from_secs(1)
        ),
        Err(MediaPrepareError::Cancelled(_))
    ));
    assert_eq!(reader.reads, 1);
}

#[cfg(unix)]
#[test]
fn symlinked_cache_directories_and_files_cannot_escape_the_cache() {
    let cache = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let root = directory(cache.path());
    std::os::unix::fs::symlink(outside.path(), cache.path().join("onnx")).unwrap();
    assert_eq!(
        prepare_one(
            &root,
            &pin(),
            "http://denied.invalid/never",
            &client(),
            &Cancel::never(),
            Instant::now() + Duration::from_secs(2)
        ),
        Err(MediaPrepareError::UnsafePath)
    );
    assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
    std::fs::remove_file(cache.path().join("onnx")).unwrap();
    std::fs::create_dir(cache.path().join("onnx")).unwrap();
    std::fs::write(outside.path().join("valid"), b"abc").unwrap();
    std::os::unix::fs::symlink(
        outside.path().join("valid"),
        cache.path().join("onnx/tiny.onnx"),
    )
    .unwrap();
    assert_eq!(
        prepare_one(
            &root,
            &pin(),
            "http://denied.invalid/never",
            &client(),
            &Cancel::never(),
            Instant::now() + Duration::from_secs(2)
        ),
        Err(MediaPrepareError::UnsafePath)
    );
}

#[test]
fn public_preparation_checks_cancellation_before_cache_or_network_access() {
    let cache = tempfile::tempdir().unwrap();
    let destination = cache.path().join("must-not-exist");
    let cancel = Cancel::never();
    cancel.cancel();
    assert!(matches!(
        prepare_media_artifacts(&destination, &client(), &cancel),
        Err(MediaPrepareError::Cancelled(_))
    ));
    assert!(!destination.exists());
}

#[test]
fn preparation_admission_wait_obeys_the_same_absolute_deadline() {
    let _held = PREPARATION.lock().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let destination = cache.path().join("must-not-exist");
    let started = Instant::now();
    let cancel = Cancel::with_deadline(started + Duration::from_millis(20));
    assert!(matches!(
        prepare_media_artifacts(&destination, &client(), &cancel),
        Err(MediaPrepareError::Cancelled(_))
    ));
    assert!(started.elapsed() < Duration::from_millis(250));
    assert!(!destination.exists());
}

#[cfg(unix)]
#[test]
fn retained_directory_descriptors_survive_parent_replacement_without_escaping() {
    let cache = tempfile::tempdir().unwrap();
    let original = cache.path().join("original");
    let moved = cache.path().join("moved");
    let outside = tempfile::tempdir().unwrap();
    let root = directory(&original);
    std::fs::rename(&original, &moved).unwrap();
    std::os::unix::fs::symlink(outside.path(), &original).unwrap();
    let (url, server) =
        serve(b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc");
    assert!(prepare_one(
        &root,
        &pin(),
        &url,
        &client(),
        &Cancel::never(),
        Instant::now() + Duration::from_secs(2)
    )
    .unwrap());
    server.join().unwrap();
    assert_eq!(std::fs::read(moved.join("onnx/tiny.onnx")).unwrap(), b"abc");
    assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
}

#[cfg(unix)]
#[test]
fn a_fifo_at_an_artifact_name_is_refused_before_network_or_blocking_read() {
    const CHILD: &str = "PLUR1BUS_TEST_MEDIA_PREPARE_FIFO";
    if let Some(path) = std::env::var_os(CHILD) {
        let root = directory(Path::new(&path));
        let cancel = Cancel::with_deadline(Instant::now() + Duration::from_millis(50));
        assert!(matches!(
            prepare_one(
                &root,
                &pin(),
                "http://denied.invalid/never",
                &client(),
                &cancel,
                Instant::now() + Duration::from_millis(50)
            ),
            Err(MediaPrepareError::Artifact(MediaError::ArtifactSize { .. }))
        ));
        return;
    }
    let cache = tempfile::tempdir().unwrap();
    std::fs::create_dir(cache.path().join("onnx")).unwrap();
    let name = c_string(cache.path().join("onnx/tiny.onnx").as_os_str()).unwrap();
    // SAFETY: a valid terminated path, with private owner-only mode, inside our temporary cache.
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    let mut child=std::process::Command::new(std::env::current_exe().unwrap()).arg("--exact")
        .arg("media::prepare::tests::a_fifo_at_an_artifact_name_is_refused_before_network_or_blocking_read")
        .env(CHILD,cache.path()).spawn().unwrap();
    let deadline = Instant::now() + Duration::from_millis(500);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break Some(status);
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            break None;
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    assert!(
        status.is_some_and(|status| status.success()),
        "FIFO regression process exceeded the bounded test budget"
    );
}
