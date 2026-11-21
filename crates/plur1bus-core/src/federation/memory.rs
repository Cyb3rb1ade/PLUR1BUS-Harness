//! Loan memory metadata, replay receipts and disclosure labels. No text, import or acknowledgement transport.

use super::{
    loan::{Offer, Side, State},
    valid_id, Error,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

/// Disclosure level of one reference.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    /// May be used with attribution, without treating it as trusted instructions.
    Shareable,
    /// May inform decisions, with disclosure prohibited.
    Confidential,
    /// Must be excluded from foreign context.
    Private,
}

/// Content-free selected reference.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Reference {
    /// Scoped opaque memory identifier.
    pub id: String,
    /// Relationship within the foreign mission.
    pub person_key: String,
    /// Disclosure label.
    pub level: Level,
    /// Lowercase SHA-256 of the referenced content.
    pub content_hash: String,
}
/// One immutable item in the transfer descriptor.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Item {
    /// Opaque memory identifier.
    pub id: String,
    /// SHA-256 of the referenced content.
    pub content_hash: String,
}
/// Grouped, deterministic content references.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Batch {
    /// Mission.
    pub loan_id: String,
    /// Loaned agent.
    pub agent_id: String,
    /// Borrower imprint.
    pub borrower_fingerprint: String,
    /// Foreign relationship derived for the scope.
    pub relationship_key: String,
    /// Same disclosure label for the batch.
    pub level: Level,
    /// Unique item IDs, sorted ascending.
    pub items: Vec<Item>,
    /// SHA-256 of the stable descriptor.
    pub batch_id: String,
}
/// Receipt for the exact accepted batch.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Ack {
    /// Mission associated with the receipt.
    pub loan_id: String,
    /// Accepted batch ID.
    pub batch_id: String,
}
/// Speculative work in the outbox model.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct OutboxEntry {
    /// The batch it represents.
    pub batch: Batch,
    /// Derived only after the exact receipt matched.
    pub acknowledged: bool,
}
/// Portable import descriptor. It performs no import and carries no content.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Import {
    id: String,
    content_hash: String,
    relationship_key: String,
    level: Level,
    context: Context,
    origin: Origin,
    source_ref: String,
    tainted: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Context {
    kind: &'static str,
    mission_id: String,
}
#[derive(Debug, Serialize)]
struct Origin {
    system: String,
}
/// Receipt-model result. Persistence must be atomic with import when this is composed.
#[derive(Debug, Serialize)]
pub struct Received {
    /// Updated inbox batch descriptors.
    pub received: Vec<Batch>,
    /// Newly seen references.
    pub imports: Vec<Import>,
    /// Exact resulting acknowledgement.
    pub ack: Ack,
}
/// Retention outcome requested by the pure model.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Disposition {
    /// Remain in the running mission.
    MissionStore,
    /// Preserve in the outbox pending receipt.
    Outbox,
    /// Cleanup is permitted.
    Remove,
    /// Keep the mission copy as specified by the offer.
    RetainedCopy,
}
/// What a foreign-memory label allows downstream.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Use {
    /// Show with foreign provenance.
    ShowWithOrigin,
    /// Use only without disclosure.
    UseWithoutDisclosure,
    /// Exclude.
    Exclude,
}

const MAX_ITEMS: usize = 2048;
const MAX_BATCHES: usize = 256;
const MAX_RECEIPT_ITEMS: usize = 16_384;

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn memory(value: &Reference) -> Result<(), Error> {
    if !valid_id(&value.id) || !valid_id(&value.person_key) {
        return Err(Error("loan-memory-model: invalid memory id"));
    }
    if !valid_hash(&value.content_hash) {
        return Err(Error("loan-memory-model: invalid memory hash"));
    }
    Ok(())
}

impl Level {
    fn name(self) -> &'static str {
        match self {
            Self::Shareable => "shareable",
            Self::Confidential => "confidential",
            Self::Private => "private",
        }
    }
}
impl Batch {
    fn digest(&self) -> Result<String, Error> {
        let items: Vec<_> = self
            .items
            .iter()
            .map(|item| (&item.id, &item.content_hash))
            .collect();
        let data = serde_json::to_vec(&(
            &self.loan_id,
            &self.agent_id,
            &self.borrower_fingerprint,
            &self.relationship_key,
            self.level.name(),
            items,
        ))
        .map_err(|_| Error("loan-memory-model: invalid batch hash"))?;
        Ok(format!("{:x}", Sha256::digest(data)))
    }
    fn check(&self) -> Result<(), Error> {
        if [&self.loan_id, &self.agent_id, &self.borrower_fingerprint]
            .into_iter()
            .any(|id| !valid_id(id))
        {
            return Err(Error("loan-memory-model: invalid memory id"));
        }
        if !valid_hash(&self.batch_id) {
            return Err(Error("loan-memory-model: invalid memory hash"));
        }
        let prefix = format!("rel:{}:peer:{}:", self.agent_id, self.borrower_fingerprint);
        if !self
            .relationship_key
            .strip_prefix(&prefix)
            .is_some_and(valid_id)
        {
            return Err(Error("loan-memory-model: invalid batch relationship"));
        }
        if !(1..=MAX_ITEMS).contains(&self.items.len()) {
            return Err(Error("loan-memory-model: invalid batch items"));
        }
        let mut previous = "";
        for item in &self.items {
            if !valid_id(&item.id) {
                return Err(Error("loan-memory-model: invalid memory id"));
            }
            if !valid_hash(&item.content_hash) {
                return Err(Error("loan-memory-model: invalid memory hash"));
            }
            if item.id.as_str() <= previous {
                return Err(Error("loan-memory-model: invalid batch order or duplicate"));
            }
            previous = &item.id;
        }
        if self.digest()? != self.batch_id {
            return Err(Error("loan-memory-model: invalid batch hash"));
        }
        Ok(())
    }
    fn matches(&self, offer: &Offer) -> bool {
        self.loan_id == offer.loan_id
            && self.agent_id == offer.agent_id
            && self.borrower_fingerprint == offer.borrower_fingerprint
    }
}

/// Validate explicit home memory selection.
pub fn selected_home(values: &[Reference]) -> Result<Vec<Reference>, Error> {
    if values.len() > MAX_ITEMS {
        return Err(Error("loan-memory-model: invalid batch items"));
    }
    for entry in values {
        memory(entry)?;
        if entry.level == Level::Private {
            return Err(Error("loan-memory-model: private home memory"));
        }
    }
    Ok(values.to_vec())
}

/// Emit deterministic mission descriptors.
pub fn make_batches(state: &State, values: &[Reference]) -> Result<Vec<Batch>, Error> {
    if state.side() != Side::Borrower || state.project().is_none() {
        return Err(Error("loan-memory-model: borrower mission required"));
    }
    if values.len() > MAX_ITEMS {
        return Err(Error("loan-memory-model: invalid batch items"));
    }
    let offer = state.offer();
    let mut seen = BTreeSet::new();
    let mut groups = BTreeMap::<_, (Level, Vec<Item>)>::new();
    for entry in values {
        memory(entry)?;
        if !seen.insert(&entry.id) {
            return Err(Error("loan-memory-model: duplicate memory"));
        }
        let relation = format!(
            "rel:{}:peer:{}:{}",
            offer.agent_id, offer.borrower_fingerprint, entry.person_key
        );
        groups
            .entry((relation, entry.level.name()))
            .or_insert_with(|| (entry.level, Vec::new()))
            .1
            .push(Item {
                id: entry.id.clone(),
                content_hash: entry.content_hash.clone(),
            });
    }
    if groups.len() > MAX_BATCHES {
        return Err(Error("loan-memory-model: batch limit"));
    }
    groups
        .into_iter()
        .map(|((relationship_key, _), (level, mut items))| {
            items.sort_by(|a, b| a.id.cmp(&b.id));
            let mut batch = Batch {
                loan_id: offer.loan_id.clone(),
                agent_id: offer.agent_id.clone(),
                borrower_fingerprint: offer.borrower_fingerprint.clone(),
                relationship_key,
                level,
                items,
                batch_id: String::new(),
            };
            batch.batch_id = batch.digest()?;
            Ok(batch)
        })
        .collect()
}

type Known<'a> = BTreeMap<&'a str, (&'a str, &'a str, Level)>;

fn check_inbox<'a>(
    offer: &Offer,
    batch: &'a Batch,
    known: &mut Known<'a>,
    remember: bool,
) -> Result<(), Error> {
    batch.check()?;
    if !batch.matches(offer) {
        return Err(Error("loan-memory-model: foreign batch"));
    }
    for item in &batch.items {
        let identity = (
            item.content_hash.as_str(),
            batch.relationship_key.as_str(),
            batch.level,
        );
        if known
            .get(item.id.as_str())
            .is_some_and(|previous| *previous != identity)
        {
            return Err(Error("loan-memory-model: conflicting memory id"));
        }
        if remember {
            known.insert(&item.id, identity);
        }
    }
    Ok(())
}

/// Model receipt and newly seen imports over the same mission.
pub fn receive(received: &[Batch], offer: &Offer, batch: &Batch) -> Result<Received, Error> {
    offer.check()?;
    check_limits(received)?;
    let mut known = BTreeMap::new();
    for prior in received {
        check_inbox(offer, prior, &mut known, true)?;
    }
    check_inbox(offer, batch, &mut known, false)?;
    let mut received = received.to_vec();
    let replay = received
        .iter()
        .any(|prior| prior.batch_id == batch.batch_id);
    let imports = if replay {
        Vec::new()
    } else {
        if received.len() == MAX_BATCHES
            || total_items(&received).saturating_add(batch.items.len()) > MAX_RECEIPT_ITEMS
        {
            return Err(Error("loan-memory-model: receipt limit"));
        }
        let imports = batch
            .items
            .iter()
            .filter(|item| !known.contains_key(item.id.as_str()))
            .map(|item| Import {
                id: item.id.clone(),
                content_hash: item.content_hash.clone(),
                relationship_key: batch.relationship_key.clone(),
                level: batch.level,
                context: Context {
                    kind: "mission",
                    mission_id: offer.loan_id.clone(),
                },
                origin: Origin {
                    system: format!("peer:{}", offer.borrower_fingerprint),
                },
                source_ref: format!(
                    "mission:{}@{}#{}:{}",
                    offer.loan_id, offer.borrower_fingerprint, batch.batch_id, item.id
                ),
                tainted: true,
            })
            .collect();
        received.push(batch.clone());
        imports
    };
    Ok(Received {
        received,
        imports,
        ack: Ack {
            loan_id: offer.loan_id.clone(),
            batch_id: batch.batch_id.clone(),
        },
    })
}

fn total_items(batches: &[Batch]) -> usize {
    batches
        .iter()
        .map(|batch| batch.items.len())
        .fold(0, usize::saturating_add)
}

fn check_limits(batches: &[Batch]) -> Result<(), Error> {
    if batches.len() > MAX_BATCHES || total_items(batches) > MAX_RECEIPT_ITEMS {
        return Err(Error("loan-memory-model: receipt limit"));
    }
    Ok(())
}

/// Model a checked outbox.
pub fn outbox(batches: &[Batch]) -> Result<Vec<OutboxEntry>, Error> {
    check_limits(batches)?;
    batches
        .iter()
        .map(|batch| {
            batch.check()?;
            Ok(OutboxEntry {
                batch: batch.clone(),
                acknowledged: false,
            })
        })
        .collect()
}

/// Model exact acknowledgment of one batch. The host authenticates the acknowledgement.
pub fn acknowledge(outbox: &[OutboxEntry], ack: &Ack) -> Result<Vec<OutboxEntry>, Error> {
    if outbox.len() > MAX_BATCHES
        || outbox
            .iter()
            .map(|entry| entry.batch.items.len())
            .fold(0, usize::saturating_add)
            > MAX_RECEIPT_ITEMS
    {
        return Err(Error("loan-memory-model: receipt limit"));
    }
    let mut seen = false;
    let output = outbox
        .iter()
        .map(|entry| {
            entry.batch.check()?;
            let matched =
                entry.batch.loan_id == ack.loan_id && entry.batch.batch_id == ack.batch_id;
            seen |= matched;
            Ok(OutboxEntry {
                batch: entry.batch.clone(),
                acknowledged: entry.acknowledged || matched,
            })
        })
        .collect::<Result<Vec<_>, Error>>()?;
    if !seen {
        return Err(Error("loan-memory-model: unknown ack"));
    }
    Ok(output)
}

/// Compute retention from completed mission and exact acknowledgement.
pub fn disposition(offer: &Offer, acknowledged: bool, ended: bool) -> Disposition {
    match (ended, acknowledged, offer.keep_mission_copies) {
        (false, _, _) => Disposition::MissionStore,
        (true, false, _) => Disposition::Outbox,
        (true, true, true) => Disposition::RetainedCopy,
        (true, true, false) => Disposition::Remove,
    }
}

/// Resolve the confidentiality level.
pub fn foreign_use(level: Level) -> Use {
    match level {
        Level::Shareable => Use::ShowWithOrigin,
        Level::Confidential => Use::UseWithoutDisclosure,
        Level::Private => Use::Exclude,
    }
}

#[cfg(test)]
#[path = "memory_vectors.rs"]
mod vectors;
