#[path = "../build_support.rs"]
mod build_support;

fn tauri_output(out: &std::path::Path) -> String {
    format!(
        "cargo:rustc-cfg=desktop\ncargo:rustc-link-arg-bins={}\r\ncargo:rustc-link-arg=/DEFAULTLIB:libcmt.lib\ncargo:rustc-link-search=native={}\ncargo:rerun-if-changed=tauri.conf.json\n",
        out.join("resource.lib").display(), out.display()
    )
}

#[test]
fn windows_msvc_resource_scope_preserves_every_other_output_and_resource() {
    // Both CI architectures have the same target OS/env contract; the resource
    // is the matching target's already compiled output, never a host library.
    for arch in ["x86_64", "aarch64"] {
        let out = tempfile::Builder::new().prefix(arch).tempdir().unwrap();
        let resource = out.path().join("resource.lib");
        std::fs::write(&resource, b"generated manifest resource").unwrap();
        std::fs::write(out.path().join("msvcrt.lib"), b"private CRT source").unwrap();
        std::fs::write(out.path().join("resource.rc"), b"generated main resource").unwrap();
        std::fs::create_dir(out.path().join("capabilities")).unwrap();
        let original = tauri_output(out.path());
        let output =
            build_support::windows_resource_link_output("windows", "msvc", out.path(), &original)
                .unwrap();
        assert_eq!(
            output,
            original.replace("rustc-link-arg-bins=", "rustc-link-arg=")
        );
        assert_eq!(output.matches("resource.lib").count(), 1);
        assert_eq!(
            std::fs::read(&resource).unwrap(),
            b"generated manifest resource"
        );
        assert_eq!(
            std::fs::read(out.path().join("msvcrt.lib")).unwrap(),
            b"private CRT source"
        );
        assert_eq!(
            std::fs::read(out.path().join("resource.rc")).unwrap(),
            b"generated main resource"
        );
        assert!(out.path().join("capabilities").is_dir());
        assert_eq!(std::fs::read_dir(out.path()).unwrap().count(), 4);
    }
}

#[test]
fn resource_named_directories_preserve_unrelated_search_output() {
    let root = tempfile::tempdir().unwrap();
    let out = root.path().join("resource.library");
    std::fs::create_dir(&out).unwrap();
    std::fs::write(out.join("resource.lib"), b"generated manifest resource").unwrap();
    let original = format!(
        "cargo:rustc-link-search=native={}\r\ncargo::rustc-link-search=all=C:\\work\\resource.library\\cache\r\ncargo:rustc-link-search=C:\\work\\resource.lib\r\ncargo:rustc-link-arg=/LIBPATH:C:\\work\\resource.lib\r\ncargo:rustc-link-arg=/DEFAULTLIB:C:\\work\\resource.library\\libcmt.lib\r\ncargo:rustc-link-arg-bin=resource.lib-launcher=/DEFAULTLIB:libcmt.lib\r\ncargo:warning=rustc-link-arg=resource.lib\r\ncargo:rustc-link-arg-bins={}\r\ncargo:rerun-if-changed=tauri.conf.json\r\n",
        out.display(), out.join("resource.lib").display()
    );
    let output =
        build_support::windows_resource_link_output("windows", "msvc", &out, &original).unwrap();
    assert_eq!(
        output,
        original.replacen("cargo:rustc-link-arg-bins=", "cargo:rustc-link-arg=", 1)
    );
    assert_eq!(
        std::fs::read(out.join("resource.lib")).unwrap(),
        b"generated manifest resource"
    );
}

#[test]
fn missing_windows_msvc_generated_resource_fails_without_falling_back() {
    let out = tempfile::tempdir().unwrap();
    std::fs::write(
        out.path().join("another.lib"),
        b"not the generated resource",
    )
    .unwrap();
    let error = build_support::windows_resource_link_output(
        "windows",
        "msvc",
        out.path(),
        &tauri_output(out.path()),
    )
    .unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    assert_eq!(std::fs::read_dir(out.path()).unwrap().count(), 1);
}

#[test]
fn nonregular_windows_msvc_generated_resource_fails_without_mutating_it() {
    let out = tempfile::tempdir().unwrap();
    std::fs::create_dir(out.path().join("resource.lib")).unwrap();
    let error = build_support::windows_resource_link_output(
        "windows",
        "msvc",
        out.path(),
        &tauri_output(out.path()),
    )
    .unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    assert!(out.path().join("resource.lib").is_dir());
}

#[cfg(unix)]
#[test]
fn symlink_is_not_a_generated_regular_resource() {
    let out = tempfile::tempdir().unwrap();
    let unrelated = out.path().join("another.lib");
    std::fs::write(&unrelated, b"not the generated resource").unwrap();
    std::os::unix::fs::symlink(&unrelated, out.path().join("resource.lib")).unwrap();
    let error = build_support::windows_resource_link_output(
        "windows",
        "msvc",
        out.path(),
        &tauri_output(out.path()),
    )
    .unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    assert_eq!(
        std::fs::read(unrelated).unwrap(),
        b"not the generated resource"
    );
}

#[test]
fn other_targets_need_no_windows_resource_or_link_instruction() {
    let out = tempfile::tempdir().unwrap();
    for (os, env) in [("macos", ""), ("linux", "gnu"), ("windows", "gnu")] {
        assert_eq!(
            build_support::windows_resource_link_output(os, env, out.path(), "unchanged\r\n")
                .unwrap(),
            "unchanged\r\n"
        );
    }
    assert_eq!(std::fs::read_dir(out.path()).unwrap().count(), 0);
}

#[cfg(all(target_os = "windows", target_env = "msvc"))]
#[test]
fn windows_build_has_the_real_tauri_resource() {
    let out = std::path::Path::new(env!("OUT_DIR"));
    assert!(std::fs::symlink_metadata(out.join("resource.lib"))
        .unwrap()
        .file_type()
        .is_file());
    assert_eq!(
        build_support::windows_resource_link_output("windows", "msvc", out, &tauri_output(out))
            .unwrap()
            .matches("resource.lib")
            .count(),
        1
    );
}

#[test]
fn missing_duplicate_or_changed_resource_directives_fail_closed() {
    let out = tempfile::tempdir().unwrap();
    std::fs::write(out.path().join("resource.lib"), b"generated resource").unwrap();
    let original = tauri_output(out.path());
    for output in [
        String::new(),
        original.repeat(2),
        original.replace("rustc-link-arg-bins", "rustc-link-arg"),
        original.replace("rustc-link-arg-bins", "rustc-link-arg-examples"),
        original.replace("resource.lib", "another.lib"),
        format!(
            "{original}cargo:rustc-link-arg={}\n",
            out.path().join("resource.lib").display()
        ),
        format!("{original}cargo::rustc-link-lib=dylib=resource\n"),
    ] {
        let error =
            build_support::windows_resource_link_output("windows", "msvc", out.path(), &output)
                .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData, "{output}");
    }
    assert_eq!(
        std::fs::read(out.path().join("resource.lib")).unwrap(),
        b"generated resource"
    );
}

#[test]
fn resource_input_directives_still_fail_closed_with_resource_named_directories() {
    let root = tempfile::tempdir().unwrap();
    let out = root.path().join("resource.library");
    std::fs::create_dir(&out).unwrap();
    std::fs::write(out.join("resource.lib"), b"generated resource").unwrap();
    let original = tauri_output(&out);
    // The valid search directive in this baseline must be accepted first;
    // every rejection below must come from the additional resource input.
    assert!(
        build_support::windows_resource_link_output("windows", "msvc", &out, &original).is_ok()
    );
    for input in [
        "rustc-link-arg=C:\\work\\resource.library\\resource.lib",
        "rustc-link-arg-bins=resource.lib",
        "rustc-link-arg-tests=resource.lib",
        "rustc-link-arg-examples=resource.lib",
        "rustc-link-arg-benches=resource.lib",
        "rustc-link-arg-cdylib=resource.lib",
        "rustc-cdylib-link-arg=resource.lib",
        "rustc-link-arg-bin=main=resource.lib",
        "rustc-link-arg=/DEFAULTLIB:resource.lib",
        "rustc-link-arg=/wholearchive:\"C:\\work\\resource.library\\RESOURCE.LIB\"",
        "rustc-link-lib=resource",
        "rustc-link-lib=dylib=resource",
        "rustc-link-lib=static:+verbatim=resource.lib",
        "rustc-link-lib=static=resource:renamed",
    ] {
        for prefix in ["cargo:", "cargo::"] {
            let output = format!("{original}{prefix}{input}\r\n");
            let error =
                build_support::windows_resource_link_output("windows", "msvc", &out, &output)
                    .unwrap_err();
            assert_eq!(error.kind(), std::io::ErrorKind::InvalidData, "{output}");
        }
    }
}

#[cfg(unix)]
#[test]
fn resource_paths_that_cannot_form_a_cargo_directive_fail_closed() {
    use std::os::unix::ffi::OsStringExt;
    let out = tempfile::tempdir().unwrap();
    for name in [
        std::ffi::OsString::from("line\nfeed"),
        std::ffi::OsString::from("carriage\rreturn"),
        std::ffi::OsString::from_vec(vec![0xff]),
    ] {
        let path = out.path().join(name);
        // Reject before filesystem access; macOS itself cannot create a
        // filename containing an invalid UTF-8 byte sequence.
        let error =
            build_support::windows_resource_link_output("windows", "msvc", &path, "").unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    }
}

#[test]
fn tauri_msvcrt_shim_is_private_and_reruns_replace_it() {
    let out = tempfile::tempdir().unwrap();
    let resource = out.path().join("resource.lib");
    let capabilities = out.path().join("capabilities");
    std::fs::write(&resource, b"unrelated resource").unwrap();
    std::fs::create_dir(&capabilities).unwrap();
    std::fs::write(capabilities.join("shell.json"), b"unrelated capability").unwrap();
    // Run on Windows too: replacing an existing destination is significant.
    for contents in [
        b"first synthetic shim".as_slice(),
        b"replacement shim".as_slice(),
    ] {
        std::fs::write(out.path().join("msvcrt.lib"), contents).unwrap();
        let private = build_support::isolate_msvcrt_shim(out.path())
            .unwrap()
            .unwrap();
        assert_eq!(private.parent(), Some(out.path()));
        assert_ne!(private, out.path());
        assert!(!out.path().join("msvcrt.lib").exists());
        assert_eq!(std::fs::read(private.join("msvcrt.lib")).unwrap(), contents);
        assert_eq!(std::fs::read(&resource).unwrap(), b"unrelated resource");
        assert_eq!(
            std::fs::read(capabilities.join("shell.json")).unwrap(),
            b"unrelated capability"
        );
    }
}

#[test]
fn absent_shim_needs_no_linker_path_or_directory() {
    let out = tempfile::tempdir().unwrap();
    assert!(build_support::isolate_msvcrt_shim(out.path())
        .unwrap()
        .is_none());
    assert_eq!(std::fs::read_dir(out.path()).unwrap().count(), 0);
}

#[cfg(all(
    target_os = "windows",
    target_env = "msvc",
    any(target_arch = "x86", target_arch = "x86_64")
))]
#[test]
fn windows_build_keeps_real_tauri_shim_out_of_exported_search_directory() {
    // Exercise the actual build-script result under the project's default static
    // CRT config. A downstream test-bins target must find the toolchain CRT,
    // while desktop targets retain this exact architecture-specific Tauri shim.
    let out = std::path::Path::new(env!("OUT_DIR"));
    assert!(!out.join("msvcrt.lib").exists());
    let shim = std::fs::read(out.join("tauri-static-vcruntime/msvcrt.lib")).unwrap();
    let expected = if cfg!(target_arch = "x86_64") {
        [0x64, 0x86]
    } else {
        [0x4c, 0x01]
    };
    assert_eq!(shim.get(..2), Some(expected.as_slice()));
}

#[test]
fn relocation_failure_preserves_source_and_fails_build() {
    let out = tempfile::tempdir().unwrap();
    std::fs::write(out.path().join("msvcrt.lib"), b"original shim").unwrap();
    std::fs::write(out.path().join("tauri-static-vcruntime"), b"blocking file").unwrap();
    assert!(build_support::isolate_msvcrt_shim(out.path()).is_err());
    assert_eq!(
        std::fs::read(out.path().join("msvcrt.lib")).unwrap(),
        b"original shim"
    );
}

struct CargoLinkProbe {
    root: tempfile::TempDir,
}

impl CargoLinkProbe {
    fn new() -> Self {
        let root = tempfile::Builder::new()
            .prefix("desktop cargo link scope ")
            .tempdir()
            .unwrap();
        let write = |path: &str, contents: &str| {
            let path = root.path().join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, contents).unwrap();
        };
        write(
            "Cargo.toml",
            "[workspace]\nresolver = '2'\nmembers = ['owner', 'consumer']\n",
        );
        write(
            "owner/Cargo.toml",
            "[package]\nname = 'resource-owner'\nversion = '0.0.0'\nedition = '2021'\n",
        );
        // Compile the real build script and helper against a dependency-free
        // stand-in for pinned Tauri's resource emission. Only this fixture uses
        // a native object in place of a Windows .res, and selects MSVC handling
        // on every host. This exercises Cargo scope, not Windows resource tools.
        write("owner/desktop-build.rs", include_str!("../build.rs"));
        write(
            "owner/build_support.rs",
            include_str!("../build_support.rs"),
        );
        write(
            "owner/src/shell_commands.rs",
            include_str!("../src/shell_commands.rs"),
        );
        write(
            "owner/build.rs",
            r##"
mod tauri_build {
    pub struct Attributes;
    impl Attributes {
        pub fn new() -> Self { Self }
        pub fn app_manifest(self, _: AppManifest) -> Self { self }
    }
    pub struct AppManifest;
    impl AppManifest {
        pub fn new() -> Self { Self }
        pub fn commands(self, _: &[&str]) -> Self { self }
    }
    pub fn try_build(_: Attributes) -> std::io::Result<()> {
        let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
        println!("cargo:rerun-if-env-changed=PLUR1BUS_LINK_PROBE_FAIL");
        println!("cargo:rustc-env=PLUR1BUS_LINK_PROBE_METADATA=retained");
        if std::env::var_os("PLUR1BUS_LINK_PROBE_FAIL").is_some() {
            eprintln!("resource probe child failure");
            return Err(std::io::Error::other("resource probe rejected build"));
        }
        std::fs::write(out.join("invocation.txt"),
            std::env::args().skip(1).collect::<Vec<_>>().join("\n"))?;
        let source = out.join("resource.rs");
        std::fs::write(&source, "#![no_std]\n#[no_mangle] pub extern \"C\" fn resource_marker() -> u8 { 73 }\n")?;
        let resource = out.join("resource.lib");
        let status = std::process::Command::new(std::env::var_os("RUSTC").unwrap())
            .args(["--crate-name", "scope_resource", "--crate-type=lib", "--emit=obj", "--target"])
            .arg(std::env::var_os("TARGET").unwrap())
            .arg(&source).arg("-o").arg(&resource).status()?;
        assert!(status.success());
        println!("cargo:rustc-link-arg-bins={}", resource.display());
        println!("cargo:rustc-env=PLUR1BUS_LINK_PROBE_AFTER=retained");
        Ok(())
    }
}
mod desktop_build {
    use crate::tauri_build;
    include!("desktop-build.rs");
    pub fn run() { main(); }
}
fn main() {
    std::env::set_var("CARGO_CFG_TARGET_OS", "windows");
    std::env::set_var("CARGO_CFG_TARGET_ENV", "msvc");
    desktop_build::run();
}
"##,
        );
        let marker_test = r#"
#[test]
fn linked_resource_is_available() {
    extern "C" { fn resource_marker() -> u8; }
    assert_eq!(unsafe { resource_marker() }, 73);
    assert_eq!(env!("PLUR1BUS_LINK_PROBE_METADATA"), "retained");
    assert_eq!(env!("PLUR1BUS_LINK_PROBE_AFTER"), "retained");
}
"#;
        write(
            "owner/src/lib.rs",
            &format!("pub fn public_value() -> u8 {{ 7 }}\n{marker_test}"),
        );
        let executable = format!(
            "extern \"C\" {{ fn resource_marker() -> u8; }}\nfn main() {{ assert_eq!(unsafe {{ resource_marker() }}, 73); }}\n{marker_test}"
        );
        write("owner/src/main.rs", &executable);
        write("owner/examples/diagnostic.rs", &executable);
        write("owner/tests/integration.rs", marker_test);
        write(
            "consumer/Cargo.toml",
            "[package]\nname = 'resource-consumer'\nversion = '0.0.0'\nedition = '2021'\n[dependencies]\nresource-owner = { path = '../owner' }\n",
        );
        write(
            "consumer/src/main.rs",
            "fn main() { assert_eq!(resource_owner::public_value(), 7); }\n",
        );
        let probe = Self { root };
        let lock = probe.cargo(&["generate-lockfile", "--offline"], false);
        assert!(lock.status.success(), "{lock:?}");
        probe
    }

    fn cargo(&self, args: &[&str], fail_build: bool) -> std::process::Output {
        let mut command = std::process::Command::new(env!("CARGO"));
        command
            .current_dir(self.root.path())
            // CI may force colors; inspected verbose Cargo lines must stay plain.
            .args(["--color", "never"])
            .args(args)
            .env("CARGO_TARGET_DIR", self.root.path().join("target"))
            .env_remove("CARGO_BUILD_TARGET")
            .env_remove("RUSTFLAGS")
            .env_remove("CARGO_ENCODED_RUSTFLAGS")
            .env_remove("PLUR1BUS_LINK_PROBE_FAIL");
        if fail_build {
            command.env("PLUR1BUS_LINK_PROBE_FAIL", "1");
        }
        command.output().unwrap()
    }
}

#[test]
fn cargo_links_resource_once_into_library_tests_integrations_bins_and_examples() {
    let probe = CargoLinkProbe::new();
    let mut failures = Vec::new();
    for target in ["--lib", "--test=integration"] {
        let output = probe.cargo(
            &[
                "test",
                "--locked",
                "--offline",
                "-p",
                "resource-owner",
                target,
            ],
            false,
        );
        if !output.status.success() {
            failures.push(format!(
                "{target}: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    // Compile fresh targets with verbose rustc invocations as well as linking
    // and running their tests. A repeated object also has a duplicate symbol.
    let clean = probe.cargo(&["clean", "--offline"], false);
    assert!(clean.status.success(), "{clean:?}");
    let mut log = String::new();
    for args in [
        vec!["test", "--workspace", "--all-targets"],
        vec!["build", "--workspace", "--bins", "--examples"],
    ] {
        let mut args = args;
        args.extend(["--locked", "--offline", "-vv"]);
        let output = probe.cargo(&args, false);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(output.status.success(), "{args:?}: {stderr}");
        log.push_str(&stderr.replace('\\', "/"));
    }
    for (source, test) in [
        ("src/lib.rs", true),
        ("tests/integration.rs", true),
        ("src/main.rs", true),
        ("src/main.rs", false),
        ("examples/diagnostic.rs", true),
        ("examples/diagnostic.rs", false),
    ] {
        let invocations: Vec<_> = log
            .lines()
            .filter(|line| {
                line.contains("Running `")
                    && line.contains("--crate-name")
                    && !line.contains("--crate-name resource_consumer")
                    && line.contains(source)
                    && line.contains(" --test ") == test
            })
            .collect();
        assert!(
            !invocations.is_empty(),
            "missing invocation: {source}, test={test}\n{log}"
        );
        for line in invocations {
            assert_eq!(line.matches("resource.lib").count(), 1, "{line}");
        }
        eprintln!("Cargo scope verified: {source}, test={test}, one resource input");
    }
    let consumer: Vec<_> = log
        .lines()
        .filter(|line| {
            line.contains("Running `") && line.contains("--crate-name resource_consumer")
        })
        .collect();
    assert!(!consumer.is_empty(), "missing dependent-package invocation");
    assert!(consumer.iter().all(|line| !line.contains("resource.lib")));

    let build_outputs: Vec<_> = std::fs::read_dir(probe.root.path().join("target/debug/build"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.join("out/invocation.txt").is_file())
        .collect();
    assert!(!build_outputs.is_empty());
    for build in build_outputs {
        // The actual build script re-enters its own executable exactly through
        // its private child mode, with output replayed in its original order.
        assert_eq!(
            std::fs::read_to_string(build.join("out/invocation.txt")).unwrap(),
            "--plur1bus-tauri-build"
        );
        let output = std::fs::read_to_string(build.join("output")).unwrap();
        assert_eq!(output.matches("resource.lib").count(), 1, "{output}");
        assert!(!output.contains("rustc-link-arg-bins"));
        assert!(!output.contains("rustc-link-arg-examples"));
        let before = output.find("PLUR1BUS_LINK_PROBE_METADATA").unwrap();
        let resource = output.find("cargo:rustc-link-arg=").unwrap();
        let after = output.find("PLUR1BUS_LINK_PROBE_AFTER").unwrap();
        assert!(before < resource && resource < after, "{output}");
    }
    eprintln!("Cargo scope verified: dependent package has no resource input; real child dispatch and output order preserved");
}

#[test]
fn failed_tauri_child_preserves_its_error_stdout_and_exit() {
    let probe = CargoLinkProbe::new();
    let output = probe.cargo(
        &["check", "--locked", "--offline", "-p", "resource-owner"],
        true,
    );
    assert_eq!(output.status.code(), Some(101));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("exit status: 101") || stderr.contains("exit code: 101"),
        "{stderr}"
    );
    assert_eq!(
        stderr.matches("resource probe child failure").count(),
        1,
        "{stderr}"
    );
    assert_eq!(
        stderr
            .matches("desktop application ACL generation failed")
            .count(),
        1,
        "{stderr}"
    );
    assert!(
        stderr.contains("PLUR1BUS_LINK_PROBE_METADATA=retained"),
        "{stderr}"
    );
    assert!(
        !stderr.contains("cargo:rerun-if-changed=build_support.rs"),
        "{stderr}"
    );
}
