#![allow(
    clippy::unwrap_used,
    reason = "explicit native browser acceptance test"
)]

use plur1bus_documents::{
    browser::Chromium,
    chromium::{Control, Error},
    render::{assemble_html, FontDirectory},
    templates::{Document, Kit, Meta, Template},
};
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

#[test]
#[ignore = "requires PLUR1BUS_CHROMIUM_BIN, the native acceptance runner supplies it"]
fn renders_pdf_png_and_closes_a_private_chromium_profile() {
    let binary = PathBuf::from(std::env::var_os("PLUR1BUS_CHROMIUM_BIN").unwrap());
    let work = tempfile::tempdir().unwrap();
    let browser = Chromium::new(&binary, work.path());
    let document = Document {
        title: "Synthetic PDF fixture",
        subtitle: "Native Chromium",
        markdown: "## First page\n\nA short paragraph with **emphasis** and Unicode.",
        meta: Meta::default(),
        kit: Kit::default(),
    };
    let fonts = FontDirectory::new(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/documents/assets/fonts"),
    );
    let html = assemble_html(Template::Report, &document, &fonts).unwrap();
    let control = || Control {
        deadline: Instant::now() + Duration::from_secs(30),
        cancelled: &|| false,
    };
    let pdf = browser.print_pdf(&html, control()).unwrap();
    assert!(pdf.starts_with(b"%PDF-"));
    let contains = |word: &[u8]| pdf.windows(word.len()).any(|part| part == word);
    assert!(
        contains(b"Inter") && contains(b"%%EOF") && pdf.len() > 1000,
        "PDF length {}, embedded face {}, font descriptor {}",
        pdf.len(),
        contains(b"Inter"),
        contains(b"/FontFile")
    );
    let png = browser.screenshot_full(&html, control()).unwrap();
    assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));
    let recorded: serde_json::Value = serde_json::from_str(include_str!(
        "../../../fixtures/parity/documents/checks.json"
    ))
    .unwrap();
    let layout = browser
        .layout_check(recorded["input"]["layoutHtml"].as_str().unwrap(), control())
        .unwrap();
    assert!(layout.is_array());
    assert_eq!(std::fs::read_dir(work.path()).unwrap().count(), 0);
    assert_eq!(
        browser.print_pdf(
            &html,
            Control {
                cancelled: &|| true,
                ..control()
            }
        ),
        Err(Error::Cancelled)
    );
    assert_eq!(std::fs::read_dir(work.path()).unwrap().count(), 0);
}

#[test]
#[ignore = "requires PLUR1BUS_CHROMIUM_BIN and the frozen workspace install"]
fn renders_with_the_shipped_paged_js_asset() {
    let binary = PathBuf::from(std::env::var_os("PLUR1BUS_CHROMIUM_BIN").unwrap());
    let asset = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/documents/node_modules/pagedjs/dist/paged.polyfill.js");
    let work = tempfile::tempdir().unwrap();
    let browser = Chromium::new(&binary, work.path()).with_paged_js(&asset);
    let pdf = browser.print_pdf("<!doctype html><style>@page { size: A4 }</style><p>First page</p><p style=\"break-before:page\">Second page</p>", Control {
        deadline: Instant::now() + Duration::from_secs(30),
        cancelled: &|| false,
    }).unwrap();
    assert!(pdf.starts_with(b"%PDF-"));
    assert_eq!(std::fs::read_dir(work.path()).unwrap().count(), 0);
}

#[test]
fn oversized_render_is_rejected_before_starting_chromium() {
    let work = tempfile::tempdir().unwrap();
    let missing = work.path().join("missing-chromium");
    let browser = Chromium::new(&missing, work.path());
    let html = " ".repeat(20 * 1024 * 1024 + 1);
    assert_eq!(
        browser
            .render(
                &html,
                Control {
                    deadline: Instant::now() + Duration::from_secs(2),
                    cancelled: &|| false,
                }
            )
            .err(),
        Some(Error::TooLarge)
    );
    assert_eq!(std::fs::read_dir(work.path()).unwrap().count(), 0);
}

#[cfg(windows)]
#[test]
#[ignore = "requires PLUR1BUS_CHROMIUM_BIN, the native acceptance runner supplies it"]
fn cancelling_after_windows_chromium_starts_removes_the_private_profile() {
    let binary = PathBuf::from(std::env::var_os("PLUR1BUS_CHROMIUM_BIN").unwrap());
    let work = tempfile::tempdir().unwrap();
    let chromium_started = || {
        std::fs::read_dir(work.path())
            .unwrap()
            .flatten()
            .any(|entry| entry.path().join("profile").is_dir())
    };
    let result = Chromium::new(&binary, work.path()).print_pdf(
        "<p>Cancel this document.</p>",
        Control {
            deadline: Instant::now() + Duration::from_secs(30),
            cancelled: &chromium_started,
        },
    );
    assert_eq!(result, Err(Error::Cancelled));
    assert_eq!(std::fs::read_dir(work.path()).unwrap().count(), 0);
}

#[cfg(unix)]
#[test]
fn cancelling_a_live_render_terminates_its_process_and_discards_the_private_home() {
    use std::os::unix::fs::PermissionsExt;
    use std::{fs, process::Command};
    let work = tempfile::tempdir().unwrap();
    let root = work.path().join("private");
    fs::create_dir(&root).unwrap();
    let binary = work.path().join("renderer");
    fs::write(
        &binary,
        r#"#!/bin/sh
set -eu
record="${0%/*}/started"
printf '%s\n' "$$" "$HOME" "$TMPDIR" "$@" > "$record.tmp"
/bin/mv "$record.tmp" "$record"
exec /bin/sleep 4
"#,
    )
    .unwrap();
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
    let started = work.path().join("started");
    let invalid_asset = Chromium::new(&binary, &root).with_paged_js(Path::new("relative.js"));
    assert_eq!(
        invalid_asset.print_pdf(
            "<p>Document</p>",
            Control {
                deadline: Instant::now() + Duration::from_secs(2),
                cancelled: &|| false,
            }
        ),
        Err(Error::BrowserUnavailable)
    );
    assert!(!started.exists());
    let now = Instant::now();
    let result = Chromium::new(&binary, &root).render(
        "<p>Document</p>",
        Control {
            deadline: now + Duration::from_secs(5),
            cancelled: &|| started.exists(),
        },
    );
    assert_eq!(result.err(), Some(Error::Cancelled));
    assert!(now.elapsed() < Duration::from_secs(3));
    let record = fs::read_to_string(started).unwrap();
    let mut lines = record.lines();
    let pid = lines.next().unwrap();
    let home = Path::new(lines.next().unwrap());
    assert_eq!(home.parent(), Some(root.canonicalize().unwrap().as_path()));
    assert_eq!(Some(home), lines.next().map(Path::new));
    let args: Vec<_> = lines.collect();
    assert!(args.contains(&"--host-resolver-rules=MAP * ~NOTFOUND"));
    for (flag, directory) in [
        ("--user-data-dir=", "profile"),
        ("--crash-dumps-dir=", "crashes"),
    ] {
        assert!(args.iter().any(
            |arg| arg.strip_prefix(flag).map(Path::new) == Some(home.join(directory).as_path())
        ));
    }
    assert!(!Command::new("/bin/kill")
        .args(["-0", pid])
        .output()
        .unwrap()
        .status
        .success());
    assert_eq!(fs::read_dir(root).unwrap().count(), 0);
}

#[cfg(target_os = "macos")]
#[test]
#[ignore = "requires an idle Google Chrome installation on the macOS acceptance host"]
fn native_render_leaves_user_temp_and_crashpad_untouched() {
    use std::{collections::BTreeMap, fs, process::Command, time::SystemTime};
    type Snapshot = BTreeMap<PathBuf, (u64, SystemTime)>;
    fn record(path: PathBuf, entries: &mut Snapshot) {
        let metadata = fs::symlink_metadata(&path).unwrap();
        entries.insert(path.clone(), (metadata.len(), metadata.modified().unwrap()));
        if metadata.is_dir() {
            for child in fs::read_dir(path).unwrap() {
                record(child.unwrap().path(), entries);
            }
        }
    }

    let binary = PathBuf::from(std::env::var_os("PLUR1BUS_CHROMIUM_BIN").unwrap());
    let temp = Command::new("/usr/bin/getconf")
        .arg("DARWIN_USER_TEMP_DIR")
        .output()
        .unwrap();
    assert!(temp.status.success());
    let temp = PathBuf::from(String::from_utf8(temp.stdout).unwrap().trim());
    let crashpad = PathBuf::from(std::env::var_os("HOME").unwrap())
        .join("Library/Application Support/Google/Chrome/Crashpad");
    let snapshot = || {
        let mut entries = Snapshot::new();
        for entry in fs::read_dir(&temp).unwrap() {
            let entry = entry.unwrap();
            if entry
                .file_name()
                .to_string_lossy()
                .starts_with("com.google.Chrome.")
            {
                record(entry.path(), &mut entries);
            }
        }
        if crashpad.try_exists().unwrap() {
            record(crashpad.clone(), &mut entries);
        }
        entries
    };
    let work = tempfile::tempdir().unwrap();
    let before = snapshot();
    let pdf = Chromium::new(&binary, work.path())
        .print_pdf(
            "<p>Private render</p>",
            Control {
                deadline: Instant::now() + Duration::from_secs(30),
                cancelled: &|| false,
            },
        )
        .unwrap();
    assert!(pdf.starts_with(b"%PDF-"));
    let after = snapshot();
    // Report only the number of differences, never the user's crash-report paths.
    assert_eq!(before.len(), after.len());
    assert_eq!(
        before
            .iter()
            .filter(|(key, value)| after.get(*key) != Some(*value))
            .count(),
        0
    );
    assert_eq!(fs::read_dir(work.path()).unwrap().count(), 0);
}

#[test]
#[ignore = "requires PLUR1BUS_CHROMIUM_BIN on the native acceptance host"]
fn native_render_keeps_a_linked_image_off_the_network() {
    let binary = PathBuf::from(std::env::var_os("PLUR1BUS_CHROMIUM_BIN").unwrap());
    let work = tempfile::tempdir().unwrap();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let html = format!(
        "<p>Local report</p><img src='http://{}/logo.png'>",
        listener.local_addr().unwrap()
    );
    let output = Chromium::new(&binary, work.path())
        .render(
            &html,
            Control {
                deadline: Instant::now() + Duration::from_secs(30),
                cancelled: &|| false,
            },
        )
        .unwrap();
    assert!(output.pdf.starts_with(b"%PDF-"));
    assert!(output.screenshot.starts_with(b"\x89PNG"));
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    assert_eq!(std::fs::read_dir(work.path()).unwrap().count(), 0);
}
