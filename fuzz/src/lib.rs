//! Fuzz target bodies for the parsers of the PLUR1BUS Harness (docs/fuzzing.md). Each `pub fn run(&[u8])` is the whole
//! target; `fuzz_targets/<name>.rs` only wraps it in `fuzz_target!`, and `tests/seeds.rs` runs it over the committed
//! seed corpus on a stable toolchain.
pub mod backup_manifest;
pub mod config_parse;
pub mod ext_manifest;
pub mod install_manifest;
pub mod log_record;
pub mod rpc_message;

// The `plur1bus` binary crate has no lib target; these include its parser sources by path (see each file).
mod audit;
mod backup;
mod install;
mod paths;
