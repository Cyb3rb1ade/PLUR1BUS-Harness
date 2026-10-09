//! See docs/fuzzing.md. The body lives in `plur1bus_fuzz::backup_manifest` so a stable test can run it over the seed corpus.
#![no_main]
use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| plur1bus_fuzz::backup_manifest::run(data));
