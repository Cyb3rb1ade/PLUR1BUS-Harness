//! Local structural policy references. Each pass retains its own schema root and never retrieves resources.
use serde_json::{json, Value};
use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};

fn children(node: &Value) -> impl Iterator<Item = &Value> {
    node.get("properties")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|properties| properties.values())
        .chain(
            ["items", "additionalProperties", "x-value-schema"]
                .into_iter()
                .filter_map(|name| node.get(name)),
        )
}

fn needs_preparation(node: &Value, depth: usize) -> bool {
    depth > 128
        || node.get("$ref").is_some()
        || node.get("$dynamicRef").is_some()
        || node.get("$recursiveRef").is_some()
        || node.get("x-value-schema").is_some()
        || children(node).any(|child| needs_preparation(child, depth + 1))
}

fn declaration<'a>(node: &'a Value, name: &str) -> Option<&'a Value> {
    node.get("x-value-schema")
        .and_then(|metadata| metadata.get(name))
        .or_else(|| node.get(name))
}

fn protection(node: &Value, name: &str, value: &Value) -> bool {
    node.get(name) == Some(value)
        || node
            .get("x-value-schema")
            .and_then(|metadata| metadata.get(name))
            == Some(value)
}

fn merge(target: Value, wrapper: &Value) -> Value {
    let protected: Vec<_> = ["x-sensitive", "x-url-credentials"]
        .into_iter()
        .filter(|name| {
            protection(&target, name, &Value::Bool(true))
                || protection(wrapper, name, &Value::Bool(true))
        })
        .collect();
    let unknown_private = protection(
        &target,
        "x-unknown-members",
        &Value::String("sensitive".into()),
    ) || protection(
        wrapper,
        "x-unknown-members",
        &Value::String("sensitive".into()),
    );
    let reference_conflict = declaration(&target, "x-secret-reference")
        .zip(declaration(wrapper, "x-secret-reference"))
        .is_some_and(|(target, wrapper)| target != wrapper);
    let Some(mut output) = target.as_object().cloned() else {
        return wrapper.clone();
    };
    let Some(wrapper) = wrapper.as_object() else {
        return Value::Object(output);
    };
    for (name, value) in wrapper {
        match name.as_str() {
            "properties" => {
                let mut properties = output
                    .get(name)
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                if let Some(extra) = value.as_object() {
                    for (key, child) in extra {
                        let child = properties
                            .remove(key)
                            .map_or_else(|| child.clone(), |target| merge(target, child));
                        properties.insert(key.clone(), child);
                    }
                }
                output.insert(name.clone(), Value::Object(properties));
            }
            "x-sensitive" | "x-url-credentials"
                if output.get(name).and_then(Value::as_bool) == Some(true) => {}
            "x-unknown-members"
                if output.get(name).and_then(Value::as_str) == Some("sensitive") => {}
            "x-secret-reference" if output.get(name).is_some_and(|target| target != value) => {
                output.insert("x-sensitive".into(), Value::Bool(true));
                output.insert(name.clone(), Value::Bool(false));
            }
            "x-value-schema" | "items" | "additionalProperties" => {
                let merged = output
                    .remove(name)
                    .map_or_else(|| value.clone(), |target| merge(target, value));
                output.insert(name.clone(), merged);
            }
            _ => {
                output.insert(name.clone(), value.clone());
            }
        }
    }
    for name in protected {
        output.insert(name.into(), Value::Bool(true));
        if let Some(metadata) = output
            .get_mut("x-value-schema")
            .and_then(Value::as_object_mut)
        {
            metadata.insert(name.into(), Value::Bool(true));
        }
    }
    if unknown_private {
        output.insert(
            "x-unknown-members".into(),
            Value::String("sensitive".into()),
        );
        if let Some(metadata) = output
            .get_mut("x-value-schema")
            .and_then(Value::as_object_mut)
        {
            metadata.insert(
                "x-unknown-members".into(),
                Value::String("sensitive".into()),
            );
        }
    }
    if reference_conflict {
        for (name, value) in [("x-sensitive", true), ("x-secret-reference", false)] {
            output.insert(name.into(), Value::Bool(value));
            if let Some(metadata) = output
                .get_mut("x-value-schema")
                .and_then(Value::as_object_mut)
            {
                metadata.insert(name.into(), Value::Bool(value));
            }
        }
    }
    Value::Object(output)
}

fn flatten_metadata(mut node: Value, remaining: &mut usize) -> Value {
    while let Some(metadata) = node
        .as_object_mut()
        .and_then(|object| object.remove("x-value-schema"))
    {
        if !metadata.is_object() || *remaining == 0 {
            return json!({"x-sensitive":true});
        }
        *remaining -= 1;
        node = merge(node, &metadata);
    }
    node
}

fn resolve_head(
    node: &Value,
    root: &Value,
    visited: &mut BTreeSet<String>,
    depth: usize,
    remaining: &mut usize,
) -> Value {
    if depth > 128
        || *remaining == 0
        || node.get("$dynamicRef").is_some()
        || node.get("$recursiveRef").is_some()
    {
        return json!({"x-sensitive":true});
    }
    *remaining -= 1;
    let prepared = flatten_metadata(node.clone(), remaining);
    let node = &prepared;
    if node.get("$dynamicRef").is_some() || node.get("$recursiveRef").is_some() {
        return json!({"x-sensitive":true});
    }
    if let Some(reference) = node.get("$ref") {
        let Some(reference) = reference.as_str() else {
            return json!({"x-sensitive":true});
        };
        let target = if reference == "#" {
            Some(root)
        } else {
            reference
                .strip_prefix("#/")
                .and_then(|_| root.pointer(&reference[1..]))
        };
        let Some(target) = target else {
            return json!({"x-sensitive":true});
        };
        if !visited.insert(reference.to_owned()) {
            return json!({"x-sensitive":true});
        }
        let resolved = resolve_head(target, root, visited, depth + 1, remaining);
        visited.remove(reference);
        merge(resolved, node)
    } else {
        node.clone()
    }
}

// Only reference chains at the same value position are cycles. Structural recursion
// follows the finite configured values, so absent branches cannot exhaust the budget
// or incorrectly make a public sibling sensitive. Array/map items share the union of
// present member shapes rather than selecting only the first item.
fn resolve(
    node: &Value,
    root: &Value,
    values: &[&Value],
    depth: usize,
    remaining: &mut usize,
) -> Value {
    let mut output = resolve_head(node, root, &mut BTreeSet::new(), depth, remaining);
    if values.is_empty() {
        return output;
    }
    // Partition present members once; scanning every value for every optional
    // schema property would multiply wide arrays by the schema's property count.
    let mut named: BTreeMap<&str, Vec<&Value>> = BTreeMap::new();
    let mut items = Vec::new();
    let mut additional = Vec::new();
    for value in values {
        if let Some(fields) = value.as_object() {
            for (name, child) in fields {
                if output
                    .get("properties")
                    .and_then(|fields| fields.get(name))
                    .is_some()
                {
                    named.entry(name).or_default().push(child);
                } else {
                    additional.push(child);
                }
                if !name.is_empty() && name.bytes().all(|byte| byte.is_ascii_digit()) {
                    items.push(child);
                }
            }
        } else if let Some(values) = value.as_array() {
            items.extend(values);
            additional.extend(values);
        }
    }
    if let Some(properties) = output.get_mut("properties").and_then(Value::as_object_mut) {
        for (name, child) in properties {
            let members = named.remove(name.as_str()).unwrap_or_default();
            *child = resolve(child, root, &members, depth + 1, remaining);
        }
    }
    if let Some(child) = output.get_mut("items").filter(|child| child.is_object()) {
        *child = resolve(child, root, &items, depth + 1, remaining);
    }
    if let Some(child) = output
        .get_mut("additionalProperties")
        .filter(|child| child.is_object())
    {
        *child = resolve(child, root, &additional, depth + 1, remaining);
    }
    output
}

/// Prepare local references and metadata overlays once, retaining root definitions for reference validation.
pub(crate) fn policy_schema<'a>(schema: &'a Value, value: &Value) -> Cow<'a, Value> {
    if needs_preparation(schema, 0) {
        Cow::Owned(resolve(schema, schema, &[value], 0, &mut 10_000))
    } else {
        Cow::Borrowed(schema)
    }
}
