//! Node's Tier-2 keyword-density scorer. Its model loader is deliberately a no-op at the pin.

use crate::contract::EngineError;
use crate::text::js::{js_to_lower_case, JsString};
use crate::text::json::TolerantJsonValue as Json;

use super::emotion_json::{array, data, get, num, numeric, object, string, text, words};
use super::emotion_score::EmotionScore;

/// A deterministic seven-label density classifier, despite the historical transformer name.
pub struct Tier2Classifier;

impl Tier2Classifier {
    /// Validate access to the recorded immutable keyword vocabulary; no model is loaded.
    pub fn new() -> Result<Self, EngineError> {
        data()?;
        Ok(Self)
    }
    /// The pinned loadModel sets its session to null, so this is always false.
    #[must_use]
    pub const fn model_loaded(&self) -> bool {
        false
    }

    /// Classify exact Unicode-letter words, then preserve Node softmax and stable argmax order.
    pub fn classify(
        &self,
        input: &JsString,
        source: &str,
        now: i64,
    ) -> Result<EmotionScore, EngineError> {
        let vocabulary = data()?;
        let labels: Vec<String> = array(get(vocabulary, "tier2Labels"))
            .iter()
            .filter_map(text)
            .collect();
        let words = words(input)?;
        let lower = js_to_lower_case(&input.to_utf8_lossy());
        let marker_hits = array(get(vocabulary, "germanMarkers"))
            .iter()
            .filter_map(text)
            .filter(|word| {
                lower.contains(&format!(" {word} ")) || lower.starts_with(&format!("{word} "))
            })
            .count();
        let language = if marker_hits >= 3 { "de" } else { "en" };
        let mut counts = vec![0.0_f64; labels.len()];
        let mut total_hits = 0.0;
        for word in &words {
            for (index, label) in labels.iter().enumerate() {
                if array(get(get(vocabulary, "tier2Keywords"), label))
                    .iter()
                    .any(|keyword| text(keyword).as_deref() == Some(word.as_str()))
                {
                    counts[index] += 1.0;
                    total_hits += 1.0;
                }
            }
        }
        if total_hits == 0.0 {
            if let Some(index) = labels.iter().position(|label| label == "neutral") {
                counts[index] = 0.1;
            }
            total_hits = 0.1;
        }
        let maximum = counts.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let exp: Vec<_> = counts.iter().map(|count| (count - maximum).exp()).collect();
        let mut sum = 0.0;
        for score in &exp {
            sum += score;
        }
        let probabilities: Vec<_> = exp.iter().map(|score| score / sum).collect();
        let mut primary = "neutral";
        let mut secondary = None;
        let mut best = f64::NEG_INFINITY;
        let mut second = f64::NEG_INFINITY;
        for (label, probability) in labels.iter().zip(&probabilities) {
            if *probability > best {
                second = best;
                secondary = Some(primary);
                best = *probability;
                primary = label;
            } else if *probability > second {
                second = *probability;
                secondary = Some(label.as_str());
            }
        }
        if best - second > 0.3 {
            secondary = None;
        }
        let vad = get(get(vocabulary, "tier2Vad"), primary);
        let valence = numeric(get(vad, "v")).unwrap_or(0.0);
        let arousal = numeric(get(vad, "a")).unwrap_or(0.0);
        let dominance = numeric(get(vad, "d")).unwrap_or(0.0);
        let intensity = ((valence * valence + arousal * arousal + dominance * dominance).sqrt()
            / 3.0_f64.sqrt())
        .min(1.0);
        let confidence = (total_hits / words.len().max(1) as f64 * 1.5 + 0.2).min(1.0);
        EmotionScore::from_props(
            &object([
                ("valence", num(valence)),
                ("arousal", num(arousal)),
                ("dominance", num(dominance)),
                ("intensity", num(intensity)),
                ("primary_emotion", string(primary)),
                ("secondary_emotion", secondary.map_or(Json::Null, string)),
                (
                    "emotion_labels",
                    object(
                        labels
                            .iter()
                            .zip(probabilities)
                            .map(|(label, value)| (label.clone(), num(value))),
                    ),
                ),
                ("language", string(language)),
                ("source", string(source)),
                ("tier_used", num(2.0)),
                ("confidence", num(confidence)),
            ]),
            now,
        )
    }
}
