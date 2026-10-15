//! The command surface of the `plur1bus` binary, checked for every command in the clap tree: `--help` answers with exit 0 and
//! agrees with `docs/cli.md`, an unknown option is a usage error (exit 2), `--json` prints one document without colour, an error
//! has the exit code `docs/errors.md` documents, and colour follows `--color` and `NO_COLOR`.
//!
//! The list of commands is not written here: it is read from the binary itself (`plur1bus __markdown`, the clap tree that also
//! generates `docs/cli.md`). `docs/cli.md` itself is checked against the generator by `docs_consistency.rs`; this file does not
//! touch the generator. Every run uses an empty temporary home and a cleared environment, so no real state is read or written.
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_plur1bus");

struct Out {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

/// Runs the binary in a cleared environment with `home` as every home directory. `extra_env` is added last.
fn run_in(home: &Path, args: &[&str], extra_env: &[(&str, &str)]) -> Out {
    let mut cmd = Command::new(BIN);
    cmd.args(args)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("XDG_CONFIG_HOME", home.join("xdg-config"))
        .env("XDG_DATA_HOME", home.join("xdg-data"))
        .env("XDG_STATE_HOME", home.join("xdg-state"))
        .env("XDG_CACHE_HOME", home.join("xdg-cache"))
        .env("TMPDIR", home)
        .env("TEMP", home)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in extra_env {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().expect("spawn plur1bus");
    let started = Instant::now();
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let t_out = std::thread::spawn(move || {
        let mut s = Vec::new();
        std::io::Read::read_to_end(&mut stdout, &mut s).ok();
        s
    });
    let t_err = std::thread::spawn(move || {
        let mut s = Vec::new();
        std::io::Read::read_to_end(&mut stderr, &mut s).ok();
        s
    });
    let status = loop {
        if let Some(s) = child.try_wait().unwrap() {
            break s;
        }
        if started.elapsed() > Duration::from_secs(60) {
            let _ = child.kill();
            panic!("`plur1bus {}` ran longer than 60 s", args.join(" "));
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    Out {
        code: status.code(),
        stdout: String::from_utf8_lossy(&t_out.join().unwrap()).into_owned(),
        stderr: String::from_utf8_lossy(&t_err.join().unwrap()).into_owned(),
    }
}

fn workspace() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

/// Runs with `--home <ws>/h`, which is where this process's state lives.
fn run(ws: &Path, args: &[&str]) -> Out {
    let home = ws.join("h");
    let mut full = vec!["--home", home.to_str().unwrap()];
    full.extend_from_slice(args);
    run_in(ws, &full, &[])
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// Every command path of the clap tree, from the binary: `["agent", "list"]`, `["1staid", "check"]`, …; the root is `[]`.
fn command_paths() -> Vec<Vec<String>> {
    let ws = workspace();
    let o = run_in(ws.path(), &["__markdown"], &[]);
    assert_eq!(o.code, Some(0));
    let mut paths: Vec<Vec<String>> = o
        .stdout
        .lines()
        .filter_map(|l| {
            l.strip_prefix("* [`plur1bus")
                .and_then(|r| r.split('`').next())
                .map(|p| p.split_whitespace().map(str::to_string).collect())
        })
        .collect();
    paths.sort();
    paths.dedup();
    assert!(paths.len() > 200, "{} command paths", paths.len());
    assert!(
        paths.contains(&vec![]) && paths.contains(&vec!["agent".to_string(), "list".to_string()])
    );
    paths
}

fn is_leaf(path: &[String], all: &[Vec<String>]) -> bool {
    !all.iter()
        .any(|p| p.len() == path.len() + 1 && p.starts_with(path))
}

fn words(path: &[String], tail: &[&str]) -> Vec<String> {
    path.iter()
        .cloned()
        .chain(tail.iter().map(|s| s.to_string()))
        .collect()
}

fn run_words(ws: &Path, w: &[String]) -> Out {
    let refs: Vec<&str> = w.iter().map(String::as_str).collect();
    run(ws, &refs)
}

// ---------------------------------------------------------------------------------------------------------------------
// --help
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn every_command_answers_help_with_exit_0_a_usage_line_that_names_it_and_no_colour() {
    let ws = workspace();
    for path in command_paths() {
        for flag in ["--help", "-h"] {
            let o = run_words(ws.path(), &words(&path, &[flag]));
            let name = format!("plur1bus {}", path.join(" "));
            let name = name.trim().to_string();
            assert_eq!(o.code, Some(0), "`{name} {flag}`: {}", o.stderr);
            assert!(
                o.stderr.is_empty(),
                "`{name} {flag}` wrote to stderr: {}",
                o.stderr
            );
            assert!(
                !o.stdout.contains('\u{1b}'),
                "`{name} {flag}` printed an escape sequence into a pipe"
            );
            let usage = o
                .stdout
                .lines()
                .find(|l| l.starts_with("Usage:"))
                .unwrap_or_else(|| panic!("`{name} {flag}` has no Usage line"));
            assert!(usage.contains(&name), "`{name} {flag}`: {usage}");
            assert!(
                o.stdout
                    .lines()
                    .next()
                    .is_some_and(|l| !l.trim().is_empty()),
                "`{name} {flag}` starts with an empty line"
            );
        }
    }
}

/// `docs/cli.md` split into sections: the command path → its text up to the next `## ` heading.
fn doc_sections() -> BTreeMap<String, String> {
    let text = std::fs::read_to_string(repo_root().join("docs/cli.md")).unwrap();
    let mut out = BTreeMap::new();
    let mut current: Option<(String, String)> = None;
    for line in text.lines() {
        if let Some(h) = line.strip_prefix("## `").and_then(|r| r.strip_suffix('`')) {
            if let Some((k, v)) = current.take() {
                out.insert(k, v);
            }
            current = Some((h.to_string(), String::new()));
        } else if let Some((_, v)) = current.as_mut() {
            v.push_str(line);
            v.push('\n');
        }
    }
    if let Some((k, v)) = current {
        out.insert(k, v);
    }
    out
}

/// The `--long` option names in `text` (a declaration such as `-s, --long <VALUE>` or `--api-key[=<X>]`), in order.
fn long_names(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 2 < bytes.len() {
        let boundary = i == 0 || !(bytes[i - 1].is_ascii_alphanumeric() || bytes[i - 1] == b'-');
        if boundary && &bytes[i..i + 2] == b"--" && bytes[i + 2].is_ascii_alphanumeric() {
            let mut j = i + 2;
            while j < bytes.len() && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'-') {
                j += 1;
            }
            out.push(text[i..j].to_string());
            i = j;
        } else {
            i += 1;
        }
    }
    out
}

/// The `--long` flags a `--help` text declares under Options. The root lists the global options itself; every other command carries
/// them implicitly and docs/cli.md leaves them out.
fn help_flags(help: &str, root: bool) -> BTreeSet<String> {
    let global: &[&str] = if root {
        &["--help", "--version"]
    } else {
        &["--home", "--json", "--color", "--help", "--version"]
    };
    let mut in_options = false;
    let mut flags = BTreeSet::new();
    for line in help.lines() {
        if line == "Options:" {
            in_options = true;
            continue;
        }
        if in_options && !line.starts_with(' ') && !line.is_empty() {
            in_options = false;
        }
        // A declaration is indented by two spaces (six when the short form is missing) and begins with a dash; descriptions are deeper.
        let trimmed = line.trim_start();
        let indent = line.len() - trimmed.len();
        if in_options && (indent == 2 || indent == 6) && trimmed.starts_with('-') {
            let declaration = trimmed.split("  ").next().unwrap();
            flags.extend(
                long_names(declaration)
                    .into_iter()
                    .filter(|f| !global.contains(&f.as_str())),
            );
        }
    }
    flags
}

/// The flags docs/cli.md lists for a command: the first backticked part of each bullet under Options.
fn doc_flags(section: &str) -> BTreeSet<String> {
    let mut flags = BTreeSet::new();
    let mut in_options = false;
    for line in section.lines() {
        if line.starts_with("###### **Options:**") {
            in_options = true;
            continue;
        }
        if line.starts_with("######") {
            in_options = false;
        }
        if in_options {
            if let Some(rest) = line.strip_prefix("* `") {
                // "`-o`, `--output <FILE>` — description": every backticked part before the dash is part of the declaration.
                let declaration = format!("`{rest}");
                let declaration = declaration.split(" — ").next().unwrap();
                flags.extend(long_names(declaration));
            }
        }
    }
    flags
}

#[test]
fn the_help_of_every_command_agrees_with_docs_cli_md_on_its_summary_usage_and_options() {
    let ws = workspace();
    let sections = doc_sections();
    let mut problems = Vec::new();
    let mut compared = 0;
    for path in command_paths() {
        let name = format!("plur1bus {}", path.join(" ")).trim().to_string();
        let Some(section) = sections.get(&name) else {
            problems.push(format!("docs/cli.md has no section for `{name}`"));
            continue;
        };
        let help = run_words(ws.path(), &words(&path, &["--help"])).stdout;
        compared += 1;
        let summary = help.lines().next().unwrap_or("").trim();
        if !section.contains(summary) {
            problems.push(format!(
                "`{name}`: the help starts with {summary:?}, which docs/cli.md lacks"
            ));
        }
        // docs/cli.md writes `[OPTIONS]` only for a command with options of its own; `--help` always lists the global ones.
        let usage = help
            .lines()
            .find(|l| l.starts_with("Usage: "))
            .unwrap()
            .trim_start_matches("Usage: ")
            .replace(" [OPTIONS]", "");
        let doc_usage = section
            .lines()
            .find(|l| l.starts_with("**Usage:**"))
            .map(|l| {
                l.trim_start_matches("**Usage:** ")
                    .trim_matches('`')
                    .replace(" [OPTIONS]", "")
            });
        if doc_usage.as_deref() != Some(usage.as_str()) {
            problems.push(format!(
                "`{name}`: usage {usage:?} differs from docs/cli.md's {doc_usage:?}"
            ));
        }
        let (h, d) = (help_flags(&help, path.is_empty()), doc_flags(section));
        if h != d {
            problems.push(format!(
                "`{name}`: options differ; only in --help: {:?}, only in docs/cli.md: {:?}",
                h.difference(&d).collect::<Vec<_>>(),
                d.difference(&h).collect::<Vec<_>>()
            ));
        }
    }
    assert!(compared > 200);
    assert!(
        problems.is_empty(),
        "{} problem(s):\n{}",
        problems.len(),
        problems.join("\n")
    );
}

// ---------------------------------------------------------------------------------------------------------------------
// usage errors
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn an_unknown_option_is_a_usage_error_with_exit_2_before_anything_runs_for_every_command() {
    let ws = workspace();
    for path in command_paths() {
        let name = format!("plur1bus {}", path.join(" ")).trim().to_string();
        let o = run_words(ws.path(), &words(&path, &["--zz-no-such-option"]));
        assert_eq!(
            o.code,
            Some(2),
            "`{name} --zz-no-such-option`: stdout {:?}, stderr {:?}",
            o.stdout,
            o.stderr
        );
        assert!(
            o.stdout.is_empty(),
            "`{name}`: a usage error wrote to stdout: {}",
            o.stdout
        );
        assert!(
            o.stderr.contains("unexpected argument") && o.stderr.contains("Usage:"),
            "`{name}`: {}",
            o.stderr
        );
        assert!(!o.stderr.contains('\u{1b}'), "`{name}`: colour in a pipe");
    }
    // Nothing was created by a refused command.
    assert!(!ws.path().join("h").exists());
}

#[test]
fn an_unknown_subcommand_and_a_missing_required_argument_are_usage_errors_too() {
    let ws = workspace();
    let o = run(ws.path(), &["zz-no-such-command"]);
    assert_eq!(o.code, Some(2));
    assert!(o.stderr.contains("unrecognized subcommand"), "{}", o.stderr);
    let o = run(ws.path(), &["agent", "zz-no-such-sub"]);
    assert_eq!(o.code, Some(2));
    let o = run(ws.path(), &["config", "set"]);
    assert_eq!(o.code, Some(2));
    assert!(o.stderr.contains("required arguments"), "{}", o.stderr);
    let o = run(ws.path(), &[]);
    assert_eq!(o.code, Some(2), "no command is a usage error");
    // With --json the usage error is still clap's plain text on stderr and nothing on stdout (the docs: before any command runs).
    let o = run(ws.path(), &["--json", "config", "set"]);
    assert_eq!((o.code, o.stdout.as_str()), (Some(2), ""));
}

#[test]
fn version_prints_one_line_and_exits_0() {
    let ws = workspace();
    let o = run(ws.path(), &["--version"]);
    assert_eq!(o.code, Some(0));
    assert_eq!(o.stdout.lines().count(), 1);
    assert!(o.stdout.starts_with("plur1bus "), "{}", o.stdout);
}

// ---------------------------------------------------------------------------------------------------------------------
// --json
// ---------------------------------------------------------------------------------------------------------------------

/// The leaf commands that only read and never reach the network or the operating system's service manager.
fn read_only_leaves(all: &[Vec<String>]) -> Vec<Vec<String>> {
    const VERBS: [&str; 9] = [
        "list", "ls", "status", "show", "get", "check", "schema", "graph", "notices",
    ];
    const NOT_HERE: [&str; 9] = [
        "update",
        "service",
        "container",
        "install",
        "setup",
        "login",
        "import",
        "uninstall",
        "core",
    ];
    all.iter()
        .filter(|p| is_leaf(p, all) && !p.is_empty())
        .filter(|p| VERBS.contains(&p.last().unwrap().as_str()))
        .filter(|p| !NOT_HERE.contains(&p[0].as_str()))
        // `daemon status` only reads the run files; the other daemon verbs start and stop processes.
        .filter(|p| p[0] != "daemon" || p[1] == "status")
        .cloned()
        .collect()
}

fn json_documents(s: &str) -> Vec<Value> {
    serde_json::Deserializer::from_str(s)
        .into_iter::<Value>()
        .map(|v| v.expect("stdout holds only JSON"))
        .collect()
}

#[test]
fn json_output_is_one_document_with_a_schema_no_colour_and_nothing_else_on_stdout() {
    let ws = workspace();
    let all = command_paths();
    let leaves = read_only_leaves(&all);
    assert!(leaves.len() > 25, "{} read-only leaves", leaves.len());
    let (mut documents, mut skipped) = (0, 0);
    for path in leaves {
        let name = path.join(" ");
        for colour in [vec!["--json"], vec!["--json", "--color", "always"]] {
            let mut w = path.clone();
            w.extend(colour.iter().map(|s| s.to_string()));
            let o = run_words(ws.path(), &w);
            if o.code == Some(2) && o.stdout.is_empty() {
                skipped += 1; // it needs arguments this sweep does not know: a usage error, covered above
                continue;
            }
            assert!(
                !o.stdout.contains('\u{1b}'),
                "`{name} {colour:?}`: colour in JSON on stdout"
            );
            assert!(
                !o.stderr.contains('\u{1b}') || colour.contains(&"always"),
                "`{name}`: colour on stderr in a pipe"
            );
            let docs = json_documents(&o.stdout);
            assert_eq!(
                docs.len(),
                1,
                "`{name} {colour:?}`: {} documents on stdout: {:?}",
                docs.len(),
                o.stdout
            );
            assert!(
                docs[0]["schema"].is_string(),
                "`{name}`: no schema id in {}",
                docs[0]
            );
            assert!(
                o.stdout.ends_with('\n') && !o.stdout.ends_with("\n\n"),
                "`{name}`: one trailing newline"
            );
            documents += 1;
        }
    }
    assert!(
        documents > 40,
        "{documents} documents ({skipped} skipped for missing arguments)"
    );
}

#[test]
fn json_errors_are_one_error_1_document_on_stdout_and_the_stderr_is_not_a_second_copy() {
    let ws = workspace();
    let o = run(ws.path(), &["--json", "agent", "status", "nobody"]);
    assert_eq!(o.code, Some(1));
    let docs = json_documents(&o.stdout);
    assert_eq!(docs.len(), 1);
    assert_eq!(docs[0]["schema"], "error/1");
    assert_eq!(docs[0]["error"], "E_AGENT_UNKNOWN");
    assert!(docs[0]["message"].as_str().is_some_and(|m| !m.is_empty()));
    assert!(
        o.stderr.is_empty(),
        "the error is on stdout under --json: {}",
        o.stderr
    );
}

// ---------------------------------------------------------------------------------------------------------------------
// exit codes
// ---------------------------------------------------------------------------------------------------------------------

/// `code → exit` from the table in docs/errors.md.
fn documented_exits() -> BTreeMap<String, u32> {
    let text = std::fs::read_to_string(repo_root().join("docs/errors.md")).unwrap();
    let section = text
        .split("## Error codes")
        .nth(1)
        .unwrap()
        .split("\n## ")
        .next()
        .unwrap()
        .to_string();
    section
        .lines()
        .filter_map(|l| {
            let cells: Vec<&str> = l.split('|').map(str::trim).collect();
            let code = cells.get(1)?.strip_prefix('`')?.strip_suffix('`')?;
            Some((code.to_string(), cells.get(2)?.parse().ok()?))
        })
        .collect()
}

#[test]
fn every_error_a_failing_command_prints_exits_with_the_code_docs_errors_md_documents() {
    let ws = workspace();
    // One registered agent, so the failures below are the ones under test and not "agent unknown".
    assert_eq!(
        run(ws.path(), &["--json", "agent", "create", "bernd"]).code,
        Some(0)
    );
    let missing = ws.path().join("no-such-archive.tgz");
    let missing = missing.to_str().unwrap();
    let battery: Vec<Vec<&str>> = vec![
        vec!["agent", "status", "nobody"],
        vec!["agent", "remove", "nobody"],
        vec!["memory", "list", "--agent", "bernd"],
        vec!["memory", "recall", "--agent", "nobody", "q"],
        vec!["session", "list"],
        vec!["channel", "list"],
        vec!["project", "list"],
        vec!["budget", "status"],
        vec!["audit", "verify"],
        vec!["secret", "status"],
        vec!["user", "ls"],
        vec!["backup", "verify", missing],
        vec!["import", "--detect", "openclaw"],
        vec!["config", "set", "core.logLevel", "loud"],
        vec!["config", "set", "zzUnknownKey", "1"],
    ];
    let exits = documented_exits();
    assert!(exits.len() >= 28, "{} documented codes", exits.len());
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for args in battery {
        let mut full = vec!["--json"];
        full.extend(args.iter().copied());
        let o = run(ws.path(), &full);
        let Some(code) = json_documents(&o.stdout)
            .first()
            .and_then(|d| d["error"].as_str().map(str::to_string))
        else {
            panic!(
                "`{}` printed no error document: exit {:?}, stdout {:?}, stderr {:?}",
                args.join(" "),
                o.code,
                o.stdout,
                o.stderr
            );
        };
        seen.insert(code.clone());
        let documented = exits.get(&code).unwrap_or_else(|| {
            panic!(
                "`{}` printed {code}, which docs/errors.md does not document",
                args.join(" ")
            )
        });
        // E_IMPORT_FAILED passes the importer's own exit code through, 1 when it names none (documented in the exit table).
        assert_eq!(
            o.code.map(|c| c as u32),
            Some(*documented),
            "`{}` printed {code}: exit {:?}, documented {documented}",
            args.join(" "),
            o.code
        );
    }
    assert!(seen.len() >= 5, "only {seen:?} were reached");
}

#[test]
fn the_exit_codes_in_the_table_are_the_ones_the_page_lists() {
    let exits = documented_exits();
    let allowed: BTreeSet<u32> = [1, 2, 3].into_iter().collect();
    for (code, exit) in &exits {
        assert!(
            allowed.contains(exit),
            "{code}: exit {exit} is not 1, 2 or 3"
        );
    }
    assert_eq!(exits["E_LOCKED"], 3);
    for refused in [
        "E_INVALID_PARAMS",
        "E_NOT_AVAILABLE",
        "E_APPROVAL_REQUIRED",
        "E_CANCELLED",
    ] {
        assert_eq!(exits[refused], 2, "{refused} is refused before any work");
    }
    assert!(exits
        .iter()
        .filter(|(c, _)| ![
            "E_LOCKED",
            "E_INVALID_PARAMS",
            "E_NOT_AVAILABLE",
            "E_APPROVAL_REQUIRED",
            "E_CANCELLED"
        ]
        .contains(&c.as_str()))
        .all(|(_, e)| *e == 1));
}

// ---------------------------------------------------------------------------------------------------------------------
// colour
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn colour_follows_color_and_no_color_for_the_error_line() {
    let ws = workspace();
    let home = ws.path().join("h");
    let h = home.to_str().unwrap();
    let args = |c: &[&'static str]| -> Vec<String> {
        let mut v: Vec<String> = vec!["--home".into(), h.into()];
        v.extend(c.iter().map(|s| s.to_string()));
        v.extend(["agent", "status", "nobody"].map(String::from));
        v
    };
    let go = |color: &[&'static str], env: &[(&str, &str)]| {
        let a = args(color);
        let refs: Vec<&str> = a.iter().map(String::as_str).collect();
        run_in(ws.path(), &refs, env)
    };
    // Into a pipe: never.
    let o = go(&[], &[]);
    assert_eq!(o.code, Some(1));
    assert!(
        o.stderr.starts_with("plur1bus: ") && !o.stderr.contains('\u{1b}'),
        "{:?}",
        o.stderr
    );
    assert!(o.stdout.is_empty());
    // `--color never` and `NO_COLOR`, whatever else is said.
    assert!(!go(&["--color", "never"], &[]).stderr.contains('\u{1b}'));
    assert!(!go(&["--color", "auto"], &[("NO_COLOR", "1")])
        .stderr
        .contains('\u{1b}'));
    // `--color always` colours even into a pipe, and even with `NO_COLOR` set (the flag's own help says so).
    let always = go(&["--color", "always"], &[]);
    assert!(always.stderr.contains("\u{1b}["), "{:?}", always.stderr);
    assert!(go(&["--color", "always"], &[("NO_COLOR", "1")])
        .stderr
        .contains("\u{1b}["));
    // An empty NO_COLOR does not count as set; into a pipe `auto` is still plain.
    assert!(!go(&["--color", "auto"], &[("NO_COLOR", "")])
        .stderr
        .contains('\u{1b}'));
    // Colour never reaches stdout, with or without --json.
    assert!(!always.stdout.contains('\u{1b}'));
    let a = vec![
        "--home", h, "--json", "--color", "always", "agent", "status", "nobody",
    ];
    let o = run_in(ws.path(), &a, &[]);
    assert!(
        !o.stdout.contains('\u{1b}') && !o.stderr.contains('\u{1b}'),
        "{o_out:?} {o_err:?}",
        o_out = o.stdout,
        o_err = o.stderr
    );
    // An unknown --color value is a usage error that lists the choices.
    let o = run(ws.path(), &["--color", "sometimes", "agent", "list"]);
    assert_eq!(o.code, Some(2));
    assert!(
        o.stderr.contains("auto") && o.stderr.contains("always") && o.stderr.contains("never"),
        "{}",
        o.stderr
    );
}

// ---------------------------------------------------------------------------------------------------------------------
// the exit code each call site passes, against the table
// ---------------------------------------------------------------------------------------------------------------------

/// One `.fail(..)` or `.fail_exit(..)` call in `crates/plur1bus/src`: the argument list split at its top-level commas.
struct FailCall {
    /// `commands/login.rs`, relative to `src`.
    file: String,
    /// `fail` or `fail_exit`.
    method: String,
    args: Vec<String>,
}

/// Every `.fail(` / `.fail_exit(` call in `crates/plur1bus/src` (the definitions have no leading dot).
fn fail_calls() -> Vec<FailCall> {
    fn rs_files(dir: &Path, out: &mut Vec<PathBuf>) {
        for e in std::fs::read_dir(dir).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                rs_files(&p, out);
            } else if p.extension().is_some_and(|x| x == "rs") {
                out.push(p);
            }
        }
    }
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rs_files(&src, &mut files);
    let mut calls = Vec::new();
    for f in files {
        let text = std::fs::read_to_string(&f).unwrap();
        let rel = f
            .strip_prefix(&src)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        for method in ["fail_exit", "fail"] {
            let needle = format!(".{method}(");
            let mut from = 0;
            while let Some(at) = text[from..].find(&needle) {
                let start = from + at + needle.len();
                from = start;
                // Split the argument list at its top-level commas (strings and brackets respected).
                let (mut depth, mut in_str, mut esc) = (1, false, false);
                let (mut args, mut cur) = (Vec::<String>::new(), String::new());
                for c in text[start..].chars() {
                    if in_str {
                        cur.push(c);
                        if esc {
                            esc = false;
                        } else if c == '\\' {
                            esc = true;
                        } else if c == '"' {
                            in_str = false;
                        }
                        continue;
                    }
                    match c {
                        '"' => {
                            in_str = true;
                            cur.push(c);
                        }
                        '(' | '[' | '{' => {
                            depth += 1;
                            cur.push(c);
                        }
                        ')' | ']' | '}' => {
                            depth -= 1;
                            if depth == 0 {
                                break;
                            }
                            cur.push(c);
                        }
                        ',' if depth == 1 => args.push(std::mem::take(&mut cur)),
                        _ => cur.push(c),
                    }
                }
                if !cur.trim().is_empty() {
                    args.push(cur);
                }
                // `.fail(` is also a prefix of nothing else here, but a foreign `.fail(x)` with another arity is not ours.
                let arity = if method == "fail" { 3 } else { 4 };
                if args.len() == arity || (method == "fail" && args.len() == 4) {
                    calls.push(FailCall {
                        file: rel.clone(),
                        method: method.to_string(),
                        args: args.iter().map(|a| a.trim().to_string()).collect(),
                    });
                }
            }
        }
    }
    calls
}

/// The code → exit mapping is written once (`output::exit_code_for`): `Out::fail` takes no exit code, so no call can pass a
/// literal one for a code in the table. The only calls that name an exit are `Out::fail_exit`, and each of them is listed here
/// with the reason: `login` (Ctrl-C, 130) and `import` (the importer's own exit code). Anything else fails this test.
#[test]
fn every_fail_call_takes_its_exit_code_from_the_table() {
    let calls = fail_calls();
    assert!(
        calls.iter().filter(|c| c.method == "fail").count() > 100,
        "{} Out::fail calls found",
        calls.len()
    );
    let documented = documented_exits();
    let mut bad = Vec::new();
    for c in &calls {
        let code = c.args[0].trim_matches('"').to_string();
        let literal_code = c.args[0].starts_with('"');
        if c.method == "fail" {
            if c.args.len() == 4 {
                bad.push(format!(
                    "{}: .fail({}, .., {}) passes an exit code; use .fail(code, message, extra)",
                    c.file, c.args[0], c.args[3]
                ));
            }
            continue;
        }
        // fail_exit
        let exit = &c.args[3];
        let allowed = (c.file == "commands/login.rs"
            && code == "E_CANCELLED"
            && exit == "crate::output::EXIT_INTERRUPTED")
            || (c.file == "commands/import.rs" && !literal_code && exit == "exit")
            || c.file == "output.rs"; // the forwarding inside `Out::fail` itself
        if !allowed {
            let in_table = literal_code && documented.contains_key(&code);
            bad.push(format!(
                "{}: .fail_exit({}, .., {exit}) is not one of the two allowed exits (login Ctrl-C, import){}",
                c.file,
                c.args[0],
                if in_table {
                    format!("; {code} is in the table, use .fail")
                } else {
                    String::new()
                }
            ));
        }
        if literal_code && exit.parse::<i32>().is_ok() && documented.contains_key(&code) {
            bad.push(format!(
                "{}: .fail_exit({code}, .., {exit}) hard-codes an exit for a code of the table",
                c.file
            ));
        }
    }
    assert!(bad.is_empty(), "{}", bad.join("\n"));
}

/// A prompt answered no is `E_CANCELLED` (exit 2) in every command, never `E_INVALID_PARAMS`; a damaged `media save` output
/// is `E_STORAGE` (exit 1), never `E_INVALID_PARAMS`.
#[test]
fn a_declined_prompt_is_e_cancelled_and_a_damaged_output_is_e_storage() {
    let calls = fail_calls();
    let mut seen = 0;
    for c in calls.iter().filter(|c| c.method == "fail") {
        let message = c.args[1].trim_matches('"');
        if ["not applied", "not reindexed"].contains(&message) {
            seen += 1;
            assert_eq!(c.args[0], "\"E_CANCELLED\"", "{}: {message}", c.file);
        }
        if ["invalid output range", "incomplete output"].contains(&message) {
            seen += 1;
            assert_eq!(c.args[0], "\"E_STORAGE\"", "{}: {message}", c.file);
        }
    }
    assert!(
        seen >= 8,
        "only {seen} of the prompts and output checks were found"
    );
}

/// The same rule seen from the outside: commands, run offline, whose `--json` error and exit code have to agree with the
/// table. Before the consistency wave `login` (E_INVALID_PARAMS → 2 but documented 1), `module start` and `update --rollback`
/// (E_NOT_AVAILABLE → 1 but documented 2) disagreed.
#[test]
fn login_module_start_and_update_rollback_exit_as_the_table_says() {
    let ws = workspace();
    let exits = documented_exits();
    let mut wrong = Vec::new();
    for args in [
        vec!["login"],
        vec!["login", "nonesuch"],
        vec!["module", "start", "nosuch"],
        vec!["update", "--rollback"],
        vec!["agent", "create", "Not A Valid Id"],
        vec!["config", "get", "no.such.key"],
        vec!["service", "install", "--env", "no-equals-sign"],
    ] {
        let mut full = vec!["--json"];
        full.extend(args.iter().copied());
        let o = run(ws.path(), &full);
        let code = json_documents(&o.stdout)[0]["error"]
            .as_str()
            .unwrap()
            .to_string();
        let documented = exits[&code] as i32;
        if o.code != Some(documented) {
            wrong.push(format!(
                "`{}` prints {code}: exit {:?}, documented {documented}",
                args.join(" "),
                o.code
            ));
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}
