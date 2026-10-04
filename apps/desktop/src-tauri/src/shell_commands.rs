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
    "quit_request",
    "quit_offer",
    "quit_response",
];

// Application manifest includes both trust zones; shell-ui still names only SHELL_COMMANDS.
pub const APP_COMMANDS: &[&str] = &[
    "app_info",
    "settings_get",
    "settings_set",
    "connections_list",
    "connections_rename",
    "connections_remove",
    "pair_code",
    "pair_local",
    "open_connection",
    "quit_request",
    "quit_offer",
    "quit_response",
    "shell_info",
];
