//! Port of the core's configuration modules: load and validation, warnings, the module disclosure policy, the engine
//! configuration, and the configuration source with its patch flattener.
pub mod disclosure;
pub mod endpoint;
pub mod engine;
pub mod load;
pub mod patch;
pub mod policy;
pub mod privacy_doctor;
pub mod source;
#[cfg(test)]
mod vectors;
pub mod warnings;
