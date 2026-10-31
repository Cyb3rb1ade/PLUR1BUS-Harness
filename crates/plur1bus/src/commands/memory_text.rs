//! `plur1bus memory import-text|export-text`: prompt memory import and export (RPC 1.13.0, experimental).
//!
//! `import-text` reads an export that another chat assistant wrote for `--show-prompt`, asks the core to parse it
//! (`memory.importText.preview`, which also returns the core's per-entry target recommendations), and applies it with
//! `memory.importText.apply` or undoes a run with `memory.importText.rollback`. `export-text` writes the portable text
//! (`memory.exportText`) to stdout or, atomically and with mode 0600, to a file.
//!
//! Rules this module keeps:
//! - Memory text is never put into an error or panic message, and only a sanitised, character-bounded excerpt is
//!   shown in the human dry-run listing.
//! - Applying and rolling back follow the `config::confirm`/`memory forget` pattern: a question only on a terminal
//!   and without `--json`; otherwise `E_INVALID_PARAMS` "re-run with --yes"; a declined question is `E_CANCELLED`.
//!   Input on stdin is consumed, so it can never be combined with a question: it needs `--yes` (or `--dry-run`).
//! - Input is capped at [`MAX_INPUT_BYTES`] and the limit error does not echo it.
//! - All output goes through `Out` / `say*`, which survive a closed pipe (no `print!`).
use crate::commands::memory::require_agent;
use crate::commands::memory_ops::{
    connect_or_unavailable, print_unsupported_hint, require_supports,
};
use crate::output::{say_raw, Out};
use crate::paths::Layout;
use serde_json::{json, Value};
use std::io::{IsTerminal, Read, Write};
use std::path::{Path, PathBuf};

/// Largest import input the CLI accepts (the core parses at most 1 MB of text; 512 KiB keeps a wide margin).
pub(crate) const MAX_INPUT_BYTES: usize = 512 * 1024;
/// Characters of an entry shown in the human dry-run listing.
const EXCERPT_CHARS: usize = 60;
const EXPORT_PROMPT: &str =
    include_str!("../../../../packages/core/src/import/prompt/export-prompt.md");

pub(crate) struct ImportTextArgs {
    pub file: String,
    pub agent: Option<String>,
    pub workspace: Option<String>,
    pub all_preferences_to_user: bool,
    pub dry_run: bool,
    pub yes: bool,
    pub show_prompt: bool,
    pub rollback: Option<String>,
}

/// At most `max` characters of `s`, with `…` appended only when something was cut. Counts characters, never slices
/// bytes, so non-ASCII text cannot panic.
pub(crate) fn truncate_chars(s: &str, max: usize) -> String {
    let mut chars = s.chars();
    let head: String = chars.by_ref().take(max).collect();
    if chars.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

/// An excerpt that is safe to print to a terminal: control characters (escape sequences, newlines) become spaces.
fn excerpt(s: &str) -> String {
    let flat: String = s
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    truncate_chars(&flat, EXCERPT_CHARS)
}

/// Reads at most `limit` bytes; `None` when the input is longer.
fn read_limited(r: impl Read, limit: usize) -> std::io::Result<Option<Vec<u8>>> {
    let mut buf = Vec::new();
    r.take(limit as u64 + 1).read_to_end(&mut buf)?;
    Ok((buf.len() <= limit).then_some(buf))
}

fn read_input(out: &Out, file: &str) -> String {
    let limit_msg = format!("input exceeds the {} KiB limit", MAX_INPUT_BYTES / 1024);
    let bytes = if file == "-" {
        read_limited(std::io::stdin().lock(), MAX_INPUT_BYTES)
    } else {
        std::fs::File::open(file).and_then(|f| read_limited(f, MAX_INPUT_BYTES))
    };
    match bytes {
        Ok(Some(b)) => String::from_utf8(b).unwrap_or_else(|_| {
            out.fail("E_INVALID_PARAMS", "input is not valid UTF-8", json!({}))
        }),
        Ok(None) => out.fail("E_INVALID_PARAMS", &limit_msg, json!({})),
        Err(e) if file == "-" => out.fail(
            "E_INVALID_PARAMS",
            &format!("failed to read stdin: {e}"),
            json!({}),
        ),
        Err(e) => out.fail(
            "E_INVALID_PARAMS",
            &format!("failed to read {file}: {e}"),
            json!({}),
        ),
    }
}

/// Why a confirmation did not go through.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Refusal {
    /// No terminal or `--json`: the caller must re-run with `--yes`.
    NeedYes,
    /// The question was asked and answered with anything but `y`.
    Declined,
}

/// The confirmation rule shared by import, rollback and overwrite: `--yes` passes; a question is asked only when
/// `interactive` (terminal and not `--json`); anything else needs `--yes`.
pub(crate) fn confirm_decision(
    yes: bool,
    interactive: bool,
    ask: impl FnOnce() -> bool,
) -> Result<(), Refusal> {
    if yes {
        Ok(())
    } else if !interactive {
        Err(Refusal::NeedYes)
    } else if ask() {
        Ok(())
    } else {
        Err(Refusal::Declined)
    }
}

/// Asks `question` on stderr and reads the answer from stdin.
fn ask_yes_no(question: &str) -> bool {
    eprint_flush(&format!("{question} [y/N] "));
    let mut line = String::new();
    std::io::stdin().read_line(&mut line).ok();
    line.trim().eq_ignore_ascii_case("y")
}

fn eprint_flush(s: &str) {
    let mut e = std::io::stderr().lock();
    let _ = e.write_all(s.as_bytes());
    let _ = e.flush();
}

fn confirm(out: &Out, yes: bool, question: &str, need_yes: &str) {
    let interactive = std::io::stdin().is_terminal() && !out.json;
    match confirm_decision(yes, interactive, || ask_yes_no(question)) {
        Ok(()) => {}
        Err(Refusal::NeedYes) => out.fail(
            "E_INVALID_PARAMS",
            &format!("{need_yes}; re-run with --yes"),
            json!({ "applied": false }),
        ),
        Err(Refusal::Declined) => {
            out.fail("E_CANCELLED", "not applied", json!({ "applied": false }))
        }
    }
}

/// `run-id` of an import run: `prompt-<digits>-<hex>` (the core's own format).
fn valid_run_id(id: &str) -> bool {
    let Some(rest) = id.strip_prefix("prompt-") else {
        return false;
    };
    match rest.split_once('-') {
        Some((n, h)) => {
            !n.is_empty()
                && n.bytes().all(|b| b.is_ascii_digit())
                && !h.is_empty()
                && h.bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        }
        None => false,
    }
}

/// Turns the core's recommendations into the targets to apply. The core is authoritative (it already skips
/// instructions, redacted entries and what needs a person); the flags only steer where the recommended memories go,
/// and user scope is opt-in in the CLI: only `Preferences`, only with `--all-preferences-to-user`.
pub(crate) fn adjust_targets(
    entries: &[Value],
    recs: &[Value],
    agent: Option<&str>,
    workspace: Option<&str>,
    preferences_to_user: bool,
) -> Vec<Value> {
    entries
        .iter()
        .zip(recs)
        .map(|(entry, rec)| {
            let cat = entry["category"].as_str().unwrap_or("");
            let target = rec["target"].as_str().unwrap_or("skip");
            match target {
                "skip"
                    if preferences_to_user
                        && cat == "Preferences"
                        && rec["reason"].as_str() == Some("requires-user-binding") =>
                {
                    json!({ "target": "user" })
                }
                "user" if !(preferences_to_user && cat == "Preferences") => {
                    json!({ "target": "skip", "reason": "user-scope-opt-in" })
                }
                "agent" if cat == "Projects" && workspace.is_some() => {
                    json!({ "target": "workspace", "workspaceId": workspace })
                }
                "agent" if agent.is_some() => {
                    let mut t = rec.clone();
                    t["agentIds"] = json!([agent]);
                    t
                }
                _ => rec.clone(),
            }
        })
        .collect()
}

pub(crate) fn import_text(out: &Out, layout: &Layout, config: &Value, a: ImportTextArgs) {
    if a.show_prompt {
        let text = EXPORT_PROMPT;
        out.ok(
            "memory.importText.prompt/1",
            &json!({ "prompt": text }),
            || text.trim_end_matches('\n').to_string(),
        );
        return;
    }
    if let Some(run_id) = a.rollback.as_deref() {
        rollback(out, layout, run_id, a.yes);
        return;
    }
    if let Some(ag) = a.agent.as_deref() {
        require_agent(out, config, ag);
    }
    // stdin is consumed by the input, so no question could be asked afterwards.
    if a.file == "-" && !a.dry_run && !a.yes {
        out.fail(
            "E_INVALID_PARAMS",
            "input from stdin cannot be confirmed; re-run with --yes (or --dry-run to preview)",
            json!({ "applied": false }),
        );
    }
    let text = read_input(out, &a.file);

    let mut c = connect_or_unavailable(out, layout);
    require_supports(out, &c, "memory.importText.preview");
    let preview = match c.call("memory.importText.preview", json!({ "text": text })) {
        Ok(v) => v,
        Err(e) => {
            print_unsupported_hint(out, &e);
            out.from_rpc_error(&e);
        }
    };
    let entries = preview["entries"].as_array().cloned().unwrap_or_default();
    let status = preview["status"].as_str().unwrap_or("unrecognized");
    if status == "unrecognized" || entries.is_empty() {
        out.fail(
            "E_INVALID_PARAMS",
            "no recognizable memory entries found in export",
            json!({ "status": status }),
        );
    }
    let recs = preview["recommendations"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if recs.len() != entries.len() {
        out.fail(
            "E_INTERNAL",
            "core returned no usable recommendations for the preview",
            json!({}),
        );
    }
    let targets = adjust_targets(
        &entries,
        &recs,
        a.agent.as_deref(),
        a.workspace.as_deref(),
        a.all_preferences_to_user,
    );
    let to_import = targets
        .iter()
        .filter(|t| t["target"].as_str().is_some_and(|s| s != "skip"))
        .count();

    if a.dry_run {
        let mut doc = preview.clone();
        doc["targets"] = json!(targets);
        out.ok("memory.importText.preview/1", &doc, || {
            describe_preview(&entries, &targets, &preview, status)
        });
        return;
    }

    confirm(
        out,
        a.yes,
        &format!(
            "import {to_import} of {} entries ({} skipped)?",
            entries.len(),
            entries.len() - to_import
        ),
        &format!(
            "{to_import} of {} entries are ready to import",
            entries.len()
        ),
    );

    require_supports(out, &c, "memory.importText.apply");
    match c.call(
        "memory.importText.apply",
        json!({ "entries": entries, "targets": targets, "dryRun": false }),
    ) {
        Ok(v) => out.ok("memory.importText.apply/1", &v, || {
            format!(
                "imported: {} cards, {} linked, {} skipped (run: {})",
                v["imported"].as_u64().unwrap_or(0),
                v["linked"].as_u64().unwrap_or(0),
                v["skipped"].as_u64().unwrap_or(0),
                v["runId"].as_str().unwrap_or("?")
            )
        }),
        Err(e) => {
            print_unsupported_hint(out, &e);
            out.from_rpc_error(&e);
        }
    }
}

fn describe_preview(entries: &[Value], targets: &[Value], preview: &Value, status: &str) -> String {
    let mut s = format!("parsed {} entries (status: {status}):\n", entries.len());
    for (entry, target) in entries.iter().zip(targets) {
        s.push_str(&format!(
            "  [{}] -> {}: {}\n",
            entry["category"].as_str().unwrap_or("?"),
            target["target"].as_str().unwrap_or("skip"),
            excerpt(entry["text"].as_str().unwrap_or(""))
        ));
    }
    let warnings: Vec<&str> = preview["warnings"]
        .as_array()
        .map(|w| w.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    if !warnings.is_empty() {
        s.push_str(&format!("warnings: {}\n", warnings.join(", ")));
    }
    s
}

fn rollback(out: &Out, layout: &Layout, run_id: &str, yes: bool) {
    if !valid_run_id(run_id) {
        out.fail(
            "E_INVALID_PARAMS",
            "invalid run id (expected prompt-<number>-<hex>)",
            json!({}),
        );
    }
    confirm(
        out,
        yes,
        &format!("roll back import run {run_id}?"),
        &format!("rolling back run {run_id} removes the memories it imported"),
    );
    let mut c = connect_or_unavailable(out, layout);
    require_supports(out, &c, "memory.importText.rollback");
    match c.call("memory.importText.rollback", json!({ "runId": run_id })) {
        Ok(v) => out.ok("memory.importText.rollback/1", &v, || {
            format!(
                "rolled back run: {} memories undone, {} proposals discarded",
                v["rolledBack"].as_u64().unwrap_or(0),
                v["discardedProposals"].as_u64().unwrap_or(0)
            )
        }),
        Err(e) => {
            print_unsupported_hint(out, &e);
            out.from_rpc_error(&e);
        }
    }
}

/// What is at an export destination.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Destination {
    Free,
    ExistingFile,
    Symlink,
    Directory,
}

pub(crate) fn destination_state(dest: &Path) -> std::io::Result<Destination> {
    match std::fs::symlink_metadata(dest) {
        Ok(m) if m.file_type().is_symlink() => Ok(Destination::Symlink),
        Ok(m) if m.is_dir() => Ok(Destination::Directory),
        Ok(_) => Ok(Destination::ExistingFile),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Destination::Free),
        Err(e) => Err(e),
    }
}

/// Writes `data` to `dest` through a fresh temporary file in the same directory (created exclusively, mode 0600 on
/// unix, so it never follows a link and is never readable by others) and renames it into place. A failure removes
/// the temporary file.
pub(crate) fn write_private_atomic(dest: &Path, data: &[u8]) -> std::io::Result<()> {
    let name = dest
        .file_name()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "no file name"))?;
    let parent = match dest.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
        _ => PathBuf::from("."),
    };
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.subsec_nanos());
    let tmp = parent.join(format!(
        ".{}.tmp-{}-{nanos}",
        name.to_string_lossy(),
        std::process::id()
    ));
    let result = (|| {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, dest)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

pub(crate) fn export_text(
    out: &Out,
    layout: &Layout,
    config: &Value,
    agent: Option<&str>,
    output: &str,
    yes: bool,
) {
    let mut params = json!({});
    if let Some(a) = agent {
        require_agent(out, config, a);
        params["agentId"] = json!(a);
    }
    let to_file = output != "-";
    if to_file {
        // Decide about the destination before any memory is exported.
        match destination_state(Path::new(output)) {
            Ok(Destination::Free) => {}
            Ok(Destination::ExistingFile) => confirm(
                out,
                yes,
                &format!("overwrite {output}?"),
                &format!("{output} already exists"),
            ),
            Ok(Destination::Symlink) => out.fail(
                "E_INVALID_PARAMS",
                &format!("refusing to write through a symbolic link: {output}"),
                json!({}),
            ),
            Ok(Destination::Directory) => out.fail(
                "E_INVALID_PARAMS",
                &format!("{output} is a directory"),
                json!({}),
            ),
            Err(e) => out.fail(
                "E_STORAGE",
                &format!("cannot inspect {output}: {e}"),
                json!({}),
            ),
        }
    }
    let mut c = connect_or_unavailable(out, layout);
    require_supports(out, &c, "memory.exportText");
    let v = match c.call("memory.exportText", params) {
        Ok(v) => v,
        Err(e) => {
            print_unsupported_hint(out, &e);
            out.from_rpc_error(&e);
        }
    };
    let text = v["text"].as_str().unwrap_or("");
    let count = v["entryCount"].as_u64().unwrap_or(0);
    if !to_file {
        if out.json {
            out.ok("memory.exportText/1", &v, String::new);
        } else {
            say_raw(text);
        }
        return;
    }
    if let Err(e) = write_private_atomic(Path::new(output), text.as_bytes()) {
        out.fail(
            "E_STORAGE",
            &format!("failed to write {output}: {e}"),
            json!({}),
        );
    }
    let doc = json!({ "output": output, "entryCount": count });
    out.ok("memory.exportText/1", &doc, || {
        format!("exported {count} memories to {output}")
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_counts_characters_and_marks_only_a_real_cut() {
        let s = "ä".repeat(100);
        let t = truncate_chars(&s, 60);
        assert_eq!(t.chars().count(), 61);
        assert!(t.ends_with('…'));
        assert_eq!(truncate_chars("kurz", 60), "kurz");
        let exact = "ö".repeat(60);
        assert_eq!(truncate_chars(&exact, 60), exact);
        assert_eq!(truncate_chars("", 60), "");
        // a 4-byte character at the cut position
        let emoji = format!("{}🦀🦀", "a".repeat(59));
        assert_eq!(truncate_chars(&emoji, 60), format!("{}🦀…", "a".repeat(59)));
    }

    #[test]
    fn excerpt_flattens_control_characters() {
        assert_eq!(excerpt("a\x1b[31mb\nc"), "a [31mb c");
    }

    #[test]
    fn read_limited_accepts_the_limit_and_rejects_one_more() {
        assert_eq!(read_limited(&b"abcd"[..], 4).unwrap().unwrap(), b"abcd");
        assert!(read_limited(&b"abcde"[..], 4).unwrap().is_none());
        assert_eq!(read_limited(&b""[..], 4).unwrap().unwrap(), b"");
    }

    #[test]
    fn confirm_decision_follows_the_forget_pattern() {
        assert_eq!(confirm_decision(true, false, || false), Ok(()));
        assert_eq!(
            confirm_decision(false, false, || true),
            Err(Refusal::NeedYes)
        );
        assert_eq!(confirm_decision(false, true, || true), Ok(()));
        assert_eq!(
            confirm_decision(false, true, || false),
            Err(Refusal::Declined)
        );
    }

    #[test]
    fn run_ids_have_the_core_format() {
        assert!(valid_run_id("prompt-1761900000000-0a1b2c3d"));
        for bad in [
            "",
            "prompt-",
            "prompt-1-",
            "prompt--ab",
            "prompt-1-XY",
            "../prompt-1-ab",
            "import-1-ab",
            "prompt-1a-ab",
        ] {
            assert!(!valid_run_id(bad), "{bad}");
        }
    }

    fn entry(cat: &str) -> Value {
        json!({ "category": cat, "text": "x" })
    }

    #[test]
    fn targets_follow_the_core_and_user_scope_is_opt_in() {
        let entries = [
            entry("Identity"),
            entry("Preferences"),
            entry("Projects"),
            entry("Instructions"),
        ];
        let recs = [
            json!({ "target": "user" }),
            json!({ "target": "user" }),
            json!({ "target": "agent", "agentIds": ["main"], "reason": "projects-default-agent" }),
            json!({ "target": "skip", "reason": "instructions-not-imported" }),
        ];
        let t = adjust_targets(&entries, &recs, None, None, false);
        assert_eq!(t[0]["target"], "skip");
        assert_eq!(t[1]["target"], "skip");
        assert_eq!(t[2]["agentIds"], json!(["main"]));
        assert_eq!(t[3]["reason"], "instructions-not-imported");
        let t = adjust_targets(&entries, &recs, Some("bernd"), Some("ws"), true);
        assert_eq!(
            t[0]["target"], "skip",
            "identity never goes to user scope from the CLI"
        );
        assert_eq!(t[1]["target"], "user");
        assert_eq!(t[2], json!({ "target": "workspace", "workspaceId": "ws" }));
        let t = adjust_targets(&entries, &recs, Some("bernd"), None, false);
        assert_eq!(t[2]["agentIds"], json!(["bernd"]));
        assert_eq!(t[3]["target"], "skip");
    }

    #[test]
    fn a_preference_the_core_could_not_bind_to_a_person_goes_to_user_only_with_the_flag() {
        let entries = [entry("Preferences"), entry("Preferences")];
        let recs = [
            json!({ "target": "skip", "reason": "requires-user-binding" }),
            json!({ "target": "skip", "reason": "secret-redacted" }),
        ];
        let t = adjust_targets(&entries, &recs, None, None, true);
        assert_eq!(t[0]["target"], "user");
        assert_eq!(
            t[1]["reason"], "secret-redacted",
            "a redacted entry stays skipped"
        );
        assert_eq!(
            adjust_targets(&entries, &recs, None, None, false)[0]["target"],
            "skip"
        );
    }

    #[test]
    fn atomic_write_is_private_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("export.txt");
        write_private_atomic(&dest, b"one").unwrap();
        write_private_atomic(&dest, b"two").unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"two");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&dest).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names.len(), 1, "{names:?}");
        // a missing directory fails without leaving anything behind
        assert!(write_private_atomic(&dir.path().join("no/such/dir/f"), b"x").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn destination_state_sees_links_before_files() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("f");
        assert_eq!(destination_state(&f).unwrap(), Destination::Free);
        std::fs::write(&f, "x").unwrap();
        assert_eq!(destination_state(&f).unwrap(), Destination::ExistingFile);
        let l = dir.path().join("l");
        std::os::unix::fs::symlink(&f, &l).unwrap();
        assert_eq!(destination_state(&l).unwrap(), Destination::Symlink);
        assert_eq!(
            destination_state(dir.path()).unwrap(),
            Destination::Directory
        );
    }
}
