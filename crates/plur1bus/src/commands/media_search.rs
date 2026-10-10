//! `plur1bus media search|index|caption`: the media-index side of `media.*` (search by text or by an existing
//! medium, backfill control, caption edits). The core owns validation and the media-index error codes; this file maps
//! arguments to params and renders results.
use crate::{output::Out, paths::Layout};
use clap::{Args, Subcommand, ValueEnum};
use serde_json::{json, Value};
use std::io::{IsTerminal, Write};

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum KindArg {
    Image,
    Video,
    Audio,
}

impl KindArg {
    fn as_str(self) -> &'static str {
        match self {
            KindArg::Image => "image",
            KindArg::Video => "video",
            KindArg::Audio => "audio",
        }
    }
}

#[derive(Debug, Args)]
#[command(group(clap::ArgGroup::new("query").required(true).args(["text", "like"])))]
pub struct SearchArgs {
    /// what to look for, in words (exactly one of TEXT or --like)
    pub text: Option<String>,
    /// find media similar to this one (a media id) instead of searching by words
    #[arg(long, value_name = "MEDIA_ID")]
    pub like: Option<String>,
    /// restrict to a kind; repeat for several (default: all kinds)
    #[arg(long, value_enum)]
    pub kind: Vec<KindArg>,
    /// maximum number of hits
    #[arg(long, default_value_t = 20, value_parser = clap::value_parser!(u32).range(1..))]
    pub limit: u32,
}

#[derive(Debug, Subcommand)]
pub enum IndexCmd {
    /// [experimental] Media index state: model, counts and backfill progress
    Status,
    /// [experimental] Pause the background backfill
    Pause,
    /// [experimental] Resume a paused backfill
    Resume,
    /// [experimental] Rebuild the media index from scratch (asks first; --yes skips the question)
    Reindex {
        /// do not ask; required without a terminal and with --json
        #[arg(long)]
        yes: bool,
    },
}

#[derive(Debug, Subcommand)]
pub enum CaptionCmd {
    /// [experimental] Set the caption of a medium (it becomes a text-searchable memory entry)
    Set {
        /// the media id
        id: String,
        /// the caption text
        text: String,
    },
}

pub fn search_request(a: &SearchArgs) -> (&'static str, Value) {
    let mut p = json!({ "limit": a.limit });
    if let Some(t) = &a.text {
        p["text"] = json!(t);
    }
    if let Some(l) = &a.like {
        p["likeMediaId"] = json!(l);
    }
    if !a.kind.is_empty() {
        let mut kinds: Vec<&str> = Vec::new();
        for k in &a.kind {
            if !kinds.contains(&k.as_str()) {
                kinds.push(k.as_str());
            }
        }
        p["kinds"] = json!(kinds);
    }
    ("media.search", p)
}

pub fn index_request(cmd: &IndexCmd) -> (&'static str, Value) {
    match cmd {
        IndexCmd::Status => ("media.index.status", json!({})),
        IndexCmd::Pause => ("media.index.pause", json!({})),
        IndexCmd::Resume => ("media.index.resume", json!({})),
        IndexCmd::Reindex { .. } => ("media.index.reindex", json!({ "confirm": true })),
    }
}

pub fn caption_request(cmd: &CaptionCmd) -> (&'static str, Value) {
    match cmd {
        CaptionCmd::Set { id, text } => {
            ("media.caption.set", json!({ "mediaId": id, "text": text }))
        }
    }
}

fn ms(v: u64) -> String {
    let s = v / 1000;
    format!("{}:{:02}", s / 60, s % 60)
}

pub(crate) fn render_search(v: &Value) -> String {
    let hits = v["hits"].as_array().cloned().unwrap_or_default();
    if hits.is_empty() {
        return "no matches".to_string();
    }
    hits.iter()
        .map(|h| {
            let mut l = format!(
                "{}  {}  {:.3}",
                h["mediaId"].as_str().unwrap_or(""),
                h["kind"].as_str().unwrap_or(""),
                h["score"].as_f64().unwrap_or(0.0)
            );
            if let Some(seg) = h.get("segment").filter(|s| s.is_object()) {
                l.push_str(&format!(
                    "  @{}-{}",
                    ms(seg["startMs"].as_u64().unwrap_or(0)),
                    ms(seg["endMs"].as_u64().unwrap_or(0))
                ));
            }
            if let Some(c) = h["caption"].as_str() {
                l.push_str(&format!("  {c}"));
            }
            l
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub(crate) fn render_status(v: &Value) -> String {
    let n = |k: &str| v["counts"][k].as_u64().unwrap_or(0);
    let b = &v["backfill"];
    let mut model = v["model"].as_str().unwrap_or("").to_string();
    if let Some(var) = v["variant"].as_str() {
        model.push_str(&format!(" ({var})"));
    }
    let mut lines = vec![
        format!(
            "media index: {}",
            if v["enabled"] == json!(true) {
                "enabled"
            } else {
                "disabled"
            }
        ),
        format!(
            "model: {} / {}, {} dimensions",
            v["provider"].as_str().unwrap_or(""),
            model,
            v["dim"].as_u64().unwrap_or(0)
        ),
        format!(
            "indexed {}, pending {}, failed {}, unsupported {}",
            n("indexed"),
            n("pending"),
            n("failed"),
            n("unsupported")
        ),
    ];
    let mut bf = format!(
        "backfill: {} ({}/{})",
        b["state"].as_str().unwrap_or("idle"),
        b["done"].as_u64().unwrap_or(0),
        b["total"].as_u64().unwrap_or(0)
    );
    if let Some(r) = b["pausedReason"].as_str() {
        bf.push_str(&format!(", paused: {r}"));
    }
    lines.push(bf);
    lines.join("\n")
}

fn confirm_reindex(out: &Out, yes: bool) {
    if yes {
        return;
    }
    if std::io::stdin().is_terminal() && !out.json {
        eprint!("rebuild the whole media index (the background backfill re-embeds every medium)? [y/N] ");
        std::io::stderr().flush().ok();
        let mut line = String::new();
        std::io::stdin().read_line(&mut line).ok();
        if !line.trim().eq_ignore_ascii_case("y") {
            out.fail(
                "E_INVALID_PARAMS",
                "not reindexed",
                json!({"applied": false}),
                2,
            );
        }
    } else {
        out.fail(
            "E_INVALID_PARAMS",
            "reindex rebuilds the media index; re-run with --yes to confirm",
            json!({"applied": false}),
            2,
        );
    }
}

pub fn run_search(out: &Out, layout: &Layout, a: SearchArgs) {
    let (m, p) = search_request(&a);
    let v = super::surfaces::call(out, layout, m, p);
    out.ok("media.search/1", &v, || render_search(&v));
}

pub fn run_index(out: &Out, layout: &Layout, cmd: IndexCmd) {
    if let IndexCmd::Reindex { yes } = &cmd {
        confirm_reindex(out, *yes);
    }
    let (m, p) = index_request(&cmd);
    let v = super::surfaces::call(out, layout, m, p);
    out.ok(&format!("{m}/1"), &v, || render_status(&v));
}

pub fn run_caption(out: &Out, layout: &Layout, cmd: CaptionCmd) {
    let (m, p) = caption_request(&cmd);
    let v = super::surfaces::call(out, layout, m, p);
    out.ok("media.caption.set/1", &v, || "caption saved".to_string());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::{Cli, Cmd};
    use crate::commands::media::MediaCmd;
    use clap::Parser;

    fn parse(args: &[&str]) -> Result<MediaCmd, clap::Error> {
        let mut v = vec!["plur1bus", "media"];
        v.extend_from_slice(args);
        Cli::try_parse_from(v).map(|c| match c.cmd {
            Cmd::Media { sub } => sub,
            _ => panic!(),
        })
    }

    #[test]
    fn search_text_defaults_to_limit_20_and_omits_kinds() {
        let Ok(MediaCmd::Search(a)) = parse(&["search", "red bicycle"]) else {
            panic!()
        };
        let (m, p) = search_request(&a);
        assert_eq!(m, "media.search");
        assert_eq!(p, json!({"text":"red bicycle","limit":20}));
    }

    #[test]
    fn search_like_with_repeated_kind_and_limit() {
        let Ok(MediaCmd::Search(a)) = parse(&[
            "search", "--like", "m-1", "--kind", "image", "--kind", "video", "--kind", "image",
            "--limit", "5",
        ]) else {
            panic!()
        };
        let (_, p) = search_request(&a);
        assert_eq!(
            p,
            json!({"likeMediaId":"m-1","kinds":["image","video"],"limit":5})
        );
    }

    #[test]
    fn search_needs_exactly_one_of_text_and_like() {
        assert!(parse(&["search"]).is_err());
        assert!(parse(&["search", "words", "--like", "m-1"]).is_err());
        assert!(parse(&["search", "words", "--kind", "pdf"]).is_err());
        assert!(parse(&["search", "words", "--limit", "0"]).is_err());
    }

    #[test]
    fn index_and_caption_map_to_their_methods() {
        for (args, method) in [
            (vec!["index", "status"], "media.index.status"),
            (vec!["index", "pause"], "media.index.pause"),
            (vec!["index", "resume"], "media.index.resume"),
        ] {
            let Ok(MediaCmd::Index { sub }) = parse(&args) else {
                panic!()
            };
            assert_eq!(index_request(&sub), (method, json!({})));
        }
        let Ok(MediaCmd::Index { sub }) = parse(&["index", "reindex", "--yes"]) else {
            panic!()
        };
        assert_eq!(
            index_request(&sub),
            ("media.index.reindex", json!({"confirm":true}))
        );
        let Ok(MediaCmd::Caption { sub }) = parse(&["caption", "set", "m-1", "a red bike"]) else {
            panic!()
        };
        assert_eq!(
            caption_request(&sub),
            (
                "media.caption.set",
                json!({"mediaId":"m-1","text":"a red bike"})
            )
        );
        assert!(parse(&["caption", "set", "m-1"]).is_err());
    }

    #[test]
    fn renders_hits_and_status() {
        let hits = json!({"hits":[
            {"mediaId":"m-1","kind":"image","score":0.83,"caption":"red bike"},
            {"mediaId":"m-2","kind":"video","score":0.5,"segment":{"idx":2,"startMs":20000,"endMs":30000}}]});
        let t = render_search(&hits);
        assert!(t.contains("m-1  image  0.830  red bike"), "{t}");
        assert!(t.contains("@0:20-0:30"), "{t}");
        assert_eq!(render_search(&json!({"hits":[]})), "no matches");
        let st = json!({"enabled":true,"provider":"local-transformers","model":"google/embeddinggemma-2",
            "variant":"image-video-audio","dim":768,"fingerprint":"x",
            "counts":{"indexed":12,"pending":3,"failed":0,"unsupported":1},
            "backfill":{"state":"paused","done":12,"total":16,"pausedReason":"budget"}});
        let t = render_status(&st);
        assert!(
            t.contains("indexed 12, pending 3, failed 0, unsupported 1"),
            "{t}"
        );
        assert!(
            t.contains("backfill: paused (12/16), paused: budget"),
            "{t}"
        );
    }
}
