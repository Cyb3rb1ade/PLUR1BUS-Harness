//! Generates src/types.rs (into OUT_DIR) from packages/rpc-schema/schema/rpc.schema.json — the single source.
//! Same flattening as packages/rpc-schema/src/build.mjs: methods/<m>/{params,result} → <PascalM>{Params,Result},
//! notifications/<n> → <PascalN>Notification. `$defs` becomes `definitions` for schemars 0.8.
use serde_json::{Map, Value};
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

fn rewrite_refs(v: &mut Value) {
    match v {
        Value::Object(m) => {
            if let Some(Value::String(r)) = m.get_mut("$ref") {
                *r = r.replace("#/$defs/", "#/definitions/");
            }
            m.remove("format"); // uuid/date-time stay plain strings in Rust
            for (_, x) in m.iter_mut() {
                rewrite_refs(x);
            }
        }
        Value::Array(a) => a.iter_mut().for_each(rewrite_refs),
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
    for (m, def) in methods.as_object().unwrap() {
        defs.insert(format!("{}Params", pascal(m)), def["params"].clone());
        defs.insert(format!("{}Result", pascal(m)), def["result"].clone());
    }
    for (n, def) in notifications.as_object().unwrap() {
        defs.insert(format!("{}Notification", pascal(n)), def.clone());
    }
    let rpc_version = root["x-rpc-version"].as_str().unwrap().to_string();
    let mut flat = serde_json::json!({ "$schema": "http://json-schema.org/draft-07/schema#", "title": "RpcRoot", "type": "object", "definitions": defs });
    rewrite_refs(&mut flat);
    let _ = root.take();

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
    let mut space = typify::TypeSpace::new(&settings);
    space.add_root_schema(schema).expect("typify");
    let code = prettyplease::unparse(
        &syn::parse2::<syn::File>(space.to_stream()).expect("generated code parses"),
    );
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    fs::write(out.join("types.rs"), code).unwrap();
    fs::write(
        out.join("rpc_version.rs"),
        format!("pub const RPC_VERSION: &str = \"{rpc_version}\";\n"),
    )
    .unwrap();
}
