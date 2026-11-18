use crate::request::safe_integer;
use crate::{ErrorKind, Json, ProviderError};

type Result<T> = std::result::Result<T, ProviderError>;

const ANNOTATIONS: &[&str] = &[
    "$schema",
    "$id",
    "$comment",
    "examples",
    "default",
    "deprecated",
    "readOnly",
    "writeOnly",
    "contentMediaType",
    "contentEncoding",
    "$defs",
    "definitions",
];
const TYPES: &[&str] = &[
    "string", "number", "integer", "boolean", "object", "array", "null",
];
const REFUSED: &[&str] = &[
    "patternProperties",
    "if",
    "then",
    "else",
    "not",
    "dependentSchemas",
    "dependentRequired",
    "dependencies",
    "unevaluatedProperties",
    "unevaluatedItems",
    "$dynamicRef",
    "$dynamicAnchor",
    "$recursiveRef",
    "propertyNames",
    "contains",
];

pub(crate) fn convert(schema: &Json, tool: &str) -> Result<Json> {
    convert_node(
        schema,
        "parameters",
        1,
        &mut Converter {
            root: schema,
            tool,
            active: Vec::new(),
            nodes: 0,
        },
    )
}

struct Converter<'a> {
    root: &'a Json,
    tool: &'a str,
    active: Vec<String>,
    nodes: usize,
}

impl Converter<'_> {
    fn fail(&self, path: &str, explanation: impl std::fmt::Display) -> ProviderError {
        ProviderError::new(
            ErrorKind::InvalidRequest,
            format!("{}: {path} {explanation}", self.tool),
        )
    }
}

fn sub(path: &str, key: &str) -> String {
    const EXTRA: &[u8] = b"$_";
    let mut bytes = key.bytes();
    if bytes
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || EXTRA.contains(&c))
        && bytes.all(|c| c.is_ascii_alphanumeric() || EXTRA.contains(&c))
    {
        format!("{path}.{key}")
    } else {
        format!("{path}[{}]", Json::from(key).encode())
    }
}

fn schema_type(value: &Json) -> bool {
    if let Some(s) = value.string() {
        return TYPES.contains(&s);
    }
    let types = value.items();
    types.len() == 2
        && types[0] != types[1]
        && types.iter().all(|t| TYPES.contains(&t.text()))
        && types.iter().any(|t| t.text() == "null")
}

fn inline_ref(input: &Json, path: &str, depth: usize, ctx: &mut Converter<'_>) -> Result<Json> {
    if let Some(key) = input.as_object().and_then(|m| {
        m.keys().find(|key| {
            !["$ref", "title", "description"].contains(&key.as_str())
                && !ANNOTATIONS.contains(&key.as_str())
        })
    }) {
        return Err(ctx.fail(
            path,
            format!("has {key} next to $ref, which is not supported by Gemini"),
        ));
    }
    let at = sub(path, "$ref");
    let reference = input["$ref"]
        .string()
        .ok_or_else(|| ctx.fail(&at, "must be a string"))?;
    let brief: String = reference.chars().take(80).collect();
    let Some((table, key)) = reference
        .strip_prefix("#/")
        .and_then(|r| r.split_once('/'))
        .filter(|(table, key)| {
            ["$defs", "definitions"].contains(table) && !key.is_empty() && !key.contains('/')
        })
    else {
        return Err(ctx.fail(&at, format!("\"{brief}\" is not supported by Gemini (only #/$defs/<name> and #/definitions/<name> are inlined)")));
    };
    let raw = key.as_bytes();
    if raw.iter().enumerate().any(|(i, c)| {
        *c == b'%'
            && !raw
                .get(i + 1..i + 3)
                .is_some_and(|digits| digits.iter().all(u8::is_ascii_hexdigit))
    }) {
        return Err(ctx.fail(&at, format!("\"{brief}\" is malformed")));
    }
    let key = percent_encoding::percent_decode_str(key)
        .decode_utf8()
        .map_err(|_| ctx.fail(&at, format!("\"{brief}\" is malformed")))?
        .replace("~1", "/")
        .replace("~0", "~");
    let target = ctx.root[table]
        .get(&key)
        .ok_or_else(|| ctx.fail(&at, format!("\"{brief}\" does not resolve")))?;
    if ctx.active.iter().any(|r| r == reference) {
        return Err(ctx.fail(
            &at,
            format!("\"{brief}\" is recursive, which Gemini cannot express"),
        ));
    }
    ctx.active.push(reference.to_owned());
    let result = convert_node(target, path, depth, ctx);
    ctx.active.pop();
    let mut out = result?;
    for key in ["title", "description"] {
        if let Some(value) = input.get(key) {
            if value.string().is_none() {
                return Err(ctx.fail(&sub(path, key), "must be a string"));
            }
            out.set(key, value.clone());
        }
    }
    Ok(out)
}

fn convert_node(input: &Json, path: &str, depth: usize, ctx: &mut Converter<'_>) -> Result<Json> {
    let map = input
        .as_object()
        .ok_or_else(|| ctx.fail(path, "must be a JSON Schema object"))?;
    if depth > 32 {
        return Err(ctx.fail(path, "exceeds the maximum schema depth of 32"));
    }
    ctx.nodes += 1;
    if ctx.nodes > 5000 {
        return Err(ctx.fail(
            path,
            "exceeds the maximum of 5000 schema nodes (after inlining references)",
        ));
    }
    if map.contains_key("$ref") {
        return inline_ref(input, path, depth, ctx);
    }
    if map.contains_key("anyOf") && map.contains_key("oneOf") {
        return Err(ctx.fail(
            path,
            "has both anyOf and oneOf, which cannot be reduced to one anyOf",
        ));
    }
    if map.contains_key("const") && map.contains_key("enum") {
        return Err(ctx.fail(
            path,
            "has both const and enum, which is not supported by Gemini",
        ));
    }

    let mut out = Json::object();
    for (key, value) in map {
        let at = sub(path, key);
        if ANNOTATIONS.contains(&key.as_str()) {
            continue;
        }
        if REFUSED.contains(&key.as_str()) {
            return Err(ctx.fail(&at, "is not supported by Gemini"));
        }
        let converted = match key.as_str() {
            "type" if schema_type(value) => value.clone(),
            "type" if value.string().is_some() => return Err(ctx.fail(&at, format!("has unknown type \"{}\"", value.text()))),
            "type" => return Err(ctx.fail(&at, "must be a type name or a [type, \"null\"] pair; use anyOf for other unions")),
            "description" | "title" | "format" | "pattern" => {
                if value.string().is_none() { return Err(ctx.fail(&at, "must be a string")); }
                value.clone()
            }
            "minimum" | "maximum" => {
                if !value.number().is_some_and(f64::is_finite) { return Err(ctx.fail(&at, "must be a finite number")); }
                value.clone()
            }
            "minItems" | "maxItems" | "minLength" | "maxLength" => {
                if !value.number().is_some_and(|n| safe_integer(n, 0.0)) { return Err(ctx.fail(&at, "must be a non-negative integer")); }
                value.clone()
            }
            "properties" => {
                let mut properties = Json::object();
                for (name, schema) in value.as_object().ok_or_else(|| ctx.fail(&at, "must be an object of schemas"))? {
                    properties.set(name, convert_node(schema, &sub(&at, name), depth + 1, ctx)?);
                }
                properties
            }
            "required" => {
                if !value.array().is_some_and(|v| v.iter().all(|v| v.string().is_some())) { return Err(ctx.fail(&at, "must be an array of strings")); }
                value.clone()
            }
            "items" => convert_node(value, &at, depth + 1, ctx)?,
            "additionalProperties" if value.boolean().is_some() => value.clone(),
            "additionalProperties" => convert_node(value, &at, depth + 1, ctx)?,
            "enum" => {
                if value.items().is_empty() { return Err(ctx.fail(&at, "must be a non-empty array")); }
                value.clone()
            }
            "const" => {
                out.set("enum", vec![value.clone()]);
                continue;
            }
            "anyOf" | "oneOf" => {
                let list = value.items();
                if list.is_empty() { return Err(ctx.fail(&at, "must be a non-empty array of schemas")); }
                out.set("anyOf", list.iter().enumerate().map(|(i, schema)| convert_node(schema, &format!("{at}[{i}]"), depth + 1, ctx)).collect::<Result<Vec<_>>>()?);
                continue;
            }
            "allOf" => continue,
            _ => return Err(ctx.fail(&at, "is not a keyword this adapter knows; it is refused instead of being forwarded to Gemini")),
        };
        out.set(key, converted);
    }
    if let Some(all) = input.get("allOf") {
        merge_all_of(all, &mut out, &sub(path, "allOf"), depth, ctx)?;
    }
    Ok(out)
}

fn merge_all_of(
    value: &Json,
    out: &mut Json,
    at: &str,
    depth: usize,
    ctx: &mut Converter<'_>,
) -> Result<()> {
    if value.items().is_empty() {
        return Err(ctx.fail(at, "must be a non-empty array of schemas"));
    }
    if out.get("type").is_some_and(|t| t.text() != "object") {
        return Err(ctx.fail(at, "can only be merged into an object schema"));
    }
    let mut properties = out.get("properties").cloned();
    let mut required = out.get("required").cloned().map(|v| v.items().to_vec());
    for (i, branch) in value.items().iter().enumerate() {
        let position = format!("{at}[{i}]");
        let branch = convert_node(branch, &position, depth + 1, ctx)?;
        if let Some(key) = branch.as_object().and_then(|m| {
            m.keys().find(|key| {
                !["type", "properties", "required", "description", "title"].contains(&key.as_str())
            })
        }) {
            return Err(ctx.fail(&position, format!("is not a plain object schema (has {key}); allOf is not supported by Gemini unless every branch is")));
        }
        if branch.get("type").is_some_and(|t| t.text() != "object") {
            return Err(ctx.fail(
                &position,
                "is not an object schema; allOf is not supported by Gemini unless every branch is",
            ));
        }
        if let Some(children) = branch["properties"].as_object() {
            for (key, definition) in children {
                let props = properties.get_or_insert_with(Json::object);
                if props.get(key).is_some_and(|other| other != definition) {
                    return Err(ctx.fail(
                        &sub(&sub(&position, "properties"), key),
                        format!("conflicts with another definition of \"{key}\" in the same allOf"),
                    ));
                }
                props.set(key, definition.clone());
            }
        }
        for name in branch["required"].items() {
            let required = required.get_or_insert_with(Vec::new);
            if !required.contains(name) {
                required.push(name.clone());
            }
        }
        for key in ["title", "description"] {
            if let Some(annotation) = branch.get(key).filter(|_| out.get(key).is_none()) {
                out.set(key, annotation.clone());
            }
        }
    }
    out.set("type", "object");
    if let Some(value) = properties {
        out.set("properties", value);
    }
    if let Some(value) = required {
        out.set("required", value);
    }
    Ok(())
}
