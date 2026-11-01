//! Inline human decisions reuse D109's offered scopes and the existing approval.decide RPC. Tool/model text never enters here.
use super::{lang::Language, render};
use serde_json::Value;

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Answer {
    Once,
    Grant(String),
    Deny,
    Details,
}

fn grant_scope(record: &Value) -> Option<&str> {
    let options = record["grantOptions"].as_array()?;
    ["always", "session", "task"].into_iter().find(|scope| {
        options
            .iter()
            .any(|option| option["scope"].as_str() == Some(*scope))
    })
}
pub(super) fn answer(line: &str, record: &Value, interactive: bool) -> Option<Answer> {
    if !interactive {
        return Some(Answer::Deny);
    }
    match line.trim().to_ascii_lowercase().as_str() {
        "y" | "j" => Some(Answer::Once),
        "a" => grant_scope(record).map(|scope| Answer::Grant(scope.into())),
        "n" => Some(Answer::Deny),
        "?" => Some(Answer::Details),
        _ => None,
    }
}
pub(super) fn question(record: &Value, lang: Language) -> String {
    let grant = grant_scope(record)
        .map(|scope| format!("  [a] {} ({scope})", lang.text("grant", "Freigabe")))
        .unwrap_or_default();
    format!(
        "[y] {}{grant}  [n] {}  [?] {}",
        lang.text("once", "einmal"),
        lang.text("no", "nein"),
        lang.text("details", "Details")
    )
}
pub(super) fn preview(record: &Value, color: bool, lang: Language) -> String {
    let mut out = format!(
        "{}: {} · {} {}\n",
        lang.text("Approval", "Freigabe"),
        render::safe(
            record["tool"]
                .as_str()
                .unwrap_or_else(|| record["capability"].as_str().unwrap_or("?")),
            false
        ),
        lang.text("risk", "Risiko"),
        render::safe(record["risk"].as_str().unwrap_or("?"), false)
    );
    for target in record["targets"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        out.push_str(&render::safe(target, false));
        out.push('\n');
    }
    if let Some(summary) = record["summary"].as_str() {
        out.push_str(&render::safe(summary, true));
        out.push('\n');
    }
    if let Some(patch) = record["diff"].as_str() {
        out.push_str(lang.text(
            "Diff preview (unverified):\n",
            "Diff-Vorschau (ungeprüft):\n",
        ));
        out.push_str(&render::diff(patch, color, None, lang));
    }
    out
}

pub(super) fn details(record: &Value, color: bool, lang: Language) -> String {
    let mut out = preview(record, color, lang);
    if let Some(reason) = record["agentReason"].as_str() {
        out.push_str(lang.text(
            "Agent explanation (unverified): ",
            "Erklärung des Agenten (ungeprüft): ",
        ));
        out.push_str(&render::safe(reason, true));
        out.push('\n');
    }
    for (field, en, de) in [
        ("id", "Request", "Anfrage"),
        ("capability", "Capability", "Fähigkeit"),
        ("expiresAt", "Expires", "Gültig bis"),
    ] {
        if let Some(value) = record[field].as_str() {
            out.push_str(&format!(
                "{}: {}\n",
                lang.text(en, de),
                render::safe(value, false)
            ));
        }
    }
    out.push_str(&question(record, lang));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn scripted_tty_answers_respect_offered_caps_and_a_pipe_always_denies() {
        let capped = json!({"grantOptions":[{"scope":"once"},{"scope":"task"}]});
        assert_eq!(answer("y", &capped, true), Some(Answer::Once));
        assert_eq!(
            answer("a", &capped, true),
            Some(Answer::Grant("task".into()))
        );
        assert_eq!(answer("n", &capped, true), Some(Answer::Deny));
        assert_eq!(answer("?", &capped, true), Some(Answer::Details));
        assert_eq!(answer("y", &capped, false), Some(Answer::Deny));
        assert_eq!(answer("a", &capped, false), Some(Answer::Deny));
        assert_eq!(answer("please run tests", &capped, true), None);
        assert_eq!(answer("a", &json!({"grantOptions":[]}), true), None);
        assert!(!question(&capped, Language(false)).contains("always"));
    }
    #[test]
    fn approval_preview_cannot_control_the_terminal_or_print_a_nonce() {
        let record = json!({"tool":"file.write\u{1b}[2J","targets":["/tmp/a\u{202e}"],"risk":"high", "nonce":"private", "diff":"+ok\n-no"});
        let shown = preview(&record, false, Language(false));
        assert!(
            !shown.contains('\x1b') && !shown.contains('\u{202e}') && !shown.contains("private")
        );
        assert!(shown.contains("+ok") && shown.contains("-no"));
    }
}
