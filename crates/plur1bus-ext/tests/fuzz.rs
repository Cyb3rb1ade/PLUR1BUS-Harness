//! Fuzzing the inspect pipeline (spec 2026-09-27 §8.4, §12; acceptance 8): mutants of six valid packages never make
//! `inspect_reader` panic, and a mutant is never accepted as `first-party` unless its manifest is byte-identical to a
//! manifest the trusted key actually signed.
//!
//! `fuzz_inspect_never_panics_and_never_accepts_a_mutant_as_first_party` is `#[ignore]`d and runs for
//! `PLUR1BUS_FUZZ_SECONDS` (default 20; the nightly job `ext-fuzz` gives it 600). `fuzz_smoke` runs the same loop for
//! 2 s in every `cargo test`. The RNG is a seeded xorshift: `PLUR1BUS_FUZZ_SEED` replays a run, and the seed is printed.
use plur1bus_ext::compat::HostFacts;
use plur1bus_ext::normalise::MAX_SKILL_BYTES;
use plur1bus_ext::pack::PayloadFile;
use plur1bus_ext::testkit::{build_package_from, test_key, TestKey};
use plur1bus_ext::trust::{Tier, TrustStore};
use plur1bus_ext::verify::{inspect_reader, Policy};
use plur1bus_ext::zipaudit::Limits;
use serde_json::{json, Value};
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
}

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

/// Six valid packages: signed and unsigned skills, a skill with scripts, a module, a channel, and an unknown signer.
fn seeds(trusted: &TestKey, other: &TestKey) -> Vec<Vec<u8>> {
    let md = b"---\nname: demo\ndescription: A demo.\n---\nbody\n".as_slice();
    let text: Vec<u8> = (0..3000u32)
        .map(|i| b"abcdefgh \n"[(i % 10) as usize])
        .collect();
    vec![
        build_package_from(
            &template("demo", "skill"),
            vec![f("SKILL.md", md, false), f("references/a.md", &text, false)],
            Some(trusted),
        ),
        build_package_from(
            &template("plain", "skill"),
            vec![f("SKILL.md", md, false)],
            None,
        ),
        build_package_from(
            &template("scripted", "skill"),
            vec![
                f("SKILL.md", md, false),
                f("scripts/run.sh", b"#!/bin/sh\necho hi\n", true),
                f("bin/tool", b"\x7fELF\x02\x01\x01\0rest", false),
            ],
            Some(trusted),
        ),
        build_package_from(
            &template("fixture", "module"),
            vec![
                f("module.json", b"{\"name\":\"fixture\"}", false),
                f("dist/index.js", b"export default {};\n", false),
            ],
            Some(trusted),
        ),
        build_package_from(
            &template("chan", "channel"),
            vec![f("module.json", b"{\"name\":\"chan\"}", false)],
            Some(trusted),
        ),
        build_package_from(
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

/// The manifest bytes of a package the pipeline accepts.
fn manifest_of(pkg: &[u8], p: &Policy) -> Vec<u8> {
    inspect_reader(&mut Cursor::new(pkg), p)
        .expect("a seed passes")
        .manifest_raw
}

fn no_revocations(_: &str, _: &str) -> Option<String> {
    None
}

fn run(seconds: u64) -> u64 {
    let seed: u64 = std::env::var("PLUR1BUS_FUZZ_SEED")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos() as u64)
                .unwrap_or(1)
        })
        .max(1);
    println!("PLUR1BUS_FUZZ_SEED={seed}");
    let trusted = test_key("fuzz");
    let other = test_key("other");
    let store = TrustStore::with_test_keys(true, Some(&format!("fuzz={}", trusted.public_b64)))
        .expect("the test key parses");
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
    // The manifests the trusted key signed: the only ones a first-party result may carry.
    let signed: Vec<Vec<u8>> = corpus
        .iter()
        .filter(|pkg| {
            inspect_reader(&mut Cursor::new(pkg), &policy)
                .unwrap()
                .trust
                .tier
                == Tier::FirstParty
        })
        .map(|pkg| manifest_of(pkg, &policy))
        .collect();
    assert_eq!(signed.len(), 4, "four seeds are signed by the trusted key");

    let mut rng = Rng(seed);
    let deadline = Instant::now() + Duration::from_secs(seconds);
    let mut iterations: u64 = 0;
    let (mut accepted, mut first_party) = (0u64, 0u64);
    while Instant::now() < deadline {
        let base = &corpus[rng.below(corpus.len())];
        let other_pkg = &corpus[rng.below(corpus.len())];
        let mut m = mutate(&mut rng, base, other_pkg);
        // Stack a few mutations now and then.
        for _ in 0..rng.below(3) {
            if !m.is_empty() {
                m = mutate(&mut rng, &m, other_pkg);
            }
        }
        iterations += 1;
        let result = catch_unwind(AssertUnwindSafe(|| {
            inspect_reader(&mut Cursor::new(&m), &policy)
        }));
        match result {
            Err(_) => panic!(
                "inspect_reader panicked at iteration {iterations}; replay with PLUR1BUS_FUZZ_SEED={seed}"
            ),
            Ok(Ok(i)) => {
                accepted += 1;
                if i.trust.tier == Tier::FirstParty {
                    first_party += 1;
                    assert!(
                        signed.contains(&i.manifest_raw),
                        "a mutant was accepted as first-party with a manifest nobody signed \
                         (iteration {iterations}); replay with PLUR1BUS_FUZZ_SEED={seed}"
                    );
                }
            }
            Ok(Err(_)) => {}
        }
    }
    println!(
        "fuzz: {iterations} iterations in {seconds} s (seed {seed}); {accepted} mutants accepted, {first_party} as first-party"
    );
    iterations
}

#[test]
#[ignore = "long-running; the nightly ext-fuzz job runs it with PLUR1BUS_FUZZ_SECONDS=600"]
fn fuzz_inspect_never_panics_and_never_accepts_a_mutant_as_first_party() {
    let seconds = std::env::var("PLUR1BUS_FUZZ_SECONDS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(20);
    assert!(run(seconds) > 0);
}

#[test]
fn fuzz_smoke() {
    assert!(run(2) > 0);
}
