//! Inline MCP definitions become credential-free local MCPB or remote p1x members (M-A11).
use super::{inert_capabilities, invalid, members::Child, normalized_name, source};
use crate::mcpb::{normalise_inline_mcpb, McpbContext, NORMALIZED_CREATED};
use crate::pack::{pack_files, write_zip, ZipEntry, ZipKind};
use crate::refusal::Refusal;
use crate::zipaudit::Limits;
use serde_json::{json, Map, Value};
use std::io::Cursor;

fn template(name: &str, version: &str) -> Value {
    json!({"format":1,"id":format!("local/{name}"),"name":name,"version":version,"kind":"mcp-server",
        "title":{"en":name},"summary":{"en":"Imported plugin MCP server"},"publisher":{"id":"local","name":"Local"},
        "licence":"unspecified","compat":{"harness":">=0.0.0"},"requires":{"runtime":{"type":"none"}},
        "defaultEnabled":false,"capabilities":inert_capabilities()})
}

fn remote(name: &str, definition: &Value, version: Option<&str>) -> Result<Child, Refusal> {
    let url = definition["url"]
        .as_str()
        .ok_or_else(|| invalid("plugin remote MCP server requires a URL"))?;
    if url.contains(['?', '#']) {
        return Err(invalid("plugin inline MCP endpoint queries and fragments are unsupported; configure authentication through the secret store"));
    }
    let host = crate::kinds::url_host(url)
        .map_err(|_| invalid("plugin remote MCP URL requires HTTPS without credentials"))?;
    let mut template = template(name, "0.0.0");
    let mut warnings = Vec::new();
    if definition
        .get("headers")
        .is_some_and(|headers| !headers.is_object())
    {
        return Err(invalid("plugin remote MCP headers must be an object"));
    }
    let headers = definition.get("headers").and_then(Value::as_object);
    let auth = if let Some(headers) = headers.filter(|h| !h.is_empty()) {
        if headers.len() != 1
            || !headers
                .keys()
                .all(|k| k.eq_ignore_ascii_case("authorization"))
        {
            return Err(invalid("plugin custom MCP headers are unsupported; configure supported authentication separately"));
        }
        template["capabilities"]["secrets"] =
            json!([{"slot":"bearer","label":{"en":"Bearer token"},"required":true}]);
        warnings.push(
            "Source authorization value was removed; configure the member's bearer secret slot"
                .into(),
        );
        "header"
    } else {
        "none"
    };
    template["remote"] = json!({"url":url,"auth":auth});
    template["capabilities"]["network"] = json!({"mode":"allowlist","hosts":[host]});
    template["version"] = match version {
        Some(version) => version.into(),
        None => crate::pack::content_version(&template, &[])?.into(),
    };
    let mut output = Cursor::new(Vec::new());
    let manifest = pack_files(&template, Vec::new(), NORMALIZED_CREATED, &mut output)?;
    Ok(Child {
        manifest,
        bytes: output.into_inner(),
        warnings,
    })
}

fn plugin_path(value: &str) -> Result<String, Refusal> {
    let relative = value
        .strip_prefix("${CLAUDE_PLUGIN_ROOT}/")
        .or_else(|| value.strip_prefix("./"))
        .ok_or_else(|| {
            invalid("plugin local MCP server requires an entry point inside its source root")
        })?;
    source::relative(relative)
}

fn local<C: FnMut(&str) -> Result<McpbContext, Refusal>>(
    name: &str,
    definition: &Value,
    user_config: &Value,
    tree: &source::SourceTree,
    context: &mut C,
    limits: &Limits,
    version: Option<&str>,
) -> Result<Child, Refusal> {
    let command = definition["command"]
        .as_str()
        .ok_or_else(|| invalid("plugin stdio MCP server requires a command"))?;
    let args = definition
        .get("args")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if args.iter().any(|a| !a.is_string()) {
        return Err(invalid("plugin MCP arguments must be strings"));
    }
    let runtime = match command {
        "node" | "node.exe" => "node",
        "python" | "python3" | "python.exe" => "python",
        _ => "binary",
    };
    let entry = if runtime == "binary" {
        plugin_path(command)?
    } else {
        args.iter().filter_map(Value::as_str).find_map(|value|plugin_path(value).ok())
            .ok_or_else(||invalid("plugin MCP command requires a bundled entry point; package installers and inline scripts are not run"))?
    };
    if !tree.files.contains_key(&entry) {
        return Err(invalid("plugin MCP entry point is missing or excluded"));
    }
    let mut config = Map::new();
    config.insert(
        "command".into(),
        json!(command.replace("${CLAUDE_PLUGIN_ROOT}", "${__dirname}")),
    );
    config.insert(
        "args".into(),
        Value::Array(
            args.iter()
                .map(|a| {
                    json!(a
                        .as_str()
                        .unwrap_or("")
                        .replace("${CLAUDE_PLUGIN_ROOT}", "${__dirname}"))
                })
                .collect(),
        ),
    );
    let mut declarations = user_config.as_object().cloned().unwrap_or_default();
    let mut env = Map::new();
    let mut warnings = Vec::new();
    if let Some(values) = definition.get("env") {
        for (key, value) in values
            .as_object()
            .ok_or_else(|| invalid("plugin MCP environment must be an object"))?
        {
            if !value.is_string() {
                return Err(invalid("plugin MCP environment entries must be strings"));
            }
            declarations.insert(key.clone(),json!({"type":"string","title":key,"description":"Plugin MCP environment secret","sensitive":true,"required":true}));
            env.insert(key.clone(), json!(format!("${{user_config.{key}}}")));
        }
        warnings.push(
            "Source environment values were removed; configure the member's secret slots".into(),
        );
    }
    config.insert("env".into(), Value::Object(env));
    let mcpb = json!({"manifest_version":"0.4","name":name,"version":version.unwrap_or("0.0.0"),"description":"Imported plugin MCP server",
        "author":{"name":"Local"},"server":{"type":runtime,"entry_point":entry,"mcp_config":config},"user_config":declarations});
    let mut entries = vec![ZipEntry {
        name: "manifest.json".into(),
        bytes: serde_json::to_vec(&mcpb).map_err(|_| invalid("plugin MCP serialization failed"))?,
        kind: ZipKind::File { exec: false },
    }];
    for file in tree.files.values().filter(|file| {
        !file.rel.starts_with(".claude-plugin/")
            && !file.rel.starts_with("skills/")
            && file.rel != ".mcp.json"
            && file.rel != "manifest.json"
            && !file.rel.ends_with(".mcpb")
            && !file.rel.ends_with(".dxt")
            && !file.rel.ends_with(".p1x")
            && !source::is_mcp_configuration(file)
    }) {
        entries.push(ZipEntry {
            name: file.rel.clone(),
            bytes: file.bytes.clone(),
            kind: ZipKind::File { exec: file.exec },
        });
    }
    let bytes = write_zip(&entries)?;
    let mut output = Cursor::new(Vec::new());
    let report = normalise_inline_mcpb(
        &mut Cursor::new(bytes),
        context,
        limits,
        version,
        &mut output,
    )?;
    warnings.extend(report.warnings);
    Ok(Child {
        manifest: report.manifest,
        bytes: output.into_inner(),
        warnings,
    })
}

pub(super) fn normalize<C: FnMut(&str) -> Result<McpbContext, Refusal>>(
    name: &str,
    definition: &Value,
    user_config: &Value,
    tree: &source::SourceTree,
    context: &mut C,
    limits: &Limits,
    version: Option<&str>,
) -> Result<Child, Refusal> {
    if !definition.is_object() {
        return Err(invalid(
            "plugin MCP server definitions must be objects or bundle references",
        ));
    }
    let name = normalized_name(name);
    if definition.get("url").is_some() {
        remote(&name, definition, version)
    } else {
        local(
            &name,
            definition,
            user_config,
            tree,
            context,
            limits,
            version,
        )
    }
}
