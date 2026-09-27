//! The verified download client and the verified extractor (2a-H3b-b Task 3, ⟂EXT 1). Archives are built in the
//! test with `tar`, `flate2` and `zip`; downloads read local files or a loopback server. No network.
//!
//! The binary crate has no library target, so the two self-contained modules are included by path.
#[allow(dead_code)]
#[path = "../src/install/archive.rs"]
mod archive;
#[allow(dead_code)]
#[path = "../src/install/fetch.rs"]
mod fetch;

use archive::{extract, sha256_file, verify_and_extract, ArchiveError, PayloadError};
use fetch::{fetch_bytes, fetch_verified, FetchError};
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::time::{Duration, Instant};

const MIB: u64 = 1024 * 1024;

/// One tar entry with a raw (unchecked) name, so the test can build archives `tar::Builder::append_data` refuses.
struct E<'a> {
    name: &'a str,
    ty: tar::EntryType,
    data: &'a [u8],
    link: Option<&'a str>,
    mode: u32,
}

fn file<'a>(name: &'a str, data: &'a [u8]) -> E<'a> {
    E {
        name,
        ty: tar::EntryType::Regular,
        data,
        link: None,
        mode: 0o644,
    }
}
fn exe<'a>(name: &'a str, data: &'a [u8]) -> E<'a> {
    E {
        name,
        ty: tar::EntryType::Regular,
        data,
        link: None,
        mode: 0o755,
    }
}
fn dir(name: &str) -> E<'_> {
    E {
        name,
        ty: tar::EntryType::Directory,
        data: b"",
        link: None,
        mode: 0o755,
    }
}
#[cfg(unix)]
fn symlink<'a>(name: &'a str, target: &'a str) -> E<'a> {
    E {
        name,
        ty: tar::EntryType::Symlink,
        data: b"",
        link: Some(target),
        mode: 0o777,
    }
}
fn special<'a>(name: &'a str, ty: tar::EntryType, link: Option<&'a str>) -> E<'a> {
    E {
        name,
        ty,
        data: b"",
        link,
        mode: 0o644,
    }
}

fn tar_gz(path: &Path, entries: &[E<'_>]) {
    let gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    let mut b = tar::Builder::new(gz);
    for e in entries {
        let mut h = tar::Header::new_gnu();
        {
            let old = h.as_old_mut();
            old.name.fill(0);
            old.name[..e.name.len()].copy_from_slice(e.name.as_bytes());
            if let Some(l) = e.link {
                old.linkname.fill(0);
                old.linkname[..l.len()].copy_from_slice(l.as_bytes());
            }
        }
        h.set_entry_type(e.ty);
        h.set_size(e.data.len() as u64);
        h.set_mode(e.mode);
        h.set_cksum();
        b.append(&h, e.data).unwrap();
    }
    let bytes = b.into_inner().unwrap().finish().unwrap();
    fs::write(path, bytes).unwrap();
}

fn zip(path: &Path, entries: &[(&str, Option<&[u8]>)]) {
    let mut w = zip::ZipWriter::new(fs::File::create(path).unwrap());
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for (name, data) in entries {
        match data {
            Some(d) => {
                w.start_file(*name, opts).unwrap();
                w.write_all(d).unwrap();
            }
            None => w.add_directory(*name, opts).unwrap(),
        }
    }
    w.finish().unwrap();
}

/// Names in `dir`, sorted.
fn names(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    v.sort();
    v
}

fn assert_nothing_written(parent: &Path, into: &Path, archive_name: &str) {
    assert!(!into.exists(), "{} must not exist", into.display());
    let left: Vec<String> = names(parent)
        .into_iter()
        .filter(|n| n != archive_name)
        .collect();
    assert!(left.is_empty(), "left behind: {left:?}");
}

#[test]
fn extracts_tar_gz_with_strip_components() {
    let tmp = tempfile::tempdir().unwrap();
    let archive = tmp.path().join("node.tar.gz");
    tar_gz(
        &archive,
        &[
            dir("node-v24.21.0-linux-x64/"),
            dir("node-v24.21.0-linux-x64/bin/"),
            exe("node-v24.21.0-linux-x64/bin/node", b"#!/bin/sh\n"),
            file(
                "node-v24.21.0-linux-x64/lib/node_modules/npm/cli.js",
                b"cli",
            ),
            file("node-v24.21.0-linux-x64/./LICENSE", b"MIT"),
        ],
    );
    let into = tmp.path().join("p1b A").join("node-24.21.0");
    extract(&archive, &into, 1).unwrap();
    assert_eq!(fs::read(into.join("bin/node")).unwrap(), b"#!/bin/sh\n");
    assert_eq!(
        fs::read(into.join("lib/node_modules/npm/cli.js")).unwrap(),
        b"cli"
    );
    assert_eq!(fs::read(into.join("LICENSE")).unwrap(), b"MIT");
    assert_eq!(names(&into), ["LICENSE", "bin", "lib"]);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: std::path::PathBuf| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(into.join("bin/node")), 0o755);
        assert_eq!(mode(into.join("LICENSE")), 0o644);
    }
    assert_eq!(
        names(&tmp.path().join("p1b A")),
        ["node-24.21.0"],
        "no staging directory is left"
    );

    // Without strip the top directory is kept; `into` must not exist yet.
    let whole = tmp.path().join("whole");
    extract(&archive, &whole, 0).unwrap();
    assert!(whole.join("node-v24.21.0-linux-x64/bin/node").is_file());
    let again = extract(&archive, &whole, 0).unwrap_err();
    assert_eq!(again.reason(), "io", "{again}");
}

#[test]
fn extracts_zip() {
    let tmp = tempfile::tempdir().unwrap();
    let archive = tmp.path().join("node.zip");
    zip(
        &archive,
        &[
            ("node-v24.21.0-win-x64/", None),
            ("node-v24.21.0-win-x64/node.exe", Some(&b"MZ"[..])),
            (
                "node-v24.21.0-win-x64/node_modules/npm/cli.js",
                Some(&b"cli"[..]),
            ),
        ],
    );
    let into = tmp.path().join("node");
    extract(&archive, &into, 1).unwrap();
    assert_eq!(fs::read(into.join("node.exe")).unwrap(), b"MZ");
    assert_eq!(
        fs::read(into.join("node_modules/npm/cli.js")).unwrap(),
        b"cli"
    );
    assert_eq!(names(tmp.path()), ["node", "node.zip"]);

    let not_an_archive = tmp.path().join("x.bin");
    fs::write(&not_an_archive, b"plain text").unwrap();
    let e = extract(&not_an_archive, &tmp.path().join("y"), 0).unwrap_err();
    assert_eq!(e.reason(), "archive-unsupported", "{e}");
    assert!(!tmp.path().join("y").exists());
}

#[test]
fn refuses_parent_dir_absolute_and_drive_entries_and_writes_nothing() {
    for bad in [
        "../evil",
        "pkg/../../evil",
        "/tmp/evil-abs",
        "C:/evil",
        "C:evil",
        "pkg\\..\\..\\evil",
    ] {
        // tar.gz: a good entry first, so a partial extraction would be visible.
        let tmp = tempfile::tempdir().unwrap();
        let archive = tmp.path().join("a.tar.gz");
        tar_gz(&archive, &[file("pkg/ok.txt", b"ok"), file(bad, b"evil")]);
        let into = tmp.path().join("out");
        let e = extract(&archive, &into, 0).unwrap_err();
        assert!(matches!(e, ArchiveError::UnsafeEntry(_)), "{bad}: {e:?}");
        assert_eq!(e.reason(), "archive-unsafe-entry");
        assert_nothing_written(tmp.path(), &into, "a.tar.gz");
        assert!(!Path::new("/tmp/evil-abs").exists());

        // zip
        let tmp = tempfile::tempdir().unwrap();
        let archive = tmp.path().join("a.zip");
        zip(
            &archive,
            &[("pkg/ok.txt", Some(&b"ok"[..])), (bad, Some(&b"evil"[..]))],
        );
        let into = tmp.path().join("out");
        let e = extract(&archive, &into, 0).unwrap_err();
        assert_eq!(e.reason(), "archive-unsafe-entry", "{bad}: {e:?}");
        assert_nothing_written(tmp.path(), &into, "a.zip");
    }
}

#[cfg(unix)]
#[test]
fn keeps_an_inner_symlink_and_refuses_an_escaping_one() {
    let tmp = tempfile::tempdir().unwrap();
    let archive = tmp.path().join("node.tar.gz");
    tar_gz(
        &archive,
        &[
            symlink("pkg/bin/npm", "../lib/cli.js"),
            file("pkg/lib/cli.js", b"cli"),
        ],
    );
    let into = tmp.path().join("node");
    extract(&archive, &into, 1).unwrap();
    assert_eq!(
        fs::read_link(into.join("bin/npm")).unwrap(),
        Path::new("../lib/cli.js")
    );
    assert_eq!(fs::read(into.join("bin/npm")).unwrap(), b"cli");

    let cases: [&[E<'_>]; 5] = [
        &[symlink("pkg/bin/evil", "../../outside")],
        &[symlink("pkg/evil", "/etc/passwd")],
        // Nothing is written beneath a symlink, even one that points inside.
        &[symlink("pkg/d", "."), file("pkg/d/f", b"x")],
        // `x -> .` then `y -> x/..`: lexically inside, really the tree's parent.
        &[symlink("pkg/x", "."), symlink("pkg/y", "x/..")],
        // A symlink replacing an extracted directory.
        &[file("pkg/a/f", b"x"), symlink("pkg/a", "b")],
    ];
    for entries in cases {
        let tmp = tempfile::tempdir().unwrap();
        let archive = tmp.path().join("a.tar.gz");
        tar_gz(&archive, entries);
        let into = tmp.path().join("out");
        let e = extract(&archive, &into, 1).unwrap_err();
        assert_eq!(e.reason(), "archive-unsafe-entry", "{e:?}");
        assert_nothing_written(tmp.path(), &into, "a.tar.gz");
    }
}

#[test]
fn refuses_hardlinks_and_devices() {
    let cases: [E<'_>; 4] = [
        special("pkg/hard", tar::EntryType::Link, Some("pkg/ok.txt")),
        special("pkg/tty", tar::EntryType::Char, None),
        special("pkg/sda", tar::EntryType::Block, None),
        special("pkg/fifo", tar::EntryType::Fifo, None),
    ];
    for bad in cases {
        let tmp = tempfile::tempdir().unwrap();
        let archive = tmp.path().join("a.tar.gz");
        let name = bad.name;
        tar_gz(&archive, &[file("pkg/ok.txt", b"ok"), bad]);
        let into = tmp.path().join("out");
        let e = extract(&archive, &into, 1).unwrap_err();
        assert_eq!(e.reason(), "archive-unsafe-entry", "{name}: {e:?}");
        assert_nothing_written(tmp.path(), &into, "a.tar.gz");
    }
}

#[test]
fn verify_and_extract_checks_the_digest_before_extracting() {
    let tmp = tempfile::tempdir().unwrap();
    let archive = tmp.path().join("core.tar.gz");
    tar_gz(&archive, &[file("core/core.js", b"// core")]);
    let good = sha256_file(&archive).unwrap();
    assert_eq!(good.len(), 64);
    let into = tmp.path().join("core");

    let wrong = "0".repeat(64);
    let e = verify_and_extract(&archive, &wrong, &into, 1).unwrap_err();
    assert!(
        matches!(&e, PayloadError::DigestMismatch { expected, actual } if *expected == wrong && *actual == good),
        "{e:?}"
    );
    assert_eq!(e.reason(), "digest-mismatch");
    assert_nothing_written(tmp.path(), &into, "core.tar.gz");

    // An unsafe archive with the right digest is still refused by the extractor.
    let unsafe_archive = tmp.path().join("unsafe.tar.gz");
    tar_gz(&unsafe_archive, &[file("../x", b"x")]);
    let e = verify_and_extract(
        &unsafe_archive,
        &sha256_file(&unsafe_archive).unwrap(),
        &into,
        0,
    )
    .unwrap_err();
    assert_eq!(e.reason(), "archive-unsafe-entry");
    fs::remove_file(&unsafe_archive).unwrap();

    verify_and_extract(&archive, &good.to_uppercase(), &into, 1).unwrap();
    assert_eq!(fs::read(into.join("core.js")).unwrap(), b"// core");
}

fn file_url(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/").replace(' ', "%20");
    if s.starts_with('/') {
        format!("file://{s}")
    } else {
        format!("file:///{s}")
    }
}

#[test]
fn fetch_verified_leaves_nothing_on_a_digest_mismatch() {
    let src_dir = tempfile::tempdir().unwrap();
    let src = src_dir.path().join("node v24.tar.gz");
    fs::write(&src, b"archive bytes").unwrap();
    let good = sha256_file(&src).unwrap();
    let dl = tempfile::tempdir().unwrap();
    let dest = dl.path().join("node.tar.gz");

    let e = fetch_verified(
        &file_url(&src),
        &dest,
        &"f".repeat(64),
        MIB,
        Duration::from_secs(5),
    )
    .unwrap_err();
    assert!(
        matches!(e, FetchError::DigestMismatch { ref actual, .. } if *actual == good),
        "{e:?}"
    );
    assert_eq!(e.reason(), "digest-mismatch");
    assert!(
        names(dl.path()).is_empty(),
        "left behind: {:?}",
        names(dl.path())
    );

    // A previous good download is not touched by a failed one.
    fetch_verified(&file_url(&src), &dest, &good, MIB, Duration::from_secs(5)).unwrap();
    assert_eq!(fs::read(&dest).unwrap(), b"archive bytes");
    fs::write(&src, b"tampered").unwrap();
    assert!(fetch_verified(
        src.to_str().unwrap(),
        &dest,
        &good,
        MIB,
        Duration::from_secs(5)
    )
    .is_err());
    assert_eq!(fs::read(&dest).unwrap(), b"archive bytes");
    assert_eq!(names(dl.path()), ["node.tar.gz"]);

    let missing = fetch_verified(
        "/nonexistent/p1b/x.tar.gz",
        &dest,
        &good,
        MIB,
        Duration::from_secs(5),
    )
    .unwrap_err();
    assert_eq!(missing.reason(), "release-unreachable");
    let http = fetch_verified(
        "http://example.com/x",
        &dest,
        &good,
        MIB,
        Duration::from_secs(5),
    )
    .unwrap_err();
    assert_eq!(
        http.reason(),
        "release-unreachable",
        "plain remote http is refused: {http}"
    );
}

/// A loopback HTTP server answering every connection with `response` (then closing), on a background thread.
fn serve(response: Vec<u8>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut s) = stream else { return };
            let mut buf = [0u8; 4096];
            let _ = s.read(&mut buf);
            let _ = s.write_all(&response);
        }
    });
    format!("http://127.0.0.1:{}", addr.port())
}

#[test]
fn fetch_refuses_more_than_max_bytes() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("big.json");
    fs::write(&src, vec![b'x'; 1000]).unwrap();
    let d = Duration::from_secs(5);
    let e = fetch_bytes(src.to_str().unwrap(), 999, d).unwrap_err();
    assert_eq!(e, FetchError::TooLarge { limit: 999 });
    assert_eq!(e.reason(), "download-too-large");
    assert_eq!(
        fetch_bytes(src.to_str().unwrap(), 1000, d).unwrap().len(),
        1000
    );

    let dl = tempfile::tempdir().unwrap();
    let e = fetch_verified(
        &file_url(&src),
        &dl.path().join("big"),
        &"0".repeat(64),
        10,
        d,
    )
    .unwrap_err();
    assert_eq!(e.reason(), "download-too-large");
    assert!(names(dl.path()).is_empty());

    // Over HTTP, with no Content-Length: the cap applies while the body streams.
    let mut body = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_vec();
    body.extend(vec![b'y'; 64 * 1024]);
    let base = serve(body);
    let e = fetch_bytes(&format!("{base}/stable.json"), 1024, d).unwrap_err();
    assert_eq!(e.reason(), "download-too-large", "{e}");

    // An announced Content-Length over the cap is refused before the body is read.
    let base =
        serve(b"HTTP/1.1 200 OK\r\nContent-Length: 52428800\r\nConnection: close\r\n\r\n".to_vec());
    let e = fetch_bytes(&format!("{base}/stable.json"), MIB, d).unwrap_err();
    assert_eq!(e.reason(), "download-too-large", "{e}");

    let base =
        serve(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec());
    let e = fetch_bytes(&format!("{base}/stable.json"), MIB, d).unwrap_err();
    assert_eq!(e, FetchError::Http(404));
    assert_eq!(e.reason(), "release-unreachable");

    let base =
        serve(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".to_vec());
    assert_eq!(
        fetch_bytes(&format!("{base}/stable.json"), MIB, d).unwrap(),
        b"{}"
    );
}

#[test]
fn fetch_bytes_honours_the_deadline() {
    // Accepts every connection and never answers.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        let mut held = Vec::new();
        for s in listener.incoming() {
            held.push(s);
        }
    });
    let deadline = Duration::from_millis(600);
    let started = Instant::now();
    let e = fetch_bytes(
        &format!("http://127.0.0.1:{port}/stable.json"),
        MIB,
        deadline,
    )
    .unwrap_err();
    let took = started.elapsed();
    assert!(matches!(e, FetchError::Unreachable(_)), "{e:?}");
    assert_eq!(e.reason(), "release-unreachable");
    assert!(
        took < deadline * 3 / 2,
        "took {took:?} for a {deadline:?} deadline"
    );
    assert!(took >= deadline / 2, "gave up too early: {took:?}");
}
