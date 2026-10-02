//! Keep Tauri's MSVC CRT shim out of transitive native-library search paths.
use std::{
    fs, io,
    path::{Path, PathBuf},
};

pub fn isolate_msvcrt_shim(out_dir: &Path) -> io::Result<Option<PathBuf>> {
    let shim = out_dir.join("msvcrt.lib");
    if !shim.try_exists()? {
        // tauri-build only creates this shim for x86/x64 MSVC static CRT builds.
        return Ok(None);
    }
    let private = out_dir.join("tauri-static-vcruntime");
    fs::create_dir_all(&private)?;
    // A build-script rerun creates a fresh shim. Copy replaces the previous one
    // on Windows too, where rename cannot overwrite an existing destination.
    fs::copy(&shim, private.join("msvcrt.lib"))?;
    fs::remove_file(&shim)?;
    Ok(Some(private))
}
