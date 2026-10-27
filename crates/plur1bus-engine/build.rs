//! Generate the frozen engine contract and config data without changing their wire values.
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::{env, fs, path::PathBuf};

fn schemas(value: &mut Value, apply: &mut impl FnMut(&mut Map<String, Value>)) {
    let Value::Object(node) = value else { return };
    apply(node);
    for (key, child) in node.iter_mut() {
        match key.as_str() {
            "properties" | "patternProperties" | "$defs" | "definitions" => {
                if let Some(children) = child.as_object_mut() {
                    for schema in children.values_mut() {
                        schemas(schema, apply);
                    }
                }
            }
            "oneOf" | "anyOf" | "allOf" | "prefixItems" => {
                if let Some(children) = child.as_array_mut() {
                    for schema in children {
                        schemas(schema, apply);
                    }
                }
            }
            "items"
            | "additionalProperties"
            | "not"
            | "contains"
            | "if"
            | "then"
            | "else"
            | "propertyNames" => schemas(child, apply),
            _ => {}
        }
    }
}

fn prepare(value: &mut Value, config: bool) {
    schemas(value, &mut |node| {
        // TypeScript scalar unions may contain several string literals and null.
        // Typify interprets a multi-branch anyOf as flattened optional fields;
        // coalesce scalar alternatives into disjoint typed branches instead.
        if let Some(branches) = node.get("anyOf").and_then(Value::as_array) {
            let scalar = branches.iter().all(|branch| {
                matches!(
                    branch.get("type").and_then(Value::as_str),
                    Some("string" | "number" | "integer" | "boolean" | "null")
                ) && branch.as_object().is_some_and(|fields| {
                    fields.keys().all(|key| {
                        matches!(key.as_str(), "type" | "enum" | "description")
                            || key.starts_with("x-")
                    })
                })
            });
            if scalar {
                let mut alternatives = BTreeMap::<String, Option<Vec<Value>>>::new();
                for branch in branches {
                    let kind = branch["type"].as_str().expect("scalar type").to_owned();
                    let values = branch.get("enum").and_then(Value::as_array).cloned();
                    match alternatives.entry(kind) {
                        std::collections::btree_map::Entry::Vacant(entry) => {
                            entry.insert(values);
                        }
                        std::collections::btree_map::Entry::Occupied(mut entry) => {
                            if let (Some(existing), Some(values)) = (entry.get_mut(), values) {
                                existing.extend(values);
                            } else {
                                entry.insert(None);
                            }
                        }
                    }
                }
                node.remove("anyOf");
                let alternatives = alternatives
                    .into_iter()
                    .map(|(kind, values)| {
                        let mut branch = serde_json::json!({"type":kind});
                        if let Some(values) = values {
                            branch["enum"] = Value::Array(values);
                        }
                        branch
                    })
                    .collect::<Vec<_>>();
                node.insert("oneOf".into(), Value::Array(alternatives));
            }
        }
        if let Some(Value::String(reference)) = node.get_mut("$ref") {
            *reference = reference.replace("#/$defs/", "#/definitions/");
        }
        node.remove("default");
        node.remove("$id");
        node.retain(|name, _| !name.starts_with("x-") && name != "readAt");
        // Declaration comments use JS regex and path notation. Render those
        // tokens as code and bare endpoints as links in the Rust projection.
        if let Some(Value::String(description)) = node.get_mut("description") {
            *description = description
                .replace(
                    "/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/",
                    "`/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/`",
                )
                .replace("[A-Za-z0-9._:/@-]", "`[A-Za-z0-9._:/@-]`")
                .replace(
                    "<baseDbPath>/llm-router-errors.log",
                    "`<baseDbPath>/llm-router-errors.log`",
                );
            for endpoint in [
                "https://api.cohere.com/v2",
                "https://api.jina.ai/v1",
                "https://api.voyageai.com/v1",
            ] {
                *description = description.replace(endpoint, &format!("<{endpoint}>"));
            }
        }
        // Validation precedes configuration deserialization. The Node validator counts
        // UTF-16 units, ignores propertyNames, and accepts the JSON number 1.0 as integer.
        if config {
            node.remove("propertyNames");
            node.remove("minLength");
            node.remove("maxLength");
            node.remove("pattern");
            for constraint in [
                "minimum",
                "maximum",
                "exclusiveMinimum",
                "exclusiveMaximum",
                "multipleOf",
            ] {
                node.remove(constraint);
            }
            if node.get("type").and_then(Value::as_str) == Some("integer") {
                node.insert("type".into(), Value::String("number".into()));
            }
        }
        if let Some(constant) = node.remove("const") {
            let ty = match &constant {
                Value::Bool(_) => "boolean",
                Value::String(_) => "string",
                Value::Number(_) => "number",
                _ => panic!("structured constant needs an explicit generator mapping"),
            };
            node.insert("type".into(), Value::String(ty.into()));
            node.insert("enum".into(), Value::Array(vec![constant]));
        }
        // The pinned config has boolean | "auto" enums. Typify 0.8 requires
        // disjoint typed branches for mixed JSON kinds; this preserves exactly
        // the original set of values and the containing definition's name.
        if let Some(values) = node.get("enum").and_then(Value::as_array) {
            let mut groups = BTreeMap::<&str, Vec<Value>>::new();
            for value in values {
                let kind = match value {
                    Value::Bool(_) => "boolean",
                    Value::String(_) => "string",
                    Value::Number(_) => "number",
                    Value::Null => "null",
                    _ => continue,
                };
                groups.entry(kind).or_default().push(value.clone());
            }
            if groups.len() > 1 {
                node.remove("type");
                node.remove("enum");
                node.insert(
                    "oneOf".into(),
                    Value::Array(
                        groups
                            .into_iter()
                            .map(|(kind, values)| serde_json::json!({"type":kind,"enum":values}))
                            .collect(),
                    ),
                );
            }
        }
    });
}

fn install_field(root: &mut Value, path: &str, schema: Value) {
    let mut parts = path.split('.').peekable();
    let mut node = root;
    while let Some(part) = parts.next() {
        if parts.peek().is_none() {
            node["properties"]
                .as_object_mut()
                .expect("object properties")
                .insert(part.into(), schema);
            break;
        }
        node = node["properties"]
            .get_mut(part)
            .expect("existing parent schema");
    }
}

fn generate(mut root: Value, config: bool, output: &str) {
    if let Some(defs) = root.as_object_mut().expect("schema object").remove("$defs") {
        root["definitions"] = defs;
    }
    prepare(&mut root, config);
    let definitions = root["definitions"].as_object().cloned().unwrap_or_default();
    let root_title = root["title"].as_str().expect("schema title").to_owned();
    let mut all_definitions = definitions.clone();
    all_definitions.insert(root_title, root.clone());
    let schema: schemars::schema::RootSchema =
        serde_json::from_value(root).expect("schemars schema");
    let mut settings = typify::TypeSpaceSettings::default();
    settings.with_struct_builder(false);
    // JS numbers preserve both their integer and fractional JSON representation.
    settings.with_conversion(
        schemars::schema::SchemaObject {
            instance_type: Some(schemars::schema::InstanceType::Number.into()),
            ..Default::default()
        },
        "::serde_json::Number",
        [
            typify::TypeSpaceImpl::Display,
            typify::TypeSpaceImpl::FromStr,
        ]
        .into_iter(),
    );
    settings.with_conversion(
        schemars::schema::SchemaObject {
            instance_type: Some(schemars::schema::InstanceType::Number.into()),
            format: Some("float".into()),
            ..Default::default()
        },
        "f32",
        [
            typify::TypeSpaceImpl::Display,
            typify::TypeSpaceImpl::FromStr,
        ]
        .into_iter(),
    );
    for (value, name) in [(true, "ConstTrue"), (false, "ConstFalse")] {
        settings.with_conversion(
            schemars::schema::SchemaObject {
                instance_type: Some(schemars::schema::InstanceType::Boolean.into()),
                enum_values: Some(vec![Value::Bool(value)]),
                ..Default::default()
            },
            name,
            [typify::TypeSpaceImpl::Default].into_iter(),
        );
    }
    let mut space = typify::TypeSpace::new(&settings);
    space
        .add_root_schema(schema)
        .expect("contract schema is representable by typify");
    let mut file = syn::parse2::<syn::File>(space.to_stream()).expect("generated syntax");
    // The config deliberately accepts both camelCase and legacy snake_case
    // aliases. Typify maps both to the same Rust field; retain the canonical
    // spelling and give only the additional legacy field a distinct Rust name.
    // Explicit serde names keep both JSON keys intact, including when both occur.
    for item in &mut file.items {
        let syn::Item::Struct(record) = item else {
            continue;
        };
        let mut used = BTreeSet::new();
        for field in &mut record.fields {
            let Some(ident) = &field.ident else { continue };
            if used.insert(ident.to_string()) {
                continue;
            }
            let wire_name = json_name(field);
            let ident = field.ident.as_ref().expect("named field");
            let name = format!("{ident}_legacy");
            assert!(used.insert(name.clone()), "unique legacy field name");
            field.ident = Some(syn::Ident::new(&name, ident.span()));
            field
                .attrs
                .push(syn::parse_quote!(#[serde(rename = #wire_name)]));
        }
    }
    let names = all_definitions.keys().cloned().collect::<Vec<_>>();
    keep_explicit_values(&mut file, &all_definitions, &names);
    file.items.extend(
        syn::parse_str::<syn::File>(SUPPORT)
            .expect("wire helpers")
            .items,
    );
    fs::write(
        PathBuf::from(env::var("OUT_DIR").expect("output directory")).join(output),
        prettyplease::unparse(&file),
    )
    .expect("write generated types");
}

fn main() {
    for file in [
        "build.rs",
        "schema/engine-contract.schema.json",
        "schema/engine-config.schema.json",
        "schema/DRIFT.json",
        "schema/input-limits.json",
    ] {
        println!("cargo:rerun-if-changed={file}");
    }
    let read = |file: &str| -> Value {
        serde_json::from_str(&fs::read_to_string(file).expect("schema file")).expect("schema JSON")
    };
    let contract = read("schema/engine-contract.schema.json");
    let data: Map<String, Value> = contract["$defs"]
        .as_object()
        .expect("contract definitions")
        .iter()
        .filter(|(_, value)| {
            value.get("x-runtime") != Some(&Value::Bool(true))
                && value.get("x-config-type") != Some(&Value::Bool(true))
        })
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect();
    generate(
        serde_json::json!({"$schema":"http://json-schema.org/draft-07/schema#", "title":"EngineContractData", "type":"object", "additionalProperties":false, "$defs":data}),
        false,
        "contract.rs",
    );
    let mut config = read("schema/engine-config.schema.json");
    config["title"] = Value::String("EngineConfig".into());
    let drift = read("schema/DRIFT.json");
    for field in drift["acceptedManifestFields"]
        .as_array()
        .expect("manifest compatibility fields")
    {
        install_field(
            &mut config,
            field["path"].as_str().expect("field path"),
            field["schema"].clone(),
        );
    }
    for issue in drift["issues"].as_array().expect("drift issues") {
        if issue["kind"] == "runtime-additional-property" {
            install_field(
                &mut config,
                issue["path"].as_str().expect("field path"),
                issue["runtimeSchema"].clone(),
            );
        }
    }
    generate(config, true, "engine_config.rs");
    let limits = read("schema/input-limits.json");
    let constants = limits.as_object().expect("input limits").iter().map(|(name, value)| {
        let count = value.as_u64().expect("non-negative input limit");
        format!("/// Maximum UTF-16 code units for the {name} input boundary.\npub const {name}: usize = {count};\n")
    }).collect::<String>();
    fs::write(
        PathBuf::from(env::var("OUT_DIR").expect("output directory")).join("input_limits.rs"),
        constants,
    )
    .expect("write input limits");
}

// Wire-presence helpers follow the RPC generator; engine outputs use them too.
const SUPPORT: &str = r#"
/// The JSON literal `true`: a schema `{ "const": true }`. Any other value is refused.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ConstTrue;
/// The JSON literal `false`: a schema `{ "const": false }`. Any other value is refused.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ConstFalse;
impl ::serde::Serialize for ConstTrue {
    fn serialize<S: ::serde::Serializer>(&self, s: S) -> ::std::result::Result<S::Ok, S::Error> {
        s.serialize_bool(true)
    }
}
impl ::serde::Serialize for ConstFalse {
    fn serialize<S: ::serde::Serializer>(&self, s: S) -> ::std::result::Result<S::Ok, S::Error> {
        s.serialize_bool(false)
    }
}
impl<'de> ::serde::Deserialize<'de> for ConstTrue {
    fn deserialize<D: ::serde::Deserializer<'de>>(d: D) -> ::std::result::Result<Self, D::Error> {
        match bool::deserialize(d)? {
            true => Ok(ConstTrue),
            false => Err(<D::Error as ::serde::de::Error>::custom("expected the literal true")),
        }
    }
}
impl<'de> ::serde::Deserialize<'de> for ConstFalse {
    fn deserialize<D: ::serde::Deserializer<'de>>(d: D) -> ::std::result::Result<Self, D::Error> {
        match bool::deserialize(d)? {
            false => Ok(ConstFalse),
            true => Err(<D::Error as ::serde::de::Error>::custom("expected the literal false")),
        }
    }
}
impl ::std::convert::From<ConstTrue> for bool {
    fn from(_: ConstTrue) -> bool {
        true
    }
}
impl ::std::convert::From<ConstFalse> for bool {
    fn from(_: ConstFalse) -> bool {
        false
    }
}
/// `deserialize_with` of an optional params field that keeps an explicit value (`keep_explicit_values` in `build.rs`): a present
/// key is `Some`, also when its value is `null` (`Some(None)`) or `[]` (`Some(vec![])`); only a missing key is `None`.
fn deserialize_present<'de, D, T>(d: D) -> ::std::result::Result<::std::option::Option<T>, D::Error>
where
    D: ::serde::Deserializer<'de>,
    T: ::serde::Deserialize<'de>,
{
    T::deserialize(d).map(Some)
}
"#;

/// An optional params field whose schema allows `null` or is an array: the core reads an explicit `null` or `[]` as "clear the
/// value" and a missing key as "leave it" (`project.card.update`'s `dueAt`, `labels`, `links`; `project.column.update`'s
/// `wipLimit`). typify writes such a field as `Option<T>` or `Vec<T>` that is skipped when `None` or empty, so a typed client
/// could not send a clear. Each one becomes `Option<F>` of the field type `F` typify chose: a missing key is `None`, a present one
/// `Some(…)`, so `null` is `Some(None)` and `[]` is `Some(vec![])`, and each is written back as it was read. A `null` for an array
/// that does not allow it is still refused. Applies to the `<Method>Params` types and every struct reachable from them (a shared
/// definition such as `ModelOverrides` changes in the results that use it too); results and notifications are otherwise left as
/// they are.
fn keep_explicit_values(file: &mut syn::File, defs: &Map<String, Value>, params_types: &[String]) {
    let structs: HashMap<String, &syn::ItemStruct> = file
        .items
        .iter()
        .filter_map(|i| match i {
            syn::Item::Struct(s) => Some((s.ident.to_string(), s)),
            _ => None,
        })
        .collect();
    let mut wanted: BTreeMap<String, BTreeMap<String, bool>> = BTreeMap::new();
    let mut seen = BTreeSet::new();
    for p in params_types {
        find_explicit(&defs[p], p, defs, &structs, &mut wanted, &mut seen);
    }
    let mut done = 0usize;
    for item in &mut file.items {
        let syn::Item::Struct(s) = item else { continue };
        let Some(props) = wanted.get(&s.ident.to_string()) else {
            continue;
        };
        for field in s.fields.iter_mut() {
            if let Some(nullable) = props.get(&json_name(field)) {
                make_explicit(field, *nullable);
                done += 1;
            }
        }
    }
    assert_eq!(
        done,
        wanted.values().map(BTreeMap::len).sum::<usize>(),
        "every field found is rewritten"
    );
}

fn resolve<'a>(mut node: &'a Value, defs: &'a Map<String, Value>) -> &'a Value {
    while let Some(r) = node.get("$ref").and_then(Value::as_str) {
        let name = r.strip_prefix("#/definitions/").expect("local $ref");
        node = &defs[name];
    }
    node
}

fn allows(node: &Value, ty: &str) -> bool {
    match node.get("type") {
        Some(Value::String(t)) => t == ty,
        Some(Value::Array(a)) => a.iter().any(|t| t == ty),
        _ => ["anyOf", "oneOf"].iter().any(|keyword| {
            node.get(keyword)
                .and_then(Value::as_array)
                .is_some_and(|branches| branches.iter().any(|branch| allows(branch, ty)))
        }),
    }
}

/// Walks the schema node and the struct typify made of it side by side and records the fields to rewrite.
fn find_explicit(
    node: &Value,
    ty: &str,
    defs: &Map<String, Value>,
    structs: &HashMap<String, &syn::ItemStruct>,
    wanted: &mut BTreeMap<String, BTreeMap<String, bool>>,
    seen: &mut BTreeSet<String>,
) {
    if !seen.insert(ty.to_string()) {
        return;
    }
    let node = resolve(node, defs);
    let (Some(s), Some(props)) = (
        structs.get(ty),
        node.get("properties").and_then(Value::as_object),
    ) else {
        return;
    };
    // A fully open record (DecisionTrace) is a tuple map, with no named fields
    // whose presence could be rewritten.
    if props.is_empty() {
        return;
    }
    // Typify preserves duplicate exported names as tuple aliases of the same
    // underlying object (for example ForgetResult(MemoryForgetResult)). Walk
    // that object rather than treating the alias's tuple field as a JSON key.
    if let syn::Fields::Unnamed(fields) = &s.fields {
        if let Some(syn::Field {
            ty: syn::Type::Path(inner),
            ..
        }) = fields.unnamed.first()
        {
            if let Some(segment) = inner.path.segments.last() {
                find_explicit(
                    node,
                    &segment.ident.to_string(),
                    defs,
                    structs,
                    wanted,
                    seen,
                );
            }
        }
        return;
    }
    let required: BTreeSet<&str> = node
        .get("required")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    for field in &s.fields {
        let name = json_name(field);
        let Some(sub) = props.get(&name) else {
            continue;
        };
        let sub = resolve(sub, defs);
        if !required.contains(name.as_str())
            && (allows(sub, "null") || allows(sub, "array") || allows(sub, "object"))
        {
            wanted
                .entry(ty.to_string())
                .or_default()
                .insert(name.clone(), allows(sub, "null"));
        }
        // Descend into the field's own struct: through `Option`/`Box`, and from a `Vec` to the schema's `items`.
        let (mut node, mut t) = (sub, &field.ty);
        while let Some((wrapper, inner)) = generic_arg(t) {
            if wrapper == "Vec" {
                match node.get("items") {
                    Some(items) => node = resolve(items, defs),
                    None => break,
                }
            } else if wrapper != "Option" && wrapper != "Box" {
                break;
            }
            t = inner;
        }
        if let syn::Type::Path(p) = t {
            if p.qself.is_none() && p.path.segments.len() == 1 {
                let ident = p.path.segments[0].ident.to_string();
                find_explicit(node, &ident, defs, structs, wanted, seen);
            }
        }
    }
}

/// `Option<T>`, `Vec<T>`, `Box<T>` (in any path spelling) → (`"Option"`, `T`).
fn generic_arg(t: &syn::Type) -> Option<(String, &syn::Type)> {
    let syn::Type::Path(p) = t else { return None };
    let last = p.path.segments.last()?;
    let syn::PathArguments::AngleBracketed(args) = &last.arguments else {
        return None;
    };
    match args.args.first()? {
        syn::GenericArgument::Type(inner) if args.args.len() == 1 => {
            Some((last.ident.to_string(), inner))
        }
        _ => None,
    }
}

/// The wire name of a field: its `#[serde(rename = "…")]`, else the field name.
fn json_name(field: &syn::Field) -> String {
    let mut rename = None;
    for attr in field.attrs.iter().filter(|a| a.path().is_ident("serde")) {
        attr.parse_nested_meta(|meta| {
            if meta.path.is_ident("rename") {
                rename = Some(meta.value()?.parse::<syn::LitStr>()?.value());
            } else if meta.input.peek(syn::Token![=]) {
                meta.value()?.parse::<syn::Expr>()?;
            }
            Ok(())
        })
        .expect("serde attribute parses");
    }
    rename.unwrap_or_else(|| {
        let id = field.ident.as_ref().expect("named field").to_string();
        id.strip_prefix("r#").map(str::to_string).unwrap_or(id)
    })
}

/// `nullable`: the schema allows `null`. typify's field type `F` becomes `Option<F>`, except for an array without `null` that typify
/// already made an `Option<Vec<T>>` (it does so when the array has a `minItems`): that keeps its type, and only reading a `null` as
/// `None` stops.
fn make_explicit(field: &mut syn::Field, nullable: bool) {
    let name = json_name(field);
    let ident = field.ident.as_ref().expect("named field").to_string();
    let renamed = ident.strip_prefix("r#").unwrap_or(&ident) != name;
    for attr in field.attrs.iter().filter(|a| a.path().is_ident("serde")) {
        attr.parse_nested_meta(|meta| {
            // A schema `default` would be lost: a missing key becomes `None` here.
            assert!(
                !(meta.path.is_ident("default") && meta.input.peek(syn::Token![=])),
                "{name}: an explicit-value field with a schema default"
            );
            if meta.input.peek(syn::Token![=]) {
                meta.value()?.parse::<syn::Expr>()?;
            }
            Ok(())
        })
        .expect("serde attribute parses");
    }
    field.attrs.retain(|a| !a.path().is_ident("serde"));
    if nullable || generic_arg(&field.ty).is_none_or(|(w, _)| w != "Option") {
        let ty = &field.ty;
        field.ty = syn::parse_quote!(::std::option::Option<#ty>);
    }
    let attr: syn::Attribute = if renamed {
        let lit: syn::LitStr = syn::parse_str(&format!("{name:?}")).expect("string literal");
        syn::parse_quote!(#[serde(rename = #lit, default, deserialize_with = "deserialize_present", skip_serializing_if = "::std::option::Option::is_none")])
    } else {
        syn::parse_quote!(#[serde(default, deserialize_with = "deserialize_present", skip_serializing_if = "::std::option::Option::is_none")])
    };
    field.attrs.push(attr);
}
