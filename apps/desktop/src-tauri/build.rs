mod build_support;
#[path = "src/shell_commands.rs"]
mod shell_commands;

fn main() {
    let _ = shell_commands::SHELL_COMMANDS;
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(shell_commands::APP_COMMANDS)),
    )
    .expect("desktop application ACL generation failed");
    println!("cargo:rerun-if-changed=build_support.rs");

    let target_os = std::env::var("CARGO_CFG_TARGET_OS").expect("Cargo target OS");
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").expect("Cargo target environment");
    let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("Cargo OUT_DIR"));
    if let Some(directive) = build_support::example_resource_link_arg(&target_os, &target_env, &out)
        .expect("link generated Tauri Windows manifest resource into diagnostic examples")
    {
        // Adds the same resource only to this package's examples. Tauri's main
        // binary instruction and downstream test binaries remain unchanged.
        println!("{directive}");
    }

    // tauri-build 2.7.0 exports OUT_DIR with rustc-link-search, but its matching
    // static-CRT rustc-link-arg flags are package-local. A downstream executable
    // would otherwise find the synthetic msvcrt.lib without those CRT flags.
    // Preserve Tauri's flags and shim, exposing its new path only to our targets.
    // See tauri-build/src/static_vcruntime.rs and Cargo's rustc-link-arg contract.
    if target_os == "windows" && target_env == "msvc" {
        if let Some(private) = build_support::isolate_msvcrt_shim(&out)
            .expect("isolate Tauri static CRT shim from dependent targets")
        {
            println!("cargo:rustc-link-arg=/LIBPATH:{}", private.display());
        }
    }
}
