// Shared by the native allow-list and Tauri's generated application ACL.
pub const SHELL_COMMANDS: &[&str] = &[
    "app_info",
    "settings_get",
    "settings_set",
    "connections_list",
    "connections_rename",
    "connections_remove",
    "pair_code",
    "pair_local",
    "open_connection",
];
