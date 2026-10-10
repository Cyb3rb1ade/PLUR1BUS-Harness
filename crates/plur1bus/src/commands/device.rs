//! F44: device RPC commands. JSON preserves the raw result, including future additive fields.
use crate::cli::DeviceCmd;
use crate::commands::memory_ops::{connect_core, require_supports};
use crate::output::Out;
use crate::paths::Layout;
use serde_json::{json, Value};
use std::time::Duration;

pub fn request(cmd: &DeviceCmd) -> (&'static str, Value, &'static str) {
    match cmd {
        DeviceCmd::List => ("device.list", json!({}), "device.list/1"),
        DeviceCmd::Revoke { id } => ("device.revoke", json!({"id":id}), "device.revoke/1"),
        DeviceCmd::Rename { id, name } => (
            "device.rename",
            json!({"id":id,"name":name}),
            "device.rename/1",
        ),
    }
}
fn render(device: &Value) -> String {
    let field = |key: &str| super::grant::clean(device[key].as_str().unwrap_or("?"));
    format!(
        "{}  {}  {}  {}",
        field("id"),
        field("name"),
        field("platform"),
        if device["revoked"].as_bool() == Some(true) {
            "revoked"
        } else {
            "paired"
        }
    )
}
pub fn run(out: &Out, layout: &Layout, cmd: DeviceCmd) {
    let (method, params, schema) = request(&cmd);
    let mut client = connect_core(out, layout, "devices", Duration::from_secs(30));
    require_supports(out, &client, method);
    let value = match client.call(method, params) {
        Ok(value) => value,
        Err(error) => out.from_rpc_error(&error),
    };
    out.ok(schema, &value, || {
        if method == "device.list" {
            let devices = value["devices"].as_array().cloned().unwrap_or_default();
            if devices.is_empty() {
                "no devices".into()
            } else {
                devices.iter().map(render).collect::<Vec<_>>().join("\n")
            }
        } else {
            render(&value)
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn commands_only_send_device_fields_and_render_sanitizes_terminal_controls() {
        assert_eq!(
            request(&DeviceCmd::List),
            ("device.list", json!({}), "device.list/1")
        );
        assert_eq!(
            request(&DeviceCmd::Revoke {
                id: "dev_fixture".into()
            })
            .1,
            json!({"id":"dev_fixture"})
        );
        assert_eq!(
            request(&DeviceCmd::Rename {
                id: "dev_fixture".into(),
                name: "Phone".into()
            })
            .1,
            json!({"id":"dev_fixture","name":"Phone"})
        );
        assert!(!render(
            &json!({"id":"dev_fixture","name":"\u{1b}[31mPhone","platform":"ios","revoked":true})
        )
        .contains('\u{1b}'));
    }
}
