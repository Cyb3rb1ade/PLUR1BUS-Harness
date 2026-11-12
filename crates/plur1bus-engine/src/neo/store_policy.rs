//! Controller N1 settings. Append bounds are independent of scheduled retention.
use super::{
    derived_fields::validate_object,
    merged_order::{date, field},
};
use crate::{
    config::{self, NATIVE_NEO_SCHEMA_JSON},
    contract::{EngineConfig, EngineError, StoreError},
    text::json::TolerantJsonValue as Json,
};
use serde_json::Value;

/// Validated native limits. No process environment or record-owned policy is consulted.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StorePolicy {
    /// Hard live-record ceiling; native acquisition still has its independent byte budget.
    pub max_records: usize,
    /// Tail for unindexed replay deduplication; never inferred from max_records.
    pub dedupe_tail_records: usize,
    /// Future maintenance minimum age; append never evaluates this value.
    pub retention_days: usize,
    /// Future maintenance soft limit; append never evaluates this value.
    pub retention_soft_max_records: usize,
}
impl StorePolicy {
    /// Resolve supplied host settings and defaults from the same versioned native schema.
    /// Pinned Node manifest helpers retain their original shape for bridge compatibility.
    pub fn from_config(config: &EngineConfig) -> Result<Self, EngineError> {
        let raw = serde_json::to_value(config).map_err(|_| StoreError::InvalidInput)?;
        config::normalize(&raw).map_err(|_| StoreError::InvalidInput)?;
        let schema: Value =
            serde_json::from_str(NATIVE_NEO_SCHEMA_JSON).map_err(|_| StoreError::Corrupt)?;
        let number = |keys: &[&str]| -> Result<usize, EngineError> {
            let mut supplied = &raw["neo"];
            let mut definition = &schema;
            for key in keys {
                supplied = &supplied[*key];
                definition = &definition["properties"][*key];
            }
            let value = if supplied.is_null() {
                &definition["default"]
            } else {
                supplied
            };
            let number = value
                .as_f64()
                .filter(|n| n.is_finite() && *n >= 1. && n.fract() == 0.)
                .ok_or(StoreError::InvalidInput)?;
            if number > 50000. {
                return Err(StoreError::InvalidInput.into());
            }
            Ok(number as usize)
        };
        Ok(Self {
            max_records: number(&["maxRecords"])?,
            dedupe_tail_records: number(&["appendDedupeTailRecords"])?,
            retention_days: number(&["retention", "days"])?,
            retention_soft_max_records: number(&["retention", "softMaxRecords"])?,
        })
    }
}

/// Newest usable release timestamp, in milliseconds. Numeric values below 1e12
/// are seconds. None means undated/fresh, never permission to discard a record.
/// This does not change C4 recall ordering and does not implement the RY-A retention job.
pub fn record_time_ms(row: &Json) -> Result<Option<f64>, EngineError> {
    validate_object(row)?;
    let mut newest: Option<f64> = None;
    for name in [
        "updatedAt",
        "lastReinforcedAt",
        "endTime",
        "startTime",
        "createdAt",
        "timestamp",
        "extractedAt",
        "processedAt",
        "queuedAt",
    ] {
        let Some(value) = field(row, name).filter(|value| !matches!(value, Json::Null)) else {
            continue;
        };
        let time = match value {
            Json::Number(raw) => raw.parse::<f64>().ok().map(|number| {
                if number < 1e12 {
                    number * 1000.
                } else {
                    number
                }
            }),
            _ => Some(date(value)),
        };
        if let Some(time) = time.filter(|time| time.is_finite()) {
            newest = Some(newest.map_or(time, |previous| previous.max(time)));
        }
    }
    Ok(newest)
}
