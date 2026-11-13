//! `privacy.ts` of `packages/config-schema`: whether a provider that is not local carries a matching, well-formed
//! acknowledgment. The validator checks the media index and the captioning provider with it while loading; the core
//! checks the text providers with it when it resolves them.
use serde_json::Value;

/// `String.prototype.trim`'s white space.
fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `text.trim()`.
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

/// What a privacy acknowledgment is checked against (`PrivacyChoice`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrivacyFunction {
    /// Memory text sent to an embedding or reranking provider.
    Text,
    /// A media index provider.
    Media,
    /// A captioning provider.
    Caption,
}

/// One provider choice to check (`PrivacyChoice`).
#[derive(Debug, Clone)]
pub struct PrivacyChoice<'a> {
    /// The function the provider serves.
    pub function: PrivacyFunction,
    /// The provider id.
    pub provider: &'a str,
    /// Whether the provider runs on this machine.
    pub local: bool,
    /// Whether the privacy pin applies.
    pub pinned: bool,
    /// The exact endpoint the admitted provider uses, when it is configurable.
    pub endpoint: Option<&'a str>,
    /// The recorded acknowledgment (`undefined`, `null` and other falsy values count as none).
    pub ack: Option<&'a Value>,
}

/// A refused privacy choice (`PrivacyAcknowledgmentFailure`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrivacyFailure {
    /// `E_DENIED` for text, `E_MEDIA_PRIVACY` otherwise.
    pub code: &'static str,
    /// `privacy-pin`, `privacy-acknowledgment-required`, `-invalid` or `-mismatch`.
    pub reason: &'static str,
}

fn falsy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => true,
        Value::String(s) => s.is_empty(),
        Value::Number(n) => n.as_f64() == Some(0.0),
        _ => false,
    }
}

/// `privacyAcknowledgmentError`: `None` when the choice is admitted.
pub fn privacy_acknowledgment_error(choice: &PrivacyChoice<'_>) -> Option<PrivacyFailure> {
    if choice.local {
        return None;
    }
    let code = if choice.function == PrivacyFunction::Text {
        "E_DENIED"
    } else {
        "E_MEDIA_PRIVACY"
    };
    if choice.pinned {
        return Some(PrivacyFailure {
            code,
            reason: "privacy-pin",
        });
    }
    let fail = |reason| Some(PrivacyFailure { code, reason });
    let Some(ack) = choice.ack.filter(|a| !falsy(a)) else {
        return fail("privacy-acknowledgment-required");
    };
    let by_ok = ack
        .get("by")
        .and_then(Value::as_str)
        .is_some_and(|by| !js_trim(by).is_empty());
    let at_ok = ack
        .get("acknowledgedAt")
        .and_then(Value::as_str)
        .is_some_and(|at| {
            let b = at.as_bytes();
            b.len() >= 11
                && b[..4].iter().all(u8::is_ascii_digit)
                && b[4] == b'-'
                && b[5..7].iter().all(u8::is_ascii_digit)
                && b[7] == b'-'
                && b[8..10].iter().all(u8::is_ascii_digit)
                && b[10] == b'T'
                && crate::js_date::date_parse(at).is_some()
        });
    if !by_ok || !at_ok {
        return fail("privacy-acknowledgment-invalid");
    }
    let endpoint = match ack.get("endpoint") {
        None | Some(Value::Null) => None,
        Some(other) => Some(other),
    };
    let wanted = choice.endpoint.map(|e| Value::String(e.to_owned()));
    if ack.get("provider") != Some(&Value::String(choice.provider.to_owned()))
        || endpoint != wanted.as_ref()
    {
        return fail("privacy-acknowledgment-mismatch");
    }
    None
}
