use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

use serde_json::{json, Map, Value};

use crate::{
    http::{Client, Image, Method},
    images,
    jobs::{Checkpoint, Error, Progress, Result, Stage},
    units::{self, Units},
};

use super::{
    duration_ms, moderation,
    payload::{self, Prepared},
    probe_draw_things, safe_id,
    schema::{self, Model},
    valid_model, Call, DrawThingsState, ImageCatalog, ImageModel, Observer, Provider, Run,
};

const MAX_REFERENCE_BYTES: usize = 50 * 1024 * 1024;
const MAX_FILES: usize = 10;

pub struct ImageRequest<'a> {
    pub parameters: &'a Value,
    pub references: &'a [&'a [u8]],
    pub mask: Option<&'a [u8]>,
}

pub struct ImageOutput {
    pub files: Vec<Image>,
    pub metadata: Value,
    pub partial: bool,
}

pub struct ImageAdapter<'a> {
    provider: Provider,
    model: &'a str,
    http: Client<'a>,
    poll: Duration,
    schema: Mutex<Option<Option<Map<String, Value>>>>,
    catalog: ImageCatalog,
}

impl<'a> ImageAdapter<'a> {
    pub fn new(
        provider: Provider,
        model: &'a str,
        http: Client<'a>,
        poll: Duration,
    ) -> Result<Self> {
        if !valid_model(model) || poll.as_millis() == 0 {
            return Err(Error::UnsupportedParameter);
        }
        Ok(Self {
            provider,
            model,
            http,
            poll,
            schema: Mutex::new(None),
            catalog: ImageCatalog::default(),
        })
    }

    pub fn with_catalog_ttl(mut self, ttl: Duration) -> Result<Self> {
        self.catalog = ImageCatalog::new(ttl, Duration::from_secs(30))?;
        Ok(self)
    }

    pub fn list_models(&self, deadline: Instant) -> Call<Vec<ImageModel>> {
        if self.provider != Provider::OpenRouter {
            return Err(Error::UnsupportedParameter.into());
        }
        self.catalog.update(
            || self.http.wall_time(),
            || self.http.check(deadline).is_ok(),
            || {
                self.http.json(
                    Method::Get,
                    "models?output_modalities=image",
                    None,
                    deadline,
                )
            },
        )
    }

    pub fn generate(
        &self,
        request: &ImageRequest<'_>,
        observer: &mut dyn Observer,
        run: Run<'_>,
    ) -> Call<ImageOutput> {
        self.batch(request, observer, run, false)
    }

    pub fn edit(
        &self,
        request: &ImageRequest<'_>,
        observer: &mut dyn Observer,
        run: Run<'_>,
    ) -> Call<ImageOutput> {
        if !self.provider.can_edit() || request.references.is_empty() {
            return Err(Error::UnsupportedParameter.into());
        }
        self.batch(request, observer, run, true)
    }

    fn batch(
        &self,
        request: &ImageRequest<'_>,
        observer: &mut dyn Observer,
        run: Run<'_>,
        edit: bool,
    ) -> Call<ImageOutput> {
        self.http.check(run.deadline)?;
        let Units::Images(count) = units::requested(request.parameters).map_err(Error::from)?
        else {
            return Err(Error::UnsupportedParameter.into());
        };
        validate_resume(self.provider, self.model, run)?;
        let mut prepared = prepare(request, count)?;
        if !matches!(self.provider, Provider::OpenRouter | Provider::Google) || count == 1 {
            return self.perform(&prepared, observer, run, edit);
        }
        let start = self.http.wall_time();
        let mut params = request.parameters.clone();
        params["n"] = json!(1);
        prepared.params = &params;
        prepared.count = 1;
        let mut files = Vec::new();
        let mut metadata = Value::Null;
        for index in 0..count {
            let mut progress = BatchProgress {
                inner: observer,
                index,
                count,
            };
            match self.perform(&prepared, &mut progress, run, edit) {
                Ok(output) => {
                    metadata = output.metadata;
                    files.extend(output.files);
                }
                Err(error)
                    if !files.is_empty()
                        && matches!(error.code, Error::BackendUnavailable | Error::Timeout) =>
                {
                    if self.http.check(run.deadline) == Err(Error::Cancelled) {
                        return Err(Error::Cancelled.into());
                    }
                    break;
                }
                Err(error) => return Err(error),
            }
        }
        metadata["durationMs"] = json!(duration_ms(start, self.http.wall_time()));
        Ok(ImageOutput {
            partial: files.len() < count as usize,
            metadata,
            files,
        })
    }

    fn perform(
        &self,
        request: &Prepared<'_>,
        observer: &mut dyn Observer,
        run: Run<'_>,
        edit: bool,
    ) -> Call<ImageOutput> {
        let started = self.http.wall_time();
        let mut pending = run.resume.map(|checkpoint| checkpoint.id.clone());
        let result = (|| {
            self.http.check(run.deadline)?;
            observer.progress(Progress {
                fraction: 0.0,
                stage: Some(Stage::Running),
            })?;
            let output = if let Some(id) = &pending {
                self.poll(id, observer, run)?
            } else {
                let schema = self.replicate_schema(run)?;
                let submission = payload::build(
                    self.provider,
                    self.model,
                    request,
                    edit,
                    schema.as_ref(),
                    observer,
                )?;
                let mut output = self.http.json(
                    Method::Post,
                    &submission.path,
                    Some(submission.body()),
                    run.deadline,
                )?;
                if self.provider.queued() {
                    let field = if self.provider == Provider::Fal {
                        "request_id"
                    } else {
                        "id"
                    };
                    let id = output[field]
                        .as_str()
                        .filter(|id| safe_id(id))
                        .ok_or(Error::InvalidResponse)?
                        .to_owned();
                    pending = Some(id.clone());
                    observer.checkpoint(Checkpoint {
                        id: id.clone(),
                        model: self.model.into(),
                    })?;
                    if self.provider != Provider::Replicate || output["status"] != "succeeded" {
                        output = self.poll(&id, observer, run)?;
                    }
                }
                output
            };
            if moderation(&output) {
                return Err(Error::ContentPolicy.into());
            }
            let values = file_references(self.provider, &output);
            if values.is_empty() || values.len() > MAX_FILES {
                return Err(Error::InvalidResponse.into());
            }
            observer.progress(Progress {
                fraction: 0.9,
                stage: Some(Stage::Downloading),
            })?;
            let files = values
                .iter()
                .map(|value| self.http.image(value, run.deadline))
                .collect::<Result<Vec<_>>>()?;
            let mut metadata = json!({ "adapter":self.provider.id(), "model":self.model,
                "durationMs":duration_ms(started, self.http.wall_time()), "origin":self.http.origin() });
            if let Some(seed) = output
                .get("seed")
                .filter(|value| value.is_number())
                .or_else(|| request.params.get("seed"))
            {
                metadata["seed"] = seed.clone();
            }
            Ok(ImageOutput {
                partial: files.len() < request.count as usize,
                metadata,
                files,
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
                .and_then(|id| self.provider.cancel(self.model, id))
            {
                self.http
                    .close_remote(method, &route, Duration::from_secs(2));
            }
        }
        result.map_err(|mut error| {
            if self.provider == Provider::DrawThings
                && error.code == Error::BackendUnavailable
                && error.reason.is_none()
            {
                error.reason = match probe_draw_things(&self.http, run.deadline) {
                    DrawThingsState::Running => None,
                    DrawThingsState::ApiOff { reason }
                    | DrawThingsState::NotInstalled { reason } => Some(reason),
                };
            }
            error
        })
    }

    fn replicate_schema(&self, run: Run<'_>) -> Call<Option<Map<String, Value>>> {
        if self.provider != Provider::Replicate {
            return Ok(None);
        }
        let Some(model) = Model::parse(self.model) else {
            return Ok(None);
        };
        let mut cache = self.schema.lock().map_err(|_| Error::BackendUnavailable)?;
        if let Some(schema) = &*cache {
            return Ok(schema.clone());
        }
        let document = self
            .http
            .json(Method::Get, &model.schema_path(), None, run.deadline)?;
        let schema = schema::from_document(&document);
        *cache = Some(schema.clone());
        Ok(schema)
    }

    fn poll(&self, id: &str, observer: &mut dyn Observer, run: Run<'_>) -> Call<Value> {
        let fal = self.provider == Provider::Fal;
        let endpoint = if fal {
            format!("{}/requests/{id}", self.model)
        } else {
            format!("predictions/{id}")
        };
        let status_path = if fal {
            format!("{endpoint}/status")
        } else {
            endpoint.clone()
        };
        loop {
            let value = self
                .http
                .json(Method::Get, &status_path, None, run.deadline)?;
            match value["status"].as_str() {
                Some("canceled") => return Err(Error::Cancelled.into()),
                Some("failed") => return Err(crate::http::classify(500, &value)),
                Some("succeeded") => return Ok(value),
                Some("COMPLETED") if fal => {
                    return self.http.json(Method::Get, &endpoint, None, run.deadline)
                }
                status => {
                    let queued = matches!(status, Some("IN_QUEUE" | "starting"));
                    observer.progress(Progress {
                        fraction: if queued { 0.1 } else { 0.5 },
                        stage: Some(if queued {
                            Stage::Queued
                        } else {
                            Stage::Running
                        }),
                    })?;
                    self.http.wait(self.poll, run.deadline)?;
                }
            }
        }
    }
}

fn prepare<'a>(request: &'a ImageRequest<'a>, count: u32) -> Result<Prepared<'a>> {
    fn clean(bytes: &[u8]) -> Result<Image> {
        if bytes.len() > MAX_REFERENCE_BYTES {
            return Err(Error::TooLarge);
        }
        let (format, bytes) = images::sanitize(bytes)?;
        Ok(Image { format, bytes })
    }
    Ok(Prepared {
        params: request.parameters,
        count,
        prompt: request.parameters["prompt"]
            .as_str()
            .ok_or(Error::UnsupportedParameter)?,
        refs: request
            .references
            .iter()
            .map(|bytes| clean(bytes))
            .collect::<Result<_>>()?,
        mask: request.mask.map(clean).transpose()?,
    })
}

fn validate_resume(provider: Provider, model: &str, run: Run<'_>) -> Result<()> {
    if run
        .resume
        .is_some_and(|resume| !provider.queued() || resume.model != model || !safe_id(&resume.id))
    {
        return Err(Error::UnsupportedParameter);
    }
    Ok(())
}

struct BatchProgress<'a> {
    inner: &'a mut dyn Observer,
    index: u32,
    count: u32,
}

impl Observer for BatchProgress<'_> {
    fn progress(&mut self, event: Progress) -> Result<()> {
        self.inner.progress(Progress {
            fraction: (f64::from(self.index) + event.fraction) / f64::from(self.count),
            ..event
        })
    }
    fn checkpoint(&mut self, event: Checkpoint) -> Result<()> {
        self.inner.checkpoint(event)
    }
    fn multipart_boundary(&mut self) -> Result<String> {
        self.inner.multipart_boundary()
    }
}

fn items(value: &Value) -> impl Iterator<Item = &Value> {
    value.as_array().into_iter().flatten()
}

fn file_references(provider: Provider, document: &Value) -> Vec<String> {
    let text = |value: &Value| {
        value
            .as_str()
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    match provider {
        Provider::OpenRouter => items(&document["choices"])
            .flat_map(|row| items(&row["message"]["images"]))
            .filter_map(|item| text(&item["image_url"]["url"]))
            .collect(),
        Provider::Google => items(&document["candidates"])
            .flat_map(|row| items(&row["content"]["parts"]))
            .filter_map(|part| {
                let item = &part["inlineData"];
                Some(format!(
                    "data:{};base64,{}",
                    item["mimeType"].as_str()?,
                    item["data"].as_str()?
                ))
            })
            .collect(),
        Provider::Replicate => text(&document["output"]).map_or_else(
            || items(&document["output"]).filter_map(text).collect(),
            |value| vec![value],
        ),
        Provider::Fal => items(&document["images"])
            .filter_map(|item| text(&item["url"]))
            .collect(),
        Provider::DrawThings => items(&document["images"]).filter_map(text).collect(),
        _ => items(&document["data"])
            .filter_map(|item| text(&item["b64_json"]).or_else(|| text(&item["url"])))
            .collect(),
    }
}
