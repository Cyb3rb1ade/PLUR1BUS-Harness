//! Local video probe, metadata-free remux and poster commands over the host process port.

use std::{ffi::OsString, path::Path, str::FromStr, time::Instant};

use serde_json::Value;

const MAX_STDOUT: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Codec {
    Ffprobe,
    Ffmpeg,
}

impl Codec {
    pub const fn program(self) -> &'static str {
        match self {
            Self::Ffprobe => "ffprobe",
            Self::Ffmpeg => "ffmpeg",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Format {
    Mp4,
    Mov,
    Webm,
}

impl Format {
    pub const fn extension(self) -> &'static str {
        match self {
            Self::Mp4 => "mp4",
            Self::Mov => "mov",
            Self::Webm => "webm",
        }
    }
}

impl FromStr for Format {
    type Err = Error;

    fn from_str(value: &str) -> Result<Self, Error> {
        match value {
            "mp4" => Ok(Self::Mp4),
            "mov" => Ok(Self::Mov),
            "webm" => Ok(Self::Webm),
            _ => Err(Error::InvalidResponse),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    BackendUnavailable,
    Cancelled,
    InvalidResponse,
    Timeout,
}

impl Error {
    pub const fn code(self) -> &'static str {
        match self {
            Self::BackendUnavailable => "backend_unavailable",
            Self::Cancelled => "cancelled",
            Self::InvalidResponse => "invalid_response",
            Self::Timeout => "timeout",
        }
    }
}

/// Run one configured local codec executable without a shell or stdin.
/// The implementation bounds stdout while reading and kills/reaps the child
/// on overflow, deadline or cancellation. It discards stderr.
pub trait ProcessPort {
    fn run(
        &self,
        codec: Codec,
        args: &[OsString],
        max_stdout: usize,
        deadline: Instant,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Vec<u8>, Error>;
}

/// Physical, private staging paths derived and owned by the caller.
/// The caller removes partial files on error and publishes only on success.
pub struct VideoPaths<'a> {
    pub input: &'a Path,
    pub output: &'a Path,
    pub poster: &'a Path,
}

pub struct VideoRequest<'a> {
    pub paths: VideoPaths<'a>,
    pub format: Format,
    /// Included only when the caller has admitted embedding the user's prompt.
    pub prompt: Option<&'a str>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VideoInfo {
    pub duration_seconds: f64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub audio: bool,
}

pub fn detect_format(bytes: &[u8]) -> Result<Format, Error> {
    if bytes.get(4..8) == Some(b"ftyp") {
        return match bytes.get(8..12) {
            Some(b"qt  ") => Ok(Format::Mov),
            Some(
                b"isom" | b"iso2" | b"iso4" | b"iso5" | b"iso6" | b"mp41" | b"mp42" | b"avc1"
                | b"M4V " | b"dash",
            ) => Ok(Format::Mp4),
            _ => Err(Error::InvalidResponse),
        };
    }
    if bytes.len() >= 8
        && bytes.starts_with(&[0x1a, 0x45, 0xdf, 0xa3])
        && bytes.windows(4).any(|part| part == b"webm")
    {
        return Ok(Format::Webm);
    }
    Err(Error::InvalidResponse)
}

fn probe(bytes: &[u8]) -> Result<VideoInfo, Error> {
    let doc: Value = serde_json::from_slice(bytes).map_err(|_| Error::InvalidResponse)?;
    let streams = doc["streams"].as_array().ok_or(Error::InvalidResponse)?;
    let video = streams
        .iter()
        .find(|row| row["codec_type"] == "video")
        .ok_or(Error::InvalidResponse)?;
    let rate = video["avg_frame_rate"]
        .as_str()
        .ok_or(Error::InvalidResponse)?;
    let mut rate = rate.split('/');
    let numerator = rate
        .next()
        .and_then(|v| v.trim().parse::<f64>().ok())
        .ok_or(Error::InvalidResponse)?;
    let denominator = rate
        .next()
        .and_then(|v| v.trim().parse::<f64>().ok())
        .ok_or(Error::InvalidResponse)?;
    let fps = numerator / denominator;
    let duration = &doc["format"]["duration"];
    let duration_seconds = duration
        .as_f64()
        .or_else(|| duration.as_str()?.trim().parse::<f64>().ok())
        .ok_or(Error::InvalidResponse)?;
    let dimension = |name: &str| -> Result<u32, Error> {
        video[name]
            .as_u64()
            .and_then(|value| u32::try_from(value).ok())
            .filter(|&value| value > 0)
            .ok_or(Error::InvalidResponse)
    };
    if !duration_seconds.is_finite() || duration_seconds <= 0.0 || !fps.is_finite() || fps <= 0.0 {
        return Err(Error::InvalidResponse);
    }
    Ok(VideoInfo {
        duration_seconds,
        width: dimension("width")?,
        height: dimension("height")?,
        fps,
        audio: streams.iter().any(|row| row["codec_type"] == "audio"),
    })
}

fn check(deadline: Instant, cancelled: &dyn Fn() -> bool) -> Result<(), Error> {
    if cancelled() {
        return Err(Error::Cancelled);
    }
    if Instant::now() >= deadline {
        return Err(Error::Timeout);
    }
    Ok(())
}

pub fn process(
    host: &dyn ProcessPort,
    request: &VideoRequest<'_>,
    deadline: Instant,
    cancelled: &dyn Fn() -> bool,
) -> Result<VideoInfo, Error> {
    let VideoPaths {
        input,
        output,
        poster,
    } = request.paths;
    if ![input, output, poster]
        .iter()
        .all(|path| path.is_absolute())
    {
        return Err(Error::InvalidResponse);
    }
    let run = |codec, args: &[OsString]| {
        check(deadline, cancelled)?;
        let stdout = host.run(codec, args, MAX_STDOUT, deadline, cancelled)?;
        check(deadline, cancelled)?;
        if stdout.len() > MAX_STDOUT {
            return Err(Error::InvalidResponse);
        }
        Ok(stdout)
    };

    let mut args = Vec::from(options([
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
    ]));
    args.push(input.as_os_str().into());
    let info = probe(&run(Codec::Ffprobe, &args)?)?;

    let mut args = Vec::from(options([
        "-v",
        "error",
        "-nostdin",
        "-protocol_whitelist",
        "file,pipe",
        "-i",
    ]));
    args.push(input.as_os_str().into());
    args.extend(options([
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-map_metadata",
        "-1",
        "-map_metadata:s",
        "-1",
        "-map_chapters",
        "-1",
        "-c",
        "copy",
    ]));
    if let Some(prompt) = request.prompt {
        args.extend(["-metadata".into(), format!("comment={prompt}").into()]);
    }
    args.extend(options(["-f", request.format.extension(), "-y"]));
    args.push(output.as_os_str().into());
    run(Codec::Ffmpeg, &args)?;

    let mut args = Vec::from(options([
        "-v",
        "error",
        "-nostdin",
        "-protocol_whitelist",
        "file,pipe",
        "-i",
    ]));
    args.push(output.as_os_str().into());
    args.extend(options([
        "-map",
        "0:v:0",
        "-frames:v",
        "1",
        "-vf",
        "scale=320:-2",
        "-map_metadata",
        "-1",
        "-y",
    ]));
    args.push(poster.as_os_str().into());
    run(Codec::Ffmpeg, &args)?;
    Ok(info)
}

fn options<const N: usize>(values: [&str; N]) -> [OsString; N] {
    values.map(OsString::from)
}
