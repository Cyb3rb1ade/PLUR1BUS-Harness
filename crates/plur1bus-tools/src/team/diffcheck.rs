use super::{glob, list, text};
use crate::ToolError;
use serde_json::{json, Value};
pub(super) fn check(input: &Value) -> Result<Value, ToolError> {
    let owns = list(input, "owns");
    let files = list(input, "files")
        .iter()
        .map(|file| {
            let path = file.as_str().unwrap_or("");
            let class = if !glob::valid(path) || path.contains('*') {
                "foreign"
            } else if list(input, "interfaces")
                .iter()
                .any(|g| glob::matches(g.as_str().unwrap_or(""), path))
                || owns
                    .iter()
                    .any(|o| text(o, "mode") == "interface" && glob::matches(text(o, "glob"), path))
            {
                "interface"
            } else if owns
                .iter()
                .any(|o| text(o, "mode") == "shared" && glob::matches(text(o, "glob"), path))
            {
                "shared"
            } else if owns
                .iter()
                .any(|o| text(o, "mode") == "own" && glob::matches(text(o, "glob"), path))
            {
                "owned"
            } else {
                "foreign"
            };
            json!({"path":path,"classification":class})
        })
        .collect::<Vec<_>>();
    Ok(json!({"files":files}))
}
