//! RE-D27 full-prompt calibration boundary. Raw item counts stay reusable; normalized totals stay inclusive.

use super::calibration_store::Key;
use super::{
    methods, CalibrationError, CalibrationInfo, CalibrationStore, CountRequest,
    NormalizedTokenUsage, ObservationResult, ProfileUsage, PromptCountResult, TokenBounds,
    TokenCounter, TokenError, TokenMethod, TokenObservation, BASE_COUNT_VERSION,
    MAX_CALIBRATION_COUNT, MAX_CALIBRATION_KEY_BYTES,
};
use crate::cache_profiles::CacheUsageMap;

/// Convert host-extracted numeric components using the host-selected row/gateway/wire usage map.
/// Inclusive input passes through. Exclusive input requires all three disjoint components; absence
/// stays unknown and checked addition rejects overflow. Never use this on normalized usage.
pub fn normalize_profile_usage(
    map: &CacheUsageMap,
    usage: &ProfileUsage,
) -> Result<NormalizedTokenUsage, CalibrationError> {
    let input_total = if map.input_includes_cache {
        usage.input
    } else {
        match (usage.input, usage.cache_read, usage.cache_write) {
            (Some(input), Some(read), Some(write)) => Some(
                input
                    .checked_add(read)
                    .and_then(|sum| sum.checked_add(write))
                    .ok_or(CalibrationError::Overflow)?,
            ),
            _ => None,
        }
    };
    Ok(NormalizedTokenUsage {
        input_total,
        cache_read: usage.cache_read,
        cache_write: usage.cache_write,
    })
}

impl TokenCounter {
    /// Persist a validated observation batch atomically. Missing totals are unaccepted, explicit zero
    /// is retained, and invalid keys/base versions/calibrated feedback reject the entire batch.
    /// Counts above 2^53-1 are refused to keep integer learning inputs exactly representable as f64.
    pub fn observe(
        &self,
        store: &mut CalibrationStore,
        observations: &[TokenObservation],
    ) -> Result<ObservationResult, CalibrationError> {
        let mut result = ObservationResult {
            accepted: 0,
            missing_input: 0,
        };
        for observation in observations {
            self.validate_calibration_key(&Key::from_observation(observation))?;
            validate_counts(observation.base.tokens, observation.reported.input_total)?;
            if observation.reported.input_total.is_some() {
                result.accepted += 1;
            } else {
                result.missing_input += 1;
            }
        }
        if result.accepted > 0 {
            store.append(observations)?;
        }
        Ok(result)
    }

    /// Count one complete prompt by summing raw items then applying one route-specific affine fit.
    /// Returns the unchanged raw result alongside the prompt total. No route or no usable fit preserves
    /// the raw method and summed bounds. Prediction does not read or write the filesystem.
    pub fn count_prompt(
        &self,
        request: &CountRequest,
        store: &CalibrationStore,
    ) -> Result<PromptCountResult, TokenError> {
        let base = self.count(request)?;
        let mut total = TokenBounds::default();
        for item in &base.items {
            methods::add(
                &mut total,
                TokenBounds {
                    tokens: item.tokens,
                    lower: item.lower,
                    upper: item.upper,
                },
            )?;
        }
        let fit = request
            .route
            .as_ref()
            .and_then(|route| store.fit(route, &base.family, base.method));
        let observations = request.route.as_ref().map_or(0, |route| {
            store.observations(route, &base.family, base.method)
        });
        let method = if let Some(fit) = fit {
            total = fit.predict(total.tokens);
            TokenMethod::Calibrated
        } else {
            base.method
        };
        Ok(PromptCountResult {
            base,
            total,
            method,
            calibration: CalibrationInfo {
                version: BASE_COUNT_VERSION,
                observations: observations as u64,
            },
            fit,
        })
    }

    pub(super) fn validate_calibration_key(&self, key: &Key) -> Result<(), CalibrationError> {
        if key.version != BASE_COUNT_VERSION || key.method == TokenMethod::Calibrated {
            return Err(CalibrationError::InvalidObservation(
                "incompatible base version or calibrated feedback",
            ));
        }
        if [
            &key.route.provider,
            &key.route.platform,
            &key.route.wire,
            &key.route.model,
            &key.family,
        ]
        .iter()
        .any(|part| part.is_empty() || part.len() > MAX_CALIBRATION_KEY_BYTES)
        {
            return Err(CalibrationError::InvalidObservation(
                "key fields must be nonempty and within the byte limit",
            ));
        }
        let request = CountRequest {
            family: None,
            route: Some(key.route.clone()),
            items: Vec::new(),
            cumulative: false,
        };
        let family = self
            .select_family(&request)
            .map_err(|_| CalibrationError::InvalidObservation("invalid route"))?;
        if family != key.family {
            return Err(CalibrationError::InvalidObservation(
                "route and tokenizer family disagree",
            ));
        }
        Ok(())
    }
}

pub(super) fn validate_counts(
    estimated: u64,
    reported: Option<u64>,
) -> Result<(), CalibrationError> {
    if estimated > MAX_CALIBRATION_COUNT
        || reported.is_some_and(|count| count > MAX_CALIBRATION_COUNT)
    {
        return Err(CalibrationError::InvalidObservation(
            "count exceeds exact floating-point integer range",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokenizers::{
        models::wordlevel::WordLevel, pre_tokenizers::whitespace::Whitespace, Tokenizer,
    };

    #[test]
    #[allow(clippy::unwrap_used)]
    fn exact_and_tokenizer_text_prompt_fits_leave_raw_methods_unchanged() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = CalibrationStore::open(directory.path()).unwrap();
        let mut counter = TokenCounter::heuristic().unwrap();
        // A real small tokenizer exercises both base methods without requiring installed artifacts.
        let model = WordLevel::builder()
            .vocab(
                [
                    ("hello".into(), 0),
                    ("world".into(), 1),
                    ("[UNK]".into(), 2),
                ]
                .into_iter()
                .collect(),
            )
            .unk_token("[UNK]".into())
            .build()
            .unwrap();
        let mut tokenizer = Tokenizer::new(model);
        tokenizer.with_pre_tokenizer(Some(Whitespace));
        counter.families.get_mut("o200k").unwrap().tokenizer = Some(tokenizer);
        let route = json!({"provider":"openai", "model":"gpt-5.5", "wire":"chat_completions", "platform":"first-party"});
        for (method, item) in [
            (TokenMethod::Exact, json!({"id":"a", "text":"hello world"})),
            (
                TokenMethod::TokenizerText,
                json!({"id":"a", "messages":[{"role":"user", "segments":[{"text":"hello world"}]}]}),
            ),
        ] {
            let samples: Vec<TokenObservation> = [10,20,30,40,50,60].into_iter().map(|x| {
                serde_json::from_value(json!({"route":route, "family":"o200k",
                    "base":{"tokens":x,"method":method,"version":1}, "reported":{"inputTotal":2*x+7}})).unwrap()
            }).collect();
            let request = serde_json::from_value(json!({"route":route, "items":[item]})).unwrap();
            let before = counter.count(&request).unwrap();
            assert_eq!(before.method, method);
            assert_eq!(before.items[0].tokens, 2);
            assert_eq!(
                counter.count_prompt(&request, &store).unwrap().method,
                method
            );
            counter.observe(&mut store, &samples).unwrap();
            let result = counter.count_prompt(&request, &store).unwrap();
            assert_eq!(result.base, before);
            assert_eq!(result.method, TokenMethod::Calibrated);
            assert_eq!(result.total.tokens, 11);
        }
    }
}
