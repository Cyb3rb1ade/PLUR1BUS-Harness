//! Runs every fuzz target body over its committed seed corpus (`fuzz/seeds/<target>/`) on a stable toolchain, plus a
//! fixed number of deterministic mutations of each seed (seeded xorshift: byte flips, truncation, splices), so the
//! code paths run without libFuzzer. `cargo test --manifest-path fuzz/Cargo.toml`.
use std::path::PathBuf;

fn seeds(target: &str) -> Vec<(String, Vec<u8>)> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("seeds")
        .join(target);
    let mut out: Vec<_> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("{}: {e}", dir.display()))
        .map(|e| {
            let p = e.unwrap().path();
            (
                p.file_name().unwrap().to_string_lossy().into_owned(),
                std::fs::read(&p).unwrap(),
            )
        })
        .collect();
    out.sort();
    assert!(!out.is_empty(), "no seeds for {target}");
    out
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
}

fn mutate(rng: &mut Rng, seed: &[u8], other: &[u8]) -> Vec<u8> {
    let mut v = seed.to_vec();
    for _ in 0..1 + rng.next() % 4 {
        let n = v.len().max(1) as u64;
        match rng.next() % 5 {
            0 if !v.is_empty() => {
                let i = (rng.next() % n) as usize;
                v[i] ^= 1 << (rng.next() % 8);
            }
            1 if !v.is_empty() => {
                let i = (rng.next() % n) as usize;
                v[i] = rng.next() as u8;
            }
            2 => v.truncate((rng.next() % (n + 1)) as usize),
            3 if !other.is_empty() => {
                let i = (rng.next() % (v.len() as u64 + 1)) as usize;
                let a = (rng.next() % other.len() as u64) as usize;
                let b = (a + (rng.next() % 32) as usize).min(other.len());
                v.splice(i..i, other[a..b].iter().copied());
            }
            _ if !v.is_empty() => {
                let i = (rng.next() % n) as usize;
                v.remove(i);
            }
            _ => {}
        }
    }
    v
}

fn drive(target: &str, run: fn(&[u8])) {
    let all = seeds(target);
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    for (i, (name, data)) in all.iter().enumerate() {
        run(data);
        for round in 0..24 {
            let other = &all[(i + 1 + round) % all.len()].1;
            let m = mutate(&mut rng, data, other);
            let r = std::panic::catch_unwind(|| run(&m));
            if r.is_err() {
                let out = std::env::temp_dir().join(format!("fuzz-{target}-{name}-{round}.bin"));
                let _ = std::fs::write(&out, &m);
                panic!(
                    "{target}: mutant {round} of seed {name} panicked; input saved to {}",
                    out.display()
                );
            }
        }
    }
}

#[test]
fn rpc_message() {
    drive("rpc_message", plur1bus_fuzz::rpc_message::run);
}
/// libFuzzer rejects a dictionary line it cannot parse and the whole target then exits 1 (nightly run 39389723993:
/// `ParseDictionaryFile: error in line 29`). A line is empty, a `#` comment, or `[name]="value"` where the value only knows
/// the escapes `\\`, `\"` and `\xHH`: no `\n`, `\t`, `\r` and no raw control byte.
#[test]
fn dictionaries_parse_like_libfuzzer() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("dicts");
    let mut n = 0;
    for entry in std::fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|e| e.to_str()) != Some("dict") {
            continue;
        }
        n += 1;
        let text = std::fs::read_to_string(&path).unwrap();
        for (i, line) in text.lines().enumerate() {
            let at = format!("{}:{}: {line}", path.display(), i + 1);
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let (name, value) = line
                .split_once('=')
                .unwrap_or_else(|| panic!("no `=`: {at}"));
            assert!(
                name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'),
                "bad name: {at}"
            );
            let body = value
                .strip_prefix('"')
                .and_then(|v| v.strip_suffix('"'))
                .unwrap_or_else(|| panic!("value not quoted: {at}"));
            let b = body.as_bytes();
            let mut j = 0;
            while j < b.len() {
                match b[j] {
                    b'\\' => match b.get(j + 1) {
                        Some(b'\\' | b'"') => j += 2,
                        Some(b'x')
                            if b.get(j + 2..j + 4)
                                .is_some_and(|h| h.iter().all(u8::is_ascii_hexdigit)) =>
                        {
                            j += 4
                        }
                        _ => panic!("escape libFuzzer does not know: {at}"),
                    },
                    b'"' => panic!("unescaped quote: {at}"),
                    c if c < 0x20 || c == 0x7f => panic!("raw control byte: {at}"),
                    _ => j += 1,
                }
            }
        }
    }
    assert!(n >= 6, "dictionaries not found in {}", dir.display());
}

/// Nightly crash (run 39389723993): a repeated key. `Value` keeps the last one, a derived struct read from bytes refuses it,
/// which is not an inconsistency of the wire type (`Client` reads every line through `Value`, last one wins).
#[test]
fn rpc_message_repeated_key() {
    let dup = br#"{"jsonrpc":"2.0","method":"a","method":"b","params":{}}"#;
    assert!(serde_json::from_slice::<plur1bus_rpc::types::Notification>(dup).is_err());
    let v: serde_json::Value = serde_json::from_slice(dup).unwrap();
    assert!(serde_json::from_value::<plur1bus_rpc::types::Notification>(v).is_ok());
    // every selector (wire type) with the repeated key, plus the original crash input
    for sel in 0..9u8 {
        plur1bus_fuzz::rpc_message::run(&[&[sel][..], dup].concat());
    }
    plur1bus_fuzz::rpc_message::run(
        b"\x02{\"jsonrpc\": \"2.0\", \"method\": \"core.js\\\"\", \"method\": \"codnevent\", \"params\": {\"x\": 0}}",
    );
}
#[test]
fn config_parse() {
    drive("config_parse", plur1bus_fuzz::config_parse::run);
}
#[test]
fn backup_manifest() {
    drive("backup_manifest", plur1bus_fuzz::backup_manifest::run);
}
#[test]
fn install_manifest() {
    drive("install_manifest", plur1bus_fuzz::install_manifest::run);
}
#[test]
fn ext_manifest() {
    drive("ext_manifest", plur1bus_fuzz::ext_manifest::run);
}
#[test]
fn log_record() {
    drive("log_record", plur1bus_fuzz::log_record::run);
}
