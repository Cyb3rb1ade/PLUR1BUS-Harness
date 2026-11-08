//! The pinned curated DE/EN lexicon classifier, including duplicate-entry resolution and nuances.

use std::collections::HashMap;

use crate::contract::EngineError;
use crate::text::js::JsString;

use super::emotion_json::{data, entries, get, num, numeric, object, round4, string, text, words};
use super::emotion_score::EmotionScore;

/// Deterministic lexical classifier; no model or provider is loaded.
pub struct Tier1Classifier {
    english: HashMap<String, String>,
    german: HashMap<String, String>,
}

impl Tier1Classifier {
    /// Build the curated dictionaries, applying custom English/German entries after the defaults.
    pub fn new(options: &crate::text::json::TolerantJsonValue) -> Result<Self, EngineError> {
        let source = data()?;
        let dictionary = |name: &str, custom: &str| {
            entries(get(source, name))
                .into_iter()
                .chain(entries(get(options, custom)))
                .filter_map(|(key, value)| text(&value).map(|value| (key, value)))
                .collect()
        };
        Ok(Self {
            english: dictionary("lexiconEn", "customEn"),
            german: dictionary("lexiconDe", "customDe"),
        })
    }

    /// Classify letter tokens with Node language selection, polarity, stable ties and five nuances.
    /// No match or a maximum share below 0.1 returns None, allowing the next tier to run.
    pub fn classify(
        &self,
        input: &JsString,
        source: &str,
        now: i64,
    ) -> Result<Option<EmotionScore>, EngineError> {
        let words = words(input)?;
        if words.is_empty() {
            return Ok(None);
        }
        let german_hits = words
            .iter()
            .filter(|word| {
                self.german
                    .get(*word)
                    .is_some_and(|value| !value.is_empty())
            })
            .count();
        let english_hits = words
            .iter()
            .filter(|word| {
                self.english
                    .get(*word)
                    .is_some_and(|value| !value.is_empty())
            })
            .count();
        let language = if german_hits as f64 > english_hits as f64 * 1.5 {
            "de"
        } else if english_hits as f64 > german_hits as f64 * 1.5 {
            "en"
        } else {
            "mixed"
        };
        let (primary_lexicon, fallback_lexicon) = if language == "en" {
            (&self.english, &self.german)
        } else {
            (&self.german, &self.english)
        };
        let mut counts: Vec<(String, f64)> = Vec::new();
        let mut matched = 0.0;
        let mut positive = 0.0_f64;
        let mut negative = 0.0_f64;
        let data = data()?;
        let base_vad = get(data, "baseVad");
        let nuance_vad = get(data, "nuanceVad");
        for word in &words {
            let emotion = primary_lexicon
                .get(word)
                .filter(|value| !value.is_empty())
                .or_else(|| fallback_lexicon.get(word).filter(|value| !value.is_empty()));
            let Some(emotion) = emotion else {
                continue;
            };
            matched += 1.0;
            if let Some((_, count)) = counts.iter_mut().find(|(name, _)| name == emotion) {
                *count += 1.0;
            } else {
                counts.push((emotion.clone(), 1.0));
            }
            let valence = numeric(get(get(base_vad, emotion), "v")).unwrap_or(0.0);
            if valence > 0.0 {
                positive += 1.0;
            }
            if valence < 0.0 {
                negative += 1.0;
            }
        }
        if matched == 0.0 {
            return Ok(None);
        }
        let scores: Vec<_> = counts
            .iter()
            .map(|(name, count)| (name.clone(), count / matched))
            .collect();
        let mut primary = "neutral";
        let mut maximum = f64::NEG_INFINITY;
        for (name, score) in &scores {
            if *score > maximum {
                maximum = *score;
                primary = name;
            }
        }
        if maximum < 0.1 {
            return Ok(None);
        }
        let mut secondary = None;
        let mut second_maximum = f64::NEG_INFINITY;
        for (name, score) in &scores {
            if name != primary && *score > second_maximum {
                second_maximum = *score;
                if maximum - score < 0.15 {
                    secondary = Some(name.as_str());
                }
            }
        }
        let vad = if get(base_vad, primary) != &crate::text::json::TolerantJsonValue::Null {
            get(base_vad, primary)
        } else if get(nuance_vad, primary) != &crate::text::json::TolerantJsonValue::Null {
            get(nuance_vad, primary)
        } else {
            get(base_vad, "neutral")
        };
        let raw_valence = numeric(get(vad, "v")).unwrap_or(0.0);
        let arousal = numeric(get(vad, "a")).unwrap_or(0.0);
        let dominance = numeric(get(vad, "d")).unwrap_or(0.0);
        let polarity_count = positive + negative;
        let compound = if polarity_count == 0.0 {
            0.0
        } else {
            (positive - negative) / polarity_count.max(1.0)
        };
        let valence = (0.7 * raw_valence + 0.3 * compound).clamp(-1.0, 1.0);
        let intensity = ((valence * valence + arousal * arousal + dominance * dominance).sqrt()
            / 3.0_f64.sqrt())
        .min(1.0);
        let confidence = (matched / (words.len().max(1) as f64) * 2.0 + 0.3).min(1.0);
        let mut nuances = Vec::new();
        for (name, count) in &counts {
            let vad = get(nuance_vad, name);
            if vad == &crate::text::json::TolerantJsonValue::Null {
                continue;
            }
            let value = |key| numeric(get(vad, key)).unwrap_or(0.0);
            let nuance_intensity = ((value("v").powi(2) + value("a").powi(2) + value("d").powi(2))
                .sqrt()
                / 3.0_f64.sqrt())
            .min(1.0);
            nuances.push(object([
                ("label", string(name)),
                ("intensity", num(round4(nuance_intensity))),
                (
                    "confidence",
                    num(round4((count / matched * 1.5 + 0.2).min(1.0))),
                ),
                ("source", string("lexicon")),
                ("language", string(language)),
            ]));
        }
        nuances.sort_by(|left, right| {
            numeric(get(right, "intensity"))
                .unwrap_or(0.0)
                .partial_cmp(&numeric(get(left, "intensity")).unwrap_or(0.0))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        nuances.truncate(5);
        let mut score = EmotionScore::from_props(
            &object([
                ("valence", num(valence)),
                ("arousal", num(arousal)),
                ("dominance", num(dominance)),
                ("intensity", num(intensity)),
                ("primary_emotion", string(primary)),
                (
                    "secondary_emotion",
                    secondary.map_or(crate::text::json::TolerantJsonValue::Null, string),
                ),
                (
                    "emotion_labels",
                    object(scores.into_iter().map(|(name, value)| (name, num(value)))),
                ),
                ("language", string(language)),
                ("source", string(source)),
                ("tier_used", num(1.0)),
                ("confidence", num(confidence)),
            ]),
            now,
        )?;
        score.nuances = nuances;
        Ok(Some(score))
    }
}
