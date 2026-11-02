#[path = "build/attest_pins.rs"]
mod attest_pins;

fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rerun-if-changed=src/bin/watchdog/kernel_identity.c");
        cc::Build::new()
            .file("src/bin/watchdog/kernel_identity.c")
            .compile("watchdog_kernel_identity");
    }
    attest_pins::emit();
}
