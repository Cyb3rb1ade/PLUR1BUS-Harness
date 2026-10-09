//! Stand-in for `crates/plur1bus/src/audit.rs`: the included parser files reach `crate::audit::create_private` only
#![allow(dead_code)]
//! from their writer functions, which no target calls. Plain create, same signature.
use std::{fs, io, path::Path};

pub(crate) fn create_private(path: &Path, truncate: bool) -> io::Result<fs::File> {
    fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(truncate)
        .open(path)
}
