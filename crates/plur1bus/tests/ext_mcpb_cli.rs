//! mcp import retains plugin document schemas and exposes no install-and-enable flag (M-A9).
mod mcpb_support;
use mcpb_support::{document, fixture, run};

#[test]
fn mcp_import_dry_run_uses_the_existing_ext_inspect_document() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let source = temp.path().join("demo.mcpb");
    fixture(&source);
    let value = document(
        run(
            &home,
            &[
                "--json",
                "mcp",
                "import",
                source.to_str().unwrap(),
                "--dry-run",
            ],
        ),
        "ext.inspect/1",
    );
    assert_eq!(value["manifest"]["kind"], "mcp-server");
    assert_eq!(value["trust"]["tier"], "unsigned");
    assert!(!home.join("extensions").exists());
}

#[test]
fn mcp_import_offers_no_install_and_enable_option() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let help = run(&home, &["mcp", "import", "--help"]);
    assert!(help.status.success());
    assert!(!String::from_utf8_lossy(&help.stdout).contains("--enable"));
    let rejected = run(&home, &["mcp", "import", "demo.mcpb", "--enable"]);
    assert_eq!(rejected.status.code(), Some(2));
    assert!(!home.exists());
}
