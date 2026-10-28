//! Disabled MCPB installation through the compatibility alias exercises the MCP lifecycle (M-A2 acceptance).
mod mcpb_support;
use mcpb_support::{document, fixture, run};

#[test]
fn mcp_import_install_uses_the_plugin_document_and_keeps_the_package_disabled() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let source = temp.path().join("demo.dxt");
    fixture(&source);
    let value = document(
        run(
            &home,
            &[
                "--json",
                "mcp",
                "import",
                source.to_str().unwrap(),
                "--allow-unsigned",
                "--yes",
            ],
        ),
        "plugin.install/1",
    );
    assert_eq!(value["name"], "demo-server");
    let listed = document(run(&home, &["--json", "plugin", "list"]), "plugin.list/1");
    assert_eq!(listed["items"].as_array().unwrap().len(), 1);
    assert_eq!(listed["items"][0]["enabled"], false);
    assert!(home
        .join("mcp/demo-server/1.0.0/payload/manifest.json")
        .is_file());
}
