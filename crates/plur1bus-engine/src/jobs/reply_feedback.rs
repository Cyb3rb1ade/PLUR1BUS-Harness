//! Classify foreground conversation replies without inferring identity from their text.
use crate::{
    contract::{Cancel, EngineError, StoreError},
    neo::job_turns::ConversationTurn,
    text::js::{js_to_lower_case, js_trim, nfkc},
};
use regex::Regex;
use std::{
    collections::{HashMap, HashSet},
    sync::OnceLock,
};

pub(super) struct Reply<'a> {
    pub response: &'a ConversationTurn,
    pub classification: &'static str,
    pub feedback: &'static str,
    pub confidence: f64,
}

pub(super) fn collect<'a>(
    turns: &'a [ConversationTurn],
    cancel: &Cancel,
) -> Result<Vec<Reply<'a>>, EngineError> {
    let mut prior: HashMap<_, (Option<&ConversationTurn>, Option<&ConversationTurn>)> =
        HashMap::new();
    let mut replies = Vec::new();
    for turn in turns.iter().rev() {
        cancel.check()?;
        let (user, assistant) = prior.entry(&turn.session).or_insert((None, None));
        if turn.role == "assistant" {
            *assistant = Some(turn);
            continue;
        }
        if let (Some(prompt), Some(answer)) = (*user, *assistant) {
            let (classification, feedback, confidence) =
                classify(&turn.content, &prompt.content, &answer.content)?;
            replies.push(Reply {
                response: turn,
                classification,
                feedback,
                confidence,
            });
        }
        *user = Some(turn);
        *assistant = None;
    }
    Ok(replies)
}

fn classify(
    reply: &str,
    prompt: &str,
    assistant: &str,
) -> Result<(&'static str, &'static str, f64), StoreError> {
    const RULES: [(&str, &str, &str, f64); 5] = [
        (
            r"(?i)(darum ging es nicht|nicht darum|not what i meant|irrelevant|hast du nicht verstanden|you misunderstood|ignore that|vergiss das)",
            "rejected",
            "negative",
            0.9,
        ),
        (
            r"(?i)(?-u:\b)(nein|no|falsch|wrong|incorrect|stimmt nicht|nicht korrekt|eigentlich|actually|korrig|correction|sondern|rather|not that|nicht das)(?-u:\b)",
            "corrected",
            "negative",
            0.82,
        ),
        (
            r"(?i)(\?|warum|wieso|wie genau|details?|genauer|mehr dazu|was fehlt|explain|why|how exactly|tell me more)",
            "asked_details",
            "positive",
            0.68,
        ),
        (
            r"(?i)(?-u:\b)(ja|yes|genau|richtig|stimmt|passt|perfekt|super|great|good|danke|thanks|weiter|mach weiter|go on|continue|implementiere|umsetzen|merge|ship)(?-u:\b)",
            "confirmed_or_continued",
            "positive",
            0.72,
        ),
        (
            r"(?i)(?-u:\b)(ok|okay|alles klar|noted|got it|verstanden)(?-u:\b)[.!\s]*$",
            "acknowledged",
            "neutral",
            0.45,
        ),
    ];
    static PATTERNS: OnceLock<Option<Vec<Regex>>> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        RULES
            .iter()
            .map(|(source, _, _, _)| Regex::new(source).ok())
            .collect()
    });
    let patterns = patterns.as_ref().ok_or(StoreError::Unavailable)?;
    let reply = js_trim(reply);
    if reply.is_empty() {
        return Ok(("no_reply", "neutral", 0.));
    }
    let mut result = patterns
        .iter()
        .zip(RULES)
        .find(|(pattern, _)| pattern.is_match(reply))
        .map_or(
            ("neutral", "neutral", 0.35),
            |(_, (_, outcome, feedback, confidence))| (outcome, feedback, confidence),
        );
    let overlap = lexical_overlap(prompt, reply);
    if overlap >= 0.22 && result.1 == "neutral" {
        result = ("continued_topic", "positive", 0.58);
    } else if overlap < 0.05
        && !prompt.is_empty()
        && reply.encode_utf16().count() > 80
        && !reply.contains('?')
        && result.0 == "neutral"
    {
        result = ("ignored_or_topic_shifted", "neutral", 0.5);
    }
    if result.1 == "neutral" && assistant.encode_utf16().count() > 20 {
        static DEICTIC: OnceLock<Option<Regex>> = OnceLock::new();
        let deictic =
            DEICTIC.get_or_init(|| Regex::new(r"(?i)(?-u:\b)(das|this|that|it)(?-u:\b)").ok());
        if deictic.as_ref().is_some_and(|regex| regex.is_match(reply)) {
            result = ("continued_topic", "positive", result.2.max(0.52));
        }
    }
    Ok(result)
}

fn lexical_overlap(a: &str, b: &str) -> f64 {
    static TOKENS: OnceLock<Option<Regex>> = OnceLock::new();
    let Some(tokens) = TOKENS.get_or_init(|| Regex::new(r"[\p{L}\p{N}_-]+").ok()) else {
        return 0.;
    };
    const STOP: &[&str] = &[
        "der", "die", "das", "und", "oder", "ich", "du", "wir", "the", "and", "or", "you", "me",
        "it", "to", "a", "of", "in", "for", "is", "ist",
    ];
    let terms = |text: &str| {
        let normalized = nfkc(&js_to_lower_case(text));
        tokens
            .find_iter(&normalized)
            .map(|word| word.as_str())
            .filter(|word| word.encode_utf16().count() >= 3 && !STOP.contains(word))
            .map(str::to_owned)
            .collect::<HashSet<_>>()
    };
    let left = terms(a);
    let right = terms(b);
    let smaller = left.len().min(right.len());
    if smaller == 0 {
        return 0.;
    }
    left.intersection(&right).count() as f64 / smaller as f64
}
