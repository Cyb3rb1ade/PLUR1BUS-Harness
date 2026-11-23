//! Decode legacy Node Buffer and Uint8Array records at the job port.

use serde_json::{Map, Value};

use crate::{
    images,
    units::{self, Units},
    video,
};

use super::{Error, Result};

const BINARY_KEYS: [&str; 3] = ["referenceImages", "mask", "referenceVideo"];
const REFERENCE_LIMIT: usize = 50 * 1024 * 1024;

pub struct Input<F> {
    pub format: F,
    pub bytes: Vec<u8>,
}

pub struct JobRequest {
    pub parameters: Value,
    pub references: Vec<Input<images::Format>>,
    pub mask: Option<Input<images::Format>>,
    pub reference_video: Option<Input<video::Format>>,
}

impl JobRequest {
    pub fn decode(record: &Value) -> Result<Self> {
        let parameters = parameters(record)?;
        let video = parameters["kind"] == "video";
        if (video && record.get("mask").is_some())
            || (!video && record.get("referenceVideo").is_some())
        {
            return Err(Error::UnsupportedParameter);
        }
        let refs: &[Value] = match record.get("referenceImages") {
            Some(refs) => refs.as_array().ok_or(Error::UnsupportedParameter)?,
            None => &[],
        };
        let references = refs.iter().map(read_image).collect::<Result<_>>()?;
        let mask = record.get("mask").map(read_image).transpose()?;
        let reference_video = record.get("referenceVideo").map(read_video).transpose()?;
        Ok(Self {
            parameters,
            references,
            mask,
            reference_video,
        })
    }

    pub fn units(&self) -> Result<Units> {
        units::requested(&self.parameters).map_err(Into::into)
    }
}

fn parameters(request: &Value) -> Result<Value> {
    let fields = request.as_object().ok_or(Error::UnsupportedParameter)?;
    let parameters: Map<_, _> = fields
        .iter()
        .filter(|(name, _)| !BINARY_KEYS.contains(&name.as_str()))
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect();
    Ok(Value::Object(parameters))
}

pub(super) fn requested(request: &Value) -> Result<Units> {
    if BINARY_KEYS.iter().any(|key| request.get(key).is_some()) {
        units::requested(&parameters(request)?).map_err(Into::into)
    } else {
        units::requested(request).map_err(Into::into)
    }
}

fn read_image(record: &Value) -> Result<Input<images::Format>> {
    let bytes = bytes(&record["bytes"])?;
    let format = serde_json::from_value(record["format"].clone())
        .ok()
        .or_else(|| images::Format::sniff(&bytes))
        .ok_or(Error::UnsupportedParameter)?;
    Ok(Input { format, bytes })
}

fn read_video(record: &Value) -> Result<Input<video::Format>> {
    let bytes = bytes(&record["bytes"])?;
    let format = record["format"]
        .as_str()
        .and_then(|format| format.parse().ok())
        .or_else(|| video::detect_format(&bytes).ok())
        .ok_or(Error::UnsupportedParameter)?;
    Ok(Input { format, bytes })
}

fn bytes(value: &Value) -> Result<Vec<u8>> {
    if value["type"] == "Buffer" {
        return ordered_bytes(
            value["data"]
                .as_array()
                .ok_or(Error::UnsupportedParameter)?,
        );
    }
    if let Some(array) = value.as_array() {
        return ordered_bytes(array);
    }
    let fields = value.as_object().ok_or(Error::UnsupportedParameter)?;
    if fields.len() > REFERENCE_LIMIT {
        return Err(Error::TooLarge);
    }
    let mut output = vec![0; fields.len()];
    for (index, value) in fields {
        let parsed = index
            .parse::<usize>()
            .map_err(|_| Error::UnsupportedParameter)?;
        if parsed.to_string() != *index {
            return Err(Error::UnsupportedParameter);
        }
        *output.get_mut(parsed).ok_or(Error::UnsupportedParameter)? = byte(value)?;
    }
    Ok(output)
}

fn ordered_bytes(values: &[Value]) -> Result<Vec<u8>> {
    if values.len() > REFERENCE_LIMIT {
        return Err(Error::TooLarge);
    }
    values.iter().map(byte).collect()
}

fn byte(value: &Value) -> Result<u8> {
    value
        .as_u64()
        .and_then(|value| u8::try_from(value).ok())
        .ok_or(Error::UnsupportedParameter)
}
