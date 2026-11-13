//! S7/C6 pattern validation, fallback and weekly trend revisions.
use super::super::content_guard::dream_text;
use crate::text::js::{is_js_whitespace, js_to_lower_case, JsString};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};

pub(super) fn parse(response: &str) -> Option<Value> {
    let response = response.trim();
    let response = response
        .strip_prefix("```json")
        .or_else(|| response.strip_prefix("```"))
        .unwrap_or(response);
    let response = response
        .trim()
        .strip_suffix("```")
        .unwrap_or(response)
        .trim();
    let value: Value = serde_json::from_str(response).ok()?;
    value.as_object()?;
    let scalar = |name: &str, max| match &value[name] {
        Value::Null => Some(""),
        Value::String(text) if dream_text(text, 0, max).is_ok() => Some(text.as_str()),
        _ => None,
    };
    let list = |name: &str| {
        let mut list = Vec::new();
        for text in value[name].as_array().into_iter().flatten() {
            let text = text.as_str()?;
            dream_text(text, 0, 200).ok()?;
            if list.len() < 10 {
                list.push(text);
            }
        }
        Some(list)
    };
    let name = scalar("patternName", 60)?;
    let confidence = value["confidence"]
        .as_f64()
        .or_else(|| {
            value["confidence"]
                .as_str()
                .and_then(|value| value.trim().parse::<f64>().ok())
        })
        .filter(|value| value.is_finite())
        .unwrap_or(0.3)
        .clamp(0., 1.);
    Some(json!({
        "patternName":if name.is_empty() { "Unbekanntes Muster" } else { name },
        "description":scalar("description", 300)?,
        "emotionalTrajectory":scalar("emotionalTrajectory", 100)?,
        "participants":list("participants")?,
        "relatedTopics":list("relatedTopics")?,
        "confidence":confidence,
    }))
}

pub(super) fn fallback(samples: &[JsString]) -> Value {
    let mut counts = HashMap::new();
    let mut words: Vec<(String, usize)> = Vec::new();
    for sample in samples {
        let sample = sample.to_utf8_lossy();
        if dream_text(&sample, 0, 10_000).is_err() {
            continue;
        }
        let lower = js_to_lower_case(&sample);
        for word in lower.split(|c: char| {
            !c.is_ascii_alphanumeric() && !matches!(c, '_' | 'ä' | 'ö' | 'ü' | 'ß')
                || is_js_whitespace(c)
        }) {
            if !(5..=50).contains(&word.encode_utf16().count()) {
                continue;
            }
            let index = *counts.entry(word.to_owned()).or_insert_with(|| {
                words.push((word.to_owned(), 0));
                words.len() - 1
            });
            words[index].1 += 1;
        }
    }
    words.sort_by_key(|word| std::cmp::Reverse(word.1));
    let topics: Vec<_> = words.into_iter().take(5).map(|(word, _)| word).collect();
    let name = topics.first().map_or_else(
        || "Unbekanntes Muster".into(),
        |word| format!("Thema: {word}"),
    );
    json!({"patternName":name,"description":format!("{} Erinnerungen ohne klares Muster.", samples.len()),
        "emotionalTrajectory":"","participants":[],"relatedTopics":topics,"confidence":0.3})
}

pub(super) fn key(pattern: &Value) -> String {
    let sorted = |name: &str| {
        let mut values: Vec<_> = strings(pattern, name).collect();
        values.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        values
    };
    let topic = sorted("relatedTopics");
    let people = sorted("participants");
    let category = pattern["category"]
        .as_str()
        .filter(|category| !category.is_empty())
        .unwrap_or("general");
    let material = topic
        .into_iter()
        .chain(people)
        .chain([category])
        .collect::<Vec<_>>()
        .join("::");
    format!("{:x}", Sha256::digest(material.as_bytes()))[..32].to_owned()
}

fn strings<'a>(pattern: &'a Value, field: &str) -> impl Iterator<Item = &'a str> {
    pattern[field]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
}

pub(super) fn trends(new: Vec<Value>, old: Vec<Value>) -> Vec<Value> {
    let mut seen = HashSet::new();
    let mut old: Vec<_> = old
        .into_iter()
        .rev()
        .filter(|row| {
            row["id"]
                .as_str()
                .is_some_and(|id| seen.insert(id.to_owned()))
        })
        .collect();
    old.reverse();
    let superseded: HashSet<_> = old
        .iter()
        .filter(|row| row["trend"] != "verschwunden")
        .filter_map(|row| {
            row["previousPatternId"]
                .as_str()
                .filter(|&id| row["id"] != id)
        })
        .map(str::to_owned)
        .collect();
    old.retain(|row| {
        row["trend"] != "verschwunden"
            && row["id"]
                .as_str()
                .is_some_and(|id| !superseded.contains(id))
            && old_content_safe(row)
    });
    let mut matched = HashSet::new();
    let mut results = Vec::new();
    for mut pattern in new {
        let exact = old
            .iter()
            .find(|row| row["patternKey"] == pattern["patternKey"]);
        let best = exact.or_else(|| {
            old.iter()
                .map(|row| (row, similarity(&pattern, row)))
                .filter(|(_, score)| *score >= 0.78)
                .fold(None, |best: Option<(&Value, f64)>, item| {
                    if best.is_none_or(|(_, score)| item.1 > score) {
                        Some(item)
                    } else {
                        best
                    }
                })
                .map(|(row, _)| row)
        });
        if let Some(prior) = best {
            let n = pattern["memberCount"].as_f64().unwrap_or(0.);
            let previous = prior["memberCount"].as_f64().unwrap_or(0.);
            let change = if n > previous * 1.3 && n - previous >= 3. {
                "stärker"
            } else if n < previous * 0.7 {
                "schwächer"
            } else {
                "gleich"
            };
            pattern["trend"] = change.into();
            pattern["previousPatternId"] = prior["id"].clone();
            if let Some(id) = prior["id"].as_str() {
                matched.insert(id.to_owned());
            }
        } else {
            pattern["trend"] = "neu".into();
            pattern["previousPatternId"] = Value::Null;
        }
        results.push(pattern);
    }
    for row in old {
        if row["id"].as_str().is_some_and(|id| !matched.contains(id)) {
            let mut retained = json!({});
            for name in [
                "id",
                "patternKey",
                "memberCount",
                "memberIds",
                "representativeMemberIds",
                "patternName",
                "description",
                "emotionalTrajectory",
                "participants",
                "relatedTopics",
                "confidence",
            ] {
                if let Some(value) = row.get(name) {
                    retained[name] = value.clone();
                }
            }
            retained["previousPatternId"] = row["id"].clone();
            retained["trend"] = "verschwunden".into();
            results.push(retained);
        }
    }
    results
}

fn old_content_safe(row: &Value) -> bool {
    parse(&row.to_string()).is_some()
}

fn similarity(left: &Value, right: &Value) -> f64 {
    let field = |name| {
        let a: HashSet<_> = strings(left, name).collect();
        let b: HashSet<_> = strings(right, name).collect();
        let total = a.union(&b).count();
        if total == 0 {
            0.
        } else {
            a.intersection(&b).count() as f64 / total as f64
        }
    };
    field("relatedTopics") * 0.6 + field("participants") * 0.4
}
