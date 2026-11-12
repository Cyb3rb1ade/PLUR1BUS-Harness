//! Pure S2 session-watermark plans. Callers apply patches to fresh state under the Neo lock.
//! A session string is not authority: the composition root must bind the containing state
//! to the actual principal/workspace before reading, claiming legacy data or persisting.
use super::merged_order::{field, string, truthy};
use crate::{
    contract::StoreError,
    text::{
        js::{locale_compare_utf16, JsString},
        json::TolerantJsonValue as Json,
    },
};
/// Actual Node bound; replacing an existing session does not evict another one.
pub const SESSION_WATERMARK_CAP: usize = 500;
/// Observation from one session; count values retain Node's strict finite-number semantics.
pub struct Watermark {
    /// Opaque UTF-16 session key with the harmless `s:` object-key prefix.
    pub key: JsString,
    /// Whether this session owns an object entry, even if its count is zero.
    pub known: bool,
    /// Nonnegative integral message count represented as the original Node number type.
    pub count: f64,
    /// Nonnegative integral consecutive failures.
    pub failures: f64,
}
impl Watermark {
    /// Node-compatible ordered projection, preserving opaque session identities.
    pub fn to_json(&self) -> Json {
        object(vec![
            ("key", Json::String(self.key.clone())),
            ("known", Json::Bool(self.known)),
            ("count", number(self.count)),
            ("failures", number(self.failures)),
        ])
    }
}
fn session_key(raw: &JsString) -> JsString {
    let mut units = JsString::from("s:").as_utf16_units().to_vec();
    units.extend_from_slice(raw.as_utf16_units());
    JsString::from_utf16_units(units)
}
fn entry<'a>(state: &'a Json, key: &JsString) -> Option<&'a Json> {
    let Json::Object(fields) = field(state, "sessionWatermarks")? else {
        return None;
    };
    fields
        .iter()
        .rev()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v)
        .filter(|v| matches!(v, Json::Object(_) | Json::Array(_)))
}
fn count(v: Option<&Json>) -> f64 {
    let Some(Json::Number(n)) = v else { return 0. };
    n.parse::<f64>()
        .ok()
        .filter(|v| v.is_finite() && *v > 0.)
        .map_or(0., f64::floor)
}
/// Read only the exact session entry, never the old workspace-wide count.
pub fn read_session(state: &Json, session: &JsString) -> Watermark {
    let key = session_key(session);
    let current = entry(state, &key);
    Watermark {
        key,
        known: current.is_some(),
        count: count(current.and_then(|v| field(v, "count"))),
        failures: count(current.and_then(|v| field(v, "failures"))),
    }
}
fn valid(state: &Json, now: &JsString) -> Result<(), StoreError> {
    if !matches!(state, Json::Object(_)) || now.is_empty() {
        return Err(StoreError::InvalidInput);
    }
    validate_state(state)
}
pub(super) fn validate_state(state: &Json) -> Result<(), StoreError> {
    if !matches!(state, Json::Object(_)) {
        return Err(StoreError::Corrupt);
    }
    // Tolerant JSON retains duplicate keys; state mutation refuses ambiguous session maps.
    for object in [Some(state), field(state, "sessionWatermarks")]
        .into_iter()
        .flatten()
    {
        if let Json::Object(fields) = object {
            let mut seen = std::collections::HashSet::new();
            if fields.iter().any(|(key, _)| !seen.insert(key)) {
                return Err(StoreError::Corrupt);
            }
        }
    }
    // The native state codec accepts object maps, null or missing. Arrays are not session maps.
    if field(state, "sessionWatermarks").is_some_and(|v| matches!(v, Json::Array(_))) {
        return Err(StoreError::Corrupt);
    }
    Ok(())
}
fn record(count: f64, failures: f64, now: &JsString) -> Json {
    object(vec![
        ("count", number(count)),
        ("failures", number(failures)),
        ("at", Json::String(now.clone())),
    ])
}
fn with_entry(state: &Json, key: &JsString, value: Json) -> Json {
    let mut fields = match field(state, "sessionWatermarks") {
        Some(Json::Object(fields)) => fields.clone(),
        _ => Vec::new(),
    };
    if let Some(index) = fields.iter().position(|(k, _)| k == key) {
        fields[index].1 = value;
    } else {
        fields.push((key.clone(), value));
    }
    if fields.len() > SESSION_WATERMARK_CAP {
        let mut oldest: Vec<_> = fields
            .iter()
            .enumerate()
            .filter(|(_, (k, _))| k != key)
            .map(|(index, (_, v))| {
                let at = field(v, "at")
                    .filter(|v| truthy(v))
                    .map_or_else(|| JsString::from(""), string);
                (index, at)
            })
            .collect();
        oldest
            .sort_by(|(_, a), (_, b)| locale_compare_utf16(a.as_utf16_units(), b.as_utf16_units()));
        let mut remove: Vec<_> = oldest
            .into_iter()
            .take(fields.len() - SESSION_WATERMARK_CAP)
            .map(|(i, _)| i)
            .collect();
        remove.sort_unstable();
        let mut index = 0;
        fields.retain(|_| {
            let keep = remove.binary_search(&index).is_err();
            index += 1;
            keep
        });
    }
    Json::Object(fields)
}
/// First-session legacy migration plan. Presence of a session map (even null/empty)
/// prevents a second claim. The caller must prove ownership of the legacy state first.
pub fn plan_legacy_claim(
    state: &Json,
    session: &JsString,
    now: &JsString,
) -> Result<Option<Json>, StoreError> {
    valid(state, now)?;
    if field(state, "sessionWatermarks").is_some() {
        return Ok(None);
    }
    let legacy = count(field(state, "lastProcessedMessageCount"));
    if legacy == 0. {
        return Ok(None);
    }
    let value = record(legacy, count(field(state, "postProcessingFailures")), now);
    Ok(Some(object(vec![(
        "sessionWatermarks",
        with_entry(state, &session_key(session), value),
    )])))
}
/// Compare-and-set advance: an unchanged baseline allows compaction reset; otherwise
/// only a higher target can win. An older completion cannot move the stored count backward.
pub fn plan_advance(
    state: &Json,
    session: &JsString,
    baseline: &Json,
    to: &Json,
    now: &JsString,
) -> Result<Option<Json>, StoreError> {
    valid(state, now)?;
    let current = read_session(state, session);
    let target = count(Some(to));
    if current.count != count(Some(baseline)) && target <= current.count {
        return Ok(None);
    }
    Ok(Some(object(vec![
        (
            "sessionWatermarks",
            with_entry(state, &current.key, record(target, 0., now)),
        ),
        ("lastProcessedMessageCount", number(target)),
        ("postProcessingFailures", number(0.)),
    ])))
}
/// A failed completion may add failures only while its original baseline still owns the count.
pub fn plan_failure(
    state: &Json,
    session: &JsString,
    baseline: &Json,
    failures: &Json,
    now: &JsString,
) -> Result<Option<Json>, StoreError> {
    valid(state, now)?;
    let current = read_session(state, session);
    if current.count != count(Some(baseline)) {
        return Ok(None);
    }
    Ok(Some(object(vec![(
        "sessionWatermarks",
        with_entry(
            state,
            &current.key,
            record(current.count, count(Some(failures)), now),
        ),
    )])))
}
fn object(fields: Vec<(&str, Json)>) -> Json {
    Json::Object(
        fields
            .into_iter()
            .map(|(k, v)| (JsString::from(k), v))
            .collect(),
    )
}
fn number(v: f64) -> Json {
    Json::Number(ryu_js::Buffer::new().format(v).to_owned())
}
