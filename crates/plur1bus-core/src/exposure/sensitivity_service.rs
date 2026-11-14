//! `memory-sensitivity/service.ts`: `MemorySensitivityService` over [`MemorySensitivityStore`] and the task 2 scanner
//! (P4-12 task 7). A library: nothing calls it yet.
//!
//! The precedence rules are the TypeScript ones as they are: a manual label wins over any text and survives a content
//! change (inventory 14); a record found by content hash is copied to the asking card **including its source**, so a manual
//! label is copied as a manual label; a rule or model write never replaces a manual record (the store refuses it). The
//! clock is a constructor parameter (ruling R6): the TypeScript store reads `Date.now()` for every write the service makes
//! (inventory 13), here every write reads the injected clock at the moment of the write. The local-model hook is a closure
//! that answers at once (the TypeScript one is asynchronous); a failure of it is swallowed and the rules answer alone.
use super::scanner::{compute_content_hash, MemorySensitivityRecord, SensitivityScanner};
use super::sensitivity::SensitivityService;
use super::sensitivity_store::{ClearOutcome, MemorySensitivityStore, SensitivityError};
use crate::js::sort_default;
use plur1bus_log_schema::redact::RedactError;

/// The local model hook failed (the TypeScript promise rejected); the service falls back to the rules.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ModelFailure;

/// `localModelClassifier(text, summary)`.
pub type LocalModelClassifier =
    Box<dyn Fn(&str, Option<&str>) -> Result<Vec<String>, ModelFailure>>;

/// The clock: milliseconds since the epoch, `Date.now()`.
pub type Clock = Box<dyn Fn() -> i64>;

/// `MemorySensitivityServiceOptions`, plus the clock.
pub struct ServiceOptions {
    /// `store`.
    pub store: MemorySensitivityStore,
    /// The time of every write.
    pub clock: Clock,
    /// `scanner`; `None` builds the default scanner.
    pub scanner: Option<SensitivityScanner>,
    /// `localModelClassifier`.
    pub local_model_classifier: Option<LocalModelClassifier>,
}

/// A card's text for `setSensitivity`: `{ text, summary? }`.
#[derive(Clone, Copy, Debug)]
pub struct CardText<'a> {
    /// `text`
    pub text: &'a str,
    /// `summary`
    pub summary: Option<&'a str>,
}

/// `MemorySensitivityService`.
pub struct MemorySensitivityService {
    store: MemorySensitivityStore,
    scanner: SensitivityScanner,
    clock: Clock,
    local_model_classifier: Option<LocalModelClassifier>,
}

impl MemorySensitivityService {
    /// The constructor. Errors when the redaction data of the default scanner cannot be read.
    pub fn new(options: ServiceOptions) -> Result<Self, RedactError> {
        Ok(Self {
            store: options.store,
            scanner: match options.scanner {
                Some(s) => s,
                None => SensitivityScanner::new()?,
            },
            clock: options.clock,
            local_model_classifier: options.local_model_classifier,
        })
    }

    /// `service.store`.
    pub fn store(&self) -> &MemorySensitivityStore {
        &self.store
    }

    /// `assessCard(card)`: the record of the card when it is manual or its content hash is unchanged; else the categories of
    /// another record with the same content hash (copied with its source); else a fresh classification stored as `rule`.
    pub fn assess_card(
        &self,
        id: &str,
        text: &str,
        summary: Option<&str>,
    ) -> Result<Vec<String>, SensitivityError> {
        let hash = compute_content_hash(text, summary);
        if let Some(existing) = self.store.get(id)? {
            if existing.source == "manual" || existing.content_hash == hash {
                return Ok(existing.categories);
            }
        }
        if let Some(cached) = self.store.get_by_hash(&hash)? {
            self.store.set(
                id,
                &cached.categories,
                &cached.source,
                &hash,
                (self.clock)(),
            )?;
            return Ok(cached.categories);
        }
        let detected = self.assess_aggregate(text, summary);
        self.store
            .set(id, &detected, "rule", &hash, (self.clock)())?;
        Ok(detected)
    }

    /// `assessAggregate(text, summary)`: the scanner's categories plus those of the local model (a failing model adds
    /// nothing), in `Array.prototype.sort` order.
    pub fn assess_aggregate(&self, text: &str, summary: Option<&str>) -> Vec<String> {
        let mut detected: Vec<String> = self
            .scanner
            .scan(text, summary)
            .into_iter()
            .map(str::to_owned)
            .collect();
        if let Some(model) = &self.local_model_classifier {
            if let Ok(from_model) = model(text, summary) {
                for cat in from_model {
                    if !detected.contains(&cat) {
                        detected.push(cat);
                    }
                }
            }
        }
        sort_default(&mut detected);
        detected
    }

    /// `setSensitivity(cardId, categories, card?)`: a manual label. With the card's text the hash is computed from it;
    /// without, the hash of the existing record is kept, and `""` when there is none (inventory 3).
    pub fn set_sensitivity(
        &self,
        card_id: &str,
        categories: &[String],
        card: Option<CardText<'_>>,
    ) -> Result<MemorySensitivityRecord, SensitivityError> {
        let hash = match card {
            Some(c) => compute_content_hash(c.text, c.summary),
            None => self
                .store
                .get(card_id)?
                .map(|r| r.content_hash)
                .unwrap_or_default(),
        };
        self.store
            .set(card_id, categories, "manual", &hash, (self.clock)())
    }

    /// `clearSensitivity(cardId, category?)`.
    pub fn clear_sensitivity(
        &self,
        card_id: &str,
        category: Option<&str>,
    ) -> Result<ClearOutcome, SensitivityError> {
        self.store.clear(card_id, category, (self.clock)())
    }

    /// `hasManualCategories(categories)`: recall blocks lack reliable card membership, so manual exclusions are checked
    /// across all stored labels.
    pub fn has_manual_categories(&self, categories: &[String]) -> Result<bool, SensitivityError> {
        self.store.has_manual_categories(categories)
    }

    /// `getSensitivity(cardId)`.
    pub fn get_sensitivity(
        &self,
        card_id: &str,
    ) -> Result<Option<MemorySensitivityRecord>, SensitivityError> {
        self.store.get(card_id)
    }

    /// `close()`.
    pub fn close(self) {
        self.store.close();
    }
}

/// The two members the exposure filter reads (`memory-exposure/sensitivity.ts`).
impl SensitivityService<SensitivityError> for MemorySensitivityService {
    fn has_manual_categories(&self, filter: &[String]) -> Result<bool, SensitivityError> {
        MemorySensitivityService::has_manual_categories(self, filter)
    }

    fn assess_aggregate(&self, text: &str) -> Result<Vec<String>, SensitivityError> {
        Ok(MemorySensitivityService::assess_aggregate(self, text, None))
    }
}
