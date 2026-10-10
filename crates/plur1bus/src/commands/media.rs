use super::surfaces::{call, decode, emit};
use crate::{output::Out, paths::Layout};
use clap::{Args, Subcommand};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

#[derive(Debug, Args)]
pub struct GenerateArgs {
    pub prompt: String,
    #[arg(long)]
    pub video: bool,
    #[arg(long, requires = "video")]
    pub duration: Option<f64>,
    #[arg(long, requires = "video")]
    pub resolution: Option<String>,
    #[arg(long, requires = "video")]
    pub fps: Option<u32>,
    #[arg(long, requires = "video")]
    pub audio: Option<bool>,
    #[arg(long, requires = "video")]
    pub video_reference: Option<String>,
    #[arg(long, requires = "video")]
    pub video_format: Option<String>,
    #[arg(long)]
    pub aspect: Option<String>,
    #[arg(long, default_value = "main")]
    pub agent: String,
    #[arg(long)]
    pub adapter: Option<String>,
    #[arg(long, default_value_t = 1)]
    pub count: u8,
    #[arg(long, requires = "height")]
    pub width: Option<u32>,
    #[arg(long, requires = "width")]
    pub height: Option<u32>,
    #[arg(long)]
    pub reference: Vec<String>,
    #[arg(long)]
    pub mask: Option<String>,
    #[arg(long)]
    pub embed_metadata: Option<bool>,
    #[arg(long)]
    pub wait: bool,
    #[arg(long, requires = "wait")]
    pub out: Option<PathBuf>,
}
#[derive(Debug, Subcommand)]
pub enum MediaCmd {
    /// Queue an image or video generation (D109 and budget admission)
    #[command(about = "[experimental] Queue an image or video generation")]
    Generate(GenerateArgs),
    /// Edit an existing private output, using --reference output IDs
    #[command(about = "[experimental] Edit a stored image or video")]
    Edit(GenerateArgs),
    #[command(about = "[experimental] List visible media jobs")]
    Jobs {
        #[arg(long)]
        agent: Option<String>,
    },
    #[command(about = "[experimental] Read a media job")]
    Job { id: String },
    #[command(about = "[experimental] Cancel a media job")]
    Cancel { id: String },
    #[command(about = "[experimental] List visible media outputs")]
    Outputs {
        #[arg(long)]
        agent: Option<String>,
        #[arg(long)]
        adapter: Option<String>,
    },
    #[command(about = "[experimental] Read or download a media output")]
    Output {
        id: String,
        #[arg(long)]
        out: Option<PathBuf>,
        #[arg(long, default_value_t = 0)]
        file: u32,
    },
    #[command(about = "[experimental] Delete a media output")]
    Rm { id: String },
    #[command(about = "[experimental] List adapter capabilities")]
    Adapters,
}
fn save(out: &Out, layout: &Layout, id: &str, index: u32, destination: &PathBuf) {
    use sha2::{Digest, Sha256};
    use std::io::Write;
    let parent = destination
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| std::path::Path::new("."));
    let staging = parent.join(format!(".p1-media-{}", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&staging).unwrap_or_else(|_| {
        out.fail(
            "E_STORAGE",
            "cannot create output staging file",
            json!({}),
            1,
        )
    });
    let mut offset = 0_u64;
    let mut digest = Sha256::new();
    let expected;
    loop {
        let value = call(
            out,
            layout,
            "media.output.get",
            json!({"id":id,"file":index,"offset":offset,"length":4*1024*1024}),
        );
        let bytes = decode(value["data"].as_str().unwrap_or(""))
            .unwrap_or_else(|e| out.fail("E_INVALID_PARAMS", e, json!({}), 2));
        digest.update(&bytes);
        if file.write_all(&bytes).is_err() {
            out.fail("E_STORAGE", "cannot write output", json!({}), 1);
        }
        match value["nextOffset"].as_u64() {
            Some(next) if next == offset + bytes.len() as u64 && next > offset => offset = next,
            Some(_) => out.fail("E_INVALID_PARAMS", "invalid output range", json!({}), 2),
            None => {
                if value["totalBytes"].as_u64() != Some(offset + bytes.len() as u64) {
                    out.fail("E_INVALID_PARAMS", "incomplete output", json!({}), 2);
                }
                expected = value["manifest"]["files"][index as usize]["sha256"]
                    .as_str()
                    .unwrap_or("")
                    .to_owned();
                break;
            }
        }
    }
    if format!("{:x}", digest.finalize()) != expected {
        out.fail("E_STORAGE", "output integrity failed", json!({}), 1);
    }
    if file.sync_all().is_err() {
        out.fail("E_STORAGE", "cannot flush output", json!({}), 1);
    }
    drop(file);
    let published = std::fs::hard_link(&staging, destination);
    let _ = std::fs::remove_file(&staging);
    if published.is_err() {
        out.fail(
            "E_STORAGE",
            "cannot create output file (existing files are preserved)",
            json!({}),
            1,
        );
    }
}

pub fn request(cmd: &MediaCmd) -> (&'static str, Value) {
    match cmd {
        MediaCmd::Generate(a) | MediaCmd::Edit(a) => {
            let mut request = json!({"prompt":a.prompt,"n":a.count});
            if let (Some(width), Some(height)) = (a.width, a.height) {
                request["size"] = json!({"width":width,"height":height});
            }
            if !a.reference.is_empty() {
                request["referenceIds"] = json!(a.reference);
            }
            if let Some(id) = &a.mask {
                request["maskId"] = json!(id);
            }
            if let Some(value) = a.embed_metadata {
                request["embedMetadata"] = json!(value);
            }
            if a.video {
                request["kind"] = json!("video");
                if let Some(v) = a.duration {
                    request["durationSeconds"] = json!(v);
                }
                if let Some(v) = &a.resolution {
                    request["resolution"] = json!(v);
                }
                if let Some(v) = a.fps {
                    request["fps"] = json!(v);
                }
                if let Some(v) = a.audio {
                    request["audio"] = json!(v);
                }
                if let Some(v) = &a.video_reference {
                    request["referenceVideoId"] = json!(v);
                }
                if let Some(v) = &a.video_format {
                    request["videoFormat"] = json!(v);
                }
            }
            if let Some(v) = &a.aspect {
                request["aspect"] = json!(v);
            }
            let mut params = json!({"agentId":a.agent,"request":request});
            if a.video {
                params["kind"] = json!("video");
            }
            if let Some(id) = &a.adapter {
                params["adapter"] = json!(id);
            }
            (
                if matches!(cmd, MediaCmd::Generate(_)) {
                    "media.generate"
                } else {
                    "media.edit"
                },
                params,
            )
        }
        MediaCmd::Jobs { agent } => (
            "media.job.list",
            agent.as_ref().map_or(json!({}), |a| json!({"agentId":a})),
        ),
        MediaCmd::Job { id } => ("media.job.get", json!({"id":id})),
        MediaCmd::Cancel { id } => ("media.job.cancel", json!({"id":id})),
        MediaCmd::Outputs { agent, adapter } => {
            let mut p = json!({});
            if let Some(a) = agent {
                p["agentId"] = json!(a);
            }
            if let Some(a) = adapter {
                p["adapter"] = json!(a);
            }
            ("media.output.list", p)
        }
        MediaCmd::Output { id, .. } => ("media.output.get", json!({"id":id})),
        MediaCmd::Rm { id } => ("media.output.delete", json!({"id":id})),
        MediaCmd::Adapters => ("media.adapters.list", json!({})),
    }
}
pub fn run(out: &Out, layout: &Layout, cmd: MediaCmd) {
    let (method, params) = request(&cmd);
    let mut value = call(out, layout, method, params);
    if let MediaCmd::Generate(a) | MediaCmd::Edit(a) = &cmd {
        if a.wait {
            let id = value["jobId"].as_str().unwrap_or("").to_owned();
            let start = Instant::now();
            loop {
                let job = call(out, layout, "media.job.get", json!({"id":id}));
                eprintln!(
                    "media {} {} {:.0}%",
                    id,
                    job["state"].as_str().unwrap_or("?"),
                    job["progress"]["fraction"].as_f64().unwrap_or(0.0) * 100.0
                );
                match job["state"].as_str() {
                    Some("succeeded") => {
                        if let Some(dest) = &a.out {
                            save(out, layout, &id, 0, dest);
                        }
                        value = job;
                        break;
                    }
                    Some("failed" | "cancelled") => out.fail(
                        "E_NOT_AVAILABLE",
                        "media job did not succeed",
                        json!({"reason":job["error"]}),
                        1,
                    ),
                    _ => {}
                }
                if start.elapsed() > Duration::from_secs(600) {
                    out.fail(
                        "E_NOT_AVAILABLE",
                        "media wait timed out; job remains available",
                        json!({"reason":"timeout"}),
                        1,
                    );
                }
                std::thread::sleep(Duration::from_millis(250));
            }
        }
    }
    if let MediaCmd::Output {
        id,
        out: Some(dest),
        file,
    } = &cmd
    {
        save(out, layout, id, *file, dest);
    }
    emit(out, method, &value);
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::{Cli, Cmd};
    use clap::Parser;
    #[test]
    fn parse_generate_and_json() {
        let cli = Cli::try_parse_from([
            "plur1bus",
            "--json",
            "media",
            "generate",
            "forest",
            "--agent",
            "main",
            "--wait",
            "--out",
            "picture.png",
        ])
        .unwrap();
        let Cmd::Media { sub } = cli.cmd else {
            panic!()
        };
        let (m, p) = request(&sub);
        assert_eq!(m, "media.generate");
        assert_eq!(p["request"]["prompt"], "forest");
        assert!(p.get("caller").is_none());
    }
    #[test]
    fn output_requires_wait_and_reference_uses_ids() {
        assert!(Cli::try_parse_from([
            "plur1bus",
            "media",
            "generate",
            "forest",
            "--out",
            "picture.png"
        ])
        .is_err());
        let cli = Cli::try_parse_from([
            "plur1bus",
            "media",
            "edit",
            "forest",
            "--reference",
            "00000000-0000-4000-8000-000000000001",
        ])
        .unwrap();
        let Cmd::Media { sub } = cli.cmd else {
            panic!()
        };
        assert_eq!(request(&sub).0, "media.edit");
    }
}

#[cfg(test)]
mod video_tests {
    use super::*;
    use crate::cli::{Cli, Cmd};
    use clap::Parser;
    #[test]
    fn video_uses_existing_media_methods() {
        for op in ["generate", "edit"] {
            let cli = Cli::try_parse_from([
                "plur1bus",
                "media",
                op,
                "forest",
                "--video",
                "--duration",
                "4",
                "--resolution",
                "720p",
                "--fps",
                "24",
                "--wait",
                "--out",
                "clip.mp4",
            ])
            .unwrap();
            let Cmd::Media { sub } = cli.cmd else {
                panic!()
            };
            let (method, p) = request(&sub);
            assert_eq!(
                method,
                if op == "edit" {
                    "media.edit"
                } else {
                    "media.generate"
                }
            );
            assert_eq!(p["kind"], "video");
            assert_eq!(p["request"]["durationSeconds"], 4.0);
            assert_eq!(p["request"]["fps"], 24);
        }
    }
}
