//! `packages/core/src/egress/` (P4-K K2, plan P4-21): the egress policy (B4), the per-hop gate, the dry run and counters
//! of the egress service, and the model-download exception; with them the address classification and the guarded
//! resolution of `tools/web/{ip,guard}.ts` the gate stands on. The TypeScript code is the specification.
//!
//! **Nothing here runs in the product.** No RPC method (`egress.status`, `egress.decide`, `host.egress.decide`), no Front Door
//! route and no supervisor hook reaches this module; the flip wires it. What it needs from the rest of the core comes in as
//! a trait (R-K-2): [`service::ConfigSource`] (the live `egress` section), [`guard::Resolver`] (name resolution) and
//! [`Idna`] (UTS 46 `domainToASCII`, see below). There is no network access in this module.
//!
//! **IDNA.** `new URL()` and `domainToASCII` map a host through UTS 46 (case folding, NFC, Punycode). That is a port, and
//! the implementation is [`HostIdna`], the host parser of the `url` crate. The port may decline (`None`); a declined name
//! fails closed: a configuration entry is then a configuration error (deny-all, as any invalid entry), and a URL is refused
//! as `invalid-url`. The tests keep a double that declines, so that path stays proven.
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

/// [`Idna`] as Node answers it. `domainToASCII(s)` sets `s` as the host name of a URL with a special scheme and reads it
/// back, so it is the host parser of the URL Standard, not UTS 46 alone: percent-decoding, UTS 46 with the forbidden domain
/// code points, and the IPv4 parser for a name that ends in a number (`0x7f.0x1` is `127.0.0.1`, `foo.0x` is invalid).
/// `url::Host::parse` is that parser. It always answers.
#[derive(Clone, Copy, Debug, Default)]
pub struct HostIdna;

impl Idna for HostIdna {
    fn domain_to_ascii(&self, domain: &str) -> Option<String> {
        Some(
            url::Host::parse(domain)
                .map(|h| h.to_string())
                .unwrap_or_default(),
        )
    }
}

/// A port that answers only for plain ASCII names and declines everything else: the double for the fail-closed path.
#[cfg(test)]
#[derive(Clone, Copy, Debug, Default)]
pub struct AsciiIdna;

#[cfg(test)]
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
