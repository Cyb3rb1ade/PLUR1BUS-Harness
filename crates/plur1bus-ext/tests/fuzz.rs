//! Fuzzing the inspect pipeline (spec 2026-09-27 §8.4, §12; acceptance 8): mutants of six valid packages never make
//! `inspect_reader` panic, and a mutant is never accepted as `first-party` unless its manifest is byte-identical to a
//! manifest the trusted key actually signed and its payload `(name, sha256)` set equals that seed's.
//!
//! `fuzz_inspect_never_panics_and_never_accepts_a_mutant_as_first_party` is `#[ignore]`d and runs for
//! `PLUR1BUS_FUZZ_SECONDS` (default 20; the nightly job `ext-fuzz` gives it 600). `fuzz_smoke` runs the same loop for
//! 2 s in every `cargo test`.
//!
//! Replay: everything is derived from `PLUR1BUS_FUZZ_SEED` (printed). The two signing keys are Ed25519 keys whose
//! seeds and key ids come from the seeded xorshift, held in memory only (nothing is committed), and the signatures
//! are made here with deterministic Ed25519 (`ring`, RFC 8032) over minisign's BLAKE2b-512 prehash, because
//! `minisign::sign` adds a random nonce. The corpus is therefore byte-identical for a seed, and so is the mutant
//! stream; a replay with the same seed reaches the failing iteration given at least as many seconds. On a failure the
//! mutant is also written to the temp directory, and its path and the trusted public key are printed.
use plur1bus_ext::compat::HostFacts;
use plur1bus_ext::normalise::MAX_SKILL_BYTES;
use plur1bus_ext::pack::PayloadFile;
use plur1bus_ext::testkit::{assemble, filled_manifest};
use plur1bus_ext::trust::{trusted_comment, Tier, TrustStore};
use plur1bus_ext::verify::{inspect_reader, Policy};
use plur1bus_ext::zipaudit::{audit_zip, hash_entry, Limits};
use ring::signature::{Ed25519KeyPair, KeyPair};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::io::Cursor;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::time::{Duration, Instant};

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            0
        } else {
            (self.next() % n as u64) as usize
        }
    }
    fn bytes<const N: usize>(&mut self) -> [u8; N] {
        let mut out = [0u8; N];
        for chunk in out.chunks_mut(8) {
            let v = self.next().to_le_bytes();
            chunk.copy_from_slice(&v[..chunk.len()]);
        }
        out
    }
}

// ---- deterministic minisign signing (test only) -------------------------------------------------------------------

const IV: [u64; 8] = [
    0x6a09e667f3bcc908,
    0xbb67ae8584caa73b,
    0x3c6ef372fe94f82b,
    0xa54ff53a5f1d36f1,
    0x510e527fade682d1,
    0x9b05688c2b3e6c1f,
    0x1f83d9abfb41bd6b,
    0x5be0cd19137e2179,
];

const SIGMA: [[usize; 16]; 10] = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
    [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
    [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
    [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
    [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
    [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
    [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
    [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
    [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

fn compress(h: &mut [u64; 8], block: &[u8; 128], t: u128, last: bool) {
    let mut m = [0u64; 16];
    for (i, w) in m.iter_mut().enumerate() {
        *w = u64::from_le_bytes(block[i * 8..i * 8 + 8].try_into().unwrap());
    }
    let mut v = [0u64; 16];
    v[..8].copy_from_slice(h);
    v[8..].copy_from_slice(&IV);
    v[12] ^= t as u64;
    v[13] ^= (t >> 64) as u64;
    if last {
        v[14] = !v[14];
    }
    let g = |v: &mut [u64; 16], a: usize, b: usize, c: usize, d: usize, x: u64, y: u64| {
        v[a] = v[a].wrapping_add(v[b]).wrapping_add(x);
        v[d] = (v[d] ^ v[a]).rotate_right(32);
        v[c] = v[c].wrapping_add(v[d]);
        v[b] = (v[b] ^ v[c]).rotate_right(24);
        v[a] = v[a].wrapping_add(v[b]).wrapping_add(y);
        v[d] = (v[d] ^ v[a]).rotate_right(16);
        v[c] = v[c].wrapping_add(v[d]);
        v[b] = (v[b] ^ v[c]).rotate_right(63);
    };
    for r in 0..12 {
        let s = &SIGMA[r % 10];
        g(&mut v, 0, 4, 8, 12, m[s[0]], m[s[1]]);
        g(&mut v, 1, 5, 9, 13, m[s[2]], m[s[3]]);
        g(&mut v, 2, 6, 10, 14, m[s[4]], m[s[5]]);
        g(&mut v, 3, 7, 11, 15, m[s[6]], m[s[7]]);
        g(&mut v, 0, 5, 10, 15, m[s[8]], m[s[9]]);
        g(&mut v, 1, 6, 11, 12, m[s[10]], m[s[11]]);
        g(&mut v, 2, 7, 8, 13, m[s[12]], m[s[13]]);
        g(&mut v, 3, 4, 9, 14, m[s[14]], m[s[15]]);
    }
    for i in 0..8 {
        h[i] ^= v[i] ^ v[i + 8];
    }
}

/// BLAKE2b-512, unkeyed (RFC 7693): minisign's prehash.
fn blake2b512(data: &[u8]) -> [u8; 64] {
    let mut h = IV;
    h[0] ^= 0x0101_0000 ^ 64;
    let mut t: u128 = 0;
    let mut rest = data;
    while rest.len() > 128 {
        t += 128;
        compress(&mut h, rest[..128].try_into().unwrap(), t, false);
        rest = &rest[128..];
    }
    let mut last = [0u8; 128];
    last[..rest.len()].copy_from_slice(rest);
    t += rest.len() as u128;
    compress(&mut h, &last, t, true);
    let mut out = [0u8; 64];
    for (i, w) in h.iter().enumerate() {
        out[i * 8..i * 8 + 8].copy_from_slice(&w.to_le_bytes());
    }
    out
}

fn base64(bytes: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for i in 0..4 {
            out.push(if i <= chunk.len() {
                A[(n >> (18 - 6 * i) & 63) as usize] as char
            } else {
                '='
            });
        }
    }
    out
}

/// A signing key derived from the fuzz seed: deterministic, in memory, never written.
struct SeededKey {
    pair: Ed25519KeyPair,
    keynum: [u8; 8],
}

impl SeededKey {
    fn new(rng: &mut Rng) -> SeededKey {
        let seed: [u8; 32] = rng.bytes();
        let keynum: [u8; 8] = rng.bytes();
        let pair = Ed25519KeyPair::from_seed_unchecked(&seed).expect("an Ed25519 seed");
        SeededKey { pair, keynum }
    }

    /// The minisign public key, base64 (`Ed` + key id + public key).
    fn public_b64(&self) -> String {
        let mut b = b"Ed".to_vec();
        b.extend_from_slice(&self.keynum);
        b.extend_from_slice(self.pair.public_key().as_ref());
        base64(&b)
    }

    /// A prehashed (`ED`) minisign signature file over `data` with `comment`.
    fn sign(&self, data: &[u8], comment: &str) -> Vec<u8> {
        let sig = self.pair.sign(&blake2b512(data));
        let mut line = b"ED".to_vec();
        line.extend_from_slice(&self.keynum);
        line.extend_from_slice(sig.as_ref());
        let mut global = sig.as_ref().to_vec();
        global.extend_from_slice(comment.as_bytes());
        let global = self.pair.sign(&global);
        format!(
            "untrusted comment: p1x fuzz signature\n{}\ntrusted comment: {comment}\n{}\n",
            base64(&line),
            base64(global.as_ref())
        )
        .into_bytes()
    }
}

// ---- the corpus ---------------------------------------------------------------------------------------------------

fn template(name: &str, kind: &str) -> Value {
    let mut t = json!({
        "$schema": "https://plur1bus.app/schema/p1x/1/p1x.schema.json",
        "format": 1,
        "id": format!("fuzz/{name}"),
        "name": name,
        "version": "1.0.0",
        "kind": kind,
        "title": { "en": "Fuzz" },
        "summary": { "en": "A fuzz seed." },
        "publisher": { "id": "fuzz", "name": "Fuzz" },
        "licence": "MIT",
        "compat": { "harness": ">=0.0.0" },
        "requires": { "runtime": { "type": "none" } },
        "capabilities": {
            "network": { "mode": "none" },
            "filesystem": [],
            "processes": { "spawn": false },
            "harness": { "authority": "none" }
        }
    });
    if kind != "skill" {
        t["compat"]["moduleApi"] = json!(["1"]);
    }
    t
}

fn f(rel: &str, bytes: &[u8], exec: bool) -> PayloadFile {
    PayloadFile {
        rel: rel.to_string(),
        bytes: bytes.to_vec(),
        exec,
    }
}

fn package(template: &Value, files: Vec<PayloadFile>, key: Option<&SeededKey>) -> Vec<u8> {
    let (raw, files) = filled_manifest(template, files);
    let v: Value = serde_json::from_slice(&raw).unwrap();
    let sig = key.map(|k| {
        let comment = trusted_comment(
            v["id"].as_str().unwrap(),
            v["version"].as_str().unwrap(),
            &raw,
        );
        k.sign(&raw, &comment)
    });
    assemble(&raw, sig.as_deref(), &files)
}

/// Six valid packages: signed and unsigned skills, a skill with scripts, a module, a channel, and an unknown signer.
fn seeds(trusted: &SeededKey, other: &SeededKey) -> Vec<Vec<u8>> {
    let md = b"---\nname: demo\ndescription: A demo.\n---\nbody\n".as_slice();
    let text: Vec<u8> = (0..3000u32)
        .map(|i| b"abcdefgh \n"[(i % 10) as usize])
        .collect();
    vec![
        package(
            &template("demo", "skill"),
            vec![f("SKILL.md", md, false), f("references/a.md", &text, false)],
            Some(trusted),
        ),
        package(
            &template("plain", "skill"),
            vec![f("SKILL.md", md, false)],
            None,
        ),
        package(
            &template("scripted", "skill"),
            vec![
                f("SKILL.md", md, false),
                f("scripts/run.sh", b"#!/bin/sh\necho hi\n", true),
                f("bin/tool", b"\x7fELF\x02\x01\x01\0rest", false),
            ],
            Some(trusted),
        ),
        package(
            &template("fixture", "module"),
            vec![
                f("module.json", b"{\"name\":\"fixture\"}", false),
                f("dist/index.js", b"export default {};\n", false),
            ],
            Some(trusted),
        ),
        package(
            &template("chan", "channel"),
            vec![f("module.json", b"{\"name\":\"chan\"}", false)],
            Some(trusted),
        ),
        package(
            &template("stranger", "skill"),
            vec![f("SKILL.md", md, false)],
            Some(other),
        ),
    ]
}

/// The central-directory records of `b` as `(offset, length)`, found through the end-of-central-directory record.
/// Empty when the archive is too broken to find them.
fn central_records(b: &[u8]) -> (Vec<(usize, usize)>, Option<usize>) {
    let Some(eocd) = (0..b.len().saturating_sub(21))
        .rev()
        .find(|&i| b[i..i + 4] == [0x50, 0x4b, 0x05, 0x06])
    else {
        return (Vec::new(), None);
    };
    let cd = u32::from_le_bytes(b[eocd + 16..eocd + 20].try_into().unwrap()) as usize;
    let mut out = Vec::new();
    let mut at = cd;
    while at + 46 <= eocd && b[at..at + 4] == [0x50, 0x4b, 0x01, 0x02] {
        let le16 = |o: usize| u16::from_le_bytes([b[at + o], b[at + o + 1]]) as usize;
        let len = 46 + le16(28) + le16(30) + le16(32);
        if at + len > eocd {
            break;
        }
        out.push((at, len));
        at += len;
    }
    (out, Some(eocd))
}

/// One mutation of `pkg`, possibly using `other` (another seed).
fn mutate(rng: &mut Rng, pkg: &[u8], other: &[u8]) -> Vec<u8> {
    let mut b = pkg.to_vec();
    match rng.below(7) {
        // Bit flips.
        0 => {
            for _ in 0..1 + rng.below(8) {
                let i = rng.below(b.len());
                b[i] ^= 1 << rng.below(8);
            }
        }
        // A run of one byte value.
        1 => {
            let start = rng.below(b.len());
            let len = 1 + rng.below(64);
            let v = [0x00, 0xff, 0x7f, 0x80, 0x41][rng.below(5)];
            for x in b.iter_mut().skip(start).take(len) {
                *x = v;
            }
        }
        // Truncation.
        2 => b.truncate(rng.below(b.len())),
        // Splice: a central-directory field (2 or 4 bytes at the same record offset) from another package.
        3 => {
            let (mine, _) = central_records(&b);
            let (theirs, _) = central_records(other);
            if !mine.is_empty() && !theirs.is_empty() {
                let (a, alen) = mine[rng.below(mine.len())];
                let (o, olen) = theirs[rng.below(theirs.len())];
                let width = if rng.below(2) == 0 { 2 } else { 4 };
                let field = rng.below(alen.min(olen).saturating_sub(width) + 1);
                b[a + field..a + field + width]
                    .copy_from_slice(&other[o + field..o + field + width]);
            }
        }
        // Duplicate a central-directory record and fix the counts and the directory size.
        4 => {
            let (recs, eocd) = central_records(&b);
            if let (Some(eocd), false) = (eocd, recs.is_empty()) {
                let (at, len) = recs[rng.below(recs.len())];
                let rec = b[at..at + len].to_vec();
                let n = u16::from_le_bytes([b[eocd + 10], b[eocd + 11]]).wrapping_add(1);
                let size = u32::from_le_bytes(b[eocd + 12..eocd + 16].try_into().unwrap())
                    .wrapping_add(len as u32);
                b[eocd + 8..eocd + 10].copy_from_slice(&n.to_le_bytes());
                b[eocd + 10..eocd + 12].copy_from_slice(&n.to_le_bytes());
                b[eocd + 12..eocd + 16].copy_from_slice(&size.to_le_bytes());
                b.splice(eocd..eocd, rec);
            }
        }
        // Splice a whole byte range from the other package at the same offset.
        5 => {
            let start = rng.below(b.len().min(other.len()));
            let len = (1 + rng.below(256))
                .min(other.len() - start)
                .min(b.len() - start);
            b[start..start + len].copy_from_slice(&other[start..start + len]);
        }
        // Insert or delete a few bytes.
        _ => {
            let at = rng.below(b.len());
            if rng.below(2) == 0 {
                let n = 1 + rng.below(8);
                b.splice(at..at, (0..n).map(|_| rng.next() as u8));
            } else {
                let n = (1 + rng.below(8)).min(b.len() - at);
                b.drain(at..at + n);
            }
        }
    }
    b
}

/// Payload entries as `(name, sha256)`.
type PayloadSet = BTreeSet<(String, String)>;

/// The payload `(name, sha256)` set of `pkg`, hashed here independently of the pipeline. `None` if it does not audit.
fn payload_set(pkg: &[u8]) -> Option<PayloadSet> {
    let mut r = Cursor::new(pkg);
    let a = audit_zip(&mut r, &Limits::default()).ok()?;
    a.entries
        .iter()
        .filter(|e| e.name.starts_with("payload/"))
        .map(|e| Some((e.name.clone(), hash_entry(&mut r, e).ok()?.sha256)))
        .collect()
}

fn no_revocations(_: &str, _: &str) -> Option<String> {
    None
}

fn seed_from_env() -> u64 {
    std::env::var("PLUR1BUS_FUZZ_SEED")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos() as u64)
                .unwrap_or(1)
        })
        .max(1)
}

/// Writes the failing mutant beside the other temp files and panics with everything a replay needs.
fn fail(why: &str, seed: u64, iteration: u64, mutant: &[u8], trusted_b64: &str) -> ! {
    let path = std::env::temp_dir().join(format!("plur1bus-fuzz-{seed}-{iteration}.p1x"));
    let written = std::fs::write(&path, mutant).is_ok();
    panic!(
        "{why} at iteration {iteration}; replay with PLUR1BUS_FUZZ_SEED={seed}. Mutant: {} ({}); trusted key \
         PLUR1BUS_TEST_EXT_PUBKEYS=fuzz={trusted_b64}",
        path.display(),
        if written { "written" } else { "could not be written" }
    )
}

struct Stats {
    iterations: u64,
    no_ops: u64,
    accepted: u64,
    first_party: u64,
}

fn run(seed: u64, seconds: u64) -> Stats {
    println!("PLUR1BUS_FUZZ_SEED={seed}");
    let mut rng = Rng(seed);
    let trusted = SeededKey::new(&mut rng);
    let other = SeededKey::new(&mut rng);
    let store = TrustStore::with_test_keys(true, Some(&format!("fuzz={}", trusted.public_b64())))
        .expect("the seeded key parses");
    let host = HostFacts {
        harness_version: "0.3.0".into(),
        module_api_current: 1,
        rpc_version: "1.4.0".into(),
        platform: None,
        container: false,
    };
    let policy = Policy {
        limits: Limits::default(),
        skill_bytes: MAX_SKILL_BYTES,
        store: &store,
        host: &host,
        reserved: &[],
        revoked: &no_revocations,
    };
    let corpus = seeds(&trusted, &other);
    // What the trusted key signed: a first-party result must carry one of these manifests with that seed's payload.
    let mut signed: Vec<(Vec<u8>, PayloadSet)> = Vec::new();
    for pkg in &corpus {
        let i = inspect_reader(&mut Cursor::new(pkg), &policy).expect("a seed passes");
        if i.trust.tier == Tier::FirstParty {
            signed.push((i.manifest_raw, payload_set(pkg).expect("a seed audits")));
        }
    }
    assert_eq!(signed.len(), 4, "four seeds are signed by the trusted key");

    let deadline = Instant::now() + Duration::from_secs(seconds);
    let mut s = Stats {
        iterations: 0,
        no_ops: 0,
        accepted: 0,
        first_party: 0,
    };
    while Instant::now() < deadline {
        let base = &corpus[rng.below(corpus.len())];
        let other_pkg = &corpus[rng.below(corpus.len())];
        let mut m = mutate(&mut rng, base, other_pkg);
        for _ in 0..rng.below(3) {
            if !m.is_empty() {
                m = mutate(&mut rng, &m, other_pkg);
            }
        }
        // A mutation that changed nothing (a splice of equal bytes) tests nothing: count it and draw again.
        if m == *base {
            s.no_ops += 1;
            continue;
        }
        s.iterations += 1;
        let result = catch_unwind(AssertUnwindSafe(|| {
            inspect_reader(&mut Cursor::new(&m), &policy)
        }));
        match result {
            Err(_) => fail(
                "inspect_reader panicked",
                seed,
                s.iterations,
                &m,
                &trusted.public_b64(),
            ),
            Ok(Ok(i)) => {
                s.accepted += 1;
                if i.trust.tier == Tier::FirstParty {
                    s.first_party += 1;
                    let genuine = signed.iter().any(|(raw, payload)| {
                        *raw == i.manifest_raw && payload_set(&m).as_ref() == Some(payload)
                    });
                    if !genuine {
                        fail(
                            "a mutant was accepted as first-party with a manifest or payload nobody signed",
                            seed,
                            s.iterations,
                            &m,
                            &trusted.public_b64(),
                        );
                    }
                }
            }
            Ok(Err(_)) => {}
        }
    }
    println!(
        "fuzz: {} iterations in {seconds} s (seed {seed}); {} no-op mutants redrawn; {} accepted, {} as first-party",
        s.iterations, s.no_ops, s.accepted, s.first_party
    );
    s
}

#[test]
#[ignore = "long-running; the nightly ext-fuzz job runs it with PLUR1BUS_FUZZ_SECONDS=600"]
fn fuzz_inspect_never_panics_and_never_accepts_a_mutant_as_first_party() {
    let seconds = std::env::var("PLUR1BUS_FUZZ_SECONDS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(20);
    assert!(run(seed_from_env(), seconds).iterations > 0);
}

#[test]
fn fuzz_smoke() {
    assert!(run(seed_from_env(), 2).iterations > 0);
}

#[test]
fn the_corpus_and_the_mutant_stream_are_deterministic_for_a_seed() {
    assert_eq!(
        hex(&blake2b512(b"abc")),
        "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d1\
         7d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923"
    );
    // Multi-block inputs are covered by the seeds: every signed manifest is longer than one block, and
    // minisign-verify accepts their signatures (four first-party seeds in `run`).
    let build = |seed: u64| {
        let mut rng = Rng(seed);
        let t = SeededKey::new(&mut rng);
        let o = SeededKey::new(&mut rng);
        let corpus = seeds(&t, &o);
        let mutants: Vec<Vec<u8>> = (0..50)
            .map(|i| mutate(&mut rng, &corpus[i % 6], &corpus[(i + 1) % 6]))
            .collect();
        (t.public_b64(), corpus, mutants)
    };
    assert_eq!(build(42), build(42));
    assert_ne!(build(42).0, build(43).0);
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
