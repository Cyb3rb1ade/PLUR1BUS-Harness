//! Bounded RPC access to the shared Rust tokenizer and numeric calibration store.
use super::methods::WireError;
use plur1bus_tokens::{CalibrationStore, CountRequest, TokenCounter, TokenObservation};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

pub(super) struct Tokens {
    state: PathBuf,
    counter: OnceLock<Result<TokenCounter, ()>>,
    calibration: Mutex<Option<CalibrationStore>>,
}

impl Tokens {
    pub(super) fn new(home: &Path) -> Self {
        Self {
            state: home.join("state"),
            counter: OnceLock::new(),
            calibration: Mutex::new(None),
        }
    }

    fn counter(&self) -> Result<&TokenCounter, WireError> {
        self.counter
            .get_or_init(|| {
                let installed = self.state.join("tokenizers");
                let configured = std::env::var_os("PLUR1BUS_TOKENIZER_DIR").map(PathBuf::from);
                TokenCounter::from_directory(configured.as_deref().unwrap_or(&installed))
                    .map_err(|_| ())
            })
            .as_ref()
            .map_err(|()| WireError::not_available())
    }

    pub(super) fn count(&self, params: &Value) -> Result<Value, WireError> {
        let request: CountRequest =
            serde_json::from_value(params.clone()).map_err(|_| WireError::invalid_params())?;
        // Prefix counts re-encode growing strings and repeat the item IDs in the response.
        // Bound the work and output across the whole request, including nested items.
        if request.cumulative {
            let messages = request
                .items
                .iter()
                .filter_map(|item| item.messages.as_deref())
                .flatten();
            let prefixes = messages
                .map(|message| message.segments.len().max(1))
                .sum::<usize>();
            if prefixes > 200 {
                return Err(WireError::invalid_params());
            }
        }
        encode(
            self.counter()?
                .count(&request)
                .map_err(|_| WireError::invalid_params())?,
        )
    }

    pub(super) fn families(&self) -> Result<Value, WireError> {
        encode(self.counter()?.families())
    }

    pub(super) fn observe(&self, params: &Value) -> Result<Value, WireError> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Observation {
            route: plur1bus_tokens::TokenRoute,
            family: String,
            estimated: plur1bus_tokens::BaseEstimate,
            reported: plur1bus_tokens::NormalizedTokenUsage,
        }
        let input: Vec<Observation> = serde_json::from_value(params["observations"].clone())
            .map_err(|_| WireError::invalid_params())?;
        let observations: Vec<_> = input
            .into_iter()
            .map(|entry| TokenObservation {
                route: entry.route,
                family: entry.family,
                base: entry.estimated,
                reported: entry.reported,
            })
            .collect();
        let mut calibration = self
            .calibration
            .lock()
            .map_err(|_| WireError::not_available())?;
        if calibration.is_none() {
            *calibration =
                Some(CalibrationStore::open(&self.state).map_err(|_| WireError::not_available())?);
        }
        let store = calibration.as_mut().ok_or_else(WireError::not_available)?;
        let result =
            self.counter()?
                .observe(store, &observations)
                .map_err(|error| match error {
                    plur1bus_tokens::CalibrationError::InvalidObservation(_)
                    | plur1bus_tokens::CalibrationError::Overflow => WireError::invalid_params(),
                    _ => WireError::not_available(),
                })?;
        encode(result)
    }
}

fn encode(value: impl Serialize) -> Result<Value, WireError> {
    serde_json::to_value(value).map_err(|_| WireError::internal())
}
