//! `plur1bus inbox`: the signed-in person's own inbox (docs/inbox.md). Every leaf maps to one `inbox.*` RPC;
//! `--json` prints the RPC result unchanged under the schema ids `inbox.list/1`, `inbox.count/1`, `inbox.read/1`, `inbox.dismiss/1`.
use super::surfaces::call;
use crate::{output::Out, paths::Layout};
use clap::Subcommand;
use serde_json::{json, Value};

const KINDS: [&str; 8] = [
    "breakglass",
    "approval",
    "job-failed",
    "update",
    "media-index",
    "pairing",
    "channel",
    "system",
];

#[derive(Debug, Subcommand)]
pub enum InboxCmd {
    #[command(about = "[experimental] List your inbox entries, newest first")]
    List {
        /// Only these kinds (repeatable)
        #[arg(long, value_parser = KINDS)]
        kind: Vec<String>,
        /// Hide entries you already read
        #[arg(long)]
        unread: bool,
        /// Include dismissed entries
        #[arg(long)]
        all: bool,
        #[arg(long, default_value_t = 50, value_parser = clap::value_parser!(u32).range(1..=200))]
        limit: u32,
        /// `nextCursor` of the previous page
        #[arg(long)]
        cursor: Option<String>,
    },
    #[command(about = "[experimental] Count unread entries per kind")]
    Count,
    #[command(about = "[experimental] Mark entries read: give ids, or --all")]
    Read {
        #[arg(required_unless_present = "all", conflicts_with = "all")]
        ids: Vec<String>,
        /// Mark every unread entry read
        #[arg(long)]
        all: bool,
    },
    #[command(about = "[experimental] Dismiss entries (hidden, counted as read)")]
    Dismiss {
        #[arg(required = true)]
        ids: Vec<String>,
    },
}

pub fn request(cmd: &InboxCmd) -> (&'static str, Value) {
    match cmd {
        InboxCmd::List {
            kind,
            unread,
            all,
            limit,
            cursor,
        } => {
            let mut p = json!({"limit": limit});
            if !kind.is_empty() {
                p["kinds"] = json!(kind);
            }
            if *unread {
                p["unreadOnly"] = json!(true);
            }
            if *all {
                p["includeDismissed"] = json!(true);
            }
            if let Some(c) = cursor {
                p["cursor"] = json!(c);
            }
            ("inbox.list", p)
        }
        InboxCmd::Count => ("inbox.count", json!({})),
        InboxCmd::Read { ids, all } => (
            "inbox.markRead",
            if *all {
                json!({"all": true})
            } else {
                json!({"ids": ids})
            },
        ),
        InboxCmd::Dismiss { ids } => ("inbox.dismiss", json!({"ids": ids})),
    }
}

fn schema(cmd: &InboxCmd) -> &'static str {
    match cmd {
        InboxCmd::List { .. } => "inbox.list/1",
        InboxCmd::Count => "inbox.count/1",
        InboxCmd::Read { .. } => "inbox.read/1",
        InboxCmd::Dismiss { .. } => "inbox.dismiss/1",
    }
}

/// One line per entry: `id  kind  severity  titleKey  [unread]`. Clients translate `titleKey`; the CLI shows it as is.
fn human(cmd: &InboxCmd, v: &Value) -> String {
    match cmd {
        InboxCmd::List { .. } => {
            let mut lines: Vec<String> = v["entries"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|e| {
                            format!(
                                "{}  {}  {}  {}{}",
                                e["id"].as_str().unwrap_or("?"),
                                e["kind"].as_str().unwrap_or("?"),
                                e["severity"].as_str().unwrap_or("?"),
                                e["titleKey"].as_str().unwrap_or("?"),
                                if e["readAt"].is_null() {
                                    "  [unread]"
                                } else {
                                    ""
                                }
                            )
                        })
                        .collect()
                })
                .unwrap_or_default();
            if lines.is_empty() {
                lines.push("inbox is empty".into());
            }
            if let Some(c) = v["nextCursor"].as_str() {
                lines.push(format!("more: --cursor {c}"));
            }
            lines.join("\n")
        }
        InboxCmd::Count => {
            let mut lines: Vec<String> = KINDS
                .iter()
                .filter(|k| v["unread"][**k].as_u64().unwrap_or(0) > 0)
                .map(|k| format!("{k}: {}", v["unread"][*k]))
                .collect();
            lines.push(format!("visible entries: {}", v["total"]));
            lines.join("\n")
        }
        InboxCmd::Read { .. } => format!("marked read: {}", v["changed"]),
        InboxCmd::Dismiss { .. } => format!("dismissed: {}", v["changed"]),
    }
}

pub fn run(out: &Out, layout: &Layout, cmd: InboxCmd) {
    let (method, params) = request(&cmd);
    let value = call(out, layout, method, params);
    out.ok(schema(&cmd), &value, || human(&cmd, &value));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_maps_filters_and_defaults() {
        let (m, p) = request(&InboxCmd::List {
            kind: vec!["approval".into()],
            unread: true,
            all: false,
            limit: 20,
            cursor: Some("abc".into()),
        });
        assert_eq!(m, "inbox.list");
        assert_eq!(
            p,
            json!({"limit":20,"kinds":["approval"],"unreadOnly":true,"cursor":"abc"})
        );
    }

    #[test]
    fn read_is_ids_or_all_never_both() {
        let (m, p) = request(&InboxCmd::Read {
            ids: vec!["a".into()],
            all: false,
        });
        assert_eq!((m, p), ("inbox.markRead", json!({"ids":["a"]})));
        let (_, p) = request(&InboxCmd::Read {
            ids: vec![],
            all: true,
        });
        assert_eq!(p, json!({"all":true}));
    }

    #[test]
    fn kinds_match_the_closed_set() {
        assert_eq!(KINDS.len(), 8);
    }
}
