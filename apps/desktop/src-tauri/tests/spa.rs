use plur1bus_desktop::{
    commands::{allowed_command, APP_COMMANDS, SHELL_COMMANDS},
    connections::Origin,
    spa::{bridge_capability, retry_ticket},
};
use std::sync::atomic::AtomicU8;
#[test]
fn shell_info_is_the_only_spa_command() {
    assert!(APP_COMMANDS.contains(&"shell_info"));
    assert!(!SHELL_COMMANDS.contains(&"shell_info"));
    assert!(!allowed_command("shell", "shell_info"));
    assert_eq!(
        bridge_capability(&Origin::parse("http://127.0.0.1:30001").unwrap(), false)["permissions"],
        serde_json::json!(["allow-shell-info"])
    );
}
#[test]
fn spa_bridge_capability_is_scoped_to_the_spa_origin() {
    let cap = bridge_capability(&Origin::parse("http://127.0.0.1:30001").unwrap(), false);
    assert_eq!(cap["local"], false);
    assert_eq!(cap["webviews"], serde_json::json!(["spa"]));
    assert_eq!(
        cap["remote"]["urls"],
        serde_json::json!(["http://127.0.0.1:30001/*"])
    );
    assert!(cap.get("windows").is_none());
}
#[test]
fn switching_connection_replaces_the_capability() {
    let old = Origin::parse("http://127.0.0.1:30001").unwrap();
    let new = Origin::parse("http://127.0.0.1:30002").unwrap();
    let retired = bridge_capability(&old, true);
    assert_eq!(
        retired["permissions"],
        serde_json::json!(["deny-shell-info"])
    );
    assert_ne!(retired["remote"], bridge_capability(&new, false)["remote"]);
}
#[test]
fn a_replayed_ticket_page_is_retried_once_then_shows_the_error() {
    let counter = AtomicU8::new(0);
    assert!(retry_ticket(&counter, false));
    for _ in 0..300 {
        assert!(!retry_ticket(&counter, false));
    }
    assert!(retry_ticket(&counter, true));
    assert!(!retry_ticket(&counter, false));
}
