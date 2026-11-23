//! Supervised Core ML image helper protocols over host-owned processes and storage.
use std::time::{Duration, Instant, SystemTime};

use serde_json::{json, Value};

use crate::{
    adapters::{ordered::Object, ImageOutput, ImageRequest, Observer},
    http::{Failure, Image, Reason},
    images::{self, Format},
    jobs::{Checkpoint, Error, Progress, Result},
    units::{self, Units},
};

mod protocol;

const OUTPUT_BYTES: usize = 64 * 1024 * 1024;
const REFERENCE_BYTES: usize = 50 * 1024 * 1024;
const CAPABILITIES_BYTES: usize = 64 * 1024;
const CAPABILITIES_TIME: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Eq, PartialEq)]
pub enum Protocol {
    Auto,
    JsonLines,
    OneShot,
}

#[derive(Clone, Copy)]
pub enum Launch {
    JsonLines,
    OneShot,
}

pub struct Config<'a> {
    pub model: &'a str,
    pub models_dir: &'a str,
    pub protocol: Protocol,
    pub compute_units: Option<&'a str>,
    pub scheduler: Option<&'a str>,
    pub strength: f64,
    pub cancel_grace: Duration,
}

pub trait Workspace {
    /// Trusted absolute path of a private workspace which is removed on drop.
    fn path(&self) -> &str;
    fn write_private(&mut self, name: &str, bytes: &[u8], deadline: Instant) -> Result<String>;
    /// Open a confined regular file and bound bytes at the same file handle.
    fn read_regular(&self, name: &str, limit: usize, deadline: Instant) -> Result<Vec<u8>>;
}

pub trait Session {
    fn send(&mut self, line: &[u8], deadline: Instant) -> Result<()>;
    /// Deliver one complete line, bounded while reading, or EOF.
    fn receive(&mut self, limit: usize, deadline: Instant) -> Result<Option<Vec<u8>>>;
    fn close_input(&mut self, deadline: Instant) -> Result<()>;
    fn finish(self, deadline: Instant) -> Result<bool>;
    /// Terminate and reap. A host must also clean an unfinished child on drop.
    fn stop(self, deadline: Instant);
}

pub trait Environment {
    type Session: Session;
    type Workspace: Workspace;

    fn apple_silicon(&self) -> bool;
    /// Test the configured executable with --capabilities and an empty environment.
    fn probe(&self, limit: usize, deadline: Instant) -> Result<Option<Vec<u8>>>;
    /// Start the configured executable directly with an empty environment and
    /// ignored stderr. The port owns subprocess handles and all I/O deadlines.
    fn launch(&self, launch: Launch, deadline: Instant) -> Result<Self::Session>;
    fn workspace(&self, deadline: Instant) -> Result<Self::Workspace>;
    fn cancelled(&self) -> bool {
        false
    }
    fn wall_time(&self) -> SystemTime {
        SystemTime::now()
    }
}

pub struct CoreMl<'a, E: Environment> {
    host: &'a E,
    config: Config<'a>,
    jsonl: Option<bool>,
    child: Option<E::Session>,
    sequence: u64,
}

impl<'a, E: Environment> CoreMl<'a, E> {
    pub fn new(host: &'a E, config: Config<'a>) -> Result<Self> {
        if matches!(config.model, "" | "." | "..")
            || config.model.contains(['/', '\\', '\0'])
            || config.models_dir.is_empty()
            || config.models_dir.contains('\0')
            || config
                .compute_units
                .is_some_and(|units| !matches!(units, "cpuAndNeuralEngine" | "all" | "cpuAndGPU"))
            || config.scheduler.is_some_and(|scheduler| {
                !(1..=64).contains(&scheduler.len())
                    || !scheduler.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-')
                    })
            })
            || !(0.0 < config.strength && config.strength <= 1.0)
            || config.cancel_grace > Duration::from_secs(60)
        {
            return Err(Error::UnsupportedParameter);
        }
        Ok(Self {
            host,
            config,
            jsonl: None,
            child: None,
            sequence: 0,
        })
    }

    pub fn supports_edit(&self) -> bool {
        self.config.protocol != Protocol::OneShot
    }

    fn require_platform(&self) -> std::result::Result<(), Failure> {
        self.host.apple_silicon().then_some(()).ok_or(Failure {
            code: Error::BackendUnavailable,
            reason: Some(Reason::CoreMlUnavailablePlatform),
        })
    }

    fn mode(&mut self, deadline: Instant) -> Result<bool> {
        if let Some(jsonl) = self.jsonl {
            return Ok(jsonl);
        }
        let jsonl = match self.config.protocol {
            Protocol::JsonLines => true,
            Protocol::OneShot => false,
            Protocol::Auto => {
                let end = deadline.min(Instant::now() + CAPABILITIES_TIME);
                let response = self.host.probe(CAPABILITIES_BYTES, end).ok().flatten();
                protocol::check(self.host, deadline)?;
                response.is_some_and(|response| advertises_jsonl(&response))
            }
        };
        self.jsonl = Some(jsonl);
        Ok(jsonl)
    }

    pub fn close(&mut self, deadline: Instant) {
        if let Some(child) = self.child.take() {
            child.stop(deadline);
        }
    }

    pub fn generate(
        &mut self,
        request: &ImageRequest<'_>,
        observer: &mut dyn Observer,
        deadline: Instant,
    ) -> std::result::Result<ImageOutput, Failure> {
        self.image(request, observer, deadline, false)
    }

    pub fn edit(
        &mut self,
        request: &ImageRequest<'_>,
        observer: &mut dyn Observer,
        deadline: Instant,
    ) -> std::result::Result<ImageOutput, Failure> {
        self.image(request, observer, deadline, true)
    }

    fn image(
        &mut self,
        request: &ImageRequest<'_>,
        observer: &mut dyn Observer,
        deadline: Instant,
        edit: bool,
    ) -> std::result::Result<ImageOutput, Failure> {
        let params = request.parameters;
        let Units::Images(requested) = units::requested(params).map_err(Error::from)? else {
            return Err(Error::UnsupportedParameter.into());
        };
        if params.get("size").is_some()
            || params.get("aspect").is_some()
            || params.get("format").is_some_and(|format| format != "png")
            || params.get("seed").is_some_and(|seed| {
                seed.as_f64().is_none_or(|seed| {
                    seed.fract() != 0.0 || !(0.0..=f64::from(u32::MAX)).contains(&seed)
                })
            })
        {
            return Err(Error::UnsupportedParameter.into());
        }
        self.require_platform()?;
        protocol::check(self.host, deadline)?;
        if request.mask.is_some() || request.references.len() != usize::from(edit) {
            return Err(Error::UnsupportedParameter.into());
        }
        let reference = request
            .references
            .first()
            .map(|bytes| {
                if bytes.len() > REFERENCE_BYTES {
                    return Err(Error::TooLarge);
                }
                images::sanitize(bytes)
            })
            .transpose()?;
        let jsonl = self.mode(deadline)?;
        if edit && !jsonl {
            return Err(Error::UnsupportedParameter.into());
        }
        let started = self.host.wall_time();
        let mut space = self.host.workspace(deadline)?;
        let source = reference
            .map(|(format, bytes)| {
                space.write_private(&format!("input.{}", format.extension()), &bytes, deadline)
            })
            .transpose()?;
        let mut command = if jsonl {
            self.jsonl_command(if edit { "img2img" } else { "generate" })?
        } else {
            self.oneshot_command("generate", space.path())
        };
        let mut fields = Object::default();
        for field in ["prompt", "negativePrompt", "n", "seed", "steps", "guidance"] {
            fields.copy(field, params, field);
        }
        if jsonl {
            command.put("model", self.config.model);
            command.put("modelsDir", self.config.models_dir);
            command.put("outputDir", space.path());
            if let Some(units) = self.config.compute_units {
                command.put("computeUnits", units);
            }
            if let Some(source) = source {
                command.put("inputPath", source);
            }
            if let Some(scheduler) = self.config.scheduler {
                fields.put("scheduler", scheduler);
            }
            if edit {
                fields.put("strength", json!(self.config.strength));
            }
        } else if let Some(params) = params.as_object() {
            for (key, value) in params {
                if !matches!(
                    key.as_str(),
                    "prompt" | "negativePrompt" | "n" | "seed" | "steps" | "guidance"
                ) {
                    fields.put(key.clone(), value.clone());
                }
            }
        }
        command.put("request", fields);
        let result = self.request(&command, observer, deadline, jsonl)?;
        let files = collect(&space, &result, self.host, deadline)?;
        let duration = self
            .host
            .wall_time()
            .duration_since(started)
            .unwrap_or(Duration::ZERO);
        let mut metadata = json!({"adapter":"coreml-local", "model":self.config.model,
            "durationMs":u64::try_from(duration.as_millis()).unwrap_or(u64::MAX), "origin":"local"});
        if result["seed"].is_number() {
            metadata["seed"] = result["seed"].clone();
        }
        Ok(ImageOutput {
            partial: files.len() < requested as usize,
            metadata,
            files,
        })
    }

    pub fn models(&mut self, deadline: Instant) -> std::result::Result<Vec<String>, Failure> {
        self.require_platform()?;
        protocol::check(self.host, deadline)?;
        let jsonl = self.mode(deadline)?;
        let mut command = if jsonl {
            self.jsonl_command("list-models")?
        } else {
            self.oneshot_command("list", "")
        };
        if jsonl {
            command.put("modelsDir", self.config.models_dir);
        }
        let result = self.request(&command, &mut IgnoreProgress, deadline, jsonl)?;
        result["models"]
            .as_array()
            .ok_or(Error::InvalidResponse)?
            .iter()
            .map(|name| {
                name.as_str()
                    .map(str::to_owned)
                    .ok_or(Error::InvalidResponse.into())
            })
            .collect()
    }

    fn jsonl_command(&mut self, operation: &str) -> Result<Object> {
        self.sequence = self
            .sequence
            .checked_add(1)
            .ok_or(Error::BackendUnavailable)?;
        let mut command = Object::default();
        command.put("id", self.sequence.to_string());
        command.put("op", operation);
        Ok(command)
    }

    fn oneshot_command(&self, operation: &str, output: &str) -> Object {
        let mut command = Object::default();
        command.put("operation", operation);
        command.put("model", self.config.model);
        command.put("modelDir", self.config.models_dir);
        command.put("outputDir", output);
        command
    }

    fn request(
        &mut self,
        command: &Object,
        observer: &mut dyn Observer,
        deadline: Instant,
        jsonl: bool,
    ) -> Result<Value> {
        let line = protocol::encode(command)?;
        if !jsonl {
            return protocol::oneshot(self.host, line.as_slice(), observer, deadline);
        }
        let mut child = match self.child.take() {
            Some(child) => child,
            None => self.host.launch(Launch::JsonLines, deadline)?,
        };
        let result = protocol::jsonl(
            self.host,
            &mut child,
            &self.sequence.to_string(),
            &line,
            observer,
            deadline,
            self.config.cancel_grace,
        );
        if result.reusable {
            self.child = Some(child);
        } else {
            child.stop(Instant::now() + Duration::from_secs(1));
        }
        result.outcome
    }
}

fn advertises_jsonl(response: &[u8]) -> bool {
    if response.len() > CAPABILITIES_BYTES {
        return false;
    }
    let Ok(value) = serde_json::from_slice::<Value>(response) else {
        return false;
    };
    value["protocol"] == "jsonl/1"
        && value["ops"].as_array().is_some_and(|ops| {
            ["generate", "img2img", "list-models", "cancel"]
                .iter()
                .all(|required| ops.iter().any(|operation| operation == *required))
        })
}

fn collect(
    space: &impl Workspace,
    result: &Value,
    env: &impl Environment,
    deadline: Instant,
) -> Result<Vec<Image>> {
    let names = result["files"]
        .as_array()
        .filter(|files| (1..=10).contains(&files.len()))
        .ok_or(Error::InvalidResponse)?;
    names
        .iter()
        .map(|value| {
            protocol::check(env, deadline)?;
            let name = value.as_str().ok_or(Error::InvalidResponse)?;
            let digits = name
                .strip_suffix(".png")
                .filter(|digits| {
                    !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
                })
                .ok_or(Error::InvalidResponse)?;
            // A restricted leaf name is all the workspace ever receives from the helper.
            if digits.len() > 64 {
                return Err(Error::InvalidResponse);
            }
            let bytes = space.read_regular(name, OUTPUT_BYTES, deadline)?;
            if bytes.len() > OUTPUT_BYTES {
                return Err(Error::TooLarge);
            }
            let format = images::verify(&bytes)?;
            if format != Format::Png {
                return Err(Error::InvalidResponse);
            }
            Ok(Image { format, bytes })
        })
        .collect()
}

struct IgnoreProgress;

impl Observer for IgnoreProgress {
    fn progress(&mut self, _: Progress) -> Result<()> {
        Ok(())
    }
    fn checkpoint(&mut self, _: Checkpoint) -> Result<()> {
        Ok(())
    }
}
