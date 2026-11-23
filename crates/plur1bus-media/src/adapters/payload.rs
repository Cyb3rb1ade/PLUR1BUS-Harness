use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{Map, Value};

use crate::{
    http::{Body, Image},
    jobs::{Error, Result},
};

use super::{
    ordered::{object, Field, Object},
    schema::{self, Model},
    uri_component, Observer, Provider,
};

pub(super) struct Prepared<'a> {
    pub(super) params: &'a Value,
    pub(super) prompt: &'a str,
    pub(super) count: u32,
    pub(super) refs: Vec<Image>,
    pub(super) mask: Option<Image>,
}

pub(super) trait DataUri {
    fn data_uri(&self) -> String;
}

impl DataUri for Image {
    fn data_uri(&self) -> String {
        format!(
            "data:image/{};base64,{}",
            self.format.extension(),
            STANDARD.encode(&self.bytes)
        )
    }
}

pub(super) struct Submission {
    pub(super) path: String,
    pub(super) bytes: Vec<u8>,
    multipart_type: Option<String>,
}

impl Submission {
    pub(super) fn body(&self) -> Body<'_> {
        self.multipart_type.as_ref().map_or_else(
            || Body::json(&self.bytes),
            |mime| Body::multipart(&self.bytes, mime),
        )
    }

    fn json(path: impl Into<String>, object: &Object) -> Result<Self> {
        let bytes = serde_json::to_vec(object).map_err(|_| Error::UnsupportedParameter)?;
        Ok(Self {
            path: path.into(),
            bytes,
            multipart_type: None,
        })
    }
}

pub(super) fn build(
    provider: Provider,
    model: &str,
    request: &Prepared<'_>,
    edit: bool,
    schema: Option<&Map<String, Value>>,
    observer: &mut dyn Observer,
) -> Result<Submission> {
    use Provider::{DrawThings, Fal, Google, OpenAi, OpenRouter, Replicate, Together, Xai};
    let p = request.params;
    let format = p["format"].as_str().unwrap_or("png");
    if !edit && (!request.refs.is_empty() || request.mask.is_some()) {
        return Err(Error::UnsupportedParameter);
    }
    if request.mask.is_some() && (!provider.can_mask() || request.refs.is_empty()) {
        return Err(Error::UnsupportedParameter);
    }
    match provider {
        OpenAi => open_ai(model, request, edit, observer),
        OpenRouter | Google => chat(provider, model, request),
        Xai => {
            forbid(p, &["seed", "steps", "guidance", "negativePrompt", "size"])?;
            let mut body = object([
                ("model", model.into()),
                ("prompt", request.prompt.into()),
                ("n", request.count.into()),
                ("response_format", "b64_json".into()),
            ]);
            body.copy("aspect_ratio", p, "aspect");
            Submission::json("images/generations", &body)
        }
        DrawThings => {
            forbid(p, &["aspect", "format"])?;
            if request.refs.len() > 1 {
                return Err(Error::UnsupportedParameter);
            }
            let negative = p["negativePrompt"].as_str().unwrap_or_default();
            let mut body = object([
                ("model", model.into()),
                ("prompt", request.prompt.into()),
                ("negative_prompt", negative.into()),
                ("batch_size", request.count.into()),
            ]);
            copy_size(&mut body, p);
            for (key, src) in [
                ("seed", "seed"),
                ("steps", "steps"),
                ("cfg_scale", "guidance"),
            ] {
                body.copy(key, p, src);
            }
            if edit {
                body.put(
                    "init_images",
                    Field::List(
                        request
                            .refs
                            .iter()
                            .map(|image| STANDARD.encode(&image.bytes).into())
                            .collect(),
                    ),
                );
            }
            Submission::json(
                if edit {
                    "sdapi/v1/img2img"
                } else {
                    "sdapi/v1/txt2img"
                },
                &body,
            )
        }
        Together => {
            forbid(p, &["aspect"])?;
            if format == "webp" {
                return Err(Error::UnsupportedParameter);
            }
            let mut body = object([
                ("model", model.into()),
                ("prompt", request.prompt.into()),
                ("n", request.count.into()),
                ("response_format", "base64".into()),
                ("output_format", format.into()),
            ]);
            copy_size(&mut body, p);
            for (key, src) in [
                ("seed", "seed"),
                ("steps", "steps"),
                ("guidance_scale", "guidance"),
                ("negative_prompt", "negativePrompt"),
            ] {
                body.copy(key, p, src);
            }
            Submission::json("images/generations", &body)
        }
        Replicate => replicate(model, request, edit, schema),
        Fal => fal(model, request, edit),
    }
}

fn open_ai(
    model: &str,
    request: &Prepared<'_>,
    edit: bool,
    observer: &mut dyn Observer,
) -> Result<Submission> {
    let p = request.params;
    forbid(
        p,
        &["seed", "steps", "guidance", "negativePrompt", "aspect"],
    )?;
    let format = p["format"].as_str().unwrap_or("png");
    let size = p
        .get("size")
        .map(|size| format!("{}x{}", size["width"], size["height"]));
    if !edit {
        let mut body = object([
            ("model", model.into()),
            ("prompt", request.prompt.into()),
            ("n", request.count.into()),
            ("output_format", format.into()),
        ]);
        if let Some(size) = size {
            body.put("size", size);
        }
        return Submission::json("images/generations", &body);
    }
    let boundary = observer.multipart_boundary()?;
    if !(16..=70).contains(&boundary.len())
        || !boundary
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(Error::UnsupportedParameter);
    }
    let count = request.count.to_string();
    let mut bytes = Vec::new();
    for (name, value) in [
        ("model", model),
        ("prompt", request.prompt),
        ("n", &count),
        ("output_format", format),
    ] {
        append_text(&mut bytes, &boundary, name, value);
    }
    if let Some(size) = size {
        append_text(&mut bytes, &boundary, "size", &size);
    }
    for image in &request.refs {
        append_image(&mut bytes, &boundary, "image[]", "image", image);
    }
    if let Some(mask) = &request.mask {
        append_image(&mut bytes, &boundary, "mask", "mask", mask);
    }
    bytes.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    Ok(Submission {
        path: "images/edits".into(),
        bytes,
        multipart_type: Some(format!("multipart/form-data; boundary={boundary}")),
    })
}

fn append_text(bytes: &mut Vec<u8>, boundary: &str, name: &str, value: &str) {
    let value = value
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace('\n', "\r\n");
    bytes.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
        )
        .as_bytes(),
    );
}

fn append_image(bytes: &mut Vec<u8>, boundary: &str, name: &str, kind: &str, image: &Image) {
    let ext = image.format.extension();
    bytes.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{kind}.{ext}\"\r\nContent-Type: image/{ext}\r\n\r\n").as_bytes());
    bytes.extend_from_slice(&image.bytes);
    bytes.extend_from_slice(b"\r\n");
}

fn chat(provider: Provider, model: &str, request: &Prepared<'_>) -> Result<Submission> {
    let p = request.params;
    forbid(
        p,
        &[
            "seed",
            "steps",
            "guidance",
            "negativePrompt",
            "size",
            "format",
        ],
    )?;
    if provider == Provider::OpenRouter {
        let mut content =
            vec![object([("type", "text".into()), ("text", request.prompt.into())]).into()];
        content.extend(request.refs.iter().map(|image| {
            object([
                ("type", "image_url".into()),
                (
                    "image_url",
                    object([("url", image.data_uri().into())]).into(),
                ),
            ])
            .into()
        }));
        let messages = Field::List(vec![object([
            ("role", "user".into()),
            ("content", Field::List(content)),
        ])
        .into()]);
        let mut body = object([
            ("model", model.into()),
            (
                "modalities",
                Field::List(vec!["image".into(), "text".into()]),
            ),
            ("messages", messages),
        ]);
        if let Some(aspect) = p["aspect"].as_str().filter(|value| !value.is_empty()) {
            body.put("image_config", object([("aspect_ratio", aspect.into())]));
        }
        return Submission::json("chat/completions", &body);
    }
    let mut parts = vec![object([("text", request.prompt.into())]).into()];
    parts.extend(request.refs.iter().map(|image| {
        let data = object([
            (
                "mimeType",
                format!("image/{}", image.format.extension()).into(),
            ),
            ("data", STANDARD.encode(&image.bytes).into()),
        ]);
        object([("inlineData", data.into())]).into()
    }));
    let mut options = object([(
        "responseModalities",
        Field::List(vec!["TEXT".into(), "IMAGE".into()]),
    )]);
    if let Some(aspect) = p["aspect"].as_str().filter(|value| !value.is_empty()) {
        options.put("imageConfig", object([("aspectRatio", aspect.into())]));
    }
    Submission::json(
        format!("models/{}:generateContent", uri_component(model)),
        &object([
            (
                "contents",
                Field::List(vec![object([("parts", Field::List(parts))]).into()]),
            ),
            ("generationConfig", options.into()),
        ]),
    )
}

fn replicate(
    model: &str,
    request: &Prepared<'_>,
    edit: bool,
    schema: Option<&Map<String, Value>>,
) -> Result<Submission> {
    let parsed = Model::parse(model);
    let version = parsed.as_ref().and_then(|model| model.version);
    let mut body = Object::default();
    let input = if let Some(schema) = schema {
        schema::map_input(request, schema, edit)?
    } else {
        forbid(request.params, &["negativePrompt", "guidance", "size"])?;
        if edit {
            return Err(Error::UnsupportedParameter);
        }
        let mut input = gateway(request);
        let format = request.params["format"].as_str().unwrap_or("png");
        input.put(
            "output_format",
            if format == "jpeg" { "jpg" } else { format },
        );
        input.put("num_outputs", request.count);
        input
    };
    if let Some(version) = version {
        body.put("version", version);
    }
    body.put("input", input);
    Submission::json(
        version.map_or_else(
            || format!("models/{model}/predictions"),
            |_| "predictions".into(),
        ),
        &body,
    )
}

fn fal(model: &str, request: &Prepared<'_>, edit: bool) -> Result<Submission> {
    let p = request.params;
    forbid(p, &["negativePrompt", "aspect"])?;
    let format = p["format"].as_str().unwrap_or("png");
    if format == "webp" || (edit && request.refs.len() > 1) {
        return Err(Error::UnsupportedParameter);
    }
    let mut body = gateway(request);
    body.put("output_format", format);
    body.put("num_images", request.count);
    body.put("enable_safety_checker", true);
    if let Some(size) = p.get("size") {
        body.put(
            "image_size",
            object([
                ("width", size["width"].clone().into()),
                ("height", size["height"].clone().into()),
            ]),
        );
    }
    body.copy("guidance_scale", p, "guidance");
    if edit {
        let image = request.refs.first().ok_or(Error::UnsupportedParameter)?;
        body.put("image_url", image.data_uri());
        if let Some(mask) = &request.mask {
            body.put("mask_url", mask.data_uri());
        }
    }
    Submission::json(model, &body)
}

fn gateway(request: &Prepared<'_>) -> Object {
    let mut input = object([("prompt", request.prompt.into())]);
    input.copy("seed", request.params, "seed");
    input.copy("num_inference_steps", request.params, "steps");
    if let Some(value) = request.params["aspect"]
        .as_str()
        .filter(|value| !value.is_empty())
    {
        input.put("aspect_ratio", value);
    }
    input
}

fn copy_size(body: &mut Object, p: &Value) {
    body.copy("width", &p["size"], "width");
    body.copy("height", &p["size"], "height");
}

fn forbid(params: &Value, fields: &[&str]) -> Result<()> {
    if fields.iter().any(|field| params.get(field).is_some()) {
        Err(Error::UnsupportedParameter)
    } else {
        Ok(())
    }
}
