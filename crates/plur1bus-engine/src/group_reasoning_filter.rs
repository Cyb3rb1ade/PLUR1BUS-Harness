//! Pure inbound filter. The host supplies the classified chat and the verified sender.
use crate::text::js::{js_trim, js_trim_start};
use sha2::{Digest, Sha256};

/// Kept in the pinned Node order.
pub const DEFAULT_PREFIXES: &[&str] = &[
    "🧠",
    "💭",
    "<think>",
    "<thinking>",
    "reasoning:",
    "thinking:",
];

/// Resolved by the channel adapter from trusted routing metadata.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChatKind {
    /// A one-to-one conversation.
    Direct,
    /// A group, supergroup or channel.
    Group,
}

/// Inputs are already normalized to the same sender identity namespace by the adapter.
pub struct Input<'a> {
    /// Trusted chat classification.
    pub chat: ChatKind,
    /// Effective filter setting.
    pub enabled: bool,
    /// Candidate bodies supplied by the adapter, including the bare body when available.
    pub bodies: &'a [&'a str],
    /// Verified individual sender identifier. A missing identity cannot earn an exception.
    pub sender: Option<&'a str>,
    /// Individually authorized identities from the channel configuration.
    pub allow_from: &'a [&'a str],
    /// Individually authorized identities from the group configuration.
    pub group_allow_from: &'a [&'a str],
    /// Empty selects the default prefix set.
    pub prefixes: &'a [&'a str],
}

/// Only a filter hit may carry a redacted identifier.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Decision {
    /// Continue routing.
    Pass,
    /// Claim the event without starting an agent turn or sending a reply.
    Ignore {
        /// SHA-256 digest of a verified sender if one is available.
        sender_hash: Option<String>,
    },
}

/// Check the start of each candidate body after an optional transport label.
pub fn classify(input: &Input<'_>) -> Decision {
    if !input.enabled || input.chat != ChatKind::Group {
        return Decision::Pass;
    }
    let sender = input.sender.filter(|sender| !js_trim(sender).is_empty());
    if sender.is_some_and(|sender| {
        !sender.contains('*')
            && input
                .allow_from
                .iter()
                .chain(input.group_allow_from)
                .any(|entry| *entry == sender)
    }) {
        return Decision::Pass;
    }
    let prefixes = if input.prefixes.is_empty() {
        DEFAULT_PREFIXES
    } else {
        input.prefixes
    };
    let prefixes = prefixes
        .iter()
        .map(|p| js_trim(p).to_lowercase())
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>();
    let matched = input.bodies.iter().any(|body| {
        let body = js_trim_start(body);
        [Some(body), strip_label(body)]
            .into_iter()
            .flatten()
            .any(|candidate| {
                let candidate = candidate.to_lowercase();
                prefixes.iter().any(|prefix| candidate.starts_with(prefix))
            })
    });
    if matched {
        Decision::Ignore {
            sender_hash: sender.map(|id| format!("{:x}", Sha256::digest(id.as_bytes()))),
        }
    } else {
        Decision::Pass
    }
}

fn strip_label(body: &str) -> Option<&str> {
    let end = if let Some(bracketed) = body.strip_prefix('[') {
        let end = bracketed.find(']')?;
        let label = &bracketed[..end];
        if !(1..=80).contains(&label.encode_utf16().count()) || label.contains('\n') {
            return None;
        }
        end + 2
    } else {
        let end = body.find(':')?;
        let label = &body[..end];
        if !(1..=61).contains(&label.encode_utf16().count()) || label.contains('\n') {
            return None;
        }
        end
    };
    let rest = body.get(end..)?.strip_prefix(':')?;
    let stripped = js_trim_start(rest);
    (rest.len() != stripped.len()).then_some(stripped)
}
