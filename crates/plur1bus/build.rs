fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rerun-if-changed=src/bin/watchdog/kernel_identity.c");
        cc::Build::new()
            .file("src/bin/watchdog/kernel_identity.c")
            .compile("watchdog_kernel_identity");
    }
    for key in [
        "PLUR1BUS_ATTEST_SHA256",
        "PLUR1BUS_ATTEST_TEAM_ID",
        "PLUR1BUS_ATTEST_WIN_THUMBPRINT",
    ] {
        println!("cargo:rerun-if-env-changed={key}");
    }
    if std::env::var("PROFILE").as_deref() == Ok("release")
        && std::env::var("PLUR1BUS_ATTEST_SHA256")
            .unwrap_or_default()
            .is_empty()
    {
        println!("cargo:warning=Release build has no PLUR1BUS_ATTEST_SHA256; OS confirmation helper content is not pinned.");
    }
}
