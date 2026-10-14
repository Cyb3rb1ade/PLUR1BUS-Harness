//! Generates src/types.rs (into OUT_DIR) from packages/rpc-schema/schema/rpc.schema.json — the single source.
//! Same flattening as packages/rpc-schema/src/build.mjs: methods/<m>/{params,result} → <PascalM>{Params,Result},
//! notifications/<n> → <PascalN>Notification. `$defs` becomes `definitions` for schemars 0.8.
//! Where typify alone would lose part of the schema, the generator adjusts (tests in `tests/generative.rs`):
//! - `const` becomes a one-value `enum` (`pin_const`; booleans become `ConstTrue`/`ConstFalse`), so a pinned field refuses other values;
//! - only the `format` *keyword* is dropped, never a property named `format`;
//! - optional params fields that allow `null` or are arrays keep missing, `null` and `[]` apart (`keep_explicit_values`).
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::{env, fs, path::PathBuf};

fn pascal(s: &str) -> String {
    s.split(['.', '-', '_'])
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect()
}

/// Calls `f` on `v` and on every subschema below it. Only keyword positions that hold schemas are entered: the keys of a
/// `properties` map are property names, not keywords (a property may be called `format` or `const`), and `enum`, `const`,
/// `default` and `required` hold plain values.
fn each_schema(v: &mut Value, f: &mut dyn FnMut(&mut Map<String, Value>)) {
    let Value::Object(m) = v else { return };
    f(m);
    for (k, x) in m.iter_mut() {
        match (k.as_str(), x) {
            (
                "properties" | "patternProperties" | "$defs" | "definitions",
                Value::Object(named),
            ) => named.values_mut().for_each(|s| each_schema(s, f)),
            ("oneOf" | "anyOf" | "allOf" | "prefixItems" | "items", Value::Array(list)) => {
                list.iter_mut().for_each(|s| each_schema(s, f))
            }
            (
                "items"
                | "additionalProperties"
                | "not"
                | "contains"
                | "if"
                | "then"
                | "else"
                | "propertyNames",
                s,
            ) => each_schema(s, f),
            _ => {}
        }
    }
}

fn rewrite_refs(v: &mut Value) {
    each_schema(v, &mut |m| {
        if let Some(Value::String(r)) = m.get_mut("$ref") {
            *r = r.replace("#/$defs/", "#/definitions/");
        }
        // The `format` keyword (uuid, date-time): those stay plain strings in Rust. A *property* named `format` is not a
        // keyword and is kept (media.generate's `request.format`, agent.export's `bundle.format`).
        if m.get("format").is_some_and(Value::is_string) {
            m.remove("format");
        }
        m.retain(|k, _| !k.starts_with("x-")); // stability annotations etc. are not JSON Schema
        pin_const(m);
    });
}

/// typify ignores `const` and makes such a property a `serde_json::Value` that accepts anything. `{ "const": X }` is the same
/// schema as `{ "type": <type of X>, "enum": [X] }`, which typify does enforce: a one-variant enum for a string, a newtype that
/// refuses every other value for a boolean or a number. A `const` object or array is left alone (the schema has none).
fn pin_const(m: &mut Map<String, Value>) {
    let Some(c) = m.get("const").cloned() else {
        return;
    };
    let ty = match &c {
        Value::Bool(_) => "boolean",
        Value::String(_) => "string",
        Value::Number(n) if n.is_i64() || n.is_u64() => "integer",
        Value::Number(_) => "number",
        _ => return,
    };
    m.remove("const");
    m.insert("enum".into(), Value::Array(vec![c]));
    m.entry("type").or_insert_with(|| Value::String(ty.into()));
}

/// Removes `additionalProperties: false` from a schema subtree. typify turns it into `#[serde(deny_unknown_fields)]`, which
/// would make this client reject a result field added by a newer 1.x core; ADR-016 §2 says clients ignore unknown result
/// fields. Only the params the client *sends* stay closed (the core enforces that side).
fn open_objects(v: &mut Value) {
    match v {
        Value::Object(m) => {
            if m.get("additionalProperties") == Some(&Value::Bool(false)) {
                m.remove("additionalProperties");
            }
            for (_, x) in m.iter_mut() {
                open_objects(x);
            }
        }
        Value::Array(a) => a.iter_mut().for_each(open_objects),
        _ => {}
    }
}

fn main() {
    let schema_path = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap())
        .join("../../packages/rpc-schema/schema/rpc.schema.json");
    println!("cargo:rerun-if-changed={}", schema_path.display());
    println!("cargo:rerun-if-changed=build.rs");
    let mut root: Value =
        serde_json::from_str(&fs::read_to_string(&schema_path).expect("rpc.schema.json")).unwrap();
    let mut defs: Map<String, Value> = root["$defs"].as_object().unwrap().clone();
    let methods = defs.remove("methods").unwrap();
    let notifications = defs.remove("notifications").unwrap();
    // Shared `$defs` (Capabilities, cards, ErrorObject, …) are read from the core, so they are opened too.
    defs.values_mut().for_each(open_objects);
    for (m, def) in methods.as_object().unwrap() {
        let mut params = def["params"].clone();
        // A top-level `not` (e.g. config.get's "key and tier are exclusive") would turn the struct into an opaque
        // type in typify; the server that deserialises these params enforces such a rule itself.
        if let Some(o) = params.as_object_mut() {
            o.remove("not");
        }
        defs.insert(format!("{}Params", pascal(m)), params);
        let mut result = def["result"].clone();
        open_objects(&mut result);
        defs.insert(format!("{}Result", pascal(m)), result);
    }
    for (n, def) in notifications.as_object().unwrap() {
        let mut notification = def.clone();
        open_objects(&mut notification);
        defs.insert(format!("{}Notification", pascal(n)), notification);
    }
    let rpc_version = root["x-rpc-version"].as_str().unwrap().to_string();
    let params_types: Vec<String> = methods
        .as_object()
        .unwrap()
        .keys()
        .map(|m| format!("{}Params", pascal(m)))
        .collect();
    let mut flat = serde_json::json!({ "$schema": "http://json-schema.org/draft-07/schema#", "title": "RpcRoot", "type": "object", "definitions": defs });
    rewrite_refs(&mut flat);
    let _ = root.take();
    let flat_defs = flat["definitions"].as_object().unwrap().clone();

    let schema: schemars::schema::RootSchema =
        serde_json::from_value(flat).expect("flattened schema parses");
    // JSON `number` → serde_json::Number (not f64): f64 would re-serialize the core's `17000` as `17000.0`,
    // breaking byte-level fixture parity; Number keeps the integer/float representation it was read with.
    let mut settings = typify::TypeSpaceSettings::default();
    settings.with_struct_builder(false).with_conversion(
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
    // typify keeps a boolean `enum` as a plain `bool` (it ignores the values), so a pinned boolean (`pin_const`) becomes one of
    // the two literal types appended below, which refuse the other value.
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
    space.add_root_schema(schema).expect("typify");
    let mut file = syn::parse2::<syn::File>(space.to_stream()).expect("generated code parses");
    keep_explicit_values(&mut file, &flat_defs, &params_types);
    file.items.extend(
        syn::parse_str::<syn::File>(SUPPORT)
            .expect("support code parses")
            .items,
    );
    let code = prettyplease::unparse(&file);
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    fs::write(out.join("types.rs"), code).unwrap();
    fs::write(
        out.join("rpc_version.rs"),
        format!("pub const RPC_VERSION: &str = \"{rpc_version}\";\n"),
    )
    .unwrap();
}

/// Appended to the generated types: the literal booleans of `pin_const` and the field helper of `keep_explicit_values`.
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
        _ => false,
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
        if !required.contains(name.as_str()) && (allows(sub, "null") || allows(sub, "array")) {
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
