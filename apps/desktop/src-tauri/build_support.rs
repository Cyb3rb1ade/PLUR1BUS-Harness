//! Keep Tauri's Windows resource and MSVC CRT linkage within this package.
use std::{
    fs, io,
    path::{Path, PathBuf},
};

/// Widen exactly Tauri's generated MSVC resource directive, preserving all other output.
pub fn windows_resource_link_output(
    target_os: &str,
    target_env: &str,
    out_dir: &Path,
    output: &str,
) -> io::Result<String> {
    if target_os != "windows" || target_env != "msvc" {
        return Ok(output.to_owned());
    }
    // tauri-build 2.7.0 -> tauri-winres 0.3.6 -> embed-resource 3.0.11
    // runs rc.exe on resource.rc, naming the .res output resource.lib. Reuse it
    // unchanged, including Tauri's manifest, icon and version resources.
    let resource = out_dir.join("resource.lib");
    let resource_path = resource
        .to_str()
        .filter(|path| !path.contains(['\r', '\n']));
    let resource_path = resource_path.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid Tauri resource directive path",
        )
    })?;
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
    let expected = format!("cargo:rustc-link-arg-bins={resource_path}");
    let mut replacements = 0;
    let mut rewritten = String::with_capacity(output.len());
    for line in output.split_inclusive('\n') {
        if line.trim_end_matches(['\r', '\n']) == expected {
            replacements += 1;
            rewritten.push_str(&line.replacen("rustc-link-arg-bins=", "rustc-link-arg=", 1));
        } else {
            // Fail closed if the pinned dependency changes its resource output
            // shape; accepting an additional link input could duplicate it.
            if line.starts_with("cargo:")
                && line.contains("rustc-link-")
                && (line.contains("resource.lib")
                    || line.trim_end_matches(['\r', '\n']).ends_with("=resource"))
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "unexpected Tauri resource link directive",
                ));
            }
            rewritten.push_str(line);
        }
    }
    if replacements != 1 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "expected exactly one Tauri resource bins directive",
        ));
    }
    Ok(rewritten)
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
