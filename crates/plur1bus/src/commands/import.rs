//! `plur1bus import <openclaw|hermes>` (docs/import.md §8, §9). The work runs in Node — `import.js`, the importer
//! entry shipped beside `core.js` — because it reads the source's LanceDB stores and SQLite databases; this side only
//! forwards the parsed flags, then prints the one envelope line Node answers with as the usual `--json` document
//! (`schema` inserted by `Out::ok`) or as its human text. The importer never talks to a core or supervisor.
use crate::cli::{ImportArgs, ImportSource, OnConflict};
use crate::commands::core::{locate_core_js, locate_node};
use crate::output::Out;
use crate::paths::Layout;
use serde_json::{json, Value};
use std::ffi::OsString;
use std::path::PathBuf;
use std::process::{Command, Stdio};

/// `import.js`: `$PLUR1BUS_IMPORT_JS`, else `import.js` next to the core entry ([`locate_core_js`]).
pub(crate) fn locate_import_js(layout: &Layout) -> PathBuf {
    std::env::var_os("PLUR1BUS_IMPORT_JS")
        .map(PathBuf::from)
        .unwrap_or_else(|| locate_core_js(layout).with_file_name("import.js"))
}

/// The importer's argv (after the script path): source, mode flags and options, and the harness home.
pub(crate) fn importer_args(a: &ImportArgs, layout: &Layout) -> Vec<OsString> {
    let mut v: Vec<OsString> = vec![match a.source_type {
        ImportSource::Openclaw => "openclaw".into(),
        ImportSource::Hermes => "hermes".into(),
    }];
    if a.detect {
        v.push("--detect".into());
    }
    if a.skills {
        v.push("--skills".into());
    }
    if let Some(r) = &a.rollback {
        v.push("--rollback".into());
        v.push(r.clone().into_os_string());
    }
    if let Some(s) = &a.source {
        v.push("--source".into());
        v.push(s.clone().into_os_string());
    }
    for m in &a.map {
        v.push("--map".into());
        v.push(m.clone());
    }
    if let Some(p) = &a.profile {
        v.push("--profile".into());
        v.push(p.into());
    }
    if a.apply {
        v.push("--apply".into());
    }
    if a.enable {
        v.push("--enable".into());
    }
    if let Some(c) = a.on_conflict {
        v.push("--on-conflict".into());
        v.push(
            match c {
                OnConflict::Skip => "skip",
                OnConflict::Rename => "rename",
                OnConflict::Replace => "replace",
            }
            .into(),
        );
    }
    if let Some(n) = a.max_skill_bytes {
        v.push("--max-skill-bytes".into());
        v.push(n.to_string().into());
    }
    if a.migrate_secrets {
        v.push("--migrate-secrets".into());
    }
    if let Some(r) = &a.resume {
        v.push("--resume".into());
        v.push(r.into());
    }
    if a.force {
        v.push("--force".into());
    }
    if let Some(s) = &a.adopt_store {
        v.push("--adopt-store".into());
        v.push(s.clone().into_os_string());
    }
    v.push("--home".into());
    v.push(layout.home.clone().into_os_string());
    v
}

/// The last non-empty stdout line, parsed as the importer's envelope object.
pub(crate) fn parse_envelope(stdout: &[u8]) -> Option<Value> {
    let text = String::from_utf8_lossy(stdout);
    let line = text.lines().rev().find(|l| !l.trim().is_empty())?;
    let v: Value = serde_json::from_str(line).ok()?;
    v.get("ok")?.as_bool()?;
    Some(v)
}

/// The CLI exit code for a failed importer envelope: its `exit` when that is a real failure status (1..=255), else 1.
/// A bare `as i32` wrapped values such as 4294967296 to 0 (success), and a status above 255 is truncated by the OS.
pub(crate) fn exit_code(env: &Value) -> i32 {
    env["exit"]
        .as_i64()
        .and_then(|e| i32::try_from(e).ok())
        .filter(|e| (1..=255).contains(e))
        .unwrap_or(1)
}

pub fn run(out: &Out, layout: &Layout, a: ImportArgs) {
    let js = locate_import_js(layout);
    if !js.exists() {
        out.fail(
            "E_IMPORT_FAILED",
            &format!(
                "import.js not found at {} (set PLUR1BUS_IMPORT_JS, or PLUR1BUS_CORE_JS to a built core, or run setup)",
                js.display()
            ),
            json!({ "reason": "importer-missing" }),
            1,
        );
    }
    let node = locate_node(layout);
    let output = Command::new(&node)
        .arg(&js)
        .args(importer_args(&a, layout))
        .stdin(Stdio::null())
        .stderr(Stdio::inherit())
        .output();
    let output = match output {
        Ok(o) => o,
        Err(e) => out.fail(
            "E_IMPORT_FAILED",
            &format!("cannot start {}: {e}", node.display()),
            json!({ "reason": "node-unavailable" }),
            1,
        ),
    };
    let Some(env) = parse_envelope(&output.stdout) else {
        out.fail(
            "E_IMPORT_FAILED",
            &format!(
                "the importer exited ({}) without a result",
                output
                    .status
                    .code()
                    .map_or("signal".to_string(), |c| c.to_string())
            ),
            json!({ "reason": "importer-crashed" }),
            1,
        );
    };
    if env["ok"] == json!(true) {
        let schema = env["schema"].as_str().unwrap_or("import/1").to_string();
        let human = env["human"].as_str().unwrap_or_default().to_string();
        let value = env.get("value").cloned().unwrap_or_else(|| json!({}));
        out.ok(&schema, &value, || human);
        let exit = env["exit"].as_i64().map_or(0, |e| e as i32);
        if exit != 0 {
            std::process::exit(exit);
        }
    } else {
        let code = env["error"].as_str().unwrap_or("E_IMPORT_FAILED");
        let message = env["message"].as_str().unwrap_or("import failed");
        let exit = exit_code(&env);
        let mut extra = json!({});
        if let Some(r) = env["reason"].as_str() {
            extra["reason"] = json!(r);
        }
        out.fail(code, message, extra, exit);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::Cli;
    use clap::Parser;

    fn args(argv: &[&str]) -> ImportArgs {
        match Cli::parse_from(argv).cmd {
            crate::cli::Cmd::Import(a) => a,
            other => panic!("not an import: {other:?}"),
        }
    }

    #[test]
    fn forwards_every_flag_and_the_home() {
        let layout = Layout::new(PathBuf::from("/h"));
        let a = args(&[
            "plur1bus",
            "import",
            "hermes",
            "--skills",
            "--source",
            "/s",
            "--map",
            "/home/u=/srv/u",
            "--map",
            "C:\\Data=/mnt/data",
            "--profile",
            "work",
            "--apply",
            "--enable",
            "--on-conflict",
            "rename",
            "--max-skill-bytes",
            "10",
        ]);
        let v: Vec<String> = importer_args(&a, &layout)
            .into_iter()
            .map(|s| s.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            v,
            [
                "hermes",
                "--skills",
                "--source",
                "/s",
                "--map",
                "/home/u=/srv/u",
                "--map",
                "C:\\Data=/mnt/data",
                "--profile",
                "work",
                "--apply",
                "--enable",
                "--on-conflict",
                "rename",
                "--max-skill-bytes",
                "10",
                "--home",
                "/h"
            ]
        );
    }

    #[test]
    fn detect_conflicts_with_the_other_modes() {
        assert!(
            Cli::try_parse_from(["plur1bus", "import", "hermes", "--detect", "--skills"]).is_err()
        );
        assert!(Cli::try_parse_from([
            "plur1bus",
            "import",
            "hermes",
            "--skills",
            "--rollback",
            "r.json"
        ])
        .is_err());
        assert!(Cli::try_parse_from(["plur1bus", "import", "zeroclaw", "--detect"]).is_err());
        assert!(Cli::try_parse_from([
            "plur1bus",
            "import",
            "hermes",
            "--rollback",
            "r.json",
            "--map",
            "/a=/b"
        ])
        .is_err());
    }

    #[test]
    fn parses_the_last_envelope_line() {
        assert!(parse_envelope(b"noise\n{\"ok\":true,\"value\":{}}\n\n").is_some());
        assert!(parse_envelope(b"{\"value\":{}}\n").is_none());
        assert!(parse_envelope(b"not json\n").is_none());
        assert!(parse_envelope(b"").is_none());
    }

    #[test]
    fn an_out_of_range_exit_never_wraps_to_success() {
        for (raw, want) in [
            (json!(2), 2),
            (json!(255), 255),
            (json!(0), 1),
            (json!(-1), 1),
            (json!(256), 1),
            (json!(4_294_967_296_i64), 1),
            (json!(i64::MAX), 1),
            (json!("2"), 1),
            (Value::Null, 1),
        ] {
            assert_eq!(exit_code(&json!({ "exit": raw })), want, "{raw}");
        }
        assert_eq!(exit_code(&json!({})), 1);
    }
}
