fn main() {
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
