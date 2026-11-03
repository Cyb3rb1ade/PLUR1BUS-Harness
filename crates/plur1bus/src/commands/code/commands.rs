//! Parse local coding commands without shell interpretation; transcript commands keep the original human text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Command {
    Help,
    Check(Option<String>),
    Diff(Option<String>),
    Done,
    Model(Vec<String>),
    Transcript(String),
    Steer(String),
    Queue(Option<String>),
    Unqueue(usize),
    Message(String),
}

pub(super) fn parse(line: &str) -> Result<Command, &'static str> {
    if !line.trim_start().starts_with('/') {
        return Ok(Command::Message(line.into()));
    }
    let line = line.trim();
    let mut parts = line.splitn(2, char::is_whitespace);
    let name = parts.next().unwrap_or_default();
    let rest = parts.next().unwrap_or_default().trim();
    let single = || {
        if rest.split_whitespace().count() <= 1 {
            Ok((!rest.is_empty()).then(|| rest.to_string()))
        } else {
            Err("one argument expected")
        }
    };
    match name {
        "/help" if rest.is_empty() => Ok(Command::Help),
        "/done" if rest.is_empty() => Ok(Command::Done),
        "/check" => {
            let kind = single()?;
            if kind
                .as_deref()
                .is_some_and(|s| !["format", "lint", "typecheck", "test"].contains(&s))
            {
                return Err("unknown check kind");
            }
            Ok(Command::Check(kind))
        }
        "/diff" => Ok(Command::Diff(single()?)),
        "/model" => Ok(Command::Model(
            rest.split_whitespace().map(str::to_string).collect(),
        )),
        "/rewind" | "/compact" => Ok(Command::Transcript(line.into())),
        "/steer" if !rest.is_empty() => Ok(Command::Steer(rest.into())),
        "/queue" => Ok(Command::Queue((!rest.is_empty()).then(|| rest.to_string()))),
        "/unqueue" => rest
            .parse::<usize>()
            .ok()
            .filter(|n| *n > 0)
            .map(Command::Unqueue)
            .ok_or("positive queue position expected"),
        _ => Err("unknown command or invalid arguments; use /help"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn commands_do_not_send_unknown_or_malformed_management_text_to_the_model() {
        assert_eq!(
            parse("/check test").ok(),
            Some(Command::Check(Some("test".into())))
        );
        assert_eq!(
            parse("/rewind last --lesson \"keep spacing\"").ok(),
            Some(Command::Transcript(
                "/rewind last --lesson \"keep spacing\"".into()
            ))
        );
        assert_eq!(parse("/queue").ok(), Some(Command::Queue(None)));
        assert!(parse("/unqueue 0").is_err());
        assert!(parse("/check shell-command").is_err());
        assert!(parse("/unknown destructive command").is_err());
        assert!(parse("/done extra").is_err());
        assert_eq!(
            parse("  keep this indentation\n  and trailing spaces  ").ok(),
            Some(Command::Message(
                "  keep this indentation\n  and trailing spaces  ".into()
            ))
        );
    }
}
