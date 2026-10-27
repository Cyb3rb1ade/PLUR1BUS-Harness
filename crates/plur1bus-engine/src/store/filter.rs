//! Typed predicates for the persisted memory columns.
use crate::contract::MemoryScope;
use crate::text::js;
/// Optional predicates, combined with AND; an empty filter includes every row.
#[derive(Clone, Debug, Default)]
pub struct RowFilter {
    /// Owning agent.
    pub agent_id: Option<String>,
    /// Access scope.
    pub scope: Option<MemoryScope>,
    /// Persisted lifecycle status.
    pub status: Option<String>,
    /// Workspace principal.
    pub workspace_id: Option<String>,
    /// User principal.
    pub owner_user_id: Option<String>,
    /// Memory/reminder discriminator.
    pub memory_kind: Option<String>,
    /// Validity timestamp in milliseconds.
    pub valid_at: Option<i64>,
    /// Restrict to these memory IDs.
    pub ids: Option<Vec<String>>,
    /// Inclusive creation lower bound.
    pub since: Option<i64>,
    /// Inclusive creation upper bound.
    pub until: Option<i64>,
    /// Exact arbitrary category.
    pub category: Option<String>,
    /// Canonical source/origin.
    pub origin: Option<String>,
    /// Source alias kept independent from an explicit origin constraint, as in Node.
    pub source: Option<String>,
    /// Dominant emotion.
    pub emotion: Option<String>,
    /// Minimum persisted memory strength.
    pub min_importance: Option<f64>,
}

/// Quote a Lance string literal exactly like the Node SQL-safety helper.
pub fn sql_string(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "''"))
}
fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}
impl RowFilter {
    /// Render only fixed column names and safely quoted values.
    pub fn to_sql(&self) -> String {
        let mut clauses = Vec::new();
        for (column, value) in [
            ("agentId", &self.agent_id),
            ("status", &self.status),
            ("workspaceId", &self.workspace_id),
            ("ownerUserId", &self.owner_user_id),
            ("memoryKind", &self.memory_kind),
            ("category", &self.category),
            ("origin", &self.origin),
            ("origin", &self.source),
            ("emotionalDominant", &self.emotion),
        ] {
            if let Some(value) = value {
                clauses.push(format!("{column} = {}", sql_string(value)));
            }
        }
        if let Some(scope) = &self.scope {
            if let Ok(serde_json::Value::String(value)) = serde_json::to_value(scope) {
                clauses.push(format!("scope = {}", sql_string(&value)));
            }
        }
        if let Some(t) = self.valid_at {
            clauses.push(format!(
                "validFrom <= {t} AND (validUntil = 0 OR validUntil > {t})"
            ));
        }
        if let Some(t) = self.since {
            clauses.push(format!("createdAt >= {t}"));
        }
        if let Some(t) = self.until {
            clauses.push(format!("createdAt <= {t}"));
        }
        if let Some(value) = self.min_importance {
            clauses.push(format!("memoryStrength >= {value}"));
        }
        if let Some(ids) = &self.ids {
            let values = ids
                .iter()
                .filter(|id| uuid(id))
                .take(100)
                .map(|id| sql_string(id))
                .collect::<Vec<_>>();
            clauses.push(if values.is_empty() {
                "false".into()
            } else {
                format!("id IN ({})", values.join(","))
            });
        }
        if clauses.is_empty() {
            "true".into()
        } else {
            clauses.join(" AND ")
        }
    }
    /// Parse the Node list-filter suffix grammar, retaining an unknown prefix in the topic.
    pub fn parse(input: &str) -> ParsedFilter {
        let tokens = input
            .split(js::is_js_whitespace)
            .filter(|token| !token.is_empty())
            .collect::<Vec<_>>();
        let mut result = ParsedFilter {
            topic: String::new(),
            filter: Self::default(),
            errors: Vec::new(),
        };
        let mut end = tokens.len();
        for (index, token) in tokens.iter().enumerate().rev() {
            let Some((key, value)) = token.split_once(':').filter(|(key, _)| !key.is_empty())
            else {
                break;
            };
            let key = js::js_to_lower_case(key);
            let value = js::js_to_lower_case(js::js_trim(value));
            match key.as_str() {
                "über" | "about" | "cat" | "category" => result.filter.category = Some(value),
                "aus" | "source" | "src" | "origin" => {
                    let normalized = Some(
                        match value.as_str() {
                            "chat" | "konversation" | "conversation" | "direct" => "dm",
                            "gruppe" | "channel" => "group",
                            "sprachnotiz" | "audio" | "sprache" => "voice",
                            "notiz" | "notes" | "notizen" => "note",
                            "scheduled" | "automatisch" => "cron",
                            "intern" => "internal",
                            "git" => "github",
                            _ => &value,
                        }
                        .to_owned(),
                    );
                    if key == "origin" {
                        result.filter.origin = normalized;
                    } else {
                        result.filter.source = normalized;
                    }
                }
                "gefühl" | "emotion" | "mood" => result.filter.emotion = Some(value),
                "wichtig" | "min" | "important" | "minimportance" => {
                    let parsed = regex::Regex::new(
                        r"^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?",
                    )
                    .ok()
                    .and_then(|re| re.find(&value).and_then(|m| m.as_str().parse::<f64>().ok()));
                    match parsed {
                        Some(number) if (0.0..=1.0).contains(&number) => {
                            result.filter.min_importance = Some(number)
                        }
                        _ => result
                            .errors
                            .push("Wichtigkeit muss zwischen 0.0 und 1.0 liegen".into()),
                    }
                }
                "seit" | "after" | "von" | "bis" | "before" | "to" => {
                    if let Some(timestamp) = date(&value) {
                        if matches!(key.as_str(), "bis" | "before" | "to") {
                            result.filter.until = Some(timestamp + 86_399_999)
                        } else {
                            result.filter.since = Some(timestamp)
                        }
                    } else {
                        result
                            .errors
                            .push("Ungültiges Datum. Verwende YYYY-MM-DD".into())
                    }
                }
                "from" => {
                    result
                        .errors
                        .push("from: ist nicht eindeutig; aus: oder seit: verwenden".into());
                    break;
                }
                _ => break,
            }
            end = index;
        }
        result.topic = tokens[..end].join(" ");
        result
    }
}
/// Parsed topic, optional predicates and validation failures.
#[derive(Debug)]
pub struct ParsedFilter {
    /// The non-filter portion of the query.
    pub topic: String,
    /// Valid parsed predicates.
    pub filter: RowFilter,
    /// Validation failures without executing a query.
    pub errors: Vec<String>,
}
fn date(value: &str) -> Option<i64> {
    if value.len() != 10
        || value.as_bytes().iter().enumerate().any(|(index, byte)| {
            if index == 4 || index == 7 {
                *byte != b'-'
            } else {
                !byte.is_ascii_digit()
            }
        })
    {
        return None;
    }
    let year = value.get(..4)?.parse().ok()?;
    let month = value.get(5..7)?.parse().ok()?;
    let day = value.get(8..)?.parse::<u32>().ok()?;
    if !(1..=31).contains(&day) {
        return None;
    }
    let first = chrono::NaiveDate::from_ymd_opt(year, month, 1)?;
    Some(
        (first + chrono::Duration::days(i64::from(day) - 1))
            .and_hms_opt(0, 0, 0)?
            .and_utc()
            .timestamp_millis(),
    )
}
