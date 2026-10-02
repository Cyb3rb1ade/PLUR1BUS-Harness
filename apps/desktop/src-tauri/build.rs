mod build_support;

fn main() {
    tauri_build::build();
    println!("cargo:rerun-if-changed=build_support.rs");

    // tauri-build 2.7.0 exports OUT_DIR with rustc-link-search, but its matching
    // static-CRT rustc-link-arg flags are package-local. A downstream executable
    // would otherwise find the synthetic msvcrt.lib without those CRT flags.
    // Preserve Tauri's flags and shim, exposing its new path only to our targets.
    // See tauri-build/src/static_vcruntime.rs and Cargo's rustc-link-arg contract.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("Cargo OUT_DIR"));
        if let Some(private) = build_support::isolate_msvcrt_shim(&out)
            .expect("isolate Tauri static CRT shim from dependent targets")
        {
            println!("cargo:rustc-link-arg=/LIBPATH:{}", private.display());
        }
    }
}
