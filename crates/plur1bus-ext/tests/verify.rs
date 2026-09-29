//! Trust tiers and the ordered inspect pipeline (spec 2026-09-27 §8.1–§8.4; acceptance 2; X1-R3, R4, R6, R7, R10,
//! R14). Every key is generated in memory per test (`testkit`) and reaches the store only through the
//! `PLUR1BUS_TEST_EXT_PUBKEYS` parser.
use plur1bus_ext::compat::HostFacts;
use plur1bus_ext::manifest::parse_manifest;
use plur1bus_ext::normalise::MAX_SKILL_BYTES;
use plur1bus_ext::pack::PayloadFile;
use plur1bus_ext::refusal::{reason, Refusal};
use plur1bus_ext::testkit::{
    assemble, build_package_from, filled_manifest, legacy_signature, sign_manifest, sign_p1x,
    tamper, test_key, Tamper, TestKey,
};
use plur1bus_ext::trust::{trusted_comment, Tier, TrustStore, PINNED_KEYS};
use plur1bus_ext::verify::{
    first_line, inspect_file, inspect_reader, Inspection, Policy, ScriptInfo, Status,
};
use plur1bus_ext::zipaudit::Limits;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::Cursor;

// ---- helpers ------------------------------------------------------------------------------------------------------

fn template(name: &str, kind: &str) -> Value {
    json!({
        "$schema": "https://plur1bus.app/schema/p1x/1/p1x.schema.json",
        "format": 1,
        "id": format!("demo/{name}"),
        "name": name,
        "version": "1.0.0",
        "kind": kind,
        "title": { "en": "Demo" },
        "summary": { "en": "A demo." },
        "publisher": { "id": "demo", "name": "Demo" },
        "licence": "MIT",
        "compat": { "harness": ">=0.0.0" },
        "requires": { "runtime": { "type": "none" } },
        "capabilities": {
            "network": { "mode": "none" },
            "filesystem": [],
            "processes": { "spawn": false },
            "harness": { "authority": "none" }
        }
    })
}

fn f(rel: &str, bytes: &[u8], exec: bool) -> PayloadFile {
    PayloadFile {
        rel: rel.to_string(),
        bytes: bytes.to_vec(),
        exec,
    }
}

const RUN_SH: &[u8] = b"#!/bin/sh\necho hi\n";

fn skill_files() -> Vec<PayloadFile> {
    vec![
        f(
            "SKILL.md",
            b"---\nname: demo\ndescription: A demo.\n---\nbody\n",
            false,
        ),
        f("references/a.md", b"a reference", false),
        f("scripts/run.sh", RUN_SH, true),
    ]
}

fn skill(key: Option<&TestKey>) -> Vec<u8> {
    build_package_from(&template("demo", "skill"), skill_files(), key)
}

fn store_for(keys: &[&TestKey]) -> TrustStore {
    let spec: Vec<String> = keys
        .iter()
        .map(|k| format!("{}={}", k.label, k.public_b64))
        .collect();
    TrustStore::with_test_keys(true, Some(&spec.join(","))).unwrap()
}

fn host() -> HostFacts {
    HostFacts {
        harness_version: "0.3.0".into(),
        module_api_current: 1,
        rpc_version: "1.4.0".into(),
        platform: None,
        container: false,
    }
}

fn no_revocations(_: &str, _: &str) -> Option<String> {
    None
}

fn inspect_with(
    pkg: &[u8],
    store: &TrustStore,
    skill_bytes: u64,
    revoked: &dyn Fn(&str, &str) -> Option<String>,
) -> Result<Inspection, Refusal> {
    let host = host();
    let p = Policy {
        limits: Limits::default(),
        skill_bytes,
        store,
        host: &host,
        reserved: &["core"],
        revoked,
    };
    inspect_reader(&mut Cursor::new(pkg), &p)
}

fn inspect(pkg: &[u8], store: &TrustStore) -> Result<Inspection, Refusal> {
    inspect_with(pkg, store, MAX_SKILL_BYTES, &no_revocations)
}

fn refusal(pkg: &[u8], store: &TrustStore) -> Refusal {
    match inspect(pkg, store) {
        Ok(i) => panic!("accepted: {:?}", i.checks),
        Err(e) => e,
    }
}

/// minisign's own rendering of a key id: the 8 key-id bytes as a little-endian u64, 16 upper-case hex digits.
fn key_id_of(k: &TestKey) -> String {
    let pk = minisign::PublicKey::from_base64(&k.public_b64).unwrap();
    let mut b = [0u8; 8];
    b.copy_from_slice(pk.keynum());
    format!("{:016X}", u64::from_le_bytes(b))
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn ids(i: &Inspection) -> Vec<&'static str> {
    i.checks.iter().map(|c| c.id).collect()
}

fn status_of(i: &Inspection, id: &str) -> Status {
    i.checks.iter().find(|c| c.id == id).unwrap().status
}

/// A manifest filled from `template` and `files`, changed by `edit`, re-serialised; signed by `key` if given.
fn edited(
    template: &Value,
    files: Vec<PayloadFile>,
    key: Option<&TestKey>,
    edit: impl FnOnce(&mut Value),
) -> Vec<u8> {
    let (raw, files) = filled_manifest(template, files);
    let mut v: Value = serde_json::from_slice(&raw).unwrap();
    edit(&mut v);
    let raw = serde_json::to_vec_pretty(&v).unwrap();
    let sig = key.map(|k| sign_p1x(k, &raw));
    assemble(&raw, sig.as_deref(), &files)
}

const ORDER: [&str; 8] = [
    "size",
    "zip",
    "signature",
    "manifest",
    "compat",
    "files",
    "scripts",
    "revocation",
];

// ---- tiers --------------------------------------------------------------------------------------------------------

#[test]
fn a_signed_skill_package_is_first_party_and_passes_every_check() {
    let key = test_key("test");
    let pkg = skill(Some(&key));
    let i = inspect(&pkg, &store_for(&[&key])).unwrap();
    assert_eq!(i.trust.tier, Tier::FirstParty);
    assert_eq!(i.trust.key_id.as_deref(), Some(key_id_of(&key).as_str()));
    assert_eq!(i.trust.key_label.as_deref(), Some("test"));
    assert_eq!(ids(&i), ORDER);
    for c in &i.checks {
        assert_eq!(c.status, Status::Pass, "{c:?}");
        assert!(!c.detail.is_empty(), "{c:?}");
    }
    assert_eq!(i.sha256, hex(&Sha256::digest(&pkg)));
    assert_eq!(i.size, pkg.len() as u64);
    assert_eq!(i.manifest.id, "demo/demo");
    assert_eq!(
        parse_manifest(&i.manifest_raw, &[]).unwrap().id,
        "demo/demo"
    );
    assert_eq!(
        i.entries.len(),
        5,
        "p1x.json, the signature and three payload files"
    );
    assert_eq!(i.scripts.len(), 1);
    let s: &ScriptInfo = &i.scripts[0];
    assert_eq!(s.path, "payload/scripts/run.sh");
    assert_eq!(s.size, RUN_SH.len() as u64);
    assert_eq!(s.first_line.as_deref(), Some("#!/bin/sh"));
    // Serialised shapes the RPC and CLI layers pass on unchanged.
    let t = serde_json::to_value(&i.trust).unwrap();
    assert_eq!(t["tier"], "first-party");
    assert_eq!(t["keyLabel"], "test");
    assert_eq!(
        serde_json::to_value(&i.checks[0]).unwrap()["status"],
        "pass"
    );
    assert_eq!(serde_json::to_value(s).unwrap()["firstLine"], "#!/bin/sh");
}

#[test]
fn an_unsigned_package_is_unsigned_and_a_script_mismatch_is_only_a_warning() {
    let pkg = edited(&template("demo", "skill"), skill_files(), None, |v| {
        v["scripts"] = json!([]);
    });
    let i = inspect(&pkg, &TrustStore::pinned()).unwrap();
    assert_eq!(i.trust.tier, Tier::Unsigned);
    assert_eq!(i.trust.key_id, None);
    assert_eq!(i.trust.key_label, None);
    assert_eq!(ids(&i), ORDER);
    assert_eq!(status_of(&i, "signature"), Status::Warn);
    assert_eq!(status_of(&i, "scripts"), Status::Warn);
    let row = i.checks.iter().find(|c| c.id == "scripts").unwrap();
    assert!(row.detail.contains("payload/scripts/run.sh"), "{row:?}");
    // The inspection shows the derived set, not the manifest's claim.
    assert_eq!(i.scripts.len(), 1);
    assert_eq!(i.scripts[0].path, "payload/scripts/run.sh");
    // A consistent unsigned package warns only for the missing signature.
    let i = inspect(&skill(None), &TrustStore::pinned()).unwrap();
    assert_eq!(status_of(&i, "scripts"), Status::Pass);
    assert_eq!(serde_json::to_value(&i.trust).unwrap()["tier"], "unsigned");
}

#[test]
fn a_package_signed_by_an_unknown_key_is_unknown_signer_with_its_key_id() {
    let trusted = test_key("test");
    let other = test_key("other");
    let pkg = skill(Some(&other));
    let i = inspect(&pkg, &store_for(&[&trusted])).unwrap();
    assert_eq!(i.trust.tier, Tier::UnknownSigner);
    assert_eq!(i.trust.key_id.as_deref(), Some(key_id_of(&other).as_str()));
    assert_eq!(i.trust.key_label, None);
    assert_eq!(status_of(&i, "signature"), Status::Warn);
    let row = i.checks.iter().find(|c| c.id == "signature").unwrap();
    assert!(row.detail.contains(&key_id_of(&other)), "{row:?}");
    // With the pinned set (empty, X1-R6) every signed package is unknown-signer.
    assert!(PINNED_KEYS.is_empty());
    let i = inspect(&pkg, &TrustStore::pinned()).unwrap();
    assert_eq!(i.trust.tier, Tier::UnknownSigner);
    assert_eq!(
        serde_json::to_value(&i.trust).unwrap()["tier"],
        "unknown-signer"
    );
}

// ---- acceptance 2 -------------------------------------------------------------------------------------------------

fn tampered(how: Tamper) -> Refusal {
    let key = test_key("test");
    let pkg = tamper(&skill(Some(&key)), how);
    refusal(&pkg, &store_for(&[&key]))
}

#[test]
fn a_changed_payload_byte_is_digest_mismatch() {
    let e = tampered(Tamper::PayloadByte);
    assert_eq!(
        (e.code, e.reason),
        ("E_INVALID_PARAMS", reason::DIGEST),
        "{e}"
    );
}

#[test]
fn an_extra_entry_is_package_invalid() {
    let e = tampered(Tamper::ExtraEntry);
    assert_eq!(e.reason, reason::PACKAGE_INVALID, "{e}");
    assert!(e.detail.contains("payload/extra.txt"), "{e}");
}

#[test]
fn a_dot_dot_entry_is_archive_unsafe_entry() {
    assert_eq!(tampered(Tamper::DotDot).reason, reason::UNSAFE_ENTRY);
}

#[test]
fn a_symlink_entry_is_archive_unsafe_entry() {
    assert_eq!(tampered(Tamper::Symlink).reason, reason::UNSAFE_ENTRY);
}

#[test]
fn a_case_collision_pair_is_archive_unsafe_entry() {
    assert_eq!(tampered(Tamper::CaseCollision).reason, reason::UNSAFE_ENTRY);
}

#[test]
fn a_101_to_1_bomb_is_download_too_large() {
    assert_eq!(tampered(Tamper::Bomb101).reason, reason::TOO_LARGE);
}

#[test]
fn a_manifest_signed_for_another_id_is_signature_invalid() {
    let e = tampered(Tamper::ForeignId);
    assert_eq!(
        (e.code, e.reason),
        ("E_INVALID_PARAMS", reason::SIGNATURE_INVALID),
        "{e}"
    );
    // Also when the foreign manifest is re-signed by the trusted key with the old trusted comment kept: the comment
    // names another id and hash.
    let key = test_key("test");
    let (raw, files) = filled_manifest(&template("demo", "skill"), skill_files());
    let old_comment = trusted_comment("demo/demo", "1.0.0", &raw);
    let mut v: Value = serde_json::from_slice(&raw).unwrap();
    v["id"] = json!("evil/demo");
    v["publisher"]["id"] = json!("evil");
    let foreign = serde_json::to_vec_pretty(&v).unwrap();
    let sig = sign_manifest(&key, &foreign, &old_comment);
    let e = refusal(&assemble(&foreign, Some(&sig), &files), &store_for(&[&key]));
    assert_eq!(e.reason, reason::SIGNATURE_INVALID, "{e}");
    // And when the comment's hash is right but its id is not.
    let wrong_id = format!(
        "p1x evil/demo 1.0.0 sha256(p1x.json)={}",
        hex(&Sha256::digest(&raw))
    );
    let sig = sign_manifest(&key, &raw, &wrong_id);
    let e = refusal(&assemble(&raw, Some(&sig), &files), &store_for(&[&key]));
    assert_eq!(e.reason, reason::SIGNATURE_INVALID, "{e}");
}

#[test]
fn bytes_after_the_eocd_are_archive_unsupported() {
    assert_eq!(
        tampered(Tamper::AppendAfterEocd).reason,
        reason::UNSUPPORTED
    );
}

// ---- signatures ---------------------------------------------------------------------------------------------------

#[test]
fn a_legacy_ed_signature_is_signature_invalid() {
    let key = test_key("test");
    let (raw, files) = filled_manifest(&template("demo", "skill"), skill_files());
    let sig = legacy_signature(&sign_p1x(&key, &raw));
    let pkg = assemble(&raw, Some(&sig), &files);
    for store in [store_for(&[&key]), TrustStore::pinned()] {
        let e = refusal(&pkg, &store);
        assert_eq!(e.reason, reason::SIGNATURE_INVALID, "{e}");
        assert!(e.detail.contains("legacy"), "{e}");
    }
}

#[test]
fn a_trusted_signature_with_another_trusted_comment_or_garbage_is_signature_invalid() {
    let key = test_key("test");
    let store = store_for(&[&key]);
    let (raw, files) = filled_manifest(&template("demo", "skill"), skill_files());
    for comment in [
        "hello".to_string(),
        format!("p1x demo/demo 1.0.0 sha256(p1x.json)={}", "0".repeat(64)),
        format!(
            "p1x demo/demo 2.0.0 sha256(p1x.json)={}",
            hex(&Sha256::digest(&raw))
        ),
        format!("{} extra", trusted_comment("demo/demo", "1.0.0", &raw)),
    ] {
        let sig = sign_manifest(&key, &raw, &comment);
        let e = refusal(&assemble(&raw, Some(&sig), &files), &store);
        assert_eq!(e.reason, reason::SIGNATURE_INVALID, "{comment}: {e}");
    }
    for garbage in [&b"not a signature"[..], b"\xff\xfe", b""] {
        let e = refusal(&assemble(&raw, Some(garbage), &files), &store);
        assert_eq!(e.reason, reason::SIGNATURE_INVALID, "{garbage:?}: {e}");
    }
    // The trusted key's signature over other bytes: the key id is known, the signature does not verify.
    let sig = sign_p1x(&key, b"{\"id\":\"demo/demo\",\"version\":\"1.0.0\"}");
    let e = refusal(&assemble(&raw, Some(&sig), &files), &store);
    assert_eq!(e.reason, reason::SIGNATURE_INVALID, "{e}");
}

#[test]
fn trusted_comment_has_the_binding_shape() {
    let raw = b"{}\n";
    assert_eq!(
        trusted_comment("demo/demo", "1.2.3", raw),
        format!(
            "p1x demo/demo 1.2.3 sha256(p1x.json)={}",
            hex(&Sha256::digest(raw))
        )
    );
}

#[test]
fn the_trust_store_takes_test_keys_only_with_test_internals_and_ships_no_pinned_key() {
    assert!(PINNED_KEYS.is_empty(), "X1-R6: the pinned set ships empty");
    assert!(TrustStore::pinned().is_empty());
    let k = test_key("test");
    let spec = format!("test={}", k.public_b64);
    assert!(TrustStore::with_test_keys(false, Some(&spec))
        .unwrap()
        .is_empty());
    assert!(!TrustStore::with_test_keys(true, Some(&spec))
        .unwrap()
        .is_empty());
    assert!(TrustStore::with_test_keys(true, None).unwrap().is_empty());
    let two = format!("a={},b={}", k.public_b64, test_key("b").public_b64);
    assert!(TrustStore::with_test_keys(true, Some(&two)).is_ok());
    for bad in [
        "nolabel".to_string(),
        "x=notbase64!".to_string(),
        format!("={}", k.public_b64),
        format!("ext-primary={}", k.public_b64),
        format!("a={0},a={1}", k.public_b64, test_key("c").public_b64),
        format!("a={0},b={0}", k.public_b64),
    ] {
        assert!(
            TrustStore::with_test_keys(true, Some(&bad)).is_err(),
            "{bad}"
        );
    }
    assert!(TrustStore::new(&[("x".into(), "AAAA".into())]).is_err());
    assert!(TrustStore::new(&[("x".into(), k.public_b64.clone())]).is_ok());
}

// ---- scripts, kinds, revocation, order ----------------------------------------------------------------------------

#[test]
fn a_signed_package_whose_scripts_list_is_wrong_is_scripts_mismatch() {
    let key = test_key("test");
    let store = store_for(&[&key]);
    for scripts in [
        json!([]),
        json!(["payload/scripts/run.sh", "payload/SKILL.md"]),
    ] {
        let pkg = edited(&template("demo", "skill"), skill_files(), Some(&key), |v| {
            v["scripts"] = scripts.clone();
        });
        let e = refusal(&pkg, &store);
        assert_eq!(e.reason, reason::SCRIPTS_MISMATCH, "{scripts}: {e}");
    }
    // Signed by an unknown key is still signed.
    let other = test_key("other");
    let pkg = edited(
        &template("demo", "skill"),
        skill_files(),
        Some(&other),
        |v| {
            v["scripts"] = json!([]);
        },
    );
    assert_eq!(refusal(&pkg, &store).reason, reason::SCRIPTS_MISMATCH);
}

#[test]
fn mcp_server_and_bundle_kinds_are_kind_unsupported_naming_x2() {
    let key = test_key("test");
    for kind in ["mcp-server", "bundle"] {
        let pkg = build_package_from(
            &template("demo", kind),
            vec![f("README.md", b"x", false)],
            Some(&key),
        );
        let e = refusal(&pkg, &store_for(&[&key]));
        assert_eq!(
            (e.code, e.reason),
            ("E_NOT_AVAILABLE", reason::KIND_UNSUPPORTED),
            "{kind}: {e}"
        );
        assert_eq!(e.detail, format!("{kind} packages arrive in X2"));
    }
}

#[test]
fn a_revoked_id_and_version_is_denied() {
    let pkg = skill(None);
    let revoked = |id: &str, version: &str| {
        (id == "demo/demo" && version == "1.0.0").then(|| "a leaked token".to_string())
    };
    let e = inspect_with(&pkg, &TrustStore::pinned(), MAX_SKILL_BYTES, &revoked).unwrap_err();
    assert_eq!((e.code, e.reason), ("E_DENIED", "revoked"), "{e}");
    assert!(e.detail.contains("a leaked token"), "{e}");
    let other = |_: &str, version: &str| (version == "0.9.0").then(|| "old".to_string());
    let i = inspect_with(&pkg, &TrustStore::pinned(), MAX_SKILL_BYTES, &other).unwrap();
    assert_eq!(status_of(&i, "revocation"), Status::Pass);
}

#[test]
fn checks_come_in_the_binding_order() {
    let key = test_key("test");
    let store = store_for(&[&key]);
    assert_eq!(ids(&inspect(&skill(Some(&key)), &store).unwrap()), ORDER);
    assert_eq!(ids(&inspect(&skill(None), &store).unwrap()), ORDER);
    // Which refusal wins when a package breaks two steps: the earlier step (§8.4 is binding).
    let incompatible = |v: &mut Value| v["compat"]["harness"] = json!(">=99.0.0");
    // signature (4) before compat (5): a bad signature on an incompatible manifest.
    let (raw, files) = filled_manifest(&template("demo", "skill"), skill_files());
    let mut v: Value = serde_json::from_slice(&raw).unwrap();
    incompatible(&mut v);
    let raw2 = serde_json::to_vec_pretty(&v).unwrap();
    let sig = sign_p1x(&key, &raw);
    let e = refusal(&assemble(&raw2, Some(&sig), &files), &store);
    assert_eq!(e.reason, reason::SIGNATURE_INVALID, "{e}");
    // manifest (5) before files (6): a schema error beside a changed payload byte.
    let mut bad_files = files.clone();
    bad_files[0].bytes.push(b'!');
    let mut v: Value = serde_json::from_slice(&raw).unwrap();
    v["licence"] = json!(42);
    let raw3 = serde_json::to_vec_pretty(&v).unwrap();
    let e = refusal(&assemble(&raw3, None, &bad_files), &store);
    assert_eq!(e.reason, reason::PACKAGE_INVALID, "{e}");
    // compat (5) before files (6).
    let pkg = edited(
        &template("demo", "skill"),
        skill_files(),
        None,
        incompatible,
    );
    assert_eq!(refusal(&pkg, &store).reason, reason::INCOMPATIBLE);
    let mut v: Value = serde_json::from_slice(&raw).unwrap();
    incompatible(&mut v);
    let raw4 = serde_json::to_vec_pretty(&v).unwrap();
    let e = refusal(&assemble(&raw4, None, &bad_files), &store);
    assert_eq!(e.reason, reason::INCOMPATIBLE, "{e}");
    // files (6) before revocation (7).
    let everything = |_: &str, _: &str| Some("revoked".to_string());
    let e = inspect_with(
        &assemble(&raw, None, &bad_files),
        &store,
        MAX_SKILL_BYTES,
        &everything,
    )
    .unwrap_err();
    assert_eq!(e.reason, reason::DIGEST, "{e}");
    // size (1) before the ZIP parse (2).
    let host = host();
    let p = Policy {
        limits: Limits {
            package_bytes: 10,
            ..Limits::default()
        },
        skill_bytes: MAX_SKILL_BYTES,
        store: &store,
        host: &host,
        reserved: &[],
        revoked: &no_revocations,
    };
    let e = inspect_reader(&mut Cursor::new(b"not a zip at all"), &p).unwrap_err();
    assert_eq!(e.reason, reason::TOO_LARGE, "{e}");
}

#[test]
fn a_skill_over_16_mib_is_download_too_large() {
    assert_eq!(MAX_SKILL_BYTES, 16 << 20);
    // Pseudo-random bytes, so the deflate ratio stays far below 100:1.
    let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
    let big: Vec<u8> = (0..(MAX_SKILL_BYTES as usize + 1 - 64))
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x as u8
        })
        .collect();
    let mut files = skill_files();
    files.retain(|f| f.rel != "scripts/run.sh");
    let small: u64 = files.iter().map(|f| f.bytes.len() as u64).sum();
    let pad = vec![b'p'; 64 - small as usize];
    files.push(f("big.bin", &big, false));
    files.push(f("pad.txt", &pad, false));
    let total: u64 = files.iter().map(|f| f.bytes.len() as u64).sum();
    assert_eq!(total, MAX_SKILL_BYTES + 1);
    let pkg = build_package_from(&template("demo", "skill"), files, None);
    let e = refusal(&pkg, &TrustStore::pinned());
    assert_eq!(e.reason, reason::TOO_LARGE, "{e}");
    assert!(e.detail.contains("skill"), "{e}");
    // The cap is the skill's: a module of the same size passes it (shown with a small cap, to keep the test fast).
    let mut t = template("demo", "module");
    t["compat"]["moduleApi"] = json!(["1"]);
    let module = build_package_from(&t, skill_files(), None);
    inspect_with(&module, &TrustStore::pinned(), 16, &no_revocations).unwrap();
    let e = inspect_with(&skill(None), &TrustStore::pinned(), 16, &no_revocations).unwrap_err();
    assert_eq!(e.reason, reason::TOO_LARGE, "{e}");
    // Exactly at the cap passes.
    let at: u64 = skill_files().iter().map(|f| f.bytes.len() as u64).sum();
    inspect_with(&skill(None), &TrustStore::pinned(), at, &no_revocations).unwrap();
}

#[test]
fn a_p1x_skill_with_an_env_file_is_package_invalid() {
    let key = test_key("test");
    let store = store_for(&[&key]);
    for rel in [".env", "config/.env.local", "id_ed25519", "a/.git/config"] {
        let mut files = skill_files();
        files.push(f(rel, b"SECRET=1\n", false));
        let pkg = build_package_from(&template("demo", "skill"), files, Some(&key));
        let e = refusal(&pkg, &store);
        assert_eq!(e.reason, reason::PACKAGE_INVALID, "{rel}: {e}");
        assert!(e.detail.contains(rel), "{rel}: {e}");
    }
    // A module may carry such a name: the rule is the skill folder's (X1-R14).
    let mut t = template("demo", "module");
    t["compat"]["moduleApi"] = json!(["1"]);
    let mut files = skill_files();
    files.push(f(".env", b"X=1\n", false));
    inspect(&build_package_from(&t, files, Some(&key)), &store).unwrap();
}

#[test]
fn a_p1x_skill_with_a_vcs_or_cache_directory_is_package_invalid() {
    for rel in [
        "__pycache__/x.pyc",
        "scripts/__pycache__/run.cpython-312.pyc",
        ".hg/store",
        ".svn/entries",
    ] {
        let mut files = skill_files();
        files.push(f(rel, b"cache", false));
        let pkg = build_package_from(&template("demo", "skill"), files, None);
        let e = refusal(&pkg, &TrustStore::pinned());
        assert_eq!(e.reason, reason::PACKAGE_INVALID, "{rel}: {e}");
    }
}

// ---- layout, compat, first line, files ----------------------------------------------------------------------------

/// Renames an entry in place (local header and central directory): the names must have the same length, and the
/// name must occur exactly twice in the archive.
fn rename_entry(pkg: &[u8], from: &str, to: &str) -> Vec<u8> {
    assert_eq!(from.len(), to.len());
    let (from, to) = (from.as_bytes(), to.as_bytes());
    let mut out = pkg.to_vec();
    let at: Vec<usize> = (0..=out.len() - from.len())
        .filter(|i| &out[*i..*i + from.len()] == from)
        .collect();
    assert_eq!(at.len(), 2, "local header and central directory");
    for i in at {
        out[i..i + to.len()].copy_from_slice(to);
    }
    out
}

#[test]
fn only_the_manifest_its_signature_and_payload_may_sit_at_the_root() {
    let key = test_key("test");
    let store = store_for(&[&key]);
    let (raw, mut files) = filled_manifest(&template("demo", "skill"), skill_files());
    files.push(f("stray.txt", b"x", false));
    let pkg = assemble(&raw, None, &files);
    for (from, to) in [
        ("payload/stray.txt", "stray-at-root.txt"),
        ("payload/stray.txt", "payloae/stray.txt"),
        ("payload/stray.txt", "p1x.json.minisigx"),
    ] {
        let e = refusal(&rename_entry(&pkg, from, to), &store);
        assert_eq!(e.reason, reason::PACKAGE_INVALID, "{to}: {e}");
        assert!(e.detail.contains(to), "{to}: {e}");
    }
    // No p1x.json at all.
    let (raw, files) = filled_manifest(&template("demo", "skill"), skill_files());
    let e = refusal(
        &rename_entry(&assemble(&raw, None, &files), "p1x.json", "p1x.jsom"),
        &store,
    );
    assert_eq!(e.reason, reason::PACKAGE_INVALID, "{e}");
}

#[test]
fn a_missing_payload_file_is_package_invalid_and_a_wrong_size_or_exec_flag_too() {
    let (raw, mut files) = filled_manifest(&template("demo", "skill"), skill_files());
    let removed = files.remove(0);
    let e = refusal(&assemble(&raw, None, &files), &TrustStore::pinned());
    assert_eq!(e.reason, reason::PACKAGE_INVALID, "{e}");
    assert!(e.detail.contains(&removed.rel), "{e}");
    // The exec flag in the archive disagrees with `files`.
    let (raw, mut files) = filled_manifest(&template("demo", "skill"), skill_files());
    for f in &mut files {
        f.exec = !f.exec;
    }
    let e = refusal(&assemble(&raw, None, &files), &TrustStore::pinned());
    assert_eq!(e.reason, reason::PACKAGE_INVALID, "{e}");
    // `files` declares another size for the same bytes.
    let pkg = edited(&template("demo", "skill"), skill_files(), None, |v| {
        v["files"]["payload/references/a.md"]["size"] = json!(3);
    });
    assert_eq!(refusal(&pkg, &TrustStore::pinned()).reason, reason::DIGEST);
}

#[test]
fn an_incompatible_or_reserved_package_is_refused_with_its_reason() {
    let pkg = edited(&template("demo", "skill"), skill_files(), None, |v| {
        v["compat"]["harness"] = json!("<0.1.0");
    });
    let e = refusal(&pkg, &TrustStore::pinned());
    assert_eq!(e.reason, reason::INCOMPATIBLE, "{e}");
    let mut t = template("core", "skill");
    t["id"] = json!("demo/core");
    let pkg = build_package_from(&t, skill_files(), None);
    assert_eq!(
        refusal(&pkg, &TrustStore::pinned()).reason,
        reason::RESERVED
    );
}

#[test]
fn first_line_is_printable_and_at_most_120_characters() {
    assert_eq!(
        first_line(b"#!/usr/bin/env python3\r\nprint()").as_deref(),
        Some("#!/usr/bin/env python3")
    );
    assert_eq!(first_line(b"\x7fELF\x02\x01\x01\0"), None);
    assert_eq!(first_line(b"MZ\x90\0"), None);
    assert_eq!(first_line(b""), None);
    assert_eq!(first_line(b"\n#!/bin/sh"), None);
    assert_eq!(first_line("#!/bin/sh \u{202e}hs.exe".as_bytes()), None);
    let long = format!("#!/bin/{}", "a".repeat(300));
    let l = first_line(long.as_bytes()).unwrap();
    assert_eq!(l.chars().count(), 120);
    assert!(long.starts_with(&l));
    let wide = format!("# {}", "ü".repeat(200));
    assert_eq!(first_line(wide.as_bytes()).unwrap().chars().count(), 120);
    assert_eq!(
        first_line("\u{feff}#!/bin/sh\n".as_bytes()).as_deref(),
        Some("#!/bin/sh")
    );
}

#[test]
fn inspect_file_reads_a_package_from_disk_and_checks_its_size_first() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("demo skill ü.p1x");
    std::fs::write(&path, skill(None)).unwrap();
    let store = TrustStore::pinned();
    let host = host();
    let mut p = Policy {
        limits: Limits::default(),
        skill_bytes: MAX_SKILL_BYTES,
        store: &store,
        host: &host,
        reserved: &[],
        revoked: &no_revocations,
    };
    let i = inspect_file(&path, &p).unwrap();
    assert_eq!(i.trust.tier, Tier::Unsigned);
    p.limits.package_bytes = 16;
    assert_eq!(
        inspect_file(&path, &p).unwrap_err().reason,
        reason::TOO_LARGE
    );
    p.limits.package_bytes = Limits::default().package_bytes;
    assert_eq!(
        inspect_file(dir.path(), &p).unwrap_err().reason,
        reason::PACKAGE_INVALID
    );
    assert_eq!(
        inspect_file(&dir.path().join("missing.p1x"), &p)
            .unwrap_err()
            .reason,
        "io"
    );
}
