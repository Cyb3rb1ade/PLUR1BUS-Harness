#[path = "../build_support.rs"]
mod build_support;

#[test]
fn windows_msvc_examples_use_generated_resource_without_changing_other_outputs() {
    // Both CI architectures have the same target OS/env contract; the resource
    // is the matching target's already compiled output, never a host library.
    for arch in ["x86_64", "aarch64"] {
        let out = tempfile::Builder::new().prefix(arch).tempdir().unwrap();
        let resource = out.path().join("resource.lib");
        std::fs::write(&resource, b"generated manifest resource").unwrap();
        std::fs::write(out.path().join("msvcrt.lib"), b"private CRT source").unwrap();
        std::fs::write(out.path().join("resource.rc"), b"generated main resource").unwrap();
        std::fs::create_dir(out.path().join("capabilities")).unwrap();
        let directive = build_support::example_resource_link_arg("windows", "msvc", out.path())
            .unwrap()
            .unwrap();
        assert_eq!(
            directive,
            format!("cargo:rustc-link-arg-examples={}", resource.display())
        );
        // This complete instruction is emitted directly by build.rs. It adds no
        // bins/test/global link flags or transitive native library search path.
        assert_eq!(directive.lines().count(), 1);
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
fn missing_windows_msvc_generated_resource_fails_without_falling_back() {
    let out = tempfile::tempdir().unwrap();
    std::fs::write(
        out.path().join("another.lib"),
        b"not the generated resource",
    )
    .unwrap();
    let error =
        build_support::example_resource_link_arg("windows", "msvc", out.path()).unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
    assert_eq!(std::fs::read_dir(out.path()).unwrap().count(), 1);
}

#[test]
fn nonregular_windows_msvc_generated_resource_fails_without_mutating_it() {
    let out = tempfile::tempdir().unwrap();
    std::fs::create_dir(out.path().join("resource.lib")).unwrap();
    let error =
        build_support::example_resource_link_arg("windows", "msvc", out.path()).unwrap_err();
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
    let error =
        build_support::example_resource_link_arg("windows", "msvc", out.path()).unwrap_err();
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
        assert!(
            build_support::example_resource_link_arg(os, env, out.path())
                .unwrap()
                .is_none()
        );
    }
    assert_eq!(std::fs::read_dir(out.path()).unwrap().count(), 0);
}

#[cfg(all(target_os = "windows", target_env = "msvc"))]
#[test]
fn windows_build_has_the_real_tauri_example_resource() {
    let out = std::path::Path::new(env!("OUT_DIR"));
    assert!(std::fs::symlink_metadata(out.join("resource.lib"))
        .unwrap()
        .file_type()
        .is_file());
    assert!(
        build_support::example_resource_link_arg("windows", "msvc", out)
            .unwrap()
            .is_some()
    );
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
