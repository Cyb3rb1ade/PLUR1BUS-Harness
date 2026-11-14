//! `memory-exposure/sensitivity.ts`: shared external-memory sensitivity filtering. It keeps the original block objects and
//! fails closed without a classifier. The TypeScript wraps `MemorySensitivityService`; this port takes the two methods it
//! calls over a trait (the service itself is task 7).

/// The two members of `MemorySensitivityService` the filtering calls. `E` is whatever a call can throw; the TypeScript
/// `assessAggregate` is asynchronous, a Rust implementation answers synchronously.
pub trait SensitivityService<E> {
    /// `hasManualCategories(filter)`: whether any manual label of a card falls in `filter`.
    fn has_manual_categories(&self, filter: &[String]) -> Result<bool, E>;
    /// `assessAggregate(text)`: the categories of a block of text.
    fn assess_aggregate(&self, text: &str) -> Result<Vec<String>, E>;
}

/// `SensitivitySource`: a service, or a function that yields one now.
pub enum SensitivitySource<'a, S> {
    /// The service itself (`None`: no classifier).
    Service(Option<&'a S>),
    /// `() => MemorySensitivityService | null | undefined`.
    Provider(&'a dyn Fn() -> Option<&'a S>),
}

/// `sensitivityService(source)`: a function source is called, a value is returned as it is.
pub fn sensitivity_service<'a, S>(source: &SensitivitySource<'a, S>) -> Option<&'a S> {
    match source {
        SensitivitySource::Service(s) => *s,
        SensitivitySource::Provider(f) => f(),
    }
}

/// The refusals of [`sensitivity_refusal`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SensitivityRefusal {
    /// `sensitivity-unavailable`: a filter is set and there is no classifier.
    Unavailable,
    /// `sensitivity-not-enforceable`: a manual label falls in the filter and aggregate blocks cannot be matched to it.
    NotEnforceable,
}

impl SensitivityRefusal {
    /// The wire string.
    pub fn as_str(self) -> &'static str {
        match self {
            SensitivityRefusal::Unavailable => "sensitivity-unavailable",
            SensitivityRefusal::NotEnforceable => "sensitivity-not-enforceable",
        }
    }
}

/// `sensitivityRefusal(filter, service)`: aggregate blocks cannot be matched reliably to manual card-id labels under the
/// current engine contract. An error of `has_manual_categories` propagates, as the thrown error does.
pub fn sensitivity_refusal<S: SensitivityService<E>, E>(
    filter: &[String],
    service: Option<&S>,
) -> Result<Option<SensitivityRefusal>, E> {
    if filter.is_empty() {
        return Ok(None);
    }
    let Some(service) = service else {
        return Ok(Some(SensitivityRefusal::Unavailable));
    };
    Ok(if service.has_manual_categories(filter)? {
        Some(SensitivityRefusal::NotEnforceable)
    } else {
        None
    })
}

/// A block of external memory: the filter reads its `text` only.
pub trait Block {
    /// The block's text.
    fn text(&self) -> &str;
}

/// `filterSensitiveBlocks(blocks, filter, service)`: a block can contain several cards; it is withheld in full if any of its
/// text belongs to an excluded category. The blocks come back as they went in (same items, same order). With a filter and no
/// classifier, or a refusal, nothing comes back. A manual label can be set while the classifier runs, so the refusal is
/// checked again before any text is released.
pub fn filter_sensitive_blocks<T: Block + Clone, S: SensitivityService<E>, E>(
    blocks: &[T],
    filter: &[String],
    service: Option<&S>,
) -> Result<Vec<T>, E> {
    if filter.is_empty() {
        return Ok(blocks.to_vec());
    }
    let Some(service) = service else {
        return Ok(Vec::new());
    };
    if sensitivity_refusal(filter, Some(service))?.is_some() {
        return Ok(Vec::new());
    }
    let mut kept = Vec::new();
    for block in blocks {
        let categories = service.assess_aggregate(block.text())?;
        if !categories.iter().any(|c| filter.contains(c)) {
            kept.push(block.clone());
        }
    }
    Ok(if sensitivity_refusal(filter, Some(service))?.is_some() {
        Vec::new()
    } else {
        kept
    })
}
