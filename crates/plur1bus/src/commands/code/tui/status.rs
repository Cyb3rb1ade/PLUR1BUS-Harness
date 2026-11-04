//! Read-only status projections. Missing or refused telemetry stays unknown, never an invented zero.
use serde_json::Value;

#[derive(Debug, PartialEq, Eq)]
pub(super) struct Limit {
    pub scope: String,
    pub period: String,
    pub used: u64,
    pub soft: Option<u64>,
    pub hard: Option<u64>,
    pub state: String,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum Budget {
    Unlimited,
    Limits(Vec<Limit>),
}

#[derive(Default)]
pub(super) struct Status {
    pub model: Option<String>,
    pub tokens: Option<(u64, u64)>,
    pub cache: Option<f64>,
    pub budget: Option<Budget>,
}

impl Status {
    /// Project the actual effective model selection, without provider settings or credentials.
    pub fn read_model(&mut self, value: &Value) {
        self.model = value["profile"]
            .as_str()
            .or_else(|| value["defaultProfile"].as_str())
            .map(|text| super::model::clipped(&super::super::render::safe(text, false), 256));
    }

    /// Only measured usage in a completed turn is labelled as the last completed turn's tokens.
    pub fn usage(&mut self, data: &Value) {
        self.tokens = data["usage"]["inputTokens"]
            .as_u64()
            .zip(data["usage"]["outputTokens"].as_u64());
    }

    /// Aggregate this session's cache reads across its reported models, weighted by actual input.
    pub fn read_cache(&mut self, value: &Value, session: &str, agent: &str) {
        self.cache = (|| {
            let reported = value.get("session")?;
            if reported["sessionId"].as_str()? != session || reported["agentId"].as_str()? != agent
            {
                return None;
            }
            let rows = reported["models"].as_array()?;
            if rows.len() > 512 {
                return None;
            }
            let (mut input, mut read) = (0u128, 0u128);
            for row in rows {
                let total = row["totalInputTokens"].as_u64()?;
                let cached = row["cacheReadTokens"].as_u64()?;
                if cached > total {
                    return None;
                }
                input = input.checked_add(u128::from(total))?;
                read = read.checked_add(u128::from(cached))?;
            }
            (input > 0).then(|| read as f64 / input as f64)
        })();
    }

    /// Show token limits for the selected agent and global scope; other media units remain separate.
    pub fn read_budget(&mut self, value: &Value, agent: &str) {
        self.budget = (|| {
            let rows = value["limits"].as_array()?;
            if rows.len() > 1024 {
                return None;
            }
            let mut limits = Vec::new();
            for row in rows {
                match row["metric"].as_str()? {
                    "images" | "videoSeconds" => continue,
                    "tokens" => {}
                    _ => return None,
                }
                let scope = row["scope"].as_str()?;
                match scope {
                    "agent" if row["agentId"].as_str()? != agent => continue,
                    "agent" | "global" => {}
                    _ => return None,
                }
                let period = row["period"].as_str()?;
                let state = row["state"].as_str()?;
                if !matches!(period, "day" | "month") || !matches!(state, "ok" | "soft" | "hard") {
                    return None;
                }
                limits.push(Limit {
                    scope: scope.into(),
                    period: period.into(),
                    used: row["used"].as_u64()?,
                    soft: optional_count(row.get("soft"))?,
                    hard: optional_count(row.get("hard"))?,
                    state: state.into(),
                });
            }
            Some(if limits.is_empty() {
                Budget::Unlimited
            } else {
                Budget::Limits(limits)
            })
        })();
    }
}

fn optional_count(value: Option<&Value>) -> Option<Option<u64>> {
    let value = value?;
    if value.is_null() {
        Some(None)
    } else {
        value.as_u64().map(Some)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn model_and_tokens_are_projected_from_reported_values_and_keep_unknowns_honest() {
        let mut status = Status::default();
        status.read_model(&json!({"profile":null,"defaultProfile":"local-coder"}));
        assert_eq!(status.model.as_deref(), Some("local-coder"));
        status.usage(
            &json!({"usage":{"model":"provider/model","inputTokens":120,"outputTokens":34}}),
        );
        assert_eq!(status.tokens, Some((120, 34)));
        status.usage(&json!({"usage":{"inputTokens":-1,"outputTokens":4}}));
        assert_eq!(status.tokens, None);
        assert_eq!(status.cache, None);
        assert_eq!(status.budget, None);
        status.read_model(&json!({}));
        assert_eq!(status.model, None);
    }

    #[test]
    fn cache_uses_only_the_bound_session_and_weights_actual_input_instead_of_averaging_ratios() {
        let mut status = Status::default();
        let value = json!({"session":{"sessionId":"s","agentId":"a","models":[
            {"totalInputTokens":100,"cacheReadTokens":90,"hitRatio":0.9},
            {"totalInputTokens":900,"cacheReadTokens":0,"hitRatio":0.0}
        ]}});
        status.read_cache(&value, "s", "a");
        assert!((status.cache.expect("measured cache") - 0.09).abs() < 0.000001);
        status.read_cache(&value, "other-session", "a");
        assert_eq!(status.cache, None);
        status.read_cache(
            &json!({"session":{"sessionId":"s","agentId":"a","models":[]}}),
            "s",
            "a",
        );
        assert_eq!(status.cache, None);
    }

    #[test]
    fn budget_preserves_actual_global_and_own_limits_and_only_valid_success_can_mean_unlimited() {
        let mut status = Status::default();
        status.read_budget(&json!({}), "a");
        assert_eq!(status.budget, None);
        status.read_budget(&json!({"limits":[{"scope":"global","period":"day","metric":"tokens","soft":null,"hard":10,"used":-1,"state":"ok"}]}), "a");
        assert_eq!(status.budget, None);
        status.read_budget(&json!({"limits":[]}), "a");
        assert_eq!(status.budget, Some(Budget::Unlimited));
        status.read_budget(&json!({"limits":[
            {"scope":"global","period":"day","metric":"tokens","soft":100,"hard":200,"used":150,"state":"soft"},
            {"scope":"agent","agentId":"a","period":"month","metric":"tokens","soft":null,"hard":1000,"used":90,"state":"ok"},
            {"scope":"agent","agentId":"another","period":"day","metric":"tokens","soft":null,"hard":1,"used":1,"state":"hard"},
            {"scope":"global","period":"day","metric":"images","soft":null,"hard":5,"used":2,"state":"ok"}
        ]}), "a");
        let Budget::Limits(limits) = status.budget.expect("reported limits") else {
            panic!("token limits")
        };
        assert_eq!(limits.len(), 2);
        assert_eq!(limits[0].used, 150);
        assert_eq!(limits[0].state, "soft");
        assert_eq!(limits[1].period, "month");
        assert_eq!(limits[1].hard, Some(1000));
    }
}
