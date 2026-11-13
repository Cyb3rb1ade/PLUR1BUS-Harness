//! Ordered mood display projections; no ownership or disk access.
use super::EmotionalState;
use crate::capture::{
    emotion_json::{array, coerce, data, get, iso, object, string, text},
    emotion_legacy::DIMENSIONS,
};
use crate::{contract::EngineError, text::json::TolerantJsonValue as Json};
impl EmotionalState {
    pub(crate) fn dream_intensity(&self) -> f64 {
        let difference = self
            .current
            .iter()
            .zip(self.baseline)
            .map(|(value, baseline)| value - baseline)
            .fold(0., f64::max);
        (difference * 2.).clamp(0., 1.)
    }

    fn deviation(&self, values: &[f64; 8]) -> f64 {
        let mut total = 0.;
        for (i, value) in values.iter().enumerate() {
            total += (*value - self.baseline[i]).abs();
        }
        total
    }
    fn trend(&self) -> &'static str {
        let Some(mut previous) = self.history.last() else {
            return "stabil";
        };
        let now = self.deviation(&self.current);
        if self.history.len() >= 2 && (self.deviation(previous) - now).abs() < 1e-9 {
            previous = &self.history[self.history.len() - 2];
        }
        let before = self.deviation(previous);
        if now > before + 0.03 {
            "steigend"
        } else if now < before - 0.03 {
            "fallend"
        } else {
            "stabil"
        }
    }
    /// German mood label, nuance ordering and actual floating-point dimension values.
    pub fn describe(&mut self, now: i64) -> Result<Json, EngineError> {
        self.decay(now)?;
        let mut dimensions = (0..8).collect::<Vec<_>>();
        dimensions.sort_by(|&a, &b| {
            (self.current[b] - self.baseline[b]).total_cmp(&(self.current[a] - self.baseline[a]))
        });
        let index = dimensions[0];
        let dominant = DIMENSIONS[index];
        let difference = self.current[index] - self.baseline[index];
        let constants = data()?;
        let dominant_label =
            text(get(get(constants, "moodLabels"), dominant)).unwrap_or_else(|| "neutral".into());
        let mut active = self
            .nuances
            .iter()
            .filter(|(_, v)| *v > 0.2)
            .collect::<Vec<_>>();
        active.sort_by(|a, b| b.1.total_cmp(&a.1));
        let low = difference < 0.05 && active.is_empty();
        let label = if low {
            "ausgeglichen".into()
        } else if let Some((nuance, _)) = active.first() {
            let name =
                text(get(get(constants, "nuanceLabels"), nuance)).unwrap_or_else(|| nuance.clone());
            format!("{name} und {dominant_label}")
        } else {
            dominant_label
        };
        let intensity = if low {
            "niedrig"
        } else if difference > 0.35 {
            "hoch"
        } else if difference > 0.15 {
            "mittel"
        } else {
            "niedrig"
        };
        let emoji = if low {
            "🧘".into()
        } else {
            let key = active.first().map_or(dominant, |(name, _)| name.as_str());
            text(get(get(constants, "emoji"), key)).unwrap_or_else(|| "😐".into())
        };
        Ok(object([
            ("label", string(&label)),
            ("dominant", string(dominant)),
            ("intensity", string(intensity)),
            ("trend", string(self.trend())),
            ("details", Self::values(&self.current)),
            (
                "nuances",
                Json::Array(active.iter().map(|(name, _)| string(name)).collect()),
            ),
            ("emoji", string(&emoji)),
        ]))
    }
}
fn field(value: &Json, name: &str) -> String {
    text(get(value, name)).unwrap_or_default()
}
fn trend(value: &Json) -> String {
    let trend = field(value, "trend");
    if trend.is_empty() || trend == "stabil" {
        String::new()
    } else {
        format!(", {trend}")
    }
}
/// Exact short mood line for the recall prompt; an absent label produces no supplement.
#[must_use]
pub fn format_mood_line(mood: &Json) -> String {
    let label = field(mood, "label");
    if label.is_empty() {
        return String::new();
    }
    let emoji = field(mood, "emoji");
    let emoji = if emoji.is_empty() { "🧠" } else { &emoji };
    format!(
        "{emoji} Aktuelle Stimmung: {label} ({}{})",
        field(mood, "intensity"),
        trend(mood)
    )
}
/// Exact human-readable mood file, without writing or authorizing its destination.
pub fn format_mood_file(mood: &Json, agent: &str, now: i64) -> Result<String, EngineError> {
    if mood == &Json::Null {
        return Ok(String::new());
    }
    let names = array(get(mood, "nuances"))
        .iter()
        .filter_map(text)
        .collect::<Vec<_>>();
    let nuances = if names.is_empty() {
        "—".into()
    } else {
        names.join(", ")
    };
    let mut dimensions = DIMENSIONS
        .into_iter()
        .map(|dim| (dim, coerce(get(get(mood, "details"), dim))))
        .collect::<Vec<_>>();
    dimensions.sort_by(|a, b| b.1.total_cmp(&a.1));
    let top = dimensions
        .iter()
        .take(3)
        .map(|(name, value)| format!("{name} {}", crate::text::number::fixed(*value, 2)))
        .collect::<Vec<_>>()
        .join(" · ");
    let emoji = field(mood, "emoji");
    let emoji = if emoji.is_empty() { "🧠" } else { &emoji };
    Ok(format!("{emoji} {} ({}{})\nDominant: {} · Nuancen: {nuances}\nTop: {top}\nStand: {} (agent: {agent})\n",
        field(mood,"label"),field(mood,"intensity"),trend(mood),field(mood,"dominant"),iso(now)?))
}
