//! `packages/core/src/egress/` (P4-K K2, plan P4-21): the egress policy (B4), the per-hop gate, the dry run and counters
//! of the egress service, and the model-download exception; with them the address classification and the guarded
//! resolution of `tools/web/{ip,guard}.ts` the gate stands on. The TypeScript code is the specification.
//!
//! **Nothing here runs in the product.** No RPC method (`egress.status`, `egress.decide`, `host.egress.decide`), no Front Door
//! route and no supervisor hook reaches this module; the flip wires it. What it needs from the rest of the core comes in as
//! a trait (R-K-2): [`service::ConfigSource`] (the live `egress` section), [`guard::Resolver`] (name resolution) and
//! [`Idna`] (UTS 46 `domainToASCII`, see below). There is no network access in this module.
//!
//! **URLs.** The gate reads a URL with the `url` crate ([`parse_url`], R-K-17) and nothing else; [`Url`] holds the members it
//! judges, spelled as `new URL` spells them.
//!
//! **IDNA of configuration entries.** `domainToASCII` maps a host entry through the host parser of the URL Standard (UTS 46
//! case folding, NFC, Punycode, and the IPv4 parser for a name that ends in a number). That is a port, and the
//! implementation is [`HostIdna`], the host parser of the same `url` crate, so an entry and a URL are read by one parser.
//! The port may decline (`None`); a declined entry is a configuration error (deny-all, as any invalid entry). The tests
//! keep a double that declines, so that path stays proven.
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

/// The facts the gate reads from a URL, spelled as `new URL(raw)` spells them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Url {
    /// `URL.protocol` without the colon: the scheme in lower case.
    pub scheme: String,
    /// `URL.username`, percent-encoded; empty when there is none.
    pub username: String,
    /// `URL.password`, percent-encoded; empty when there is none.
    pub password: String,
    /// `URL.hostname`: a domain in its ASCII form, an IPv4 address as four decimal numbers, an IPv6 address in brackets;
    /// empty when the URL has no host.
    pub hostname: String,
    /// `URL.port`: `None` when the URL names no port or names the default port of its scheme.
    pub port: Option<u16>,
}

impl Url {
    /// `URL.protocol`.
    pub fn protocol(&self) -> String {
        format!("{}:", self.scheme)
    }
}

impl Url {
    /// The gate's members of a URL the `url` crate has parsed.
    pub fn of(url: &url::Url) -> Url {
        Url {
            scheme: url.scheme().to_owned(),
            username: url.username().to_owned(),
            password: url.password().unwrap_or_default().to_owned(),
            // `host_str` keeps the brackets of an IPv6 address, as `URL.hostname` does.
            hostname: url.host_str().unwrap_or_default().to_owned(),
            // `port` is already `None` for the default port of the scheme; `port_or_known_default` would name it.
            port: url.port(),
        }
    }
}

/// `new URL(raw)`, or `None` where the constructor throws.
///
/// The reader is the `url` crate (R-K-17): a complete parser of the URL Standard, held against Node on a hostile corpus
/// (`fixtures/parity/egress/urls.json`). The gate does not read URLs with a parser of its own, because every spelling
/// that only one reader takes for an address or a name is a second way to write a host the policy lists. The one known
/// difference to Node is K2-D4: an `xn--` label that is not valid IDNA is refused here and kept by Node.
pub fn read_url(raw: &str) -> Option<url::Url> {
    let url = url::Url::parse(raw).ok()?;
    // The crate's port state stops at `\` whatever the scheme. The URL Standard ends the authority at `\` only for a special
    // scheme; for any other scheme a `\` in the host or after the port is a failure, and `new URL` throws. The gate refuses
    // those schemes either way, but as `invalid-url` in TypeScript, not as `scheme`.
    let special = matches!(
        url.scheme(),
        "http" | "https" | "ws" | "wss" | "ftp" | "file"
    );
    if !special && url.has_host() && backslash_after_userinfo(raw) {
        return None;
    }
    Some(url)
}

/// Whether the authority of a URL that is not special holds a `\` after its userinfo. The text is cleaned as the URL
/// Standard cleans it first (leading and trailing C0 controls and spaces, every tab and newline); the authority follows
/// `scheme://` and ends at the first `/`, `?` or `#`, and the userinfo ends at its last `@`.
fn backslash_after_userinfo(raw: &str) -> bool {
    let text: String = raw
        .trim_matches(|c: char| c <= ' ')
        .chars()
        .filter(|c| !matches!(c, '\t' | '\n' | '\r'))
        .collect();
    let Some(colon) = text.find(':') else {
        return false;
    };
    let Some(rest) = text.get(colon + 1..).and_then(|r| r.strip_prefix("//")) else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    authority
        .rsplit('@')
        .next()
        .is_some_and(|host_port| host_port.contains('\\'))
}

/// `new URL(raw)` for the facts the gate reads, or `None` where the constructor throws.
pub fn parse_url(raw: &str) -> Option<Url> {
    read_url(raw).map(|url| Url::of(&url))
}
