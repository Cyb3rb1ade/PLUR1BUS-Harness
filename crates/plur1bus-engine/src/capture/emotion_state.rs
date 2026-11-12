//! Per-owner rolling mood, deterministic decay and restart-state projection from the frozen Node pin.
use super::{
    emotion_json::{
        array, clamp01, coerce, data, entries, get, iso, num, numeric, object, string, text,
    },
    emotion_legacy::DIMENSIONS,
};
use crate::{
    contract::{EngineError, Message, MessageRole},
    text::{
        js::{js_regex, js_to_lower_case},
        json::TolerantJsonValue as Json,
    },
};

#[path = "emotion_state_view.rs"]
mod view;
pub use view::{format_mood_file, format_mood_line};

/// One agent/workspace mood. Ownership and durable file access are separate host-bound operations.
#[derive(Clone)]
pub struct EmotionalState {
    baseline: [f64; 8],
    current: [f64; 8],
    nuances: Vec<(String, f64)>,
    last_update: f64,
    sensitivity: f64,
    decay_multiplier: f64,
    blend_factor: f64,
    mood_influence: f64,
    history: Vec<[f64; 8]>,
    max_history: f64,
    hydrated: bool,
}
impl EmotionalState {
    /// Resolve a validated temperament against the pinned baseline without I/O.
    pub fn new(options: &Json, now: i64) -> Result<Self, EngineError> {
        let defaults = get(data()?, "baselineMood");
        let mut baseline = [0.; 8];
        for (index, dim) in DIMENSIONS.into_iter().enumerate() {
            let custom = get(get(options, "baseline"), dim);
            baseline[index] = if custom == &Json::Null {
                coerce(get(defaults, dim))
            } else {
                numeric(custom)
                    .filter(|v| v.is_finite())
                    .ok_or_else(super::emotion_json::invalid)?
            };
        }
        let positive = |key| {
            numeric(get(options, key))
                .filter(|v| v.is_finite() && *v > 0.)
                .unwrap_or(1.)
        };
        let history = coerce(get(options, "maxHistory"));
        Ok(Self {
            baseline,
            current: baseline,
            nuances: Vec::new(),
            last_update: now as f64,
            sensitivity: positive("sensitivity"),
            decay_multiplier: positive("decayMultiplier"),
            blend_factor: numeric(get(options, "blendFactor"))
                .filter(|v| v.is_finite())
                .map(clamp01)
                .unwrap_or(0.5),
            mood_influence: numeric(get(options, "moodInfluence"))
                .filter(|v| v.is_finite() && *v >= 0.)
                .unwrap_or(0.3),
            history: Vec::new(),
            max_history: if history == 0. || history.is_nan() {
                100.
            } else {
                history
            },
            hydrated: false,
        })
    }
    /// Decay each dimension and nuance with its own pinned half-life; backwards clocks do not decay.
    pub fn decay(&mut self, now: i64) -> Result<(), EngineError> {
        let elapsed = now as f64 - self.last_update;
        if elapsed <= 0. {
            return Ok(());
        }
        let constants = data()?;
        let default = coerce(get(constants, "defaultDecayMs"));
        for (index, dim) in DIMENSIONS.into_iter().enumerate() {
            let life = numeric(get(get(constants, "decayHalfLifeMs"), dim))
                .filter(|v| *v != 0.)
                .unwrap_or(default)
                * self.decay_multiplier;
            self.current[index] = clamp01(
                self.baseline[index]
                    + (self.current[index] - self.baseline[index]) * 0.5f64.powf(elapsed / life),
            );
        }
        self.nuances.retain_mut(|(label, intensity)| {
            let life = numeric(get(get(constants, "nuanceDecayHalfLifeMs"), label))
                .filter(|v| *v != 0.)
                .unwrap_or(default)
                * self.decay_multiplier;
            *intensity *= 0.5f64.powf(elapsed / life);
            *intensity >= 0.05
        });
        self.last_update = now as f64;
        Ok(())
    }
    /// Blend an actual classifier result, retaining ordered nuance maxima.
    pub fn apply_emotion(&mut self, value: &Json, now: i64) -> Result<(), EngineError> {
        if !matches!(value, Json::Object(_) | Json::Array(_)) {
            return Ok(());
        }
        self.decay(now)?;
        let intensity = clamp01(coerce(get(value, "emotionalIntensity")));
        let blend = clamp01(self.blend_factor * self.sensitivity * (0.5 + intensity * 0.5));
        for (index, dim) in DIMENSIONS.into_iter().enumerate() {
            let target =
                clamp01(self.baseline[index] + clamp01(coerce(get(value, dim))) * self.sensitivity);
            self.current[index] = clamp01(self.current[index] * (1. - blend) + target * blend);
        }
        for nuance in array(get(value, "nuances")) {
            let intensity = clamp01(coerce(get(nuance, "intensity")));
            if let Some(label) = text(get(nuance, "label")).filter(|v| !v.is_empty()) {
                if intensity > 0.2 {
                    self.nuance(&label, intensity);
                }
            }
        }
        self.record(now);
        Ok(())
    }
    /// Blend the most recent five user/assistant messages using Node's non-global capture regexes.
    pub fn update_messages(&mut self, messages: &[Message], now: i64) -> Result<(), EngineError> {
        let messages = messages
            .iter()
            .filter(|m| matches!(m.role, MessageRole::User | MessageRole::Assistant))
            .collect::<Vec<_>>();
        let messages = &messages[messages.len().saturating_sub(5)..];
        let mut delta = [0.; 8];
        let mut weight_sum = 0.;
        let constants = data()?;
        for (index, message) in messages.iter().enumerate() {
            if message.content.is_empty() {
                continue;
            }
            let weight = (index + 1) as f64 / messages.len() as f64;
            weight_sum += weight;
            let lower = js_to_lower_case(&message.content);
            for (i, dim) in DIMENSIONS.into_iter().enumerate() {
                let pattern = text(get(get(constants, "stateHints"), dim))
                    .ok_or_else(super::emotion_json::invalid)?;
                let expression =
                    js_regex(&pattern, "").map_err(|_| super::emotion_json::invalid())?;
                // String.match without /g contains full match plus the one capture group.
                if expression
                    .is_match(&lower)
                    .map_err(|_| super::emotion_json::invalid())?
                {
                    delta[i] += 0.5 * weight;
                }
            }
        }
        if weight_sum == 0. {
            return Ok(());
        }
        self.decay(now)?;
        for (i, value) in delta.into_iter().enumerate() {
            self.current[i] =
                clamp01(self.current[i] * 0.65 + (self.baseline[i] + value / weight_sum) * 0.35);
        }
        self.record(now);
        Ok(())
    }
    /// Recalled high-intensity dimensions contribute a smaller fixed blend.
    pub fn update_recalled(&mut self, value: &Json, now: i64) -> Result<(), EngineError> {
        if !matches!(value, Json::Object(_) | Json::Array(_)) {
            return Ok(());
        }
        self.decay(now)?;
        for (i, dim) in DIMENSIONS.into_iter().enumerate() {
            let v = coerce(get(value, dim));
            if v > 0.5 {
                self.current[i] = clamp01(self.current[i] * 0.85 + v * 0.15);
            }
        }
        for nuance in array(get(value, "nuances")) {
            let intensity = coerce(get(nuance, "intensity"));
            if intensity > 0.3 {
                if let Some(label) = text(get(nuance, "label")) {
                    self.nuance(&label, intensity);
                }
            }
        }
        self.record(now);
        Ok(())
    }
    fn nuance(&mut self, label: &str, value: f64) {
        if let Some((_, v)) = self.nuances.iter_mut().find(|(key, _)| key == label) {
            *v = v.max(value);
        } else {
            self.nuances.push((label.into(), value));
        }
    }
    fn record(&mut self, now: i64) {
        self.last_update = now as f64;
        self.history.push(self.current);
        if self.history.len() as f64 > self.max_history {
            let offset = (-self.max_history).trunc();
            let start = if offset < 0. {
                self.history.len() as f64 + offset
            } else {
                offset
            };
            self.history
                .drain(..(start.max(0.) as usize).min(self.history.len()));
        }
    }
    fn values(values: &[f64; 8]) -> Json {
        object(
            DIMENSIONS
                .into_iter()
                .zip(values)
                .map(|(dim, value)| (dim, num(*value))),
        )
    }
    fn nuance_values(&self) -> Json {
        object(
            self.nuances
                .iter()
                .map(|(key, value)| (key.clone(), num(*value))),
        )
    }
    /// Current values plus ordered nuances and the host-clock timestamp.
    pub fn snapshot(&mut self, now: i64) -> Result<Json, EngineError> {
        self.decay(now)?;
        let mut fields = entries(&Self::values(&self.current));
        fields.extend([
            ("nuances".into(), self.nuance_values()),
            ("timestamp".into(), string(&iso(now)?)),
        ]);
        Ok(object(fields))
    }
    /// Node v2 restart state. The configured temperament baseline is recorded for inspection.
    pub fn serialize_state(&mut self, now: i64) -> Result<Json, EngineError> {
        self.decay(now)?;
        Ok(object([
            ("version", num(2.)),
            ("current", Self::values(&self.current)),
            ("nuanceState", self.nuance_values()),
            ("lastUpdateAt", num(self.last_update)),
            ("baseline", Self::values(&self.baseline)),
        ]))
    }
    /// Pure Node-compatible restoration; the owning file adapter must authenticate record ownership first.
    pub fn hydrate_once(&mut self, record: Option<&Json>, now: i64) -> Result<bool, EngineError> {
        if self.hydrated {
            return Ok(false);
        }
        self.hydrated = true;
        let Some(record) = record else {
            return Ok(false);
        };
        let state = get(record, "state");
        if !matches!(get(state, "current"), Json::Object(_) | Json::Array(_)) {
            return Ok(false);
        }
        for (i, dim) in DIMENSIONS.into_iter().enumerate() {
            if let Some(value) = numeric(get(get(state, "current"), dim)).filter(|v| v.is_finite())
            {
                self.current[i] = clamp01(value);
            }
        }
        for (label, value) in entries(get(state, "nuanceState")) {
            if let Some(value) = numeric(&value).filter(|v| v.is_finite() && *v > 0.) {
                if let Some((_, old)) = self.nuances.iter_mut().find(|(name, _)| name == &label) {
                    *old = clamp01(value);
                } else {
                    self.nuances.push((label, clamp01(value)));
                }
            }
        }
        if let Some(at) = numeric(get(state, "lastUpdateAt"))
            .filter(|v| v.is_finite() && *v > 0. && *v <= now as f64)
        {
            self.last_update = at;
        }
        self.decay(now)?;
        Ok(true)
    }
    /// Mood congruence, including the pinned null-input neutral score.
    pub fn compatibility(&mut self, value: &Json, now: i64) -> Result<f64, EngineError> {
        self.decay(now)?;
        if !matches!(value, Json::Object(_) | Json::Array(_)) {
            return Ok(0.5);
        }
        let mut dot = 0.;
        let mut a = 0.;
        let mut b = 0.;
        for (i, dim) in DIMENSIONS.into_iter().enumerate() {
            let v = coerce(get(value, dim));
            dot += self.current[i] * v;
            a += self.current[i] * self.current[i];
            b += v * v;
        }
        let denominator = a.sqrt() * b.sqrt();
        Ok((if denominator == 0. {
            0.
        } else {
            dot / denominator
        } + 1.)
            / 2.)
    }
    /// Recall boost that preserves the important-lesson exception independent of current mood.
    pub fn recall_boost(
        &mut self,
        value: &Json,
        importance: f64,
        now: i64,
    ) -> Result<f64, EngineError> {
        let compatibility = self.compatibility(value, now)?;
        let intensity = coerce(get(value, "emotionalIntensity"));
        if (coerce(get(value, "anger")) > 0.5 || coerce(get(value, "fear")) > 0.5)
            && (coerce(get(value, "trust")) > 0.3 || importance > 0.7)
        {
            return Ok(1. + intensity * 0.1);
        }
        Ok(1. + (compatibility - 0.5) * (self.mood_influence * 2.) + intensity * 0.05)
    }
}
