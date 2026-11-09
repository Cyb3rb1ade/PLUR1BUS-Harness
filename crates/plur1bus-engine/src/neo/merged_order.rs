//! Stable revision and creation ordering, preserving lossless UTF-16 record identities.
use crate::text::{
    js::JsString,
    json::{parse_json, TolerantJsonValue as Json},
};
use std::collections::HashMap;
pub(super) fn field<'a>(value: &'a Json, name: &str) -> Option<&'a Json> {
    let Json::Object(fields) = value else {
        return None;
    };
    let key = JsString::from_utf8_str(name);
    fields.iter().rev().find(|(k, _)| *k == key).map(|(_, v)| v)
}
pub(super) fn truthy(value: &Json) -> bool {
    match value {
        Json::Null => false,
        Json::Bool(v) => *v,
        Json::Number(v) => v.parse::<f64>().is_ok_and(|n| n != 0. && !n.is_nan()),
        Json::String(v) => !v.is_empty(),
        _ => true,
    }
}
pub(crate) fn string(value: &Json) -> JsString {
    match value {
        Json::String(s) => s.clone(),
        Json::Array(items) => {
            let mut units = Vec::new();
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    units.push(u16::from(b','));
                }
                if !matches!(item, Json::Null) {
                    units.extend_from_slice(string(item).as_utf16_units());
                }
            }
            JsString::from_utf16_units(units)
        }
        Json::Number(n) => JsString::from_utf8_str(
            ryu_js::Buffer::new().format(n.parse::<f64>().unwrap_or(f64::NAN)),
        ),
        Json::Bool(v) => JsString::from_utf8_str(if *v { "true" } else { "false" }),
        Json::Null => JsString::from_utf8_str("null"),
        Json::Object(_) => JsString::from_utf8_str("[object Object]"),
    }
}
fn date(value: &Json) -> f64 {
    match value {
        Json::Number(n) => n
            .parse::<f64>()
            .ok()
            .filter(|n| n.is_finite())
            .unwrap_or(f64::NEG_INFINITY),
        Json::Bool(v) => {
            if *v {
                1.
            } else {
                0.
            }
        }
        Json::String(s) => {
            let s = s.to_utf8_lossy();
            let s = if s.len() == 4 && s.bytes().all(|b| b.is_ascii_digit()) {
                format!("{s}-01-01")
            } else {
                s
            };
            chrono::DateTime::parse_from_rfc3339(&s)
                .ok()
                .map(|d| d.timestamp_millis() as f64)
                .or_else(|| {
                    chrono::NaiveDate::parse_from_str(&s, "%Y-%m-%d")
                        .ok()?
                        .and_hms_opt(0, 0, 0)
                        .map(|d| d.and_utc().timestamp_millis() as f64)
                })
                .unwrap_or(f64::NEG_INFINITY)
        }
        _ => f64::NEG_INFINITY,
    }
}
pub(super) fn time(row: &Json, revision: bool) -> f64 {
    let names: &[&str] = if revision {
        &["updatedAt", "startTime", "createdAt"]
    } else {
        &["startTime", "createdAt"]
    };
    names
        .iter()
        .find_map(|name| field(row, name).filter(|v| !matches!(v, Json::Null)))
        .map_or(f64::NEG_INFINITY, date)
}
pub(super) fn record_id(row: &Json) -> Option<JsString> {
    field(row, "id")
        .filter(|v| truthy(v))
        .map(string)
        .filter(|s| !s.is_empty())
}
#[derive(Clone)]
pub(super) struct Sourced {
    pub metadata: Json,
    pub legacy: bool,
}
pub(super) fn merge(canonical: &[String], legacy: &[String]) -> Vec<Sourced> {
    let mut rows: Vec<Sourced> = Vec::new();
    let mut ids: HashMap<JsString, usize> = HashMap::new();
    let mut anonymous = Vec::new();
    for (line, from_legacy) in legacy
        .iter()
        .map(|v| (v, true))
        .chain(canonical.iter().map(|v| (v, false)))
    {
        let Ok(row) = parse_json(line) else {
            continue;
        };
        if !truthy(&row) {
            continue;
        }
        let Some(id) = record_id(&row) else {
            anonymous.push(Sourced {
                metadata: row,
                legacy: from_legacy,
            });
            continue;
        };
        if let Some(&index) = ids.get(&id) {
            if time(&row, true) >= time(&rows[index].metadata, true) {
                rows[index] = Sourced {
                    metadata: row,
                    legacy: from_legacy,
                };
            }
        } else {
            ids.insert(id, rows.len());
            rows.push(Sourced {
                metadata: row,
                legacy: from_legacy,
            });
        }
    }
    rows.extend(anonymous);
    rows.sort_by(|a, b| {
        time(&a.metadata, false)
            .partial_cmp(&time(&b.metadata, false))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    rows
}
pub(super) fn select(rows: Vec<Sourced>, limit: usize) -> Vec<Sourced> {
    if rows.len() <= limit {
        return rows;
    }
    let mut indices: Vec<_> = (0..rows.len()).collect();
    indices.sort_by(|a, b| {
        time(&rows[*a].metadata, true)
            .partial_cmp(&time(&rows[*b].metadata, true))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.cmp(b))
    });
    let mut chosen = indices.split_off(indices.len() - limit);
    chosen.sort_unstable();
    rows.into_iter()
        .enumerate()
        .filter_map(|(i, row)| chosen.binary_search(&i).is_ok().then_some(row))
        .collect()
}
