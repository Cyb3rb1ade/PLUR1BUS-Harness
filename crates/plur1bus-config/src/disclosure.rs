//! Interpretable module disclosure metadata shared by installation and output consumers.
use serde_json::Value;
use std::collections::BTreeSet;

#[derive(Clone, Copy)]
enum Edge {
    Direct,
    Conditional,
    Definition,
}

fn schema_children(node: &Value) -> Vec<(&Value, Edge)> {
    let mut children = Vec::new();
    for (name, edge) in [
        ("properties", Edge::Direct),
        ("patternProperties", Edge::Conditional),
        ("dependentSchemas", Edge::Conditional),
        ("dependencies", Edge::Conditional),
        ("$defs", Edge::Definition),
        ("definitions", Edge::Definition),
    ] {
        if let Some(map) = node.get(name).and_then(Value::as_object) {
            children.extend(map.values().map(|child| (child, edge)));
        }
    }
    for name in ["items", "additionalProperties", "x-value-schema"] {
        if let Some(child) = node.get(name) {
            match child.as_array() {
                Some(items) => children.extend(items.iter().map(|item| (item, Edge::Conditional))),
                None => children.push((child, Edge::Direct)),
            }
        }
    }
    for name in [
        "if",
        "then",
        "else",
        "not",
        "contains",
        "propertyNames",
        "unevaluatedProperties",
        "unevaluatedItems",
        "additionalItems",
    ] {
        if let Some(child) = node.get(name) {
            children.push((child, Edge::Conditional));
        }
    }
    for name in ["allOf", "anyOf", "oneOf", "prefixItems"] {
        if let Some(items) = node.get(name).and_then(Value::as_array) {
            children.extend(items.iter().map(|item| (item, Edge::Conditional)));
        }
    }
    children
}

fn declaration<'a>(node: &'a Value, name: &str) -> Option<&'a Value> {
    super::sensitive::field(node, name)
}

fn has_nested_resource(node: &Value) -> bool {
    fn visit(node: &Value, depth: usize) -> bool {
        depth > 128
            || schema_children(node)
                .into_iter()
                .any(|(child, _)| child.get("$id").is_some() || visit(child, depth + 1))
    }
    visit(node, 0)
}

/// Refuse descriptors the direct-member projection cannot interpret, rather than ignoring their privacy markers.
fn direct_policy(
    node: &Value,
    root: &Value,
    direct: bool,
    references: &mut BTreeSet<String>,
    depth: usize,
    remaining: &mut usize,
) -> bool {
    if depth > 128 || *remaining == 0 {
        return false;
    }
    *remaining -= 1;
    for name in ["x-sensitive", "x-url-credentials"] {
        if node.get(name).is_some_and(|value| !value.is_boolean()) {
            return false;
        }
    }
    if node
        .get("x-value-schema")
        .is_some_and(|value| !value.is_object())
    {
        return false;
    }
    if node
        .get("x-unknown-members")
        .is_some_and(|value| !matches!(value.as_str(), Some("sensitive" | "public")))
        || node
            .get("x-text-credentials")
            .is_some_and(|value| value.as_str() != Some("parts"))
    {
        return false;
    }
    if let Some(metadata) = node.get("x-secret-reference") {
        if !metadata.is_boolean() {
            let reference = metadata
                .as_object()
                .filter(|object| object.len() == 1)
                .and_then(|object| object.get("$ref"))
                .and_then(Value::as_str);
            if !reference.is_some_and(|reference| {
                reference.starts_with("#/$defs/") && root.pointer(&reference[1..]).is_some()
            }) || has_nested_resource(root)
            {
                return false;
            }
        }
    }
    let sensitive = declaration(node, "x-sensitive").and_then(Value::as_bool) == Some(true);
    let endpoint = declaration(node, "x-url-credentials").and_then(Value::as_bool) == Some(true);
    let reference_slot = declaration(node, "x-secret-reference")
        .is_some_and(|metadata| metadata.as_bool() != Some(false));
    if sensitive && endpoint {
        return false;
    }
    if !direct
        && (sensitive
            || endpoint
            || reference_slot
            || declaration(node, "x-unknown-members").is_some()
            || declaration(node, "x-text-credentials").is_some())
    {
        return false;
    }
    if node.get("$dynamicRef").is_some() || node.get("$recursiveRef").is_some() {
        return false;
    }
    if let Some(reference) = node.get("$ref") {
        let Some(reference) = reference.as_str() else {
            return false;
        };
        // Root JSON pointers do not resolve nested resources. Refuse those scopes rather than guessing.
        if has_nested_resource(root) {
            return false;
        }
        let target = if reference == "#" {
            Some(root)
        } else {
            reference
                .strip_prefix('#')
                .and_then(|pointer| root.pointer(pointer))
        };
        let Some(target) = target else { return false };
        if references.insert(reference.to_string()) {
            let supported = direct_policy(target, root, false, references, depth + 1, remaining);
            references.remove(reference);
            if !supported {
                return false;
            }
        }
    }
    schema_children(node)
        .into_iter()
        .all(|(child, edge)| match edge {
            Edge::Direct => direct_policy(child, root, direct, references, depth + 1, remaining),
            Edge::Conditional => {
                direct_policy(child, root, false, references, depth + 1, remaining)
            }
            Edge::Definition => true, // Definitions only apply when referenced.
        })
}

pub fn supports_config_disclosure_policy(schema: &Value) -> bool {
    // Always inspect references: a target may be stored under an otherwise opaque keyword such as `default`.
    direct_policy(schema, schema, true, &mut BTreeSet::new(), 0, &mut 10_000)
}
