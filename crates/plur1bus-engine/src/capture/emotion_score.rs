//! Validated Node emotion scores with ordered serialization, VAD vectors and display projections.

use crate::contract::EngineError;
use crate::text::json::{write_json, TolerantJsonValue as Json};

use super::emotion_json::{
    array, coerce, entries, get, invalid, iso, num, numeric, object, round4, string, text,
};

/// The complete Node score; optional enrichment remains ordered JSON rather than a sorted map.
#[derive(Clone, Debug)]
pub struct EmotionScore {
    /// Negative-to-positive valence in [-1,1].
    pub valence: f64,
    /// Calm-to-excited arousal in [-1,1].
    pub arousal: f64,
    /// Powerless-to-powerful dominance in [-1,1].
    pub dominance: f64,
    /// Emotion strength in [0,1].
    pub intensity: f64,
    /// Primary base emotion or supported nuance label.
    pub primary_emotion: String,
    /// Secondary label when close enough to the primary.
    pub secondary_emotion: Option<String>,
    /// Label values in Node insertion order.
    pub emotion_labels: Vec<(String, Json)>,
    /// Detected language label.
    pub language: String,
    /// Message source role.
    pub source: String,
    /// Classifier tier that produced the score.
    pub tier_used: u8,
    /// Classifier certainty in [0,1].
    pub confidence: f64,
    /// Capture-clock timestamp in epoch milliseconds.
    pub timestamp: i64,
    /// Up to five lexical nuances, or the caller's validated enrichment.
    pub nuances: Vec<Json>,
    /// Optional blend evidence.
    pub complex_emotion: Option<Json>,
    /// Optional transition from the preceding score.
    pub emotional_context: Option<Json>,
    /// Blend factors in required-emotion insertion order.
    pub blend_factors: Vec<(String, Json)>,
}

impl EmotionScore {
    /// Construct and validate a Node-shaped score. Errors never echo the supplied properties.
    pub fn from_props(props: &Json, now: i64) -> Result<Self, EngineError> {
        let finite = |key: &str, default: f64| {
            let value = get(props, key);
            let value = if value == &Json::Null {
                default
            } else {
                numeric(value).ok_or_else(invalid)?
            };
            if value.is_finite() {
                Ok(value)
            } else {
                Err(invalid())
            }
        };
        let valence = finite("valence", 0.0)?;
        let arousal = finite("arousal", 0.0)?;
        let dominance = finite("dominance", 0.0)?;
        let intensity = finite("intensity", 0.0)?;
        let confidence = finite("confidence", 1.0)?;
        if [valence, arousal, dominance]
            .iter()
            .any(|value| !(-1.0..=1.0).contains(value))
            || !(0.0..=1.0).contains(&intensity)
            || !(0.0..=1.0).contains(&confidence)
        {
            return Err(invalid());
        }
        let nuances = array(get(props, "nuances")).to_vec();
        for nuance in &nuances {
            for key in ["intensity", "confidence"] {
                let value = get(nuance, key);
                let number = coerce(value);
                // Node range comparisons leave NaN-valued optional enrichment untouched.
                if !number.is_nan() && !(0.0..=1.0).contains(&number) {
                    return Err(invalid());
                }
            }
        }
        let complex_emotion = (get(props, "complex_emotion") != &Json::Null)
            .then(|| get(props, "complex_emotion").clone());
        if let Some(complex) = &complex_emotion {
            let confidence = coerce(get(complex, "confidence"));
            if !confidence.is_nan() && !(0.0..=1.0).contains(&confidence) {
                return Err(invalid());
            }
        }
        let timestamp = match get(props, "timestamp") {
            Json::Number(value) => value
                .parse::<f64>()
                .ok()
                .filter(|value| value.is_finite())
                .map(|value| value as i64)
                .ok_or_else(invalid)?,
            Json::String(value) => chrono::DateTime::parse_from_rfc3339(&value.to_utf8_lossy())
                .map_err(|_| invalid())?
                .timestamp_millis(),
            _ => now,
        };
        iso(timestamp)?;
        Ok(Self {
            valence,
            arousal,
            dominance,
            intensity,
            primary_emotion: text(get(props, "primary_emotion"))
                .unwrap_or_else(|| "neutral".into()),
            secondary_emotion: text(get(props, "secondary_emotion")),
            emotion_labels: entries(get(props, "emotion_labels")),
            language: text(get(props, "language")).unwrap_or_else(|| "unknown".into()),
            source: text(get(props, "source")).unwrap_or_else(|| "user".into()),
            tier_used: numeric(get(props, "tier_used")).unwrap_or(1.0) as u8,
            confidence,
            timestamp,
            nuances,
            complex_emotion,
            emotional_context: (get(props, "emotional_context") != &Json::Null)
                .then(|| get(props, "emotional_context").clone()),
            blend_factors: entries(get(props, "blend_factors")),
        })
    }

    /// Node's fromDict intentionally discards the old timestamp and stamps the new instance.
    pub fn from_dict(props: &Json, now: i64) -> Result<Self, EngineError> {
        let mut fields = entries(props);
        fields.retain(|(key, _)| key != "timestamp");
        Self::from_props(&object(fields), now)
    }

    /// Construct the engine's neutral fallback; tier three retains its own fallback tier.
    #[must_use]
    pub fn neutral(source: &str, tier: u8, now: i64) -> Self {
        Self {
            valence: 0.0,
            arousal: 0.0,
            dominance: 0.0,
            intensity: 0.0,
            primary_emotion: "neutral".into(),
            secondary_emotion: None,
            emotion_labels: vec![("neutral".into(), num(1.0))],
            language: "unknown".into(),
            source: source.into(),
            tier_used: tier,
            confidence: 0.0,
            timestamp: now,
            nuances: Vec::new(),
            complex_emotion: None,
            emotional_context: None,
            blend_factors: Vec::new(),
        }
    }

    /// All Node toDict fields and only non-empty enrichment, in Node insertion order.
    pub fn to_dict(&self) -> Result<Json, EngineError> {
        let rounded = |values: &[(String, Json)]| {
            object(values.iter().map(|(key, value)| {
                (
                    key.clone(),
                    numeric(value).map_or_else(|| value.clone(), |value| num(round4(value))),
                )
            }))
        };
        let mut fields = vec![
            ("valence", num(round4(self.valence))),
            ("arousal", num(round4(self.arousal))),
            ("dominance", num(round4(self.dominance))),
            ("intensity", num(round4(self.intensity))),
            ("primary_emotion", string(&self.primary_emotion)),
            (
                "secondary_emotion",
                self.secondary_emotion.as_deref().map_or(Json::Null, string),
            ),
            ("emotion_labels", rounded(&self.emotion_labels)),
            ("language", string(&self.language)),
            ("source", string(&self.source)),
            ("tier_used", num(f64::from(self.tier_used))),
            ("confidence", num(round4(self.confidence))),
            ("timestamp", string(&iso(self.timestamp)?)),
        ];
        if !self.nuances.is_empty() {
            fields.push(("nuances", Json::Array(self.nuances.clone())));
        }
        if let Some(complex) = &self.complex_emotion {
            fields.push(("complex_emotion", complex.clone()));
        }
        if let Some(context) = &self.emotional_context {
            fields.push(("emotional_context", context.clone()));
        }
        if !self.blend_factors.is_empty() {
            fields.push(("blend_factors", rounded(&self.blend_factors)));
        }
        Ok(object(fields))
    }

    /// Compact JSON bytes used by the Node golden.
    pub fn to_dict_json(&self) -> Result<String, EngineError> {
        self.to_dict().map(|value| write_json(&value))
    }
    /// VAD coordinates rounded to Float32Array values, not Float64 values.
    #[must_use]
    pub fn to_vad_vector(&self) -> [f32; 3] {
        [
            self.valence as f32,
            self.arousal as f32,
            self.dominance as f32,
        ]
    }
    /// Exact JSON representation of the Node Float32Array converted to an ordinary array.
    #[must_use]
    pub fn vector_json(&self) -> String {
        write_json(&Json::Array(
            self.to_vad_vector()
                .into_iter()
                .map(|value| num(f64::from(value)))
                .collect(),
        ))
    }
    /// The pinned strict intensity threshold.
    #[must_use]
    pub fn is_high_intensity(&self) -> bool {
        self.intensity > 0.6
    }
    /// The pinned strict ambivalence threshold.
    #[must_use]
    pub fn is_ambivalent(&self) -> bool {
        self.valence.abs() < 0.2
    }
    /// Blend label, primary label, first nuance or neutral, in Node preference order.
    #[must_use]
    pub fn effective_label(&self) -> String {
        if let Some(label) = self
            .complex_emotion
            .as_ref()
            .and_then(|value| text(get(value, "label")))
            .filter(|label| !label.is_empty())
        {
            return label;
        }
        if !self.primary_emotion.is_empty() && self.primary_emotion != "neutral" {
            return self.primary_emotion.clone();
        }
        self.nuances
            .first()
            .and_then(|value| text(get(value, "label")))
            .unwrap_or_else(|| "neutral".into())
    }
    /// Active labels sorted stably by their unrounded intensity.
    #[must_use]
    pub fn active_emotions_json(&self) -> String {
        let mut labels: Vec<_> = self
            .emotion_labels
            .iter()
            .filter(|(_, value)| coerce(value) > 0.1)
            .collect();
        labels.sort_by(|(_, left), (_, right)| {
            coerce(right)
                .partial_cmp(&coerce(left))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        write_json(&Json::Array(
            labels
                .into_iter()
                .map(|(key, value)| object([("label", string(key)), ("intensity", value.clone())]))
                .collect(),
        ))
    }
    /// Unrounded classifier state, used to verify routing inputs and full softmax precision.
    #[must_use]
    pub fn unrounded(&self) -> Json {
        object([
            ("valence", num(self.valence)),
            ("arousal", num(self.arousal)),
            ("dominance", num(self.dominance)),
            ("intensity", num(self.intensity)),
            ("confidence", num(self.confidence)),
            (
                "labels",
                Json::Array(
                    self.emotion_labels
                        .iter()
                        .map(|(key, value)| Json::Array(vec![string(key), value.clone()]))
                        .collect(),
                ),
            ),
        ])
    }
}
