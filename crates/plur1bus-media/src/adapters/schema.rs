//! Mapping to a model's declared Replicate-compatible input fields.
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value};

use crate::jobs::{Error, Result};

use super::{
    ordered::{Field, Object},
    payload::{DataUri, Prepared},
};

pub(super) struct Model<'a> {
    owner: &'a str,
    name: &'a str,
    pub(super) version: Option<&'a str>,
}

impl<'a> Model<'a> {
    pub(super) fn parse(model: &'a str) -> Option<Self> {
        static REFERENCE: LazyLock<Option<Regex>> = LazyLock::new(|| {
            Regex::new(
                r"^([A-Za-z0-9][A-Za-z0-9._-]*)/([A-Za-z0-9][A-Za-z0-9._-]*)(?::([A-Za-z0-9]+))?$",
            )
            .ok()
        });
        let captures = REFERENCE.as_ref()?.captures(model)?;
        Some(Self {
            owner: captures.get(1)?.as_str(),
            name: captures.get(2)?.as_str(),
            version: captures.get(3).map(|v| v.as_str()),
        })
    }

    pub(super) fn schema_path(&self) -> String {
        self.version.map_or_else(
            || self.path(),
            |version| format!("{}/versions/{version}", self.path()),
        )
    }

    pub(super) fn path(&self) -> String {
        format!("models/{}/{}", self.owner, self.name)
    }
}

pub(super) fn from_document(document: &Value) -> Option<Map<String, Value>> {
    let schema = document["latest_version"]["openapi_schema"]
        .as_object()
        .or_else(|| document["openapi_schema"].as_object())?;
    schema.get("components")?["schemas"]["Input"]["properties"]
        .as_object()
        .filter(|properties| !properties.is_empty())
        .cloned()
}

pub(super) fn map_input(
    request: &Prepared<'_>,
    schema: &Map<String, Value>,
    edit: bool,
) -> Result<Object> {
    let mut body = Object::default();
    let params = request.params;
    set(&mut body, schema, &["prompt"], &params["prompt"])?;
    for (key, exported) in [
        ("negativePrompt", &["negative_prompt"][..]),
        ("seed", &["seed"][..]),
        ("steps", &["num_inference_steps", "steps"][..]),
        ("guidance", &["guidance_scale", "guidance", "cfg"][..]),
        ("aspect", &["aspect_ratio"][..]),
    ] {
        if let Some(value) = params.get(key) {
            set(&mut body, schema, exported, value)?;
        }
    }
    if let Some(size) = params.get("size") {
        set(&mut body, schema, &["width"], &size["width"])?;
        set(&mut body, schema, &["height"], &size["height"])?;
    }
    if let Some(count) = params.get("n") {
        if let Some(name) = key(schema, &["num_outputs", "num_images", "batch_size"]) {
            set(&mut body, schema, &[name], count)?;
        } else if request.count > 1 {
            return Err(Error::UnsupportedParameter);
        }
    }
    if let Some(format) = params.get("format").and_then(Value::as_str) {
        let candidates: &[&str] = if format == "jpeg" {
            &["jpg", "jpeg"]
        } else {
            &[format]
        };
        let choice = schema
            .get("output_format")
            .and_then(|prop| prop["enum"].as_array())
            .and_then(|items| {
                candidates
                    .iter()
                    .copied()
                    .find(|candidate| items.iter().any(|item| item == *candidate))
            })
            .unwrap_or(candidates[0]);
        set(&mut body, schema, &["output_format"], &Value::from(choice))?;
    }
    if edit {
        match request.refs.as_slice() {
            [] => {}
            [image] if key(schema, &SINGLE_IMAGE).is_some() => {
                put_first(&mut body, schema, &SINGLE_IMAGE, image.data_uri().into())?;
            }
            images => {
                let values = images.iter().map(|image| image.data_uri().into()).collect();
                put_first(&mut body, schema, &MANY_IMAGES, Field::List(values))?;
            }
        }
        if let Some(mask) = &request.mask {
            put_first(
                &mut body,
                schema,
                &["mask", "mask_image"],
                mask.data_uri().into(),
            )?;
        }
    }
    Ok(body)
}

const SINGLE_IMAGE: [&str; 7] = [
    "image",
    "input_image",
    "init_image",
    "image_prompt",
    "image_url",
    "start_image_url",
    "first_frame_url",
];
const MANY_IMAGES: [&str; 4] = ["input_images", "image_input", "images", "image_urls"];

pub(super) fn set(
    body: &mut Object,
    schema: &Map<String, Value>,
    names: &[&'static str],
    value: &Value,
) -> Result<()> {
    let name = key(schema, names).ok_or(Error::UnsupportedParameter)?;
    let property = &schema[name];
    if property["enum"]
        .as_array()
        .is_some_and(|values| !values.contains(value))
        || value.as_f64().is_some_and(|number| {
            property["minimum"].as_f64().is_some_and(|min| number < min)
                || property["maximum"].as_f64().is_some_and(|max| number > max)
        })
    {
        return Err(Error::UnsupportedParameter);
    }
    body.put(name, value.clone());
    Ok(())
}

fn put_first(
    body: &mut Object,
    schema: &Map<String, Value>,
    names: &[&'static str],
    value: Field,
) -> Result<()> {
    let key = key(schema, names).ok_or(Error::UnsupportedParameter)?;
    body.put(key, value);
    Ok(())
}

fn key(schema: &Map<String, Value>, names: &[&'static str]) -> Option<&'static str> {
    names
        .iter()
        .copied()
        .find(|name| schema.contains_key(*name))
}
