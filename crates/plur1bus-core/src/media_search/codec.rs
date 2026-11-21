//! Bounded FFmpeg planning with a confined input lease and a process port.

use super::{
    caption::{Frame, Source, MAX_FRAME_BYTES, MAX_SOURCE_BYTES},
    Caller, Error, Scope,
};
use serde::Serialize;

/// Fixed placeholder resolved to the already opened input by the process port.
pub const INPUT_SLOT: &str = "file:<input>";

/// Encoder command with no caller-controlled executable or argument.
#[derive(Clone, Copy, Debug)]
pub enum Command {
    /// Quick duration probe.
    Probe,
    /// Timed video frames.
    Video {
        /// Scene detection or evenly spaced extraction.
        filter: VideoFilter,
        /// Maximum frame count.
        frames: usize,
    },
    /// Bounded mono PCM.
    Audio {
        /// PCM rate.
        rate: u32,
        /// Stop after this duration.
        seconds: u32,
    },
}

/// Video selection rule.
#[derive(Clone, Copy, Debug)]
pub enum VideoFilter {
    /// Detect transitions and preserve the initial keyframe.
    Scene,
    /// Uniform interval in seconds.
    Interval(f64),
}

/// A validated command and bounds for the process adapter to enforce.
pub struct Plan {
    /// Fixed command.
    pub command: Command,
    /// Wall-time deadline relative to launch.
    pub timeout_ms: u64,
    /// Enforced stdout maximum.
    pub max_bytes: usize,
    /// Enforced stderr maximum.
    pub max_stderr: usize,
}

impl Plan {
    /// Fixed argv template with exactly one prebound input slot.
    pub fn arguments(&self) -> Vec<String> {
        if matches!(self.command, Command::Probe) {
            let mut args = vec!["-v".into(), "error".into()];
            options(&mut args, &PORT_ARGS);
            options(
                &mut args,
                &[
                    "-show_entries",
                    "format=duration",
                    "-of",
                    "default=noprint_wrappers=1:nokey=1",
                    "-i",
                    INPUT_SLOT,
                ],
            );
            return args;
        }
        let mut args = argument_prefix();
        match self.command {
            Command::Probe => {}
            Command::Video { filter, frames } => {
                let filter = match filter {
                    VideoFilter::Scene => "select='eq(n,0)+gt(scene,0.3)'".into(),
                    VideoFilter::Interval(n) => format!("fps=1/{n}"),
                };
                options(
                    &mut args,
                    &[
                        "-loglevel",
                        "info",
                        "-nostats",
                        "-i",
                        INPUT_SLOT,
                        "-an",
                        "-sn",
                        "-vf",
                        &format!("{filter},showinfo"),
                        "-fps_mode",
                        "vfr",
                        "-frames:v",
                        &frames.to_string(),
                        "-c:v",
                        "png",
                        "-f",
                        "image2pipe",
                        "pipe:1",
                    ],
                );
            }
            Command::Audio { rate, seconds } => options(
                &mut args,
                &[
                    "-loglevel",
                    "error",
                    "-t",
                    &seconds.to_string(),
                    "-i",
                    INPUT_SLOT,
                    "-vn",
                    "-sn",
                    "-ac",
                    "1",
                    "-ar",
                    &rate.to_string(),
                    "-f",
                    "f32le",
                    "-acodec",
                    "pcm_f32le",
                    "pipe:1",
                ],
            ),
        }
        args
    }
}

/// Input rooted in a configured media store or privately staged bytes.
pub trait Lease {
    /// Recheck the regular-file handle, confinement, length and same live scope.
    fn live(&self, scope: &Scope) -> bool;
    /// Initial bytes from this precise file handle.
    fn head(&self) -> &[u8];
    /// Length of the leased file.
    fn bytes(&self) -> usize;
}

/// Trusted input resolver with lease-owned cleanup.
pub trait Sources {
    /// Open once and validate the source under the given scope.
    fn lease(
        &self,
        scope: &Scope,
        source: Source<'_>,
        max_bytes: usize,
    ) -> Result<Box<dyn Lease + '_>, Error>;
}

/// Captured process output, still treated as untrusted data.
pub struct Output {
    /// Complete bounded stdout.
    pub stdout: Vec<u8>,
    /// Bounded stderr.
    pub stderr: Vec<u8>,
}

/// No production process is launched by this library.
pub trait Process {
    /// Whether the verified ffprobe executable is available.
    fn has_probe(&self) -> bool;
    /// Execute the typed command without a shell, against only this input handle, with I/O and time limits.
    fn execute(&self, lease: &dyn Lease, plan: &Plan) -> Result<Output, Error>;
}

/// Sample decoder output.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pcm {
    /// Offset of the first sample.
    pub start_ms: u64,
    /// Mono normalized samples.
    pub samples: Vec<f32>,
}

/// Video options with an explicit maximum.
pub struct Video {
    /// Minimum sampling interval in seconds.
    pub interval: f64,
    /// Try scene detection before the uniform fallback.
    pub scene_detect: bool,
    /// Maximum number of returned images.
    pub max_frames: usize,
}

/// Audio options with an explicit duration limit.
pub struct Audio {
    /// Output sample rate in Hz.
    pub rate: u32,
    /// Maximum output duration.
    pub max_seconds: u32,
    /// Number of samples per chunk.
    pub samples_per_chunk: usize,
}

const DEMUXERS: &str =
    "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,wav,aiff,ogg,flac,mp3,aac,flv,mpeg";
const PORT_ARGS: [&str; 5] = [
    "-nostdin",
    "-protocol_whitelist",
    "file,pipe",
    "-format_whitelist",
    DEMUXERS,
];
const TIMEOUT_MS: u64 = 120_000;
const STDERR_MAX: usize = 256 * 1024;
const PROBE_MAX: usize = 64 * 1024;
const PNG: &[u8] = b"\x89PNG\r\n\x1a\n";
const MAX_FRAMES: usize = 256;
const MAX_VIDEO_INTERVAL: f64 = 86_400.0;
const MAX_AUDIO_SECONDS: u32 = 900;
const ACTION: &str = "media.write";

/// Media container preflight.
pub fn allowed_container(head: &[u8]) -> bool {
    [b"ftyp", b"moov", b"mdat", b"free", b"wide"]
        .iter()
        .any(|sig| head.get(4..8) == Some(sig.as_slice()))
        || [
            b"\x1a\x45\xdf\xa3".as_slice(),
            b"RIFF",
            b"FORM",
            b"OggS",
            b"fLaC",
            b"ID3",
            b"FLV",
            b"\0\0\x01\xba",
        ]
        .iter()
        .any(|sig| head.starts_with(sig))
        || matches!(head,[0xff,b,..] if b & 0xe0 == 0xe0)
}

/// Canonical platform executable extensions.
pub fn binary_extensions(windows: bool) -> &'static [&'static str] {
    if windows {
        &[".exe", ".com"]
    } else {
        &[""]
    }
}
/// Whether the name is an allowed native executable on the selected platform.
pub fn spawnable_name(name: &str, windows: bool) -> bool {
    if !windows {
        return true;
    }
    let ext = name
        .rsplit(['\\', '/'])
        .next()
        .and_then(|base| base.rsplit_once('.'))
        .map(|(_, ext)| ext);
    ext.is_some_and(|ext| ["exe", "com"].iter().any(|ok| ext.eq_ignore_ascii_case(ok)))
}

impl Plan {
    fn new(command: Command, max_bytes: usize) -> Self {
        let timeout_ms = if matches!(command, Command::Probe) {
            30_000
        } else {
            TIMEOUT_MS
        };
        Self {
            command,
            timeout_ms,
            max_bytes,
            max_stderr: STDERR_MAX,
        }
    }
}

fn argument_prefix() -> Vec<String> {
    let mut args = PORT_ARGS.iter().map(|s| (*s).into()).collect::<Vec<_>>();
    args.insert(1, "-hide_banner".into());
    args
}

fn options(args: &mut Vec<String>, pairs: &[&str]) {
    args.extend(pairs.iter().map(|s| (*s).into()));
}

struct ScopedProcess<'a> {
    caller: &'a Caller<'a>,
    lease: Box<dyn Lease + 'a>,
    process: &'a dyn Process,
}
impl<'a> ScopedProcess<'a> {
    fn new(
        caller: &'a Caller<'a>,
        source: Source<'_>,
        sources: &'a dyn Sources,
        process: &'a dyn Process,
    ) -> Result<Self, Error> {
        caller.authorize(ACTION)?;
        if matches!(source,Source::Bytes(bytes) if bytes.len()>MAX_SOURCE_BYTES) {
            return Err(unsupported("codec-input-size"));
        }
        let lease = sources.lease(caller.scope, source, MAX_SOURCE_BYTES)?;
        let session = Self {
            caller,
            lease,
            process,
        };
        session.live()?;
        let head = session.lease.head();
        if head.len() > session.lease.bytes() || !allowed_container(&head[..head.len().min(16)]) {
            return Err(unsupported("container-not-allowed"));
        }
        Ok(session)
    }
    fn live(&self) -> Result<(), Error> {
        self.caller.authorize(ACTION)?;
        if !self.lease.live(self.caller.scope) {
            return Err(unsupported("codec-input-changed"));
        }
        if self.lease.bytes() == 0 || self.lease.bytes() > MAX_SOURCE_BYTES {
            return Err(unsupported("codec-input-size"));
        }
        Ok(())
    }
    fn run(&self, plan: &Plan) -> Result<Output, Error> {
        self.live()?;
        let output = self.process.execute(self.lease.as_ref(), plan);
        self.live()?;
        let output = output?;
        if output.stdout.len() > plan.max_bytes || output.stderr.len() > plan.max_stderr {
            return Err(unsupported("codec-output-limit"));
        }
        Ok(output)
    }
    fn duration(&self) -> Result<Option<f64>, Error> {
        if !self.process.has_probe() {
            return Ok(None);
        }
        let reply = self.run(&Plan::new(Command::Probe, PROBE_MAX));
        self.live()?;
        Ok(reply.ok().and_then(|out| {
            std::str::from_utf8(&out.stdout)
                .ok()?
                .trim()
                .parse::<f64>()
                .ok()
                .filter(|n| n.is_finite() && *n > 0.0 && *n <= MAX_VIDEO_INTERVAL)
        }))
    }
    fn video(&self, filter: VideoFilter, maximum: usize) -> Result<Output, Error> {
        self.run(&Plan::new(
            Command::Video {
                filter,
                frames: maximum,
            },
            MAX_SOURCE_BYTES,
        ))
    }
}

/// Read bounded PNG frames through the process port.
pub fn frames(
    caller: &Caller<'_>,
    source: Source<'_>,
    options: &Video,
    sources: &dyn Sources,
    process: &dyn Process,
) -> Result<Vec<Frame>, Error> {
    if !(1..=MAX_FRAMES).contains(&options.max_frames)
        || !options.interval.is_finite()
        || !(0.0..=MAX_VIDEO_INTERVAL).contains(&options.interval)
    {
        return Err(unsupported("codec-frame-options"));
    }
    let input = ScopedProcess::new(caller, source, sources, process)?;
    let duration = input.duration()?.unwrap_or_default();
    let interval = options
        .interval
        .max(duration / options.max_frames as f64)
        .max(0.001);
    if options.scene_detect {
        let output = input.video(VideoFilter::Scene, options.max_frames)?;
        let frames = png_frames(&output, options.max_frames, interval)?;
        if !frames.is_empty() {
            return Ok(frames);
        }
    }
    let output = input.video(VideoFilter::Interval(interval), options.max_frames)?;
    png_frames(&output, options.max_frames, interval)
}

fn png_frames(result: &Output, maximum: usize, interval: f64) -> Result<Vec<Frame>, Error> {
    let mut input = result.stdout.as_slice();
    let times = String::from_utf8_lossy(&result.stderr);
    let mut times = times.lines().filter_map(|line| {
        let (_, value) = line.split_once("showinfo")?.1.split_once("pts_time:")?;
        Some(
            value
                .split_ascii_whitespace()
                .next()
                .and_then(|s| s.parse::<f64>().ok())
                .filter(|t| t.is_finite() && (0.0..=MAX_VIDEO_INTERVAL).contains(t)),
        )
    });
    let mut frames = Vec::new();
    while !input.is_empty() {
        let len = png_size(input)?;
        if frames.len() < maximum {
            let ts = times
                .next()
                .flatten()
                .unwrap_or(frames.len() as f64 * interval);
            frames.push(Frame {
                ts_ms: (ts * 1000.0).round() as u64,
                bytes: input[..len].to_vec(),
                mime: "image/png".into(),
            });
        }
        input = &input[len..];
    }
    Ok(frames)
}

fn png_size(input: &[u8]) -> Result<usize, Error> {
    if !input.starts_with(PNG) {
        return Err(unsupported("codec-png-header"));
    }
    let mut current = 8;
    loop {
        let header = input
            .get(current..current + 8)
            .ok_or_else(|| unsupported("codec-png-incomplete"))?;
        let len = u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as usize;
        let end = current
            .checked_add(12)
            .and_then(|n| n.checked_add(len))
            .filter(|n| *n <= MAX_FRAME_BYTES)
            .ok_or_else(|| unsupported("codec-frame-limit"))?;
        if end > input.len() {
            return Err(unsupported("codec-png-incomplete"));
        }
        if &header[4..] == b"IEND" {
            if len != 0 {
                return Err(unsupported("codec-png-incomplete"));
            }
            return Ok(end);
        }
        current = end;
    }
}

/// Read bounded mono PCM through the process port.
pub fn pcm(
    caller: &Caller<'_>,
    source: Source<'_>,
    options: &Audio,
    sources: &dyn Sources,
    process: &dyn Process,
) -> Result<Vec<Pcm>, Error> {
    if !(8_000..=96_000).contains(&options.rate)
        || !(1..=MAX_AUDIO_SECONDS).contains(&options.max_seconds)
        || !(1..=options.rate as usize * 30).contains(&options.samples_per_chunk)
    {
        return Err(unsupported("codec-audio-options"));
    }
    let input = ScopedProcess::new(caller, source, sources, process)?;
    let duration = input.duration()?;
    let seconds = duration.map_or(options.max_seconds, |d| {
        options.max_seconds.min(d.ceil() as u32)
    });
    let max_samples = (options.rate as usize)
        .checked_mul(seconds as usize)
        .ok_or_else(|| unsupported("codec-output-limit"))?;
    let max_bytes = max_samples.saturating_mul(4).min(MAX_SOURCE_BYTES);
    let output = input.run(&Plan::new(
        Command::Audio {
            rate: options.rate,
            seconds,
        },
        max_bytes,
    ))?;
    if output.stdout.len() % 4 != 0 {
        return Err(unsupported("codec-pcm-incomplete"));
    }
    let stride = options.samples_per_chunk * 4;
    let mut result = Vec::new();
    if output.stdout.len().div_ceil(stride) > MAX_FRAMES * 32 {
        return Err(unsupported("codec-pcm-chunk-limit"));
    }
    for (i, chunk) in output.stdout.chunks(stride).enumerate() {
        let samples = chunk
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect::<Vec<_>>();
        if samples.iter().any(|n| !n.is_finite()) {
            return Err(unsupported("codec-pcm-sample"));
        }
        let position = i as f64 * options.samples_per_chunk as f64;
        let start_ms = (position * 1000.0 / f64::from(options.rate)).round() as u64;
        result.push(Pcm { start_ms, samples });
    }
    Ok(result)
}

fn unsupported(reason: &'static str) -> Error {
    Error::new("E_MEDIA_UNSUPPORTED_KIND", reason)
}

#[cfg(test)]
#[path = "codec_vectors.rs"]
mod vectors;
