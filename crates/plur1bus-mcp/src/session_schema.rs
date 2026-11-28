//! Bounded structural validation of a peer's advertised tool output.
use jsonschema::{Draft, Validator};
use serde_json::{Map, Value};

use crate::session::Error;

const MAX_SCHEMA_NODES: usize = 4096;
const MAX_INSTANCE_NODES: usize = 4096;
const MAX_WORK: usize = 256 * 1024;

pub(crate) struct OutputSchema {
    validator: Validator,
    size: usize,
}
impl OutputSchema {
    pub(crate) fn compile(schema: &Map<String, Value>) -> Result<Self, Error> {
        let mut size = 0;
        let clean = sanitize(&Value::Object(schema.clone()), 0, &mut size)?;
        let validator = jsonschema::options()
            .with_draft(Draft::Draft202012)
            .should_validate_formats(false)
            .build(&clean)
            .map_err(|_| Error::Protocol)?;
        Ok(Self { validator, size })
    }

    pub(crate) fn validate(&self, content: Option<&Value>) -> Result<(), Error> {
        let value = content.ok_or(Error::Protocol)?;
        let mut count = 0;
        let mut pending = vec![value];
        while let Some(item) = pending.pop() {
            count += 1;
            if count > MAX_INSTANCE_NODES || self.size.saturating_mul(count) > MAX_WORK {
                return Err(Error::Protocol);
            }
            match item {
                Value::Array(items) if items.len() <= 256 => pending.extend(items),
                Value::Array(_) => return Err(Error::Protocol),
                Value::Object(items) if items.len() <= 256 => pending.extend(items.values()),
                Value::Object(_) => return Err(Error::Protocol),
                _ => {}
            }
        }
        if self.validator.is_valid(value) {
            Ok(())
        } else {
            Err(Error::Protocol)
        }
    }
}

fn sanitize(value: &Value, depth: usize, count: &mut usize) -> Result<Value, Error> {
    *count += 1;
    if depth > 32 || *count > MAX_SCHEMA_NODES {
        return Err(Error::Protocol);
    }
    Ok(match value {
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|value| sanitize(value, depth + 1, count))
                .collect::<Result<_, _>>()?,
        ),
        Value::Object(object) => {
            let had_patterns = object.contains_key("patternProperties");
            let mut safe = Map::new();
            for (name, value) in object {
                match name.as_str() {
                    "$ref" | "$dynamicRef" | "$recursiveRef" => return Err(Error::Protocol),
                    "pattern" | "patternProperties" => continue,
                    "additionalProperties" | "unevaluatedProperties" if had_patterns => continue,
                    "enum" | "const" | "default" | "examples" => {
                        count_data(value, depth + 1, count)?;
                        safe.insert(name.clone(), value.clone());
                    }
                    "properties" | "$defs" | "definitions" | "dependentSchemas"
                    | "dependencies"
                        if value.is_object() =>
                    {
                        let nested = value.as_object().ok_or(Error::Protocol)?;
                        let fields = nested
                            .iter()
                            .map(|(field, schema)| {
                                Ok((field.clone(), sanitize(schema, depth + 1, count)?))
                            })
                            .collect::<Result<Map<_, _>, Error>>()?;
                        safe.insert(name.clone(), Value::Object(fields));
                    }
                    _ => {
                        safe.insert(name.clone(), sanitize(value, depth + 1, count)?);
                    }
                }
            }
            Value::Object(safe)
        }
        primitive => primitive.clone(),
    })
}

fn count_data(value: &Value, depth: usize, count: &mut usize) -> Result<(), Error> {
    *count += 1;
    if depth > 32 || *count > MAX_SCHEMA_NODES {
        return Err(Error::Protocol);
    }
    match value {
        Value::Array(items) => items
            .iter()
            .try_for_each(|item| count_data(item, depth + 1, count)),
        Value::Object(items) => items
            .values()
            .try_for_each(|item| count_data(item, depth + 1, count)),
        _ => Ok(()),
    }
}

#[cfg(test)]
#[allow(clippy::expect_used, reason = "ordinary schema fixtures")]
mod tests {
    use super::*;

    #[test]
    fn output_schema_validates_structure_without_remote_references_or_pattern_checks() {
        let shape = serde_json::json!({
            "type":"object","required":["pattern"],"properties":{
              "pattern":{"type":"string","minLength":2,"pattern":"^[a-z]+$"}
            },"additionalProperties":false
        });
        let compiled = OutputSchema::compile(shape.as_object().expect("fixture schema"))
            .expect("valid schema");
        assert!(compiled
            .validate(Some(&serde_json::json!({"pattern":"Notes"})))
            .is_ok());
        assert!(compiled
            .validate(Some(&serde_json::json!({"pattern":10})))
            .is_err());
        assert!(compiled.validate(None).is_err());
        let reference = serde_json::json!({"$ref":"https://fixture.invalid/schema"});
        assert!(OutputSchema::compile(reference.as_object().expect("fixture schema")).is_err());
    }
}
