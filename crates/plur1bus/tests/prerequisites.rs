#[path = "common/prerequisites.rs"]
mod prerequisites;

#[test]
fn missing_audit_dependencies_fail_with_install_guidance() {
    let root = tempfile::tempdir().unwrap();
    let audit = root.path().join("packages/core/src/audit");
    std::fs::create_dir_all(&audit).unwrap();
    std::fs::write(
        audit.join("chain.ts"),
        include_str!("../../../packages/core/src/audit/chain.ts"),
    )
    .unwrap();
    let failure = std::panic::catch_unwind(|| prerequisites::require("audit", root.path()));
    let error = failure.expect_err("missing audit dependencies must fail, not skip");
    let message = error.downcast_ref::<String>().unwrap();
    assert!(message.contains("@plur1bus/module-api"), "{message}");
    assert!(
        message.contains("pnpm install --frozen-lockfile"),
        "{message}"
    );
    assert!(message.contains("pnpm test:prep"), "{message}");
}

#[test]
fn missing_core_build_fails_with_build_guidance() {
    let root = tempfile::tempdir().unwrap();
    let failure = std::panic::catch_unwind(|| prerequisites::require("core", root.path()));
    let error = failure.expect_err("missing core build must fail, not skip");
    let message = error.downcast_ref::<String>().unwrap();
    assert!(message.contains("packages/core/dist/core.js"), "{message}");
    assert!(message.contains("pnpm build"), "{message}");
    assert!(message.contains("pnpm test:prep"), "{message}");
}
