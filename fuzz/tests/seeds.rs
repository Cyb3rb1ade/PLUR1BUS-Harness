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
