//! `session/tokens.ts`: the per-model token calibration (L14, an exponentially weighted average kept in session storage;
//! transcript rows stay immutable) and `catalogWindow`. `readOnlyCatalog` of `catalog.ts` reads discovery's catalogue file
//! and validates it with `discovery/catalog-store.ts`; it comes with discovery (P4-44) and is not here, only the
//! [`ReadCatalog`] port it implements.
use super::store::SessionStore;
use super::SessionError;
use crate::js::utf16_len;

/// `ContextModel`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContextModel {
    /// The provider.
    pub provider: String,
    /// The model id.
    pub model: String,
}

/// One entry of the catalogue as `catalogWindow` reads it.
#[derive(Clone, Debug, PartialEq)]
pub struct CatalogModel {
    /// The provider.
    pub provider: String,
    /// The model id.
    pub id: String,
    /// The context window, if the catalogue has one.
    pub context_window: Option<f64>,
}

/// `ReadCatalog`: a read-only view of the model catalogue (a port, R-K-2).
pub trait ReadCatalog {
    /// `read().models`.
    fn models(&self) -> Vec<CatalogModel>;
}

fn is_safe_integer(n: f64) -> bool {
    n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0
}

/// `catalogWindow`: the first catalogue entry for the model, if its window is a positive safe integer.
pub fn catalog_window(catalog: &dyn ReadCatalog, model: &ContextModel) -> Option<i64> {
    let window = catalog
        .models()
        .into_iter()
        .find(|m| m.provider == model.provider && m.id == model.model)?
        .context_window?;
    (is_safe_integer(window) && window > 0.0).then_some(window as i64)
}

/// `TokenMeter.count`: a measured count when it is a non-negative safe integer, else the estimate of one token per four
/// UTF-16 units scaled by the model's calibration factor and rounded up.
pub fn count(
    store: &SessionStore,
    model: &str,
    text: &str,
    measured: Option<f64>,
) -> Result<i64, SessionError> {
    if let Some(m) = measured {
        if is_safe_integer(m) && m >= 0.0 {
            return Ok(m as i64);
        }
    }
    let factor = store.token_factor(model)?;
    let base = (utf16_len(text) as f64 / 4.0).ceil();
    Ok((base * factor).ceil() as i64)
}

/// `TokenMeter.observe`: folds one measured count into the model's factor: the ratio clamped to 0.25..=16, then
/// `0.8 * prior + 0.2 * ratio` (the first observation is the ratio itself). Nothing for an empty model, a non-finite or
/// non-positive estimate, or a measured count that is not a positive safe integer.
pub fn observe(
    store: &mut SessionStore,
    model: &str,
    estimated: f64,
    measured: f64,
) -> Result<(), SessionError> {
    if model.is_empty()
        || !estimated.is_finite()
        || estimated <= 0.0
        || !is_safe_integer(measured)
        || measured <= 0.0
    {
        return Ok(());
    }
    let ratio = 16.0_f64.min(0.25_f64.max(measured / estimated));
    let next = match store.token_calibration(model)? {
        None => ratio,
        Some(prior) => 0.8 * prior + 0.2 * ratio,
    };
    store.set_token_factor(model, next)
}
