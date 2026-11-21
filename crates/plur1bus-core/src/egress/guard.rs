//! The SSRF guard's decision point (TypeScript: `tools/web/guard.ts`, D94 "Safety"): resolve a host, refuse anything that
//! is not positively public, and hand back ONE address to pin for the connect. The resolver is a port ([`Resolver`]), so a
//! test (and the flip) controls name resolution; this module never touches the network.
use super::ip::{canonical, classify, family, format_address, in_cidr, parse_address, Cidr};
use crate::js;
use std::net::IpAddr;

/// One answer of a resolver: the address as text and its family (`4` or `6`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedAddress {
    /// The address in `formatAddress` spelling.
    pub address: String,
    /// `4` or `6`.
    pub family: u8,
}

/// Name resolution (`Resolver` of `guard.ts`; `dns.lookup(host, { all: true, verbatim: true })` in production). It must
/// return every address; an error carries the resolver's code (`ENOTFOUND`, ...) when it has one.
pub trait Resolver: Send + Sync {
    /// Every address of `host`, or the error code of the lookup (`None` when it has none).
    fn resolve(&self, host: &str) -> Result<Vec<ResolvedAddress>, Option<String>>;
}

/// A `WebFailure` of the guard: `private-address`, `invalid-url` or `not-found`, with its message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WebFailure {
    /// `private-address`, `invalid-url` or `not-found`.
    pub code: &'static str,
    /// The text of the failure.
    pub message: String,
}

fn failure(code: &'static str, message: String) -> WebFailure {
    WebFailure { code, message }
}

/// The per-host allowance of an [`AddressPolicy`].
pub type HostAllowance<'a> = Box<dyn Fn(&str) -> Vec<Cidr> + 'a>;

/// `AddressPolicy`: extra allowances, mandatory exclusions (they win over any allowance) and a per-host allowance.
pub struct AddressPolicy<'a> {
    /// Ranges admitted although not public.
    pub allow: Vec<Cidr>,
    /// Ranges refused even when allowed (mandatory exclusions).
    pub deny: Vec<Cidr>,
    /// Ranges admitted for one host (the name as `resolveGuarded` normalised it).
    pub for_host: HostAllowance<'a>,
}

fn admit(a: IpAddr, policy: &AddressPolicy<'_>, host: &str) -> Result<ResolvedAddress, WebFailure> {
    let c = canonical(a);
    if policy.deny.iter().any(|cidr| in_cidr(c, cidr)) {
        return Err(failure("private-address", "address is excluded".to_owned()));
    }
    let verdict = classify(c);
    if !verdict.public
        && !policy.allow.iter().any(|cidr| in_cidr(c, cidr))
        && !(policy.for_host)(host).iter().any(|cidr| in_cidr(c, cidr))
    {
        return Err(failure(
            "private-address",
            format!(
                "{host} resolves to a non-public address ({})",
                verdict.reason.unwrap_or("undefined")
            ),
        ));
    }
    Ok(ResolvedAddress {
        address: format_address(c),
        family: family(c),
    })
}

/// `resolveGuarded`: resolve `host` and return the single address the connection must use. Refuses if ANY answer is not
/// public, so a name that mixes a public and an internal record cannot be used to reach the internal one.
pub fn resolve_guarded(
    host: &str,
    resolver: &dyn Resolver,
    policy: &AddressPolicy<'_>,
) -> Result<ResolvedAddress, WebFailure> {
    let mut name = js::to_lower_case(host.trim_matches(js::is_js_space));
    if name.len() >= 2 && name.starts_with('[') && name.ends_with(']') {
        name = name[1..name.len() - 1].to_owned();
    }
    if name.ends_with('.') {
        name.pop();
    }
    if name.is_empty()
        || name.encode_utf16().count() > 253
        || name
            .chars()
            .any(|c| js::is_js_space(c) || matches!(c, '/' | '\\' | '@'))
    {
        return Err(failure(
            "invalid-url",
            format!("invalid host {}", js::json_stringify(host)),
        ));
    }
    if let Some(literal) = parse_address(&name, false) {
        return admit(literal, policy, &name);
    }
    if name == "localhost" || name.ends_with(".localhost") {
        // Refused unless 127.0.0.0/8 is allowed for this host.
        return admit(IpAddr::from([127, 0, 0, 1]), policy, &name);
    }
    let answers = resolver.resolve(&name).map_err(|code| {
        failure(
            "not-found",
            format!(
                "could not resolve {name}: {}",
                code.as_deref().unwrap_or("lookup failed")
            ),
        )
    })?;
    if answers.is_empty() {
        return Err(failure(
            "not-found",
            format!("could not resolve {name}: no addresses"),
        ));
    }
    let mut first = None;
    for r in &answers {
        let Some(parsed) = parse_address(&r.address, false) else {
            return Err(failure(
                "private-address",
                format!("{name} resolved to an unparseable address"),
            ));
        };
        let admitted = admit(parsed, policy, &name)?;
        first.get_or_insert(admitted);
    }
    // `answers` is not empty, so `first` is set; the fallback only keeps the function total.
    first.ok_or_else(|| {
        failure(
            "not-found",
            format!("could not resolve {name}: no addresses"),
        )
    })
}
