//! Examples in every command's long help (`--help`, the manpages).
//!
//! A command that carries its own `Examples:` block in its definition keeps it. Every other command gets one here:
//! a curated one for the commands people start with, otherwise one derived from the clap definition itself (the
//! required arguments become placeholders), so it cannot name a flag the command does not have.

use clap::{Arg, Command};

/// Curated examples by command path (space-joined, without the binary name).
const CURATED: &[(&str, &[&str])] = &[
    (
        "",
        &[
            "plur1bus setup",
            "plur1bus daemon status",
            "plur1bus memory recall --agent main \"what did we decide about backups\"",
            "plur1bus --json agent list",
            "plur1bus completions bash",
        ],
    ),
    (
        "setup",
        &[
            "plur1bus setup",
            "plur1bus setup --non-interactive --no-service",
            "plur1bus setup --profile host --channel beta",
        ],
    ),
    (
        "memory add",
        &[
            "plur1bus memory add --agent main \"The staging database moved to host db2\"",
            "plur1bus --json memory add --agent main --session work \"Release is on Friday\"",
        ],
    ),
    (
        "memory recall",
        &[
            "plur1bus memory recall --agent main \"staging database\"",
            "plur1bus --json memory recall --agent main --joined \"release date\"",
        ],
    ),
    (
        "chat",
        &[
            "plur1bus chat --agent main \"Summarise what I did yesterday\"",
            "plur1bus chat --no-memory",
            "echo \"hello\" | plur1bus chat --agent main",
        ],
    ),
    (
        "update",
        &[
            "plur1bus update --check",
            "plur1bus update",
            "plur1bus update --rollback",
        ],
    ),
];

/// Whether `cmd`'s help already shows an example.
fn has_examples(cmd: &Command) -> bool {
    [cmd.get_after_long_help(), cmd.get_after_help()]
        .into_iter()
        .flatten()
        .any(|t| t.to_string().to_lowercase().contains("example"))
}

fn placeholder(arg: &Arg) -> String {
    if let Some(first) = arg
        .get_possible_values()
        .into_iter()
        .find(|v| !v.is_hide_set())
    {
        return first.get_name().to_string();
    }
    match arg.get_value_names().and_then(|n| n.first()) {
        Some(n) => format!(
            "<{}>",
            n.to_string().trim_matches(['<', '>']).to_uppercase()
        ),
        None => format!(
            "<{}>",
            arg.get_id().as_str().to_uppercase().replace('_', "-")
        ),
    }
}

/// `plur1bus <path> <required flags> <required positionals>` from the clap definition.
fn synthesized_invocation(cmd: &Command, path: &str) -> String {
    let mut line = format!("plur1bus {path}");
    let required = |a: &&Arg| {
        a.is_required_set()
            && !a.is_global_set()
            && !matches!(a.get_id().as_str(), "help" | "version")
    };
    for a in cmd
        .get_arguments()
        .filter(required)
        .filter(|a| !a.is_positional())
    {
        let flag = a
            .get_long()
            .map(|l| format!("--{l}"))
            .unwrap_or_else(|| format!("-{}", a.get_short().unwrap_or('?')));
        line.push(' ');
        line.push_str(&flag);
        if a.get_action().takes_values() {
            line.push(' ');
            line.push_str(&placeholder(a));
        }
    }
    for a in cmd
        .get_arguments()
        .filter(required)
        .filter(|a| a.is_positional())
    {
        line.push(' ');
        line.push_str(&placeholder(a));
    }
    line
}

fn examples_for(cmd: &Command, path: &str) -> Vec<String> {
    if let Some((_, lines)) = CURATED.iter().find(|(p, _)| *p == path) {
        return lines.iter().map(|l| (*l).to_string()).collect();
    }
    let prefix = if path.is_empty() {
        String::new()
    } else {
        format!("{path} ")
    };
    if let Some(sub) = cmd.get_subcommands().find(|s| !s.is_hide_set()) {
        return vec![
            format!("plur1bus {prefix}--help"),
            format!("plur1bus {prefix}{} --help", sub.get_name()),
        ];
    }
    let base = synthesized_invocation(cmd, path);
    vec![base.clone(), format!("{base} --json")]
}

fn decorate_at(cmd: Command, path: &str) -> Command {
    let parent = path.to_string();
    let mut cmd = cmd.mut_subcommands(|sc| {
        let child = if parent.is_empty() {
            sc.get_name().to_string()
        } else {
            format!("{parent} {}", sc.get_name())
        };
        decorate_at(sc, &child)
    });
    if has_examples(&cmd) {
        return cmd;
    }
    let lines = examples_for(&cmd, path);
    let mut text = String::from("Examples:");
    for l in lines {
        text.push_str("\n  ");
        text.push_str(&l);
    }
    cmd = cmd.after_long_help(text);
    cmd
}

/// Gives every command in the tree (the root included) an `Examples:` block in its long help.
pub(crate) fn decorate(root: Command) -> Command {
    decorate_at(root, "")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn visit(cmd: &Command, path: &str, f: &mut dyn FnMut(&Command, &str)) {
        f(cmd, path);
        for sc in cmd.get_subcommands() {
            let p = if path.is_empty() {
                sc.get_name().to_string()
            } else {
                format!("{path} {}", sc.get_name())
            };
            visit(sc, &p, f);
        }
    }

    #[test]
    fn every_command_has_an_example_in_its_long_help() {
        let root = crate::cli::command();
        let mut n = 0;
        visit(&root, "", &mut |c, path| {
            n += 1;
            let long = c.clone().render_long_help().to_string();
            assert!(
                long.contains("Examples:") && long.contains("plur1bus"),
                "`plur1bus {path}` has no example in its long help"
            );
        });
        assert!(n > 100, "sanity: expected the whole tree, saw {n}");
    }

    #[test]
    fn every_command_renders_short_and_long_help_without_panic() {
        let root = crate::cli::command();
        visit(&root, "", &mut |c, path| {
            let mut c = c.clone();
            assert!(
                !c.render_help().to_string().is_empty(),
                "short help of `{path}`"
            );
            assert!(
                !c.render_long_help().to_string().is_empty(),
                "long help of `{path}`"
            );
        });
    }

    #[test]
    fn curated_examples_name_real_commands_and_flags() {
        let root = crate::cli::command();
        for (path, lines) in CURATED {
            assert!(!lines.is_empty(), "`{path}` has no examples");
            for l in *lines {
                // Walk the words after `plur1bus` down the command tree; the first word that is not a subcommand
                // (a quoted value, a pipe) ends the command path.
                let mut cmd = &root;
                for tok in l
                    .split_whitespace()
                    .skip_while(|t| *t != "plur1bus")
                    .skip(1)
                {
                    if tok.starts_with('-') {
                        continue;
                    }
                    match cmd.find_subcommand(tok) {
                        Some(sc) => cmd = sc,
                        None => break,
                    }
                }
                for tok in l.split_whitespace().filter(|t| t.starts_with("--")) {
                    let flag = tok.trim_start_matches("--");
                    let known = cmd.get_arguments().any(|a| a.get_long() == Some(flag))
                        || root.get_arguments().any(|a| a.get_long() == Some(flag));
                    assert!(
                        known,
                        "`{l}` uses --{flag}, which is not a flag of `{}`",
                        cmd.get_name()
                    );
                }
            }
        }
    }

    #[test]
    fn synthesized_example_uses_required_arguments() {
        let root = crate::cli::command();
        let add = root.find_subcommand("agent").unwrap();
        let text = examples_for(add, "agent");
        assert_eq!(text[0], "plur1bus agent --help");
        let leaf = Command::new("x")
            .arg(Arg::new("name").long("name").required(true))
            .arg(Arg::new("file").required(true));
        assert_eq!(
            synthesized_invocation(&leaf, "demo x"),
            "plur1bus demo x --name <NAME> <FILE>"
        );
    }
}
