//! Pure line presentation. Human output neutralizes control/bidi characters; JSON retains every raw RPC value.
use serde_json::{json, Value};

fn bidi(c: char) -> bool {
    matches!(c, '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
}

pub(super) fn safe(text: &str, multiline: bool) -> String {
    let mut out = String::new();
    for c in text.chars() {
        if bidi(c) || (c.is_control() && !(multiline && matches!(c, '\n' | '\t'))) {
            out.push_str(&format!("\\u{{{:04x}}}", c as u32));
        } else {
            out.push(c);
        }
    }
    out
}

pub(super) fn json_event(raw: &Value) -> Result<String, serde_json::Error> {
    let mut document = if raw.is_object() {
        raw.clone()
    } else {
        json!({"event":raw})
    };
    document["schema"] = json!("code.event/1");
    let json = serde_json::to_string(&document)?;
    let mut escaped = String::with_capacity(json.len());
    for c in json.chars() {
        if bidi(c) {
            escaped.push_str(&format!("\\u{:04x}", c as u32));
        } else {
            escaped.push(c);
        }
    }
    Ok(escaped)
}

pub(super) fn diff(
    patch: &str,
    color: bool,
    call: Option<&str>,
    lang: super::lang::Language,
) -> String {
    let lines: Vec<&str> = patch.lines().collect();
    let mut out = String::new();
    for line in lines
        .iter()
        .take(if call.is_some() { 40 } else { usize::MAX })
    {
        let line = safe(line, false);
        // clap re-exports its existing anstyle types; no second colour dependency is needed.
        use clap::builder::styling::AnsiColor;
        let tint = if line.starts_with('+') {
            Some(AnsiColor::Green.on_default())
        } else if line.starts_with('-') {
            Some(AnsiColor::Red.on_default())
        } else {
            None
        };
        if let Some(style) = tint.filter(|_| color) {
            out.push_str(&format!("{style}{line}{style:#}"));
        } else {
            out.push_str(&line);
        }
        out.push('\n');
    }
    if let Some(call) = call.filter(|_| lines.len() > 40) {
        out.push_str(&format!(
            "… {} {}: /diff {}\n",
            lines.len() - 40,
            lang.text("more lines", "weitere Zeilen"),
            safe(call, false)
        ));
    }
    out
}

/// Keep envelopes compact; a legacy file/tool body is never dumped merely because the core returned one.
pub(super) fn tool_result(
    output: &str,
    call: &str,
    color: bool,
    lang: super::lang::Language,
) -> String {
    let Ok(raw) = serde_json::from_str::<Value>(output) else {
        return String::new();
    };
    let value = raw.get("value").unwrap_or(&raw);
    let mut out = String::new();
    for field in ["summary", "essence"] {
        if let Some(text) = value[field].as_str() {
            out.push_str(&safe(text, true));
            out.push('\n');
        }
    }
    if let Some(patch) = value["diff"]
        .as_str()
        .or_else(|| value["unifiedDiff"].as_str())
    {
        out.push_str(&diff(patch, color, Some(call), lang));
    }
    if raw["isError"].as_bool() == Some(true) {
        out.push_str(lang.text("Tool failed: ", "Werkzeug fehlgeschlagen: "));
        out.push_str(&safe(
            raw["error"]["code"].as_str().unwrap_or("tool-failed"),
            false,
        ));
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn untrusted_terminal_controls_are_visible_text_and_plain_text_stays_intact() {
        let text = safe("hello\x1b[2J\r\x07\u{202e} world 🧩\n", true);
        assert!(
            !text.contains('\x1b')
                && !text.contains('\r')
                && !text.contains('\x07')
                && !text.contains('\u{202e}')
        );
        assert!(text.contains("hello") && text.contains("world 🧩\n"));
    }
    #[test]
    fn diff_folding_keeps_forty_lines_and_the_full_call_remains_addressable() {
        let patch = (0..60)
            .map(|n| format!("+line {n}"))
            .collect::<Vec<_>>()
            .join("\n");
        let shown = diff(
            &patch,
            false,
            Some("call-1"),
            super::super::lang::Language(false),
        );
        assert!(shown.contains("+line 39"));
        assert!(!shown.contains("+line 40"));
        assert!(shown.contains("/diff call-1"));
        assert!(!shown.contains('\x1b'));
    }
    #[test]
    fn json_events_keep_unknown_fields_and_escape_bidi_without_changing_values() {
        let raw =
            json!({"method":"session.event","params":{"future":{"text":"\u{202e}"},"number":7}});
        let encoded = json_event(&raw).expect("object event");
        assert!(!encoded.contains('\u{202e}'));
        let mut decoded: Value = serde_json::from_str(&encoded).expect("JSON");
        assert_eq!(decoded["schema"], "code.event/1");
        decoded.as_object_mut().expect("object").remove("schema");
        assert_eq!(decoded, raw);
    }
}
