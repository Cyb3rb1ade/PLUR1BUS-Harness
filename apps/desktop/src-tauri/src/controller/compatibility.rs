//! Read-only detection of the provisional cold-upgrade CLI contract. No compatibility
//! translation is attempted: the owning harness must actually supply these commands.
use super::{CtlError, Installed};
use crate::runtime::Runtime;
use std::time::Duration;
const HELP_LIMIT: usize = 64 * 1024;
fn section_lines<'a>(help: &'a str, section: &'static str) -> impl Iterator<Item = &'a str> {
    let mut active = false;
    help.lines().filter(move |line| {
        let trimmed = line.trim();
        if trimmed == section {
            active = true;
            return false;
        }
        if active && !line.starts_with(char::is_whitespace) && !trimmed.is_empty() {
            active = false;
        }
        active && !trimmed.is_empty()
    })
}
pub fn has_command(help: &str, command: &str) -> bool {
    section_lines(help, "Commands:").any(|line| line.split_whitespace().next() == Some(command))
}
pub fn has_option(help: &str, option: &str) -> bool {
    section_lines(help, "Options:").any(|line| {
        line.split_whitespace()
            .take_while(|part| {
                part.starts_with('-') || part.starts_with('<') || part.starts_with('[')
            })
            .any(|part| part.trim_end_matches(',') == option)
    })
}
async fn help(runtime: &dyn Runtime, i: &Installed, argv: &[&str]) -> Result<String, CtlError> {
    let output = runtime
        .exec(&i.container, argv, None, Duration::from_secs(10))
        .await?;
    if output.code != 0 || output.stdout.len() > HELP_LIMIT {
        return Err(CtlError::MissingContract("help"));
    }
    String::from_utf8(output.stdout).map_err(|_| CtlError::MissingContract("help"))
}
pub async fn require_upgrade(runtime: &dyn Runtime, i: &Installed) -> Result<(), CtlError> {
    let state = runtime.state(&i.container).await?;
    if !state.exists
        || !state.running
        || state.labels.get("app.plur1bus.role").map(String::as_str) != Some("harness")
        || state.labels.get("app.plur1bus.image.digest") != Some(&i.image_digest)
    {
        return Err(CtlError::Health);
    }
    let root = help(runtime, i, &["plur1bus", "--help"]).await?;
    for command in ["state", "admin"] {
        if !has_command(&root, command) {
            return Err(CtlError::MissingContract(command));
        }
    }
    let state = help(runtime, i, &["plur1bus", "state", "--help"]).await?;
    for command in ["snapshot", "verify", "restore"] {
        if !has_command(&state, command) {
            return Err(CtlError::MissingContract(command));
        }
    }
    let admin = help(runtime, i, &["plur1bus", "admin", "--help"]).await?;
    for command in ["migrate", "smoke"] {
        if !has_command(&admin, command) {
            return Err(CtlError::MissingContract(command));
        }
    }
    for (argv, options) in [
        (
            vec!["plur1bus", "state", "snapshot", "--help"],
            vec!["--src", "--dst", "--json"],
        ),
        (
            vec!["plur1bus", "state", "verify", "--help"],
            vec!["--dir", "--json"],
        ),
        (
            vec!["plur1bus", "state", "restore", "--help"],
            vec!["--src", "--dst", "--json"],
        ),
        (
            vec!["plur1bus", "admin", "migrate", "--help"],
            vec!["--from", "--to", "--yes", "--json"],
        ),
        (vec!["plur1bus", "admin", "smoke", "--help"], vec!["--json"]),
    ] {
        let text = help(runtime, i, &argv).await?;
        for option in options {
            if !has_option(&text, option) {
                return Err(CtlError::MissingContract(option));
            }
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_clap_tables_only_not_prose_substrings_or_options() {
        let real="Usage: plur1bus [OPTIONS] <COMMAND>\n\nCommands:\n  backup  Backup and restore state snapshot verify restore\n  admin   Administration\n\nOptions:\n  --state <PATH>  State directory\n";
        assert!(!has_command(real, "state"));
        assert!(has_command(real, "backup"));
        assert!(!has_command(real, "snapshot"));
        assert!(!has_command(
            "Commands:\n  snapshot-unsafe  Other\n",
            "snapshot"
        ));
        assert!(has_option(
            "Options:\n  -s, --src <PATH>  Source\n",
            "--src"
        ));
        assert!(!has_option(
            "Options:\n  --other <PATH>  Description mentions --src\n",
            "--src"
        ));
    }
}
