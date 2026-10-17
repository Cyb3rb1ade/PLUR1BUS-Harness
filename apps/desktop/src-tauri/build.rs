mod build_keys;
mod build_support;
#[path = "src/shell_commands.rs"]
mod shell_commands;

const TAURI_BUILD_CHILD: &str = "--plur1bus-tauri-build";

fn generate_tauri_build() {
    let _ = shell_commands::SHELL_COMMANDS;
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(shell_commands::APP_COMMANDS)),
    )
    .expect("desktop application ACL generation failed");
}

fn main() {
    println!("cargo:rerun-if-env-changed=PLUR1BUS_DESKTOP_BUILD_CHANNEL");
    let channel =
        std::env::var("PLUR1BUS_DESKTOP_BUILD_CHANNEL").unwrap_or_else(|_| "stable".into());
    assert!(
        ["stable", "beta", "dev"].contains(&channel.as_str()),
        "invalid build channel"
    );
    assert!(
        channel != "dev" || std::env::var("PROFILE").as_deref() != Ok("release"),
        "dev channel requires a debug build"
    );
    println!("cargo:rustc-env=PLUR1BUS_DESKTOP_BUILD_CHANNEL={channel}");
    println!("cargo:rerun-if-env-changed=PLUR1BUS_DESKTOP_BUNDLE_MANIFEST");
    let bundle_bytes = if let Some(path) = std::env::var_os("PLUR1BUS_DESKTOP_BUNDLE_MANIFEST") {
        let metadata = std::fs::symlink_metadata(&path).expect("staged bundle metadata");
        assert!(
            metadata.is_file() && !metadata.file_type().is_symlink() && metadata.len() <= 131072,
            "staged bundle must be a bounded regular file"
        );
        println!(
            "cargo:rerun-if-changed={}",
            std::path::Path::new(&path).display()
        );
        std::fs::read(path).expect("staged bundle manifest")
    } else {
        include_bytes!("../bundle/bundle.json.tmpl").to_vec()
    };
    let staged_bundle: serde_json::Value =
        serde_json::from_slice(&bundle_bytes).expect("bundle JSON");
    let bundle_out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("Cargo OUT_DIR"));
    std::fs::write(bundle_out.join("bundle.json"), &bundle_bytes)
        .expect("write embedded bundle manifest");
    println!("cargo:rerun-if-changed=keys");
    println!("cargo:rerun-if-changed=build_keys.rs");
    build_keys::check(
        std::env::var("PROFILE").as_deref() == Ok("release"),
        std::env::var("PLUR1BUS_DESKTOP_ALLOW_PLACEHOLDER_KEY").as_deref() == Ok("1"),
        [
            include_str!("keys/stable.feed.pub"),
            include_str!("keys/beta.feed.pub"),
            include_str!("keys/stable.updater.pub"),
            include_str!("keys/beta.updater.pub"),
        ],
    )
    .expect("release update key guard");
    println!("cargo:rerun-if-changed=../bundle/bundle.json.tmpl");
    println!("cargo:rerun-if-env-changed=PLUR1BUS_DESKTOP_ALLOW_PLACEHOLDER_KEY");
    if std::env::var("PROFILE").as_deref() == Ok("release")
        && std::env::var("PLUR1BUS_DESKTOP_ALLOW_PLACEHOLDER_KEY").as_deref() != Ok("1")
    {
        let bundle = &staged_bundle;
        let placeholder = bundle["images"]
            .as_object()
            .expect("bundle images")
            .values()
            .any(|v| {
                v.as_str()
                    .is_none_or(|d| d == format!("sha256:{}", "0".repeat(64)))
            })
            || bundle["apple"]["pkgSha256"].as_str()
                == Some("0000000000000000000000000000000000000000000000000000000000000000");
        assert!(
            !placeholder,
            "release build refuses placeholder bundle digests"
        );
    }

    let target_os = std::env::var("CARGO_CFG_TARGET_OS").expect("Cargo target OS");
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").expect("Cargo target environment");
    let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("Cargo OUT_DIR"));
    if target_os == "windows" && target_env == "msvc" {
        if std::env::args_os().nth(1).as_deref() == Some(std::ffi::OsStr::new(TAURI_BUILD_CHILD)) {
            generate_tauri_build();
            return;
        }
        // Tauri has no resource-link-scope option. Capture its output in this
        // same host build-script executable, then replace only the resource's
        // bins-only directive. Adding a second directive would duplicate the
        // .res input for main; tests-only flags also miss the library unit test.
        let output = std::process::Command::new(std::env::current_exe().expect("build executable"))
            .arg(TAURI_BUILD_CHILD)
            .stderr(std::process::Stdio::inherit())
            .output()
            .expect("run Tauri resource and ACL generation");
        if !output.status.success() {
            use std::io::Write;
            let mut stdout = std::io::stdout().lock();
            stdout
                .write_all(&output.stdout)
                .expect("Tauri build output");
            stdout.flush().expect("flush Tauri build output");
            std::process::exit(output.status.code().unwrap_or(1));
        }
        let stdout = std::str::from_utf8(&output.stdout).expect("Tauri build output is UTF-8");
        print!(
            "{}",
            build_support::windows_resource_link_output(&target_os, &target_env, &out, stdout)
                .expect("link the generated Tauri resource once into all package executables")
        );
    } else {
        generate_tauri_build();
    }
    println!("cargo:rerun-if-changed=build_support.rs");

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
