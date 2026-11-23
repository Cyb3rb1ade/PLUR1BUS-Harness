//! Agent-to-agent protocol projections and transport boundaries.
#![forbid(unsafe_code)]

pub mod card;
pub mod client;
pub mod endpoint;
pub mod events;
pub mod parts;
pub mod peer_card;
pub mod push;

use plur1bus_providers::provenance::{Origin, Provenance, Transformation, Trust};

fn peer_provenance(peer: &str, redacted: bool) -> Provenance {
    Provenance {
        origin: Origin {
            system: "a2a".into(),
            agent: None,
            principal: peer.into(),
            trust: Trust::Untrusted,
        },
        hops: 1,
        transformed_by: if redacted {
            vec![Transformation::Redact]
        } else {
            Vec::new()
        },
    }
}
