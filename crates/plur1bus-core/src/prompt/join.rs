//! The harness's own join of recall blocks under a cap (spec §6.6; `packages/core/src/join.ts`): order preserved,
//! non-empty blocks separated by a blank line, clipping preferred to dropping, a non-droppable block never touched.
//! Lengths are UTF-16 code units, and a clip never ends on a high surrogate.
use crate::js::slice::safe_keep;

/// One recall block of the engine (`ContextBlock`; `chars` is recomputed here).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Block {
    /// The block's name, reported in a deferral.
    pub name: String,
    /// The text.
    pub text: String,
    /// Whether the host may clip or drop it.
    pub droppable: bool,
}

/// What happened to a block that did not fit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeferralKind {
    /// Shortened.
    Clipped,
    /// Removed.
    Dropped,
}

/// One clip or drop (`Deferral`), with lengths in code units.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Deferral {
    /// The block's name.
    pub block: String,
    /// Clipped or dropped.
    pub kind: DeferralKind,
    /// Length before.
    pub from: usize,
    /// Length after.
    pub to: usize,
    /// Always `global-cap` here.
    pub reason: &'static str,
}

const SEP: [u16; 2] = [0x0a, 0x0a];

/// `joinBlocks(blocks, capChars)`. A cap that is not a number counts as 0 (it must not switch the cap off); a
/// fractional cap is floored; `+Infinity` is "no cap".
pub fn join_blocks(blocks: &[Block], cap_chars: f64) -> (String, Vec<Deferral>) {
    let cap = if cap_chars.is_nan() {
        0.0
    } else {
        cap_chars.floor()
    };
    let mut parts: Vec<Vec<u16>> = blocks
        .iter()
        .map(|b| b.text.encode_utf16().collect())
        .collect();
    let mut deferrals: Vec<(usize, Deferral)> = Vec::new();
    let joined_len = |parts: &[Vec<u16>]| -> usize {
        let filled = parts.iter().filter(|p| !p.is_empty()).count();
        parts.iter().map(Vec::len).sum::<usize>() + SEP.len() * filled.saturating_sub(1)
    };
    loop {
        let over = joined_len(&parts) as f64 - cap;
        // `over > 0` in JavaScript; a NaN (`Infinity - Infinity`) ends the loop there too.
        if over.is_nan() || over <= 0.0 {
            break;
        }
        // Scanning from the last block backwards.
        let candidates: Vec<usize> = (0..parts.len())
            .rev()
            .filter(|i| blocks[*i].droppable && !parts[*i].is_empty())
            .collect();
        let Some(&last) = candidates.first() else {
            break;
        };
        let keep_of = |p: &[u16]| -> usize {
            if p.len() as f64 > over {
                // `over` is a whole number here: the cap was floored and the length is one.
                safe_keep(p, p.len() - over as usize)
            } else {
                0
            }
        };
        let clip = candidates.iter().copied().find(|i| keep_of(&parts[*i]) > 0);
        let (index, kind, to) = match clip {
            Some(i) => (i, DeferralKind::Clipped, keep_of(&parts[i])),
            None => (last, DeferralKind::Dropped, 0),
        };
        deferrals.push((
            index,
            Deferral {
                block: blocks[index].name.clone(),
                kind,
                from: parts[index].len(),
                to,
                reason: "global-cap",
            },
        ));
        parts[index].truncate(to);
    }
    let mut text: Vec<u16> = Vec::new();
    for part in parts.iter().filter(|p| !p.is_empty()) {
        if !text.is_empty() {
            text.extend_from_slice(&SEP);
        }
        text.extend_from_slice(part);
    }
    // Reported in block order; a block clipped and later dropped keeps that order (the sort is stable).
    deferrals.sort_by_key(|(index, _)| *index);
    (
        String::from_utf16_lossy(&text),
        deferrals.into_iter().map(|(_, d)| d).collect(),
    )
}
