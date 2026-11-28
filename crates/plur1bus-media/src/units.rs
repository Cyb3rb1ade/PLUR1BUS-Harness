//! Requested and delivered units for the host-owned media job budget.
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Units {
    Images(u32),
    VideoSeconds(f64),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Invalid {
    UnsupportedParameter,
    TooLarge,
}

pub fn requested(request: &Value) -> Result<Units, Invalid> {
    use Invalid::{TooLarge, UnsupportedParameter};
    if !request.is_object() {
        return Err(UnsupportedParameter);
    }
    let video = match request.get("kind") {
        Some(kind) if kind == "video" => true,
        Some(kind) if kind == "image" => false,
        None => false,
        _ => return Err(UnsupportedParameter),
    };
    // The metadata-only boundary cannot validate binary inputs.
    if includes_binary_input(request) {
        return Err(UnsupportedParameter);
    }
    let includes = |keys: &[&str]| keys.iter().any(|key| request.get(key).is_some());
    let count = request
        .get("n")
        .map_or(Some(1), |n| n.as_u64().filter(|n| (1..=10).contains(n)))
        .ok_or(UnsupportedParameter)? as u32;
    let duration = if video {
        if count != 1
            || includes(&["mask", "format", "steps", "guidance"])
            || !whole(request, "fps", 1, 120)
            || !choice(request, "videoFormat", &["mp4", "webm", "mov"])
        {
            return Err(UnsupportedParameter);
        }
        request
            .get("durationSeconds")
            .map_or(Some(8.), |value| {
                value
                    .as_f64()
                    .filter(|number| *number > 0. && *number <= 600.)
            })
            .ok_or(UnsupportedParameter)?
    } else {
        if includes(&[
            "durationSeconds",
            "resolution",
            "fps",
            "audio",
            "videoFormat",
            "referenceVideo",
        ]) {
            return Err(UnsupportedParameter);
        }
        0.
    };
    let prompt = request["prompt"]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .ok_or(UnsupportedParameter)?;
    if prompt.encode_utf16().take(32_001).count() > 32_000 {
        return Err(TooLarge);
    }
    if let Some(size) = request.get("size") {
        if size.as_object().is_none_or(|dims| dims.len() != 2)
            || !size["width"]
                .as_u64()
                .is_some_and(|n| (1..=8192).contains(&n))
            || !size["height"]
                .as_u64()
                .is_some_and(|n| (1..=8192).contains(&n))
        {
            return Err(UnsupportedParameter);
        }
    }
    if !whole(request, "steps", 1, 1000)
        || !choice(request, "format", &["png", "jpeg", "webp"])
        || ["seed", "guidance"]
            .iter()
            .any(|key| request.get(key).is_some_and(|value| !value.is_number()))
    {
        return Err(UnsupportedParameter);
    }
    Ok(if video {
        Units::VideoSeconds(duration)
    } else {
        Units::Images(count)
    })
}

fn includes_binary_input(request: &Value) -> bool {
    ["referenceImages", "referenceVideo", "mask"]
        .iter()
        .any(|key| request.get(key).is_some())
}

fn whole(value: &Value, key: &str, lower: u64, upper: u64) -> bool {
    value
        .get(key)
        .is_none_or(|value| value.as_u64().is_some_and(|n| (lower..=upper).contains(&n)))
}

fn choice(value: &Value, key: &str, choices: &[&str]) -> bool {
    value
        .get(key)
        .is_none_or(|value| value.as_str().is_some_and(|word| choices.contains(&word)))
}

/// Use already verified media metadata from the output store. Image files
/// contribute one unit. A video lacking a measured duration uses the request.
pub fn delivered(request: Units, files: &[Option<f64>]) -> Result<Units, Invalid> {
    match request {
        Units::Images(_) => u32::try_from(files.len())
            .map(Units::Images)
            .map_err(|_| Invalid::TooLarge),
        Units::VideoSeconds(default) => {
            let total = files.iter().try_fold(0., |sum, duration| {
                let duration = duration.unwrap_or(default);
                let next = sum + duration;
                if duration.is_finite() && duration >= 0. && next.is_finite() {
                    Ok(next)
                } else {
                    Err(Invalid::UnsupportedParameter)
                }
            })?;
            Ok(Units::VideoSeconds(total))
        }
    }
}
