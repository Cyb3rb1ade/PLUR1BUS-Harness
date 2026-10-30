//! Version-specific closed MCPB manifest validation, backed by the pinned upstream schemas (M-A9).
use super::{config, invalid, McpbManifest};
use crate::manifest::MAX_MANIFEST_BYTES;
use crate::refusal::{reason, Refusal};
use serde_json::Value;
use std::sync::OnceLock;

const SCHEMAS: [&str; 4] = [
    include_str!("../../schema/mcpb/mcpb-0.1.schema.json"),
    include_str!("../../schema/mcpb/mcpb-0.2.schema.json"),
    include_str!("../../schema/mcpb/mcpb-0.3.schema.json"),
    include_str!("../../schema/mcpb/mcpb-0.4.schema.json"),
];

fn validators() -> &'static [jsonschema::Validator; 4] {
    static VALIDATORS: OnceLock<[jsonschema::Validator; 4]> = OnceLock::new();
    VALIDATORS.get_or_init(|| {
        SCHEMAS.map(|raw| {
            let schema: Value = serde_json::from_str(raw).expect("pinned MCPB schema JSON");
            // The pinned schemas declare draft-07. A mismatched vocabulary can silently disable validation.
            jsonschema::options()
                .with_draft(jsonschema::Draft::Draft7)
                .should_validate_formats(true)
                .build(&schema)
                .expect("pinned MCPB schema compiles")
        })
    })
}

pub(super) fn parse(raw: &[u8]) -> Result<McpbManifest, Refusal> {
    if raw.len() > MAX_MANIFEST_BYTES {
        return Err(Refusal::invalid(
            reason::TOO_LARGE,
            "MCPB manifest.json exceeds 1 MiB",
        ));
    }
    let source: Value = serde_json::from_slice(raw)
        .map_err(|_| invalid("MCPB manifest.json is not valid UTF-8 JSON"))?;
    let version = source
        .get("manifest_version")
        .or_else(|| source.get("dxt_version"))
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("MCPB requires manifest_version or dxt_version"))?;
    let index = match version {
        "0.1" => 0,
        "0.2" => 1,
        "0.3" => 2,
        "0.4" => 3,
        _ => {
            return Err(invalid(
                "MCPB manifest_version must be 0.1, 0.2, 0.3 or 0.4",
            ))
        }
    };
    // Validator messages can print default secret values. Only structural locations leave this boundary.
    if let Some(error) = validators()[index].iter_errors(&source).next() {
        return Err(invalid(format!(
            "MCPB manifest.json field {} does not match its versioned schema",
            error.instance_path
        )));
    }
    config::validate_declarations(&source)?;
    let manifest_version = version.to_owned();
    Ok(McpbManifest {
        source,
        manifest_version,
    })
}
