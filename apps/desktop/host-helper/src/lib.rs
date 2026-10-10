//! D1 permission frame, deliberately offering zero host capabilities.
pub fn response(method: &str) -> Option<serde_json::Value> {
    match method {
        "hello" => Some(serde_json::json!({"version":"1","capabilities":[]})),
        "os.permissions.status" => Some(serde_json::json!({"grants":[]})),
        "shutdown" => Some(serde_json::json!({"ok":true})),
        _ => None,
    }
}
