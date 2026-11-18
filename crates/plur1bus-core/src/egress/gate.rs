//! The per-hop decision (TypeScript: `egress/gate.ts`, B4). [`Gate::before_resolve`] runs on the URL alone, so a name the
//! policy does not allow is never looked up; [`Gate::after_resolve`] runs on the one address the connect will be pinned
//! to. The SSRF range check itself is [`super::guard::resolve_guarded`]; the gate adds scheme, port, host allowlist and the
//! loopback rules.
use super::guard::ResolvedAddress;
use super::ip::{classify, parse_address};
use super::policy::{host_allowed, EgressPolicy, HostMatch};
use super::Url;

/// `DenyReason` of the gate and the service.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum DenyReason {
    /// The URL cannot be judged (no host, credentials, an empty label, or it does not parse).
    InvalidUrl,
    /// Not https (plain http only to a listed loopback host with `allowLoopback`).
    Scheme,
    /// The port is not in `egress.allowPorts`.
    Port,
    /// The host is not in `egress.allowHosts`.
    HostNotAllowed,
    /// A loopback pin that the rules refuse.
    Loopback,
    /// The SSRF guard refused an address.
    PrivateAddress,
    /// The name did not resolve.
    NotFound,
}

impl DenyReason {
    /// The TypeScript spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            DenyReason::InvalidUrl => "invalid-url",
            DenyReason::Scheme => "scheme",
            DenyReason::Port => "port",
            DenyReason::HostNotAllowed => "host-not-allowed",
            DenyReason::Loopback => "loopback",
            DenyReason::PrivateAddress => "private-address",
            DenyReason::NotFound => "not-found",
        }
    }
}

/// What the gate reports to its hook: one allowed connect, or a denial with its reason.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    /// An allowed connect (after the pin was checked).
    Allowed,
    /// A refusal, with its reason.
    Denied(DenyReason),
}

/// `EgressDenial`: a refusal of the gate.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Denial {
    /// Why the hop was refused.
    pub reason: DenyReason,
    /// The text of the refusal.
    pub message: String,
    /// The destination host of the hop that was refused (`bareHost`).
    pub host: String,
}

impl Denial {
    /// The `WebFailure` code the TypeScript error carries.
    pub fn code(&self) -> &'static str {
        if self.reason == DenyReason::PrivateAddress {
            "private-address"
        } else {
            "egress-denied"
        }
    }
}

/// `bareHost`: the URL hostname without IPv6 brackets, lower case, without one trailing dot.
pub fn bare_host(url: &Url) -> String {
    let h = url.hostname.as_str();
    // `hostname.slice(1, -1)`: without the bracket and without the last character, whatever that is. The members of
    // `Url` are public, so this must hold for a host no reader produces (`"["`, a bracket before a multi-byte character).
    let inner = match h.strip_prefix('[') {
        Some(rest) => {
            let mut chars = rest.chars();
            chars.next_back();
            chars.as_str()
        }
        None => h,
    };
    let mut out = crate::js::to_lower_case(inner);
    if out.ends_with('.') {
        out.pop();
    }
    out
}

/// `isLoopbackHost`: `localhost`, `*.localhost`, or an IP literal in 127/8 or `::1` (any spelling).
pub fn is_loopback_host(host: &str) -> bool {
    if host == "localhost" || host.ends_with(".localhost") {
        return true;
    }
    parse_address(host, false).is_some_and(|a| classify(a).reason == Some("loopback"))
}

/// `effectivePort`: the URL's port, or 443 for https and 80 for anything else.
pub fn effective_port(url: &Url) -> u16 {
    match url.port {
        Some(p) => p,
        None if url.scheme == "https" => 443,
        None => 80,
    }
}

/// `createGate(policy, hooks)`: the gate of one request (its hops share the hook).
pub struct Gate<'a> {
    policy: &'a EgressPolicy,
    on_decision: Box<dyn FnMut(Decision) + 'a>,
}

impl<'a> Gate<'a> {
    /// A gate over `policy` that reports every decision to `on_decision`.
    pub fn new(policy: &'a EgressPolicy, on_decision: impl FnMut(Decision) + 'a) -> Self {
        Gate {
            policy,
            on_decision: Box::new(on_decision),
        }
    }

    fn deny(&mut self, reason: DenyReason, message: String, host: &str) -> Result<(), Denial> {
        (self.on_decision)(Decision::Denied(reason));
        Err(Denial {
            reason,
            message,
            host: host.to_owned(),
        })
    }

    /// `beforeResolve`: scheme, host, credentials, labels, port and allowlist, on the URL alone.
    pub fn before_resolve(&mut self, url: &Url) -> Result<(), Denial> {
        let p = self.policy;
        let host = bare_host(url);
        let loopback_ok = p.allow_loopback && is_loopback_host(&host);
        if url.scheme != "https" && !(url.scheme == "http" && loopback_ok) {
            return self.deny(DenyReason::Scheme, format!("{} to {host} is not allowed (https only; http only to a listed loopback host when egress.allowLoopback is on)", url.protocol()), &host);
        }
        if host.is_empty() {
            return self.deny(DenyReason::InvalidUrl, "URL has no host".to_owned(), &host);
        }
        // The guarded client refuses these too; refusing here keeps the dry run and the dial in agreement.
        if !url.username.is_empty() || !url.password.is_empty() {
            return self.deny(
                DenyReason::InvalidUrl,
                "URLs with embedded credentials are refused".to_owned(),
                &host,
            );
        }
        // One trailing dot is the root label; an empty label anywhere else is not a name and must not be normalised onto
        // an allowlist entry.
        if host.starts_with('.') || host.ends_with('.') || host.contains("..") {
            return self.deny(
                DenyReason::InvalidUrl,
                format!("{host} has an empty label"),
                &host,
            );
        }
        let port = effective_port(url);
        if !p.allow_ports.contains(&port) {
            return self.deny(
                DenyReason::Port,
                format!("port {port} is not in egress.allowPorts"),
                &host,
            );
        }
        if !host_allowed(p, &host, HostMatch::default()) {
            return self.deny(
                DenyReason::HostNotAllowed,
                format!("{host} is not in egress.allowHosts"),
                &host,
            );
        }
        // `*` stands for public names; a loopback spelling must be listed on its own to be reachable.
        let explicit = HostMatch {
            explicit_only: true,
            exact_only: false,
        };
        if p.allow_loopback && is_loopback_host(&host) && !host_allowed(p, &host, explicit) {
            return self.deny(
                DenyReason::HostNotAllowed,
                format!(
                    "{host} is a loopback host and must be listed in egress.allowHosts by name"
                ),
                &host,
            );
        }
        Ok(())
    }

    /// `afterResolve`: the loopback and plain-http rules on the address the connect is pinned to.
    pub fn after_resolve(&mut self, url: &Url, pin: &ResolvedAddress) -> Result<(), Denial> {
        let host = bare_host(url);
        let loopback_pin = parse_address(&pin.address, false)
            .is_some_and(|a| classify(a).reason == Some("loopback"));
        if loopback_pin && !self.policy.allow_loopback {
            return self.deny(
                DenyReason::Loopback,
                format!("{host} resolved to a loopback address and egress.allowLoopback is off"),
                &host,
            );
        }
        // RULING (TypeScript): a public name that answers with a loopback address is rebinding-shaped; refused whatever
        // allowLoopback says.
        if loopback_pin && !is_loopback_host(&host) {
            return self.deny(
                DenyReason::Loopback,
                format!("{host} resolved to a loopback address"),
                &host,
            );
        }
        if url.scheme == "http" && !loopback_pin {
            return self.deny(
                DenyReason::Scheme,
                format!("plain http to {host} is only allowed for loopback"),
                &host,
            );
        }
        (self.on_decision)(Decision::Allowed);
        Ok(())
    }
}
