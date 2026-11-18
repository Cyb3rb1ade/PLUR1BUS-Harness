//! `packages/core/src/egress/` (P4-K K2, plan P4-21): the egress policy (B4), the per-hop gate, the dry run and counters
//! of the egress service, and the model-download exception; with them the address classification and the guarded
//! resolution of `tools/web/{ip,guard}.ts` the gate stands on. The TypeScript code is the specification.
//!
//! **Nothing here runs in the product.** No RPC method (`egress.status`, `egress.decide`, `host.egress.decide`), no Front Door
//! route and no supervisor hook reaches this module; the flip wires it. What it needs from the rest of the core comes in as
//! a trait (R-K-2): [`service::ConfigSource`] (the live `egress` section), [`guard::Resolver`] (name resolution) and
//! [`Idna`] (UTS 46 `domainToASCII`, see below). There is no network access in this module.
//!
//! **IDNA.** `new URL()` and `domainToASCII` map a host through UTS 46 (case folding, NFC, Punycode). This crate has no
//! IDNA implementation (`idna` 1.1.0 is in the lock file through `url`, but not a dependency of `plur1bus-core`), so it is a
//! port, and the only implementation here, [`AsciiIdna`], answers for plain ASCII names and declines everything else. A
//! declined name fails closed: a configuration entry that needs IDNA is a configuration error (deny-all, as any invalid
//! entry), and a URL whose host needs IDNA is refused as `invalid-url`. Where TypeScript would allow such a host, Rust
//! refuses it; the vectors carry a note on every such case and the replay checks that it is refused.
pub mod gate;
pub mod guard;
pub mod ip;
pub mod model_downloads;
pub mod policy;
pub mod service;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod vectors;

use crate::config::endpoint::Url;

/// `domainToASCII` (UTS 46 ToASCII as the URL Standard runs it). `None` means the port cannot answer for this input, and the
/// caller fails closed; `Some("")` is the empty string `domainToASCII` returns for an invalid domain.
pub trait Idna: Send + Sync {
    /// The ASCII form of `domain`, `Some("")` for an invalid one, `None` when this port cannot answer.
    fn domain_to_ascii(&self, domain: &str) -> Option<String>;
}

/// The IDNA of a build without an IDNA crate: exact for a domain of ASCII characters with no `xn--` label (UTS 46 then only
/// lower-cases it), and no answer for anything else.
#[derive(Clone, Copy, Debug, Default)]
pub struct AsciiIdna;

impl Idna for AsciiIdna {
    fn domain_to_ascii(&self, domain: &str) -> Option<String> {
        let lower = domain.to_ascii_lowercase();
        if !domain.is_ascii() || lower.split('.').any(|l| l.starts_with("xn--")) {
            return None;
        }
        Some(lower)
    }
}

/// The outcome of [`parse_url`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ParsedUrl {
    /// The URL as `new URL` reads it, with the host in its ASCII form.
    Ok(Url),
    /// `new URL(raw)` throws.
    Invalid,
    /// The host needs IDNA and the [`Idna`] port declined it.
    NeedsIdna,
}

/// `new URL(raw)` for the facts the gate reads: [`Url::parse`] (the configuration code's reader) followed by the IDNA step
/// of the host parser for a special scheme's domain.
pub fn parse_url(raw: &str, idna: &dyn Idna) -> ParsedUrl {
    let Some(mut url) = Url::parse(raw) else {
        return ParsedUrl::Invalid;
    };
    let special = matches!(url.scheme.as_str(), "http" | "https" | "ws" | "wss" | "ftp");
    if special && !url.hostname.starts_with('[') && ip::parse_address(&url.hostname, true).is_none()
    {
        match idna.domain_to_ascii(&url.hostname) {
            None => return ParsedUrl::NeedsIdna,
            Some(a) if a.is_empty() => return ParsedUrl::Invalid,
            Some(a) => url.hostname = a,
        }
    }
    ParsedUrl::Ok(url)
}
