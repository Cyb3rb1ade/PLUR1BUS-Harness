//! Hardening of `backup create` and `backup restore` (step 8): a backup restores to identical files, a damaged archive is
//! refused or leaves no difference, and what the archive does and does not contain. Hand-built archives and the injected
//! failure steps are in `tests/backup.rs`; this file starts from a real `create`.
//!
//! Not tested, and why: a restore that runs out of disk space. Restore extracts with plain file writes and has no writer seam
//! to inject a full disk into; the failure steps `PLUR1BUS_TEST_BACKUP_FAIL_AT` (`extract`, `swap:<i>`, `swap-after:<i>`) are
//! what proves the rollback, in `tests/backup.rs`.
use super::archive::{hash_file, hex, verify};
use super::create::{create, testkit, SnapFile};
use super::redact::PLACEHOLDER;
use super::restore::{restore, RestoreOpts, REAPPLY_MARKER};
use crate::paths::Layout;
use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::Path;

const SEED: u64 = 0x6261_636b_7570_0001;

struct Rng(u64);
impl Rng {
    fn bytes(&mut self, n: usize) -> Vec<u8> {
        (0..n)
            .map(|_| {
                self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
                let mut z = self.0;
                z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
                z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
                (z ^ (z >> 31)) as u8
            })
            .collect()
    }
}

fn put(home: &Path, rel: &str, bytes: &[u8]) {
    let p = rel.split('/').fold(home.to_path_buf(), |p, s| p.join(s));
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, bytes).unwrap();
}

/// An installation with every kind of unit `create` copies, with seeded binary content.
fn populate(home: &Path) {
    let mut rng = Rng(SEED);
    put(home, "config.json", b"{\"schemaVersion\":1}\n");
    put(home, "agents/bernd/persona.md", b"persona of bernd\n");
    put(home, "agents/bernd/workspace/data.bin", &rng.bytes(20_000));
    put(
        home,
        "agents/anna/persona.md",
        "Persona von Änna ✓\n".as_bytes(),
    );
    put(
        home,
        "skills/triage/SKILL.md",
        b"---\nname: triage\n---\nTriage.\n",
    );
    put(home, "modules/m/module.json", b"{\"name\":\"m\"}");
    put(home, "extensions/state.json", b"{\"items\":{}}");
    put(home, "catalog/models.json", b"{\"models\":[]}");
    put(home, "state/journal/bernd.jsonl", b"{\"v\":1}\n{\"v\":2}\n");
    put(home, "state/system-jobs/j.json", &rng.bytes(300));
}

/// Every file below `root` with its SHA-256, by relative path, skipping what a restore adds around the data (`backups/`,
/// `.restore-*`, `state/backup-staging`, and the re-apply marker, whose body carries the time of the restore).
fn hashes(root: &Path) -> BTreeMap<String, String> {
    fn go(base: &Path, dir: &Path, out: &mut BTreeMap<String, String>) {
        for e in fs::read_dir(dir).unwrap() {
            let e = e.unwrap();
            let rel = e
                .path()
                .strip_prefix(base)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            if rel == "backups"
                || rel.starts_with(".restore-")
                || rel.starts_with("state/backup-staging")
                || rel == REAPPLY_MARKER
            {
                continue;
            }
            let ft = e.file_type().unwrap();
            if ft.is_dir() {
                go(base, &e.path(), out);
            } else if ft.is_file() {
                out.insert(rel, hex(&Sha256::digest(fs::read(e.path()).unwrap())));
            }
        }
    }
    let mut m = BTreeMap::new();
    go(root, root, &mut m);
    m
}

fn opts() -> RestoreOpts {
    RestoreOpts {
        dry_run: false,
        fail_at: None,
    }
}

/// A backup of `populate`d home `a` into `<d>/b.tar.gz`, and the snapshot files the core would have staged.
fn backup_of_populated_home(d: &Path) -> (Layout, std::path::PathBuf) {
    let layout = Layout::new(d.join("a"));
    fs::create_dir_all(&layout.home).unwrap();
    populate(&layout.home);
    let snap = testkit::staged(&layout, b"database bytes", false);
    let out = d.join("b.tar.gz");
    create(&layout, &out, &snap).expect("create");
    (layout, out)
}

// ---------------------------------------------------------------------------------------------------------------------
// the round trip
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn a_backup_restores_to_identical_files_in_a_fresh_home() {
    let d = tempfile::tempdir().unwrap();
    let (a, archive) = backup_of_populated_home(d.path());
    let b = Layout::new(d.path().join("fresh"));
    fs::create_dir_all(&b.home).unwrap();
    let manifest = verify(&archive).unwrap();
    let report = restore(&b, &archive, &opts()).expect("restore into a fresh home");
    assert!(report.applied);
    // Every file the manifest lists, at its live path, with the manifest's hash.
    let restored = hashes(&b.home);
    let original = hashes(&a.home);
    let mut checked = 0;
    for f in &manifest.files {
        // The unit this archive path belongs to says where it lives: its `archive` prefix becomes its `target`.
        let live = manifest
            .units
            .iter()
            .find_map(|u| {
                if f.path == u.archive {
                    Some(u.target.clone())
                } else {
                    f.path
                        .strip_prefix(&format!("{}/", u.archive))
                        .map(|rest| format!("{}/{rest}", u.target))
                }
            })
            .unwrap_or_else(|| panic!("{} belongs to no unit", f.path));
        let got = restored
            .get(&live)
            .unwrap_or_else(|| panic!("{live} is not restored"));
        assert_eq!(
            *got, f.sha256,
            "{live}: the restored bytes are not the archived bytes"
        );
        checked += 1;
    }
    assert!(checked >= 12, "{checked} files");
    // And the plain units equal the source home's files, hash for hash.
    for (path, hash) in &original {
        if path.starts_with("state/backup-staging") {
            continue;
        }
        assert_eq!(
            restored.get(path),
            Some(hash),
            "{path} differs after the round trip"
        );
    }
    // Nothing was restored that the source did not have.
    let extra: Vec<&String> = restored
        .keys()
        .filter(|k| {
            !original.contains_key(*k)
                && !k.starts_with("state/lancedb/")
                && !k.starts_with("state/budget")
        })
        .collect();
    assert!(extra.is_empty(), "{extra:?}");
}

#[test]
fn restoring_twice_gives_the_same_files_and_keeps_the_first_state_aside() {
    let d = tempfile::tempdir().unwrap();
    let (_, archive) = backup_of_populated_home(d.path());
    let b = Layout::new(d.path().join("fresh"));
    fs::create_dir_all(&b.home).unwrap();
    restore(&b, &archive, &opts()).unwrap();
    let once = hashes(&b.home);
    let second = restore(&b, &archive, &opts()).unwrap();
    assert_eq!(
        hashes(&b.home),
        once,
        "a second restore of the same archive changes nothing"
    );
    let pre = second.pre_restore.expect("the replaced state is kept");
    assert!(Path::new(&pre).exists(), "{pre}");
}

// ---------------------------------------------------------------------------------------------------------------------
// a damaged archive
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn an_archive_cut_off_at_any_byte_is_refused_by_verify_and_by_restore_and_nothing_changes() {
    let d = tempfile::tempdir().unwrap();
    let (_, archive) = backup_of_populated_home(d.path());
    let bytes = fs::read(&archive).unwrap();
    let live = Layout::new(d.path().join("live"));
    fs::create_dir_all(&live.home).unwrap();
    put(&live.home, "config.json", b"{\"old\":true}");
    let before = hashes(&live.home);
    let cut_file = d.path().join("cut.tar.gz");
    // Every offset of the first and last kilobyte, and every 97th byte in between: each prefix is refused.
    let mut offsets: Vec<usize> = (0..bytes.len().min(1024)).collect();
    offsets.extend((bytes.len().saturating_sub(1024)..bytes.len()).filter(|o| *o >= 1024));
    offsets.extend((1024..bytes.len().saturating_sub(1024)).step_by(97));
    for cut in offsets {
        fs::write(&cut_file, &bytes[..cut]).unwrap();
        match verify(&cut_file) {
            Ok(_) => panic!("a prefix of {cut} of {} bytes was accepted", bytes.len()),
            Err(e) => assert!(
                [
                    "truncated",
                    "archive-corrupt",
                    "manifest-invalid",
                    "missing-entry"
                ]
                .contains(&e.reason),
                "{cut}: {} {}",
                e.reason,
                e.detail
            ),
        }
    }
    // One representative through restore: refused and the live home is untouched.
    fs::write(&cut_file, &bytes[..bytes.len() / 2]).unwrap();
    assert!(restore(&live, &cut_file, &opts()).is_err());
    assert_eq!(hashes(&live.home), before);
    assert!(
        !live.home.join("backups").exists(),
        "nothing is set aside for a refused archive"
    );
}

#[test]
fn a_single_changed_byte_anywhere_is_refused_or_changes_nothing_that_a_restore_writes() {
    let d = tempfile::tempdir().unwrap();
    let (_, archive) = backup_of_populated_home(d.path());
    let bytes = fs::read(&archive).unwrap();
    // What restoring the untouched archive gives.
    let reference = Layout::new(d.path().join("reference"));
    fs::create_dir_all(&reference.home).unwrap();
    restore(&reference, &archive, &opts()).unwrap();
    let want = hashes(&reference.home);
    let (mut refused, mut harmless) = (0, 0);
    let mutated = d.path().join("m.tar.gz");
    // Every byte of the first 3 KiB (gzip header, tar headers, the manifest) and of the last 64, and every 53rd in between.
    let head = bytes.len().min(3072);
    let tail = bytes.len().saturating_sub(64).max(head);
    let positions: Vec<usize> = (0..head)
        .chain((head..tail).step_by(53))
        .chain(tail..bytes.len())
        .collect();
    for at in positions.iter().copied() {
        let mut b = bytes.clone();
        b[at] ^= 0x01;
        fs::write(&mutated, &b).unwrap();
        let Ok(_) = verify(&mutated) else {
            refused += 1;
            continue;
        };
        // Accepted (a byte the format ignores, such as a gzip time stamp or a tar field nobody reads): then it must restore the
        // very same files.
        let home = Layout::new(d.path().join(format!("m{at}")));
        fs::create_dir_all(&home.home).unwrap();
        restore(&home, &mutated, &opts()).unwrap_or_else(|e| {
            panic!(
                "byte {at}: verified but not restorable: {} {}",
                e.reason, e.detail
            )
        });
        assert_eq!(
            hashes(&home.home),
            want,
            "byte {at} changed what a restore writes and verify did not notice"
        );
        harmless += 1;
        fs::remove_dir_all(&home.home).unwrap();
    }
    assert!(
        refused > positions.len() / 2,
        "{refused} of {} refused",
        positions.len()
    );
    assert!(
        harmless < 400,
        "{harmless} ignored bytes: the format has slack"
    );
}

#[test]
fn bit_flips_in_the_manifest_hashes_are_refused_as_checksum_mismatches() {
    // Rebuild the archive with each file's recorded hash altered in turn: verify names the mismatch.
    let d = tempfile::tempdir().unwrap();
    let (_, archive) = backup_of_populated_home(d.path());
    let manifest = verify(&archive).unwrap();
    let gz = GzDecoder::new(fs::File::open(&archive).unwrap());
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    for e in tar::Archive::new(gz).entries().unwrap() {
        let mut e = e.unwrap();
        let name = e.path().unwrap().to_string_lossy().into_owned();
        let mut buf = Vec::new();
        e.read_to_end(&mut buf).unwrap();
        entries.push((name, buf));
    }
    assert!(entries.len() > manifest.files.len());
    for i in 0..manifest.files.len() {
        let mut doc: serde_json::Value = serde_json::from_slice(&entries[0].1).unwrap();
        let h = doc["files"][i]["sha256"].as_str().unwrap().to_string();
        let mut chars: Vec<char> = h.chars().collect();
        chars[0] = if chars[0] == '0' { '1' } else { '0' };
        doc["files"][i]["sha256"] = serde_json::json!(chars.into_iter().collect::<String>());
        let out = d.path().join(format!("flip{i}.tar.gz"));
        write_tar(
            &out,
            std::iter::once((
                "manifest.json".to_string(),
                serde_json::to_vec(&doc).unwrap(),
            ))
            .chain(entries[1..].iter().cloned()),
        );
        let e = verify(&out).expect_err("a changed hash must not verify");
        assert_eq!(
            e.reason, "checksum-mismatch",
            "file {i}: {} {}",
            e.reason, e.detail
        );
    }
}

fn write_tar(path: &Path, entries: impl Iterator<Item = (String, Vec<u8>)>) {
    let mut t = tar::Builder::new(flate2::write::GzEncoder::new(
        fs::File::create(path).unwrap(),
        flate2::Compression::default(),
    ));
    for (n, b) in entries {
        let mut h = tar::Header::new_gnu();
        h.as_gnu_mut().unwrap().name[..n.len()].copy_from_slice(n.as_bytes());
        h.set_size(b.len() as u64);
        h.set_mode(0o600);
        h.set_entry_type(tar::EntryType::Regular);
        h.set_cksum();
        t.append(&h, b.as_slice()).unwrap();
    }
    t.into_inner().unwrap().finish().unwrap();
}

// ---------------------------------------------------------------------------------------------------------------------
// secrets
// ---------------------------------------------------------------------------------------------------------------------

fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for c in bytes.chunks(3) {
        let n = (u32::from(c[0]) << 16)
            | (u32::from(*c.get(1).unwrap_or(&0)) << 8)
            | u32::from(*c.get(2).unwrap_or(&0));
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 {
            T[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if c.len() > 2 {
            T[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// Every entry name and every entry's bytes of the archive, decompressed: what anybody who opens the file can read.
fn everything_in(archive: &Path) -> (Vec<String>, Vec<u8>) {
    let gz = GzDecoder::new(fs::File::open(archive).unwrap());
    let (mut names, mut all) = (Vec::new(), Vec::new());
    for e in tar::Archive::new(gz).entries().unwrap() {
        let mut e = e.unwrap();
        names.push(e.path().unwrap().to_string_lossy().into_owned());
        e.read_to_end(&mut all).unwrap();
    }
    (names, all)
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && hay.windows(needle.len()).any(|w| w == needle)
}

/// Markers, not token-shaped literals. Each is looked for as text, as base64 (three alignments) and as hex.
fn found_forms(names: &[String], bytes: &[u8], marker: &str) -> Vec<&'static str> {
    let mut found = Vec::new();
    let mut hay = bytes.to_vec();
    hay.extend(names.join("\n").into_bytes());
    if contains(&hay, marker.as_bytes()) {
        found.push("plain");
    }
    for pad in 0..3 {
        let shifted = format!("{}{marker}", "x".repeat(pad));
        let b64 = base64(shifted.as_bytes());
        // The part of the encoding that does not depend on the bytes before the marker.
        let core = &b64[pad.div_ceil(3) * 4..];
        let core = core.trim_end_matches('=');
        if core.len() >= 8 && contains(&hay, &core.as_bytes()[..core.len().saturating_sub(2)]) {
            found.push("base64");
            break;
        }
    }
    if contains(&hay, hex(marker.as_bytes()).as_bytes()) {
        found.push("hex");
    }
    found
}

const RUN_MARKER: &str = "redact-probe-run-token";
const LOG_MARKER: &str = "redact-probe-log-line";
const FALLBACK_MARKER: &str = "redact-probe-secret-store";
const KEY_MARKER: &str = "redact-probe-store-key";
const CONFIG_MARKER: &str = "redact-probe-webhook-secret";

fn home_with_secrets(d: &Path) -> std::path::PathBuf {
    let layout = Layout::new(d.join("a"));
    fs::create_dir_all(&layout.home).unwrap();
    populate(&layout.home);
    put(&layout.home, "run/core.token", RUN_MARKER.as_bytes());
    put(&layout.home, "run/supervisor.token", RUN_MARKER.as_bytes());
    put(&layout.home, "logs/supervisor.log", LOG_MARKER.as_bytes());
    put(
        &layout.home,
        "state/secrets/store.json",
        FALLBACK_MARKER.as_bytes(),
    );
    put(
        &layout.home,
        "state/secrets/store.key",
        KEY_MARKER.as_bytes(),
    );
    put(&layout.home, "runtime/node-24/note", b"runtime");
    put(&layout.home, "models/m.bin", b"model");
    put(
        &layout.home,
        "config.json",
        format!("{{\"schemaVersion\":1,\"channels\":{{\"telegram\":{{\"webhook\":{{\"secret\":\"{CONFIG_MARKER}\"}}}}}}}}\n").as_bytes(),
    );
    let snap = testkit::staged(&layout, b"database bytes", false);
    let out = d.join("secrets.tar.gz");
    create(&layout, &out, &snap).expect("create");
    out
}

#[test]
fn nothing_from_run_logs_the_secret_store_runtime_or_models_is_in_the_archive_in_any_form() {
    let d = tempfile::tempdir().unwrap();
    let archive = home_with_secrets(d.path());
    let (names, bytes) = everything_in(&archive);
    for marker in [RUN_MARKER, LOG_MARKER, FALLBACK_MARKER, KEY_MARKER] {
        let forms = found_forms(&names, &bytes, marker);
        assert!(forms.is_empty(), "{marker} is in the archive as {forms:?}");
    }
    for n in &names {
        for banned in [
            "run/",
            "logs/",
            "runtime/",
            "models/",
            "secrets",
            "store.key",
            "core.token",
            ".restore-",
            "backups/",
        ] {
            assert!(!n.contains(banned), "the entry {n:?} is under {banned}");
        }
    }
    // The manifest says so, and what it says is what the entries show.
    let m = verify(&archive).unwrap();
    assert!(!m.secrets.included);
    assert!(
        m.secrets.note.contains("run/ is never archived")
            && m.secrets
                .note
                .contains("encrypted fallback file is not included")
    );
}

#[test]
fn the_search_forms_find_a_marker_that_is_there() {
    // A positive control for the tests above: the same search must find a marker that IS in the bytes, plain, and a hex and a
    // base64 copy. (It used to use the webhook marker in the archive itself, which was the leak; the archive no longer has it,
    // so the plain copy is appended here like the other two.)
    let d = tempfile::tempdir().unwrap();
    let archive = home_with_secrets(d.path());
    let (names, bytes) = everything_in(&archive);
    assert!(
        found_forms(&names, &bytes, CONFIG_MARKER).is_empty(),
        "the archive must not carry the webhook marker"
    );
    let mut more = bytes.clone();
    more.extend(CONFIG_MARKER.as_bytes());
    assert_eq!(found_forms(&names, &more, CONFIG_MARKER), ["plain"]);
    more.extend(hex(b"redact-probe-hex-copy").as_bytes());
    more.extend(base64(b"redact-probe-b64-copy").as_bytes());
    assert!(found_forms(&names, &more, "redact-probe-hex-copy").contains(&"hex"));
    assert!(found_forms(&names, &more, "redact-probe-b64-copy").contains(&"base64"));
    assert!(
        found_forms(
            &["data/x-redact-probe-name".to_string()],
            b"",
            "redact-probe-name"
        )
        .contains(&"plain"),
        "a marker in an entry name counts"
    );
}

/// SICHERHEIT. The manifest says no secret-store values are part of the archive, and `run/`, the encrypted fallback file and
/// `logs/` are indeed never archived. `config.json` is copied, and `channels.telegram.webhook.secret` is a secret VALUE that
/// lives there (the config schema describes it as the secret token the webhook header carries): `create` replaces it by a
/// placeholder in its staged copy (`redact.rs`), so whoever opens the archive does not read it.
#[test]
fn a_secret_value_kept_in_config_json_is_not_in_the_archive() {
    let d = tempfile::tempdir().unwrap();
    let archive = home_with_secrets(d.path());
    let (names, bytes) = everything_in(&archive);
    let forms = found_forms(&names, &bytes, CONFIG_MARKER);
    assert!(
        forms.is_empty(),
        "the webhook secret is in the archive as {forms:?}"
    );
}

/// The archived `config.json` entry itself.
fn archived_config(archive: &Path) -> String {
    let gz = GzDecoder::new(fs::File::open(archive).unwrap());
    for e in tar::Archive::new(gz).entries().unwrap() {
        let mut e = e.unwrap();
        if e.path().unwrap().to_string_lossy() == "data/config.json" {
            let mut text = String::new();
            e.read_to_string(&mut text).unwrap();
            return text;
        }
    }
    panic!("no data/config.json in the archive");
}

#[test]
fn the_webhook_secret_is_replaced_in_the_archive_and_left_alone_in_the_live_config() {
    let d = tempfile::tempdir().unwrap();
    let archive = home_with_secrets(d.path());
    let archived: serde_json::Value = serde_json::from_str(&archived_config(&archive)).unwrap();
    assert_eq!(
        archived["channels"]["telegram"]["webhook"]["secret"], PLACEHOLDER,
        "the value is replaced, not dropped: the rest of the config keeps its shape"
    );
    assert_eq!(archived["schemaVersion"], 1);
    // The live file is the owner's and is never rewritten.
    let live = fs::read_to_string(d.path().join("a/config.json")).unwrap();
    assert!(live.contains(CONFIG_MARKER), "{live}");
    // The manifest describes the redacted bytes (verify checks every digest).
    verify(&archive).unwrap();
}

#[test]
fn a_config_without_a_secret_value_is_archived_byte_for_byte() {
    let d = tempfile::tempdir().unwrap();
    let (_, archive) = backup_of_populated_home(d.path());
    assert_eq!(archived_config(&archive), "{\"schemaVersion\":1}\n");
}

#[test]
fn a_config_that_is_not_json_makes_create_fail_closed_and_writes_no_archive() {
    let d = tempfile::tempdir().unwrap();
    let layout = Layout::new(d.path().join("a"));
    fs::create_dir_all(&layout.home).unwrap();
    populate(&layout.home);
    put(&layout.home, "config.json", CONFIG_MARKER.as_bytes());
    let snap = testkit::staged(&layout, b"database bytes", false);
    let out = d.path().join("never.tar.gz");
    let e = match create(&layout, &out, &snap) {
        Err(e) => e,
        Ok(_) => panic!("an unreadable config must not be archived unchecked"),
    };
    assert_eq!(e.reason, "config-unreadable");
    assert!(!e.detail.contains(CONFIG_MARKER), "{}", e.detail);
    assert!(!out.exists());
}

#[test]
fn a_restore_gives_the_webhook_a_fresh_valid_secret_instead_of_the_placeholder() {
    let d = tempfile::tempdir().unwrap();
    let archive = home_with_secrets(d.path());
    let mut secrets = Vec::new();
    for name in ["fresh-1", "fresh-2"] {
        let b = Layout::new(d.path().join(name));
        fs::create_dir_all(&b.home).unwrap();
        restore(&b, &archive, &opts()).expect("restore");
        let text = fs::read_to_string(b.home.join("config.json")).unwrap();
        assert!(
            !text.contains(CONFIG_MARKER) && !text.contains(PLACEHOLDER),
            "{text}"
        );
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        let secret = v["channels"]["telegram"]["webhook"]["secret"]
            .as_str()
            .unwrap()
            .to_string();
        // Matches the schema's pattern for the property (^[A-Za-z0-9_-]{1,256}$).
        assert!(
            secret.len() == 64 && secret.bytes().all(|c| c.is_ascii_hexdigit()),
            "{secret}"
        );
        assert_eq!(v["schemaVersion"], 1);
        secrets.push(secret);
    }
    assert_ne!(secrets[0], secrets[1], "each restore draws its own secret");
}

// ---------------------------------------------------------------------------------------------------------------------
// the account database
// ---------------------------------------------------------------------------------------------------------------------

/// `state/api/accounts.db` is staged by the core like every database under `state/`, and docs/portable-backup.md restores the API
/// accounts from it. It holds password hashes and TOTP seeds, so the manifest must not claim there are no secrets in the archive.
/// (OWNER QUESTION: whether the seeds should stay in the ordinary archive at all; until that is decided this pins what is true.)
#[test]
fn the_account_database_is_archived_and_the_manifest_says_what_is_in_it() {
    let d = tempfile::tempdir().unwrap();
    let layout = Layout::new(d.path().join("a"));
    fs::create_dir_all(&layout.home).unwrap();
    populate(&layout.home);
    let mut snap = testkit::staged(&layout, b"database bytes", false);
    let db = snap.dir.join("sqlite/api/accounts.db");
    fs::create_dir_all(db.parent().unwrap()).unwrap();
    fs::write(&db, b"accounts bytes").unwrap();
    let (sha256, bytes) = hash_file(&db).unwrap();
    snap.files.push(SnapFile {
        path: "sqlite/api/accounts.db".into(),
        bytes,
        sha256,
    });
    let out = d.path().join("accounts.tar.gz");
    create(&layout, &out, &snap).expect("create");
    let m = verify(&out).unwrap();
    assert!(
        m.units.iter().any(|u| u.target == "state/api/accounts.db"),
        "{:?}",
        m.units.iter().map(|u| &u.target).collect::<Vec<_>>()
    );
    assert!(!m.secrets.included, "the secret store itself is not in it");
    for phrase in [
        "state/api/accounts.db",
        "password hashes",
        "TOTP seeds",
        "neither signed nor encrypted",
        "run/ is never archived",
        "encrypted fallback file is not included",
    ] {
        assert!(
            m.secrets.note.contains(phrase),
            "the note does not say {phrase:?}: {}",
            m.secrets.note
        );
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// permission bits
// ---------------------------------------------------------------------------------------------------------------------

#[cfg(unix)]
#[test]
fn an_executable_skill_script_stays_executable_through_backup_and_restore() {
    use std::os::unix::fs::PermissionsExt;
    let d = tempfile::tempdir().unwrap();
    let layout = Layout::new(d.path().join("a"));
    fs::create_dir_all(&layout.home).unwrap();
    populate(&layout.home);
    put(
        &layout.home,
        "skills/triage/scripts/run.sh",
        b"#!/bin/sh\necho ok\n",
    );
    put(&layout.home, "skills/triage/notes.md", b"notes\n");
    put(&layout.home, "skills/triage/open.txt", b"open\n");
    for (rel, mode) in [
        ("skills/triage/scripts/run.sh", 0o755),
        ("skills/triage/notes.md", 0o644),
        ("skills/triage/open.txt", 0o666),
    ] {
        fs::set_permissions(layout.home.join(rel), fs::Permissions::from_mode(mode)).unwrap();
    }
    let snap = testkit::staged(&layout, b"database bytes", false);
    let out = d.path().join("m.tar.gz");
    create(&layout, &out, &snap).expect("create");
    // The manifest records the bits the SOURCE had, not those of a private staging copy.
    let m = verify(&out).unwrap();
    let recorded = |p: &str| {
        m.files
            .iter()
            .find(|f| f.path == p)
            .unwrap_or_else(|| panic!("{p} is not in the manifest"))
            .mode
    };
    assert_eq!(recorded("skills/triage/scripts/run.sh"), Some(0o755));
    assert_eq!(recorded("skills/triage/notes.md"), Some(0o644));
    assert_eq!(recorded("skills/triage/open.txt"), Some(0o666));
    // A restore keeps the owner's bits and never widens: the script runs for its owner, nothing is group or world accessible.
    let fresh = Layout::new(d.path().join("fresh"));
    fs::create_dir_all(&fresh.home).unwrap();
    restore(&fresh, &out, &opts()).expect("restore");
    let got = |rel: &str| {
        fs::metadata(fresh.home.join(rel))
            .unwrap()
            .permissions()
            .mode()
            & 0o777
    };
    assert_eq!(got("skills/triage/scripts/run.sh"), 0o700);
    assert_eq!(got("skills/triage/notes.md"), 0o600);
    assert_eq!(got("skills/triage/open.txt"), 0o600);
    assert_eq!(got("skills/triage/SKILL.md"), 0o600);
}
