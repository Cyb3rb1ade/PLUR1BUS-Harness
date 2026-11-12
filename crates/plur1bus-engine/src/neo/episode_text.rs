//! C4 participant and topic extraction. Display labels never establish speaker identity.
use super::{
    episode_words,
    merged_order::{field, string, truthy},
};
use crate::{
    capture::fact_quality::matching::{lower, replace_pattern, split_whitespace, trim},
    contract::{Cancel, EngineError},
    text::{
        js::{self, JsRegex, JsString},
        json::TolerantJsonValue as Json,
    },
};
use std::{collections::HashMap, sync::OnceLock};

struct Patterns {
    voice: JsRegex,
    capitalized: JsRegex,
    pictographic: JsRegex,
}
fn error() -> EngineError {
    EngineError::NotAvailable {
        reason: "episode-text-pattern".into(),
    }
}
fn patterns() -> Result<&'static Patterns, EngineError> {
    static VALUE: OnceLock<Result<Patterns, ()>> = OnceLock::new();
    VALUE.get_or_init(|| {
        let data: serde_json::Value = serde_json::from_str(include_str!("episode-unicode17.json")).map_err(|_| ())?;
        let class = |name: &str| -> Result<String, ()> {
            let mut out = String::from("[");
            let mut last = None;
            for range in data["classes"][name].as_array().ok_or(())? {
                let start = range[0].as_u64().ok_or(())?; let end = range[1].as_u64().ok_or(())?;
                if start > end || end > 0x10ffff || last.is_some_and(|v| v >= start) { return Err(()); }
                out.push_str(&format!("\\x{{{start:X}}}-\\x{{{end:X}}}")); last = Some(end);
            }
            out.push(']'); Ok(out)
        };
        let upper = class("Lu")?; let lower = class("Ll")?;
        Ok(Patterns {
            voice: js::js_regex(&format!(r#"(?:^|\n|"\s*|\|\s*|\.\s+|\?\s+|!\s+)({upper}{lower}+(?:[ -]{upper}{lower}+)?):\s"#), "gu").map_err(|_| ())?,
            capitalized: js::js_regex(&format!("^{upper}{lower}+"), "u").map_err(|_| ())?,
            pictographic: js::js_regex(&class("Extended_Pictographic")?, "gu").map_err(|_| ())?,
        })
    }).as_ref().map_err(|_| error())
}
fn has(words: &str, value: &str) -> bool {
    words.split_ascii_whitespace().any(|w| w == value)
}
fn role(row: &Json, expected: &str) -> bool {
    field(row, "role") == Some(&Json::String(JsString::from(expected)))
}
fn content(row: &Json) -> JsString {
    field(row, "content")
        .filter(|v| truthy(v))
        .map(string)
        .unwrap_or_default()
}

pub(super) struct Labels {
    pub participants: Vec<JsString>,
    pub voices: Vec<JsString>,
    pub topics: Vec<JsString>,
}
pub(super) fn analyze(
    turns: &[Json],
    names: Option<(&JsString, &JsString)>,
    cancel: &Cancel,
) -> Result<Labels, EngineError> {
    let patterns = patterns()?;
    let mut voices = Vec::<JsString>::new();
    let own: Vec<_> = names
        .into_iter()
        .flat_map(|(u, a)| [lower(u), lower(a)])
        .collect();
    for turn in turns.iter().filter(|t| role(t, "user")) {
        cancel.check()?;
        let text = content(turn).to_utf8_lossy();
        if !js::js_to_lower_case(&text).contains("[audio transcript") {
            continue;
        }
        for captures in patterns.voice.captures_all(&text).map_err(|_| error())? {
            let name = captures.get(1).and_then(Option::as_ref).ok_or_else(error)?;
            let name = trim(&JsString::from(name.matched.as_str()));
            let key = lower(&name);
            let key_text = key.to_utf8_lossy();
            if has(episode_words::VOICE_STOP, &key_text)
                || has(
                    episode_words::VOICE_STOP,
                    key_text.split([' ', '-']).next().unwrap_or_default(),
                )
                || own.contains(&key)
            {
                continue;
            }
            if !voices.iter().any(|v| lower(v) == key) {
                voices.push(name);
            }
            // Preserve C4's per-turn break: a later user turn can still add a sixth speaker.
            if voices.len() >= 5 {
                break;
            }
        }
    }
    let default_user = JsString::from("Nutzer");
    let default_agent = JsString::from("agent");
    let (user, assistant) = names.unwrap_or((&default_user, &default_agent));
    let mut participants = Vec::<JsString>::new();
    let mut push = |name: &JsString| {
        let name = trim(name);
        if !name.is_empty() && !participants.iter().any(|v| lower(v) == lower(&name)) {
            participants.push(name);
        }
    };
    if turns.iter().any(|t| role(t, "user")) {
        push(user);
    }
    if turns.iter().any(|t| role(t, "assistant")) {
        push(assistant);
    }
    for voice in &voices {
        push(voice);
    }
    participants.truncate(10);
    let mut scores: HashMap<JsString, (usize, usize)> = HashMap::new();
    for turn in turns.iter().filter(|t| !role(t, "tool")) {
        cancel.check()?;
        let text = clean(&content(turn))?;
        for sentence in text
            .as_utf16_units()
            .split(|c| [46, 33, 63, 10].contains(c))
        {
            let sentence = replace_pattern(
                r"[^\p{L}\p{N}\s-]",
                "gu",
                &JsString::from_utf16_units(sentence.to_vec()),
                " ",
            )?;
            for (index, token) in split_whitespace(&sentence)
                .into_iter()
                .filter(|v| !v.is_empty())
                .enumerate()
            {
                if !(5..=30).contains(&token.as_utf16_units().len())
                    || token.as_utf16_units().iter().any(|c| (48..=57).contains(c))
                {
                    continue;
                }
                let key = lower(&token);
                let key_text = key.to_utf8_lossy();
                if has(episode_words::STOP_WORDS, &key_text)
                    || has(episode_words::TOPIC_NOISE, &key_text)
                {
                    continue;
                }
                let weight = if index > 0
                    && patterns
                        .capitalized
                        .is_match(&token.to_utf8_lossy())
                        .map_err(|_| error())?
                {
                    3
                } else {
                    1
                };
                let position = scores.len();
                let entry = scores.entry(key).or_insert((0, position));
                entry.0 += weight;
            }
        }
    }
    let mut scores: Vec<_> = scores
        .into_iter()
        .filter(|(_, (weight, _))| *weight >= 2)
        .collect();
    scores.sort_by(|(a, (aw, ai)), (b, (bw, bi))| {
        bw.cmp(aw)
            .then_with(|| js::locale_compare_utf16(a.as_utf16_units(), b.as_utf16_units()))
            .then(ai.cmp(bi))
    });
    let topics = scores.into_iter().take(5).map(|(word, _)| word).collect();
    Ok(Labels {
        participants,
        voices,
        topics,
    })
}

/// Pinned topic/prompt cleaning, shared without changing the pure episode projection.
pub(super) fn clean(text: &JsString) -> Result<JsString, EngineError> {
    let patterns = patterns()?;
    let mut text = text.clone();
    for (pattern, flags) in [
        (
            r"\[(?:audio transcript|media attached|user sent media|voice message)[^\]]*\]",
            "gi",
        ),
        (r"https?://\S+", "gi"),
        (r"<[^>]{1,80}>", "g"),
        (r"`[^`]*`", "g"),
    ] {
        text = replace_pattern(pattern, flags, &text, " ")?;
    }
    let utf8 = text.to_utf8_lossy();
    let mut cleaned = String::new();
    let mut end = 0;
    for found in patterns.pictographic.find_all(&utf8).map_err(|_| error())? {
        cleaned.push_str(&utf8[end..found.byte_start]);
        cleaned.push(' ');
        end = found.byte_end;
    }
    cleaned.push_str(&utf8[end..]);
    Ok(JsString::from(cleaned))
}
