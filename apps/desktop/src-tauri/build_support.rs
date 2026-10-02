//! Keep Tauri's Windows resource and MSVC CRT linkage within this package.
use std::{
    fs, io,
    path::{Path, PathBuf},
};

pub fn example_resource_link_arg(
    target_os: &str,
    target_env: &str,
    out_dir: &Path,
) -> io::Result<Option<String>> {
    if target_os != "windows" || target_env != "msvc" {
        return Ok(None);
    }
    // tauri-build 2.7.0 -> tauri-winres 0.3.6 -> embed-resource 3.0.11
    // compiles resource.rc into resource.lib on MSVC. Its existing bins-only
    // linker instruction omits our diagnostic examples (on x64 and ARM alike).
    let resource = out_dir.join("resource.lib");
    let metadata = fs::symlink_metadata(&resource).map_err(|error| {
        io::Error::new(
            error.kind(),
            format!(
                "generated Tauri Windows resource {}: {error}",
                resource.display()
            ),
        )
    })?;
    if !metadata.file_type().is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "generated Tauri Windows resource is not a regular file: {}",
                resource.display()
            ),
        ));
    }
    Ok(Some(format!(
        "cargo:rustc-link-arg-examples={}",
        resource.display()
    )))
}

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
