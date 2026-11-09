//! Native extensions validate supplied settings without changing pinned manifest recordings.
use super::{Embedded, NATIVE_NEO_SCHEMA_JSON};
use serde_json::Value;

pub(super) fn install_validation_fields(schema: &mut Value) {
    let mut extension: Value =
        serde_json::from_str(NATIVE_NEO_SCHEMA_JSON).embedded("native N1 schema");
    // The public legacy manifest helpers retain their pinned default shape. Native
    // StorePolicy resolves the explicit defaults from this same extension schema.
    remove_defaults(&mut extension);
    for (name, field) in extension["properties"]
        .as_object()
        .embedded("native Neo properties")
    {
        schema["properties"]["neo"]["properties"][name] = field.clone();
    }
}
fn remove_defaults(value: &mut Value) {
    if let Value::Object(fields) = value {
        fields.remove("default");
        for child in fields.values_mut() {
            remove_defaults(child);
        }
    }
}
