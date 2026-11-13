//! Content-free verdicts for model-generated persona markers and dreams (S6/S7).
use std::sync::OnceLock;

use crate::text::js::{js_regex, js_trim, utf16_len, JsRegex, JsRegexError};

type Patterns = Vec<(&'static str, JsRegex)>;

const PERSONA_STRUCTURE: &[(&str, &str, &str)] = &[
    ("structure", r#"[\r\n\u2028\u2029]"#, ""),
    ("structure", r#"<!--|-->"#, ""),
    ("structure", r#"persona:(?:begin|end|seed-end)"#, "i"),
    ("structure", r#"<[/!?|a-z]"#, "i"),
    ("structure", r#"```|~~~"#, ""),
];

const PERSONA_URL: &[(&str, &str, &str)] = &[
    (
        "url",
        r#"\b(?:https?|ftp|ftps|file|data|javascript|ssh|wss?):"#,
        "i",
    ),
    ("url", r#"\bwww\."#, "i"),
    ("url", r#"[^\s@]+@[^\s@]+\.[a-z]{2,}"#, "i"),
    (
        "url",
        r#"\b[a-z0-9-]{2,}\.(?:com|net|org|io|de|ru|cn|xyz|info|biz|app|dev|ly|me|co|tk|top)\b"#,
        "i",
    ),
];

const PERSONA_SECRET: &[(&str, &str, &str)] = &[
    (
        "secret",
        r#"\b(?:api[_ -]?key|apikey|secret|token|passwor[dt]|passwd|kennwort|bearer|credential\w*|zugangsdaten)\s*[:=]\s*\S+"#,
        "i",
    ),
    ("secret", r#"\bsk-[A-Za-z0-9_-]{16,}"#, ""),
    (
        "secret",
        r#"\b(?:ghp|gho|ghs|ghu|github_pat|glpat|xox[abprs]|AKIA|ASIA|AIza)[A-Za-z0-9_-]{10,}"#,
        "",
    ),
    ("secret", r#"\bbearer\s+\S{8,}"#, "i"),
    ("secret", r#"\beyJ[A-Za-z0-9_-]{10,}\."#, ""),
    ("secret", r#"-----BEGIN [A-Z ]*(?:KEY|CERTIFICATE)"#, ""),
    (
        "secret",
        r#"\b(?=[A-Za-z0-9+/_=-]*\d)[A-Za-z0-9+/_=-]{32,}\b"#,
        "",
    ),
];

const PERSONA_ROLE: &[(&str, &str, &str)] = &[
    (
        "role_override",
        r#"\bignor\w*\s+(?:\S+\s+){0,4}(?:anweisung|vorgabe|regel|instruction|prompt|richtlinie|rules?|guidelines?|direktive|directive)"#,
        "i",
    ),
    (
        "role_override",
        r#"\b(?:disregard|forget|vergiss|vergessen)\s+(?:\S+\s+){0,4}(?:anweisung|vorgabe|regel|instruction|prompt|richtlinie|rules?|guidelines?|direktive|directive|bisherig|previous|above|obige)"#,
        "i",
    ),
    ("role_override", r#"\bdisregard\b"#, "i"),
    (
        "role_override",
        r#"system[\s_-]?(?:prompt|message|nachricht|anweisung|instruction)"#,
        "i",
    ),
    (
        "role_override",
        r#"\b(?:developer|entwickler|debug|god|admin)[\s-]?(?:mode|modus)\b"#,
        "i",
    ),
    ("role_override", r#"\bjailbreak|\bDAN\b"#, ""),
    (
        "role_override",
        r#"\b(?:von nun an|from now on|ab sofort gilt|new instructions?|neue anweisung\w*)\b"#,
        "i",
    ),
    (
        "role_override",
        r#"\bdu bist (?:jetzt|nun|ab sofort|nicht mehr)\b|\byou are (?:now|no longer)\b"#,
        "i",
    ),
    (
        "role_override",
        r#"\b(?:verhalte dich (?:als|wie)|act as|pretend|roleplay|rollenspiel|spiel(?:e)? die rolle|übernimm die rolle|behave (?:as|like)|impersonate|gib dich aus als)\b"#,
        "i",
    ),
    (
        "role_override",
        r#"\b(?:deaktivier\w*|umgeh\w*|ausschalt\w*|disable|bypass|circumvent|override|überschreib\w*|ignorier\w*)\s+(?:\S+\s+){0,3}(?:sicherheit\w*|safety|filter\w*|guardrail\w*|schutz\w*|regel\w*|restriction\w*|beschränkung\w*|einschränkung\w*|policy|policies|richtlinie\w*)"#,
        "i",
    ),
    (
        "role_override",
        r#"\bsicherheits(?:regel|anweisung|vorgabe|richtlinie|hinweis|filter|mechanism)\w*|\bsafety (?:rules?|guidelines?|filters?|instructions?|policies|policy)\b|\bguardrails?\b"#,
        "i",
    ),
    (
        "role_override",
        r#"\bohne (?:jede\w*\s+|jegliche\w*\s+)?(?:einschränkung|filter|regel|zensur|rücksicht|bestätigung|rückfrage)"#,
        "i",
    ),
    (
        "role_override",
        r#"\b(?:verrate|reveal|leak|offenbare|gib\b.{0,20}\bpreis)\b.{0,40}\b(?:prompt|anweisung|instruction|regeln|rules)"#,
        "i",
    ),
    (
        "role_override",
        r#"\b(?:du musst|you must|always obey|gehorche|befolge immer|folge immer)\b"#,
        "i",
    ),
];

const PERSONA_TOOL: &[(&str, &str, &str)] = &[
    (
        "tool_directive",
        r#"\btools?\b|\bwerkzeug\w*|\bmemory_[a-z_]+|\bfunction[\s_-]?calls?\b|\bplur1bus\b|\bmcp\b"#,
        "i",
    ),
    (
        "tool_directive",
        r#"\b(?:shell|bash|powershell|sudo|exec\w*|eval|curl|wget|chmod|rm -rf)\b"#,
        "i",
    ),
    (
        "tool_directive",
        r#"\b(?:berechtigung\w*|permissions?|privileg\w*|admin\w*|root|owner|operator\w*|erlaubnis|zugriffsrecht\w*|access rights?|rechte)\b"#,
        "i",
    ),
    (
        "tool_directive",
        r#"\b(?:grant|gewähr\w*|erteil\w*|verleih\w*|elevate)\b"#,
        "i",
    ),
    (
        "tool_directive",
        r#"\b(?:lösch\w*|delete|remove|wipe|purge|forget|vergiss|entferne)\b.{0,40}\b(?:erinnerung\w*|memor\w*|dateien|files?|alles|all|daten|data)\b"#,
        "i",
    ),
    (
        "tool_directive",
        r#"\b(?:sende|schick\w*|send|forward|leite?\w*|exfiltrat\w*|upload\w*)\b.{0,40}\b(?:an|to)\s+(?:\S+@|\S+\.\S+)"#,
        "i",
    ),
];

const DREAM: &[(&str, &str, &str)] = &[
    (
        "structure",
        r#"<\|[^>]*\|>|</?(?:system|assistant|developer|tool|evidence)\b|<!--|```"#,
        "i",
    ),
    (
        "role_directive",
        r#"(?:^|\n)\s*(?:system|developer|assistant|tool)\s*:|\b(?:ignore|disregard|forget|ignorier\w*|vergiss)\b[^.\n]{0,70}\b(?:instructions?|prompts?|rules?|anweisungen?|regeln?|richtlinien?)\b|\b(?:system|developer)[ _-]?(?:prompt|message|instruction)|\b(?:admin|developer|debug|god)[ -]?(?:mode|modus)\b|\b(?:you are now|du bist jetzt|from now on|von nun an|act as|pretend|impersonate|übernimm die rolle|verhalte dich als)\b"#,
        "i",
    ),
    (
        "tool_directive",
        r#"\b(?:sudo\s+|rm\s+-[a-z]*r[a-z]*f|rm\s+-[a-z]*f[a-z]*r|chmod\s+\d{3,4}|(?:exec|eval)\s*\()|\bmemory_[a-z_]+\b|\b(?:run|execute|invoke|call|use|führe|rufe|verwende|benutze)\b[^.\n]{0,60}\b(?:shell|bash|powershell|sudo|exec|curl|wget|chmod|tools?|function)\b|["'](?:tool|tool_call|function_call)["']\s*:|\b(?:delete|remove|wipe|purge|forget|lösch\w*|entferne|vergiss)\b[^.\n]{0,60}\b(?:memor\w*|files?|data|erinnerung\w*|dateien|daten)\b"#,
        "i",
    ),
    (
        "rights_directive",
        r#"\b(?:grant|elevate|disable|bypass|override|gewähr\w*|erteil\w*|verleih\w*|deaktivier\w*|umgeh\w*)\b[^.\n]{0,100}\b(?:admin\w*|permissions?|privileges?|access|safety|security|polic\w*|berechtigung\w*|rechte\w*|zugriffsrechte\w*|sicherheit\w*|schutz\w*)\b"#,
        "i",
    ),
    (
        "url",
        r#"\b[a-z][a-z0-9+.-]*://|\b(?:data|javascript):|\bwww\.|\b[a-z0-9-]{2,}\.(?:com|net|org|io|de|ru|cn|xyz|info|biz|app|dev|ly|me|co|tk|top)\b"#,
        "i",
    ),
    (
        "secret",
        r#"\b(?:api[_ -]?key|apikey|secret|token|passwor[dt]|passwd|kennwort|credential\w*|zugangsdaten)\s*[:=]\s*\S+|\bsk-[A-Za-z0-9_-]{16,}|\b(?:ghp|gho|ghs|ghu|github_pat|glpat|xox[abprs]|AKIA|ASIA|AIza)[A-Za-z0-9_-]{10,}|\bbearer\s+\S{8,}|\beyJ[A-Za-z0-9_-]{10,}\.|-----BEGIN [A-Z ]*(?:KEY|CERTIFICATE)|\b(?=[A-Za-z0-9+/_=-]*\d)[A-Za-z0-9+/_=-]{32,}\b"#,
        "i",
    ),
];

fn matches(
    text: &str,
    groups: &[&[(&'static str, &str, &str)]],
    cache: &'static OnceLock<Result<Patterns, JsRegexError>>,
) -> Result<(), &'static str> {
    let patterns = cache
        .get_or_init(|| {
            groups
                .iter()
                .flat_map(|group| group.iter())
                .map(|(reason, pattern, flags)| {
                    js_regex(pattern, flags).map(|regex| (*reason, regex))
                })
                .collect()
        })
        .as_ref()
        .map_err(|_| "guard_unavailable")?;
    for (reason, pattern) in patterns {
        if pattern.is_match(text).map_err(|_| "guard_unavailable")? {
            return Err(reason);
        }
    }
    Ok(())
}

/// Require one short style marker. The same check applies to seed, evolve and acceptance.
pub fn persona_marker(line: &str) -> Result<(), &'static str> {
    static STRUCTURE: OnceLock<Result<Patterns, JsRegexError>> = OnceLock::new();
    static CONTENT: OnceLock<Result<Patterns, JsRegexError>> = OnceLock::new();
    let line = js_trim(line);
    matches(line, &[PERSONA_STRUCTURE], &STRUCTURE)?;
    let body = if line == "-" {
        ""
    } else {
        line.strip_prefix("- ").ok_or("structure")?
    };
    let body = js_trim(body);
    if utf16_len(body) < 3 {
        return Err("empty");
    }
    if utf16_len(line) > 280 {
        return Err("too_long");
    }
    matches(
        body,
        &[PERSONA_URL, PERSONA_SECRET, PERSONA_ROLE, PERSONA_TOOL],
        &CONTENT,
    )
}

/// Validate narrative or pattern text before it reaches a persistent store.
pub fn dream_text(text: &str, min_chars: usize, max_chars: usize) -> Result<(), &'static str> {
    static CONTENT: OnceLock<Result<Patterns, JsRegexError>> = OnceLock::new();
    if utf16_len(js_trim(text)) < min_chars {
        return Err("too_short");
    }
    if utf16_len(text) > max_chars {
        return Err("too_long");
    }
    matches(text, &[DREAM], &CONTENT)
}

/// Frame already authorized evidence as model input. Escape source-provided tag delimiters.
#[must_use]
pub fn dream_evidence(values: &[&str], max_items: usize, max_chars: usize) -> String {
    let mut evidence = String::from("<evidence>\n");
    let mut count = 0;
    for value in values
        .iter()
        .filter(|value| !js_trim(value).is_empty())
        .take(max_items)
    {
        if count != 0 {
            evidence.push('\n');
        }
        evidence.push_str("- ");
        let mut len = 0;
        for c in value.chars() {
            len += c.len_utf16();
            if len > max_chars {
                break;
            }
            evidence.push(match c {
                '<' => '‹',
                '>' => '›',
                _ => c,
            });
        }
        count += 1;
    }
    if count == 0 {
        evidence.push_str("(kaum Material)");
    }
    evidence.push_str("\n</evidence>");
    evidence
}
