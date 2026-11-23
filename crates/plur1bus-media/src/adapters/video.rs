use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::{
    http::{Binary, Body, Client, Image, Method},
    images,
    jobs::{Checkpoint, Error, Progress, Result, Stage},
    units::{self, Units},
    video::Format,
};

use super::{
    duration_ms, moderation,
    ordered::{object, Field, Object},
    payload::{DataUri, Prepared},
    safe_id,
    schema::{self, Model},
    uri_component, valid_model, Call, Observer, Provider, Run,
};

const MAX_REFERENCE_BYTES: usize = 50 * 1024 * 1024;

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct VideoProfile {
    pub model: Option<String>,
    pub text_to_video: bool,
    pub image_to_video: bool,
    pub video_to_video: bool,
    pub audio: bool,
    pub duration_seconds: Option<[f64; 2]>,
    pub resolutions: Option<Vec<String>>,
    pub aspects: Option<Vec<String>>,
    pub fps: Option<Vec<u32>>,
    pub input_schema: Option<Map<String, Value>>,
}

pub struct VideoRequest<'a> {
    pub parameters: &'a Value,
    pub reference_image: Option<&'a [u8]>,
    pub reference_video: Option<&'a [u8]>,
}

pub struct SanitizedVideo {
    pub bytes: Vec<u8>,
    pub format: Format,
}

impl SanitizedVideo {
    fn mime(&self) -> &'static str {
        match self.format {
            Format::Mp4 => "video/mp4",
            Format::Mov => "video/quicktime",
            Format::Webm => "video/webm",
        }
    }

    fn uri(&self) -> String {
        format!(
            "data:{};base64,{}",
            self.mime(),
            STANDARD.encode(&self.bytes)
        )
    }
}

pub trait ReferenceVideo {
    /// Stage the input privately, remux it using the bounded ffmpeg port and
    /// return only the cleaned container. Any failure discards the staging directory.
    fn sanitize(&self, input: &[u8], deadline: Instant) -> Result<SanitizedVideo>;
}

pub struct VideoAdapter<'a> {
    provider: Provider,
    model: String,
    http: Client<'a>,
    poll: Duration,
    profile: VideoProfile,
    cleaner: Option<&'a dyn ReferenceVideo>,
}

pub struct VideoOutput<'a> {
    pub metadata: Value,
    pub download: Download<'a>,
}

/// Open the single-use download after the caller has reserved storage and installed its cancellation port.
pub struct Download<'a> {
    http: &'a Client<'a>,
    uri: String,
    authenticated: bool,
    deadline: Instant,
}

impl<'a> Download<'a> {
    pub fn open(self) -> Result<Binary<'a>> {
        self.http
            .stream(&self.uri, self.authenticated, self.deadline)
    }
}

impl<'a> VideoAdapter<'a> {
    pub fn new(
        provider: Provider,
        model: &str,
        http: Client<'a>,
        poll: Duration,
        profile: VideoProfile,
    ) -> Result<Self> {
        let model = profile.model.clone().unwrap_or_else(|| model.into());
        if !matches!(
            provider,
            Provider::Google
                | Provider::OpenRouter
                | Provider::Xai
                | Provider::Replicate
                | Provider::Fal
        ) || !valid_model(&model)
            || poll.as_millis() == 0
        {
            return Err(Error::UnsupportedParameter);
        }
        Ok(Self {
            provider,
            model,
            http,
            poll,
            profile,
            cleaner: None,
        })
    }

    pub fn with_reference_cleaner(mut self, cleaner: &'a dyn ReferenceVideo) -> Self {
        self.cleaner = Some(cleaner);
        self
    }

    pub fn generate(
        &self,
        request: &VideoRequest<'_>,
        observer: &mut dyn Observer,
        run: Run<'_>,
    ) -> Call<VideoOutput<'_>> {
        self.execute(request, observer, run, false)
    }

    pub fn edit(
        &self,
        request: &VideoRequest<'_>,
        observer: &mut dyn Observer,
        run: Run<'_>,
    ) -> Call<VideoOutput<'_>> {
        self.execute(request, observer, run, true)
    }

    fn validate(&self, request: &VideoRequest<'_>, edit: bool) -> Result<()> {
        let p = request.parameters;
        let cap = &self.profile;
        let has_image = request.reference_image.is_some();
        let has_video = request.reference_video.is_some();
        if !matches!(units::requested(p)?, Units::VideoSeconds(_))
            || (!edit && !cap.text_to_video)
            || (edit && !has_image && !has_video)
            || (has_image && !cap.image_to_video)
            || (has_video
                && (!cap.video_to_video || self.provider == Provider::OpenRouter || has_image))
            || p.get("size").is_some()
            || p["durationSeconds"]
                .as_f64()
                .zip(cap.duration_seconds)
                .is_some_and(|(value, [min, max])| value < min || value > max)
            || p["resolution"]
                .as_str()
                .zip(cap.resolutions.as_ref())
                .is_some_and(|(value, allowed)| !allowed.iter().any(|option| option == value))
            || p["aspect"]
                .as_str()
                .zip(cap.aspects.as_ref())
                .is_some_and(|(value, allowed)| !allowed.iter().any(|option| option == value))
            || p["fps"].as_u64().is_some_and(|value| {
                cap.fps
                    .as_ref()
                    .is_none_or(|allowed| !allowed.contains(&(value as u32)))
            })
            || (p.get("audio").is_some() && !cap.audio)
        {
            return Err(Error::UnsupportedParameter);
        }
        if [request.reference_image, request.reference_video]
            .into_iter()
            .flatten()
            .any(|bytes| bytes.len() > MAX_REFERENCE_BYTES)
        {
            return Err(Error::TooLarge);
        }
        Ok(())
    }

    fn execute(
        &self,
        request: &VideoRequest<'_>,
        observer: &mut dyn Observer,
        run: Run<'_>,
        edit: bool,
    ) -> Call<VideoOutput<'_>> {
        self.validate(request, edit)?;
        let start = self.http.wall_time();
        let mut pending = run.resume.map(|checkpoint| checkpoint.id.clone());
        let result = (|| {
            self.http.check(run.deadline)?;
            if run.resume.is_some_and(|checkpoint| {
                checkpoint.model != self.model || !valid_id(self.provider, &checkpoint.id)
            }) {
                return Err(Error::UnsupportedParameter.into());
            }
            let input = request.parameters;
            let image = request
                .reference_image
                .map(|bytes| {
                    let (format, bytes) = images::sanitize(bytes)?;
                    Ok::<_, Error>(Image { format, bytes })
                })
                .transpose()?;
            let video = request
                .reference_video
                .map(|bytes| {
                    let cleaner = self.cleaner.ok_or(Error::BackendUnavailable)?;
                    let video = cleaner.sanitize(bytes, run.deadline)?;
                    if video.bytes.len() > MAX_REFERENCE_BYTES {
                        return Err(Error::TooLarge);
                    }
                    Ok(video)
                })
                .transpose()?;
            let mut response = Value::Null;
            if pending.is_none() {
                let (path, request) = self.submission(input, image, video.as_ref(), run)?;
                let body = serde_json::to_vec(&request).map_err(|_| Error::UnsupportedParameter)?;
                response =
                    self.http
                        .json(Method::Post, &path, Some(Body::json(&body)), run.deadline)?;
                let field = match self.provider {
                    Provider::Google => "name",
                    Provider::OpenRouter | Provider::Replicate => "id",
                    _ => "request_id",
                };
                let id = response[field]
                    .as_str()
                    .filter(|id| valid_id(self.provider, id))
                    .ok_or(Error::InvalidResponse)?;
                pending = Some(id.to_owned());
                observer.checkpoint(Checkpoint {
                    id: id.into(),
                    model: self.model.clone(),
                })?;
            }
            let id = pending.as_deref().ok_or(Error::InvalidResponse)?;
            response = self.poll(id, response, observer, run)?;
            if moderation(&response)
                || response["video"]["respect_moderation"] == false
                || response["response"]["generateVideoResponse"]["raiMediaFilteredCount"]
                    .as_u64()
                    .is_some_and(|count| count > 0)
            {
                return Err(Error::ContentPolicy.into());
            }
            let uri = self.download_uri(id, &response)?;
            observer.progress(Progress {
                fraction: 0.9,
                stage: Some(Stage::Downloading),
            })?;
            Ok(VideoOutput {
                metadata: json!({"adapter":self.provider.id(), "model":self.model,
                    "durationMs":duration_ms(start, self.http.wall_time()), "origin":self.http.origin()}),
                download: Download {
                    http: &self.http,
                    uri,
                    authenticated: matches!(self.provider, Provider::Google | Provider::OpenRouter),
                    deadline: run.deadline,
                },
            })
        })();
        if result
            .as_ref()
            .err()
            .is_some_and(|error: &crate::http::Failure| {
                matches!(error.code, Error::Cancelled | Error::Timeout)
            })
        {
            if let Some((method, route)) = pending
                .as_ref()
                .filter(|id| valid_id(self.provider, id))
                .and_then(|id| self.provider.cancel(self.queue_model(), id))
            {
                self.http
                    .close_remote(method, &route, Duration::from_secs(5));
            }
        }
        result
    }

    fn submission(
        &self,
        p: &Value,
        image: Option<Image>,
        video: Option<&SanitizedVideo>,
        run: Run<'_>,
    ) -> Call<(String, Object)> {
        let prompt = p["prompt"].as_str().ok_or(Error::UnsupportedParameter)?;
        let model = self.model.as_str();
        match self.provider {
            Provider::Google => {
                forbid(p, &["fps", "audio", "seed"])?;
                let mut instance = object([("prompt", prompt.into())]);
                if let Some(image) = image {
                    instance.put(
                        "image",
                        object([(
                            "inlineData",
                            inline_data(
                                &format!("image/{}", image.format.extension()),
                                &image.bytes,
                            )
                            .into(),
                        )]),
                    );
                }
                if let Some(video) = video {
                    instance.put(
                        "video",
                        object([("inlineData", inline_data(video.mime(), &video.bytes).into())]),
                    );
                }
                let mut options = object([("numberOfVideos", 1u32.into())]);
                for (key, field) in [
                    ("durationSeconds", "durationSeconds"),
                    ("resolution", "resolution"),
                    ("aspectRatio", "aspect"),
                    ("negativePrompt", "negativePrompt"),
                ] {
                    options.copy(key, p, field);
                }
                Ok((
                    format!("models/{}:predictLongRunning", uri_component(model)),
                    object([
                        ("instances", Field::List(vec![instance.into()])),
                        ("parameters", options.into()),
                    ]),
                ))
            }
            Provider::OpenRouter => {
                forbid(p, &["fps", "negativePrompt"])?;
                let catalog = self
                    .http
                    .json(Method::Get, "videos/models", None, run.deadline)?;
                let profile = catalog["data"]
                    .as_array()
                    .and_then(|rows| rows.iter().find(|row| row["id"] == model))
                    .ok_or(Error::UnsupportedParameter)?;
                for (key, value) in [
                    ("supported_durations", "durationSeconds"),
                    ("supported_resolutions", "resolution"),
                    ("supported_aspect_ratios", "aspect"),
                ] {
                    if p.get(value)
                        .zip(profile[key].as_array())
                        .is_some_and(|(wanted, options)| !options.contains(wanted))
                    {
                        return Err(Error::UnsupportedParameter.into());
                    }
                }
                let mut body = object([("model", model.into()), ("prompt", prompt.into())]);
                copy_video_options(&mut body, p);
                body.copy("generate_audio", p, "audio");
                body.copy("seed", p, "seed");
                if let Some(image) = image {
                    let frame = object([
                        ("type", "image_url".into()),
                        ("frame_type", "first_frame".into()),
                        (
                            "image_url",
                            object([("url", image.data_uri().into())]).into(),
                        ),
                    ]);
                    body.put("frame_images", Field::List(vec![frame.into()]));
                }
                Ok(("videos".into(), body))
            }
            Provider::Xai => {
                forbid(p, &["fps", "audio", "negativePrompt", "seed"])?;
                let mut body = object([("model", model.into()), ("prompt", prompt.into())]);
                if let Some(video) = video {
                    body.put("video", object([("url", video.uri().into())]));
                }
                if let Some(image) = image {
                    body.put("image", object([("url", image.data_uri().into())]));
                }
                copy_video_options(&mut body, p);
                Ok((
                    if video.is_some() {
                        "videos/edits"
                    } else {
                        "videos/generations"
                    }
                    .into(),
                    body,
                ))
            }
            Provider::Fal | Provider::Replicate => {
                self.queue_submission(p, prompt, image, video, run)
            }
            _ => Err(Error::UnsupportedParameter.into()),
        }
    }

    fn queue_submission(
        &self,
        p: &Value,
        prompt: &str,
        image: Option<Image>,
        video: Option<&SanitizedVideo>,
        run: Run<'_>,
    ) -> Call<(String, Object)> {
        let replicate = self.provider == Provider::Replicate;
        let model = if replicate {
            Some(Model::parse(&self.model).ok_or(Error::UnsupportedParameter)?)
        } else {
            None
        };
        let properties;
        let props = if let Some(model) = &model {
            let document = self
                .http
                .json(Method::Get, &model.schema_path(), None, run.deadline)?;
            properties = schema::from_document(&document);
            properties.as_ref()
        } else {
            self.profile.input_schema.as_ref()
        }
        .ok_or(Error::UnsupportedParameter)?;
        let edit = image.is_some();
        let mut input = schema::map_input(
            &Prepared {
                params: p,
                prompt,
                count: 1,
                refs: image.into_iter().collect(),
                mask: None,
            },
            props,
            edit,
        )?;
        for (key, fields) in [
            (
                "durationSeconds",
                &["duration", "duration_seconds", "seconds"][..],
            ),
            ("resolution", &["resolution"][..]),
            ("fps", &["fps", "frame_rate"][..]),
            ("audio", &["generate_audio", "audio"][..]),
        ] {
            if let Some(value) = p.get(key) {
                schema::set(&mut input, props, fields, value)?;
            }
        }
        if let Some(video) = video {
            schema::set(
                &mut input,
                props,
                &["video_url", "video", "input_video"],
                &Value::from(video.uri()),
            )?;
        }
        let Some(model) = model else {
            return Ok((self.model.clone(), input));
        };
        let mut body = object([("input", input.into())]);
        let path = if let Some(version) = model.version {
            body.put("version", version);
            "predictions".into()
        } else {
            format!("{}/predictions", model.path())
        };
        Ok((path, body))
    }

    fn queue_model(&self) -> &str {
        self.model
            .match_indices('/')
            .nth(1)
            .map_or(&self.model, |(index, _)| &self.model[..index])
    }

    fn poll(
        &self,
        id: &str,
        mut response: Value,
        observer: &mut dyn Observer,
        run: Run<'_>,
    ) -> Call<Value> {
        let endpoint = match self.provider {
            Provider::Google => id.to_owned(),
            Provider::Replicate => format!("predictions/{id}"),
            Provider::Fal => format!("{}/requests/{id}/status", self.queue_model()),
            _ => format!("videos/{id}"),
        };
        loop {
            let status = response["status"].as_str();
            if matches!(status, Some("canceled" | "cancelled" | "CANCELLED")) {
                return Err(Error::Cancelled.into());
            }
            if matches!(status, Some("failed" | "FAILED" | "expired"))
                || !response["error"].is_null()
            {
                return Err(crate::http::classify(500, &response["error"]));
            }
            if response["done"] == true
                || matches!(
                    status,
                    Some("succeeded" | "completed" | "done" | "COMPLETED")
                )
            {
                return if self.provider == Provider::Fal {
                    self.http.json(
                        Method::Get,
                        &format!("{}/requests/{id}", self.queue_model()),
                        None,
                        run.deadline,
                    )
                } else {
                    Ok(response)
                };
            }
            observer.progress(Progress {
                fraction: response["progress"]
                    .as_f64()
                    .map_or(0.2, |fraction| (fraction / 100.).clamp(0., 0.85)),
                stage: Some(if matches!(status, Some("queued" | "IN_QUEUE")) {
                    Stage::Queued
                } else {
                    Stage::Running
                }),
            })?;
            self.http.wait(self.poll, run.deadline)?;
            response = self.http.json(Method::Get, &endpoint, None, run.deadline)?;
        }
    }

    fn download_uri(&self, id: &str, response: &Value) -> Result<String> {
        if self.provider == Provider::OpenRouter {
            return Ok(self.http.endpoint(&format!("videos/{id}/content"))?.into());
        }
        let value = match self.provider {
            Provider::Google => {
                &response["response"]["generateVideoResponse"]["generatedSamples"][0]["video"]
                    ["uri"]
            }
            Provider::Replicate if response["output"].is_array() => &response["output"][0],
            Provider::Replicate => &response["output"],
            _ => &response["video"]["url"],
        };
        value
            .as_str()
            .map(str::to_owned)
            .ok_or(Error::InvalidResponse)
    }
}

fn valid_id(provider: Provider, id: &str) -> bool {
    if provider != Provider::Google {
        return safe_id(id);
    }
    let path = if let Some(rest) = id.strip_prefix("models/") {
        let Some((name, suffix)) = rest.split_once('/') else {
            return false;
        };
        if name.is_empty()
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        {
            return false;
        }
        suffix
    } else {
        id
    };
    path.strip_prefix("operations/").is_some_and(safe_id)
}

fn inline_data(mime: &str, bytes: &[u8]) -> Object {
    object([
        ("data", STANDARD.encode(bytes).into()),
        ("mimeType", mime.into()),
    ])
}

fn copy_video_options(body: &mut Object, p: &Value) {
    body.copy("duration", p, "durationSeconds");
    body.copy("resolution", p, "resolution");
    body.copy("aspect_ratio", p, "aspect");
}

fn forbid(params: &Value, fields: &[&str]) -> Result<()> {
    if fields.iter().any(|field| params.get(field).is_some()) {
        Err(Error::UnsupportedParameter)
    } else {
        Ok(())
    }
}
