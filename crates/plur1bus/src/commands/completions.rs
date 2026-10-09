//! `plur1bus completions <shell>` and the hidden `plur1bus __manpages <dir>` (used by the release pipeline).

use crate::output::{self, Out};
use clap_complete::Shell;
use serde_json::json;
use std::path::{Path, PathBuf};

/// The completion script for `shell`, as text.
pub(crate) fn script(shell: Shell) -> String {
    let mut cmd = crate::cli::command();
    let mut buf = Vec::new();
    clap_complete::generate(shell, &mut cmd, "plur1bus", &mut buf);
    String::from_utf8_lossy(&buf).into_owned()
}

/// Prints the completion script for `shell` to stdout (`--json` does not apply: the output is the script).
pub fn run(shell: Shell) {
    output::say_raw(&script(shell));
}

/// Writes one manpage per command (the root and every visible subcommand, recursively) into `dir` and returns the
/// files, sorted. Names follow clap_mangen: `plur1bus.1`, `plur1bus-memory.1`, `plur1bus-memory-add.1`.
pub(crate) fn write_manpages(dir: &Path) -> std::io::Result<Vec<PathBuf>> {
    std::fs::create_dir_all(dir)?;
    let cmd = crate::cli::command();
    clap_mangen::generate_to(cmd, dir)?;
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "1"))
        .collect();
    files.sort();
    Ok(files)
}

/// `plur1bus __manpages <dir>`: prints the written files, one per line (or as a `manpages/1` document with `--json`).
pub fn manpages(out: &Out, dir: &Path) {
    match write_manpages(dir) {
        Ok(files) => {
            let names: Vec<String> = files.iter().map(|f| f.display().to_string()).collect();
            out.ok(
                "manpages/1",
                &json!({ "dir": dir.display().to_string(), "files": names }),
                || names.join("\n"),
            );
        }
        Err(e) => out.fail(
            "E_INTERNAL",
            &format!("cannot write manpages to {}: {e}", dir.display()),
            json!({ "reason": "io" }),
            1,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every non-hidden command path of the tree, the root included (as the empty path).
    fn visible_paths(cmd: &clap::Command, prefix: &str, acc: &mut Vec<String>) {
        acc.push(prefix.to_string());
        for sc in cmd.get_subcommands().filter(|s| !s.is_hide_set()) {
            let p = if prefix.is_empty() {
                sc.get_name().to_string()
            } else {
                format!("{prefix}-{}", sc.get_name())
            };
            visible_paths(sc, &p, acc);
        }
    }

    #[test]
    fn every_shell_prints_a_script_that_names_known_subcommands() {
        for shell in [
            Shell::Bash,
            Shell::Zsh,
            Shell::Fish,
            Shell::PowerShell,
            Shell::Elvish,
        ] {
            let s = script(shell);
            assert!(!s.trim().is_empty(), "{shell} script is empty");
            for known in ["plur1bus", "memory", "daemon", "completions", "1staid"] {
                assert!(s.contains(known), "{shell} script lacks `{known}`");
            }
        }
    }

    #[test]
    fn manpages_are_written_once_per_command_and_are_not_empty() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("man");
        let files = write_manpages(&out).unwrap();
        let mut expected = Vec::new();
        visible_paths(&crate::cli::command(), "", &mut expected);
        let mut want: Vec<String> = expected
            .iter()
            .map(|p| {
                if p.is_empty() {
                    "plur1bus.1".to_string()
                } else {
                    format!("plur1bus-{p}.1")
                }
            })
            .collect();
        want.sort();
        let mut got: Vec<String> = files
            .iter()
            .map(|f| f.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        got.sort();
        assert_eq!(got, want);
        assert!(got.len() > 100, "sanity: the whole tree, saw {}", got.len());
        for f in &files {
            let text = std::fs::read_to_string(f).unwrap();
            assert!(!text.trim().is_empty(), "{} is empty", f.display());
            assert!(
                text.contains(".TH"),
                "{} is not a roff manpage",
                f.display()
            );
        }
    }
}
