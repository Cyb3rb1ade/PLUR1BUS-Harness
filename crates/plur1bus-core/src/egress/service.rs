//! The egress service (TypeScript: `egress/service.ts`, B4): the one object the rest of the core asks before it talks to the
//! network. It compiles the live configuration on each call (so a change of `egress.*` applies without a restart) and owns
//! the decision counters.
//!
//! Ported: `decide` (the dry run) and `status`. Not ported: `request`, the guarded HTTP client that pins the connect to the
//! vetted address and re-checks every redirect hop; it belongs to the web tools (P4-30), which will call
//! [`super::gate::Gate`] and [`super::guard::resolve_guarded`] per hop exactly as `decide` does here.
use super::gate::{bare_host, effective_port, is_loopback_host, Decision, DenyReason, Gate};
use super::guard::{resolve_guarded, AddressPolicy, Resolver};
use super::ip::Cidr;
use super::policy::{compile_egress_policy, host_allowed, EgressPolicy, HostMatch};
use super::{parse_url, Idna, ParsedUrl};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::Mutex;

/// The result of a dry run (`DryRun`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DryRun {
    /// The URL may be fetched: the host, port and the one address the connect is pinned to.
    Allowed {
        /// The host as the gate judged it (`bareHost`).
        host: String,
        /// The effective port.
        port: u16,
        /// The pinned address.
        address: String,
        /// Its family, `4` or `6`.
        family: u8,
    },
    /// The URL is refused.
    Denied {
        /// Why.
        reason: DenyReason,
        /// The text of the refusal.
        message: String,
    },
}

impl DryRun {
    /// The TypeScript object.
    pub fn json(&self) -> Value {
        match self {
            DryRun::Allowed {
                host,
                port,
                address,
                family,
            } => {
                json!({ "allowed": true, "host": host, "port": port, "address": address, "family": family })
            }
            DryRun::Denied { reason, message } => {
                json!({ "allowed": false, "reason": reason.as_str(), "message": message })
            }
        }
    }
}

/// The purpose of a dry run: ordinary egress, or an outbound A2A connection (exact names only, tailnet pins admitted).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Purpose {
    /// Ordinary egress.
    Ordinary,
    /// An outbound A2A connection.
    A2a,
}

/// Where the live configuration comes from (the `egress` section as JSON).
pub trait ConfigSource: Send + Sync {
    /// The current `egress` section of the configuration.
    fn egress_config(&self) -> Value;
}

#[derive(Default)]
struct Counters {
    allowed: u64,
    denied: BTreeMap<DenyReason, u64>,
}

impl Counters {
    fn record(&mut self, d: Decision) {
        match d {
            Decision::Allowed => self.allowed += 1,
            Decision::Denied(r) => *self.denied.entry(r).or_default() += 1,
        }
    }
}

/// `createEgress` without `request`.
pub struct Egress<'a> {
    config: &'a dyn ConfigSource,
    resolver: &'a dyn Resolver,
    idna: &'a dyn Idna,
    since: String,
    counters: Mutex<Counters>,
}

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

const fn v4(a: [u8; 4], prefix: u8) -> Cidr {
    Cidr {
        address: IpAddr::V4(Ipv4Addr::new(a[0], a[1], a[2], a[3])),
        prefix,
    }
}

const fn v6(g: [u16; 8], prefix: u8) -> Cidr {
    Cidr {
        address: IpAddr::V6(Ipv6Addr::new(
            g[0], g[1], g[2], g[3], g[4], g[5], g[6], g[7],
        )),
        prefix,
    }
}

/// `127.0.0.0/8`, `::1/128`.
const LOOPBACK: [Cidr; 2] = [v4([127, 0, 0, 0], 8), v6([0, 0, 0, 0, 0, 0, 0, 1], 128)];
/// `100.64.0.0/10`, `fd7a:115c:a1e0::/48`.
const TAILNET: [Cidr; 2] = [
    v4([100, 64, 0, 0], 10),
    v6([0xfd7a, 0x115c, 0xa1e0, 0, 0, 0, 0, 0], 48),
];
/// `100.100.100.200/32` (the Alibaba metadata address, inside the shared address space a tailnet uses).
const METADATA: [Cidr; 1] = [v4([100, 100, 100, 200], 32)];

/// `new Date(ms).toISOString()` for the `since` of `status`.
fn iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default()
}

/// RULING (TypeScript): the SSRF range check never relaxes through the egress configuration; loopback is admitted only
/// through `allowLoopback`, and only for a host that is itself a loopback spelling, so a public name answering 127.0.0.1
/// is a private-address refusal and `allowLoopback` cannot be used for rebinding. An A2A dry run admits tailnet pins for an
/// exactly listed host.
fn address_policy(p: &EgressPolicy, a2a: bool) -> AddressPolicy<'_> {
    AddressPolicy {
        allow: Vec::new(),
        deny: METADATA.to_vec(),
        for_host: Box::new(move |h: &str| {
            let exact = HostMatch {
                explicit_only: false,
                exact_only: true,
            };
            if p.allow_loopback && is_loopback_host(h) {
                LOOPBACK.to_vec()
            } else if a2a && host_allowed(p, h, exact) {
                TAILNET.to_vec()
            } else {
                Vec::new()
            }
        }),
    }
}

impl<'a> Egress<'a> {
    /// `createEgress({ config, resolver, now })`; `now_ms` is read once, for `since`.
    pub fn new(
        config: &'a dyn ConfigSource,
        resolver: &'a dyn Resolver,
        idna: &'a dyn Idna,
        now_ms: i64,
    ) -> Self {
        Egress {
            config,
            resolver,
            idna,
            since: iso(now_ms),
            counters: Mutex::new(Counters::default()),
        }
    }

    fn record(&self, d: Decision) {
        // A poisoned lock only means another thread panicked while counting; the counters are still counts.
        self.counters
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .record(d);
    }

    fn policy(&self) -> EgressPolicy {
        compile_egress_policy(&self.config.egress_config(), self.idna)
    }

    /// `decide(url, { purpose })`: judge one URL without connecting.
    pub fn decide(&self, raw: &str, purpose: Purpose) -> DryRun {
        let policy = self.policy();
        let denied = |reason: DenyReason, message: String| DryRun::Denied { reason, message };
        let url = match parse_url(raw, self.idna) {
            ParsedUrl::Ok(u) => u,
            ParsedUrl::Invalid => {
                self.record(Decision::Denied(DenyReason::InvalidUrl));
                return denied(DenyReason::InvalidUrl, "not a valid URL".to_owned());
            }
            ParsedUrl::NeedsIdna => {
                self.record(Decision::Denied(DenyReason::InvalidUrl));
                return denied(
                    DenyReason::InvalidUrl,
                    "the host needs IDNA, which this build cannot apply (fail closed)".to_owned(),
                );
            }
        };
        let mut gate = Gate::new(&policy, |d| self.record(d));
        if let Err(d) = gate.before_resolve(&url) {
            return denied(d.reason, d.message);
        }
        let a2a = purpose == Purpose::A2a;
        let exact = HostMatch {
            explicit_only: false,
            exact_only: true,
        };
        if a2a && !host_allowed(&policy, &bare_host(&url), exact) {
            self.record(Decision::Denied(DenyReason::HostNotAllowed));
            return denied(
                DenyReason::HostNotAllowed,
                "A2A requires an exact allowed host name or IP literal".to_owned(),
            );
        }
        let pin = match resolve_guarded(&url.hostname, self.resolver, &address_policy(&policy, a2a))
        {
            Ok(pin) => pin,
            Err(f) => {
                let reason = match f.code {
                    "private-address" => DenyReason::PrivateAddress,
                    "not-found" => DenyReason::NotFound,
                    _ => DenyReason::InvalidUrl,
                };
                if reason == DenyReason::PrivateAddress {
                    self.record(Decision::Denied(reason));
                }
                return denied(reason, f.message);
            }
        };
        if let Err(d) = gate.after_resolve(&url, &pin) {
            return denied(d.reason, d.message);
        }
        DryRun::Allowed {
            host: bare_host(&url),
            port: effective_port(&url),
            address: pin.address,
            family: pin.family,
        }
    }

    /// `status()`: the compiled policy, the decision counters and when they started.
    pub fn status(&self) -> Value {
        let p = self.policy();
        let c = self.counters.lock().unwrap_or_else(|e| e.into_inner());
        let by_reason: serde_json::Map<String, Value> = c
            .denied
            .iter()
            .map(|(r, n)| (r.as_str().to_owned(), json!(n)))
            .collect();
        json!({
            "policy": {
                "allowHosts": p.allow_hosts(),
                "allowPorts": p.allow_ports,
                "allowLoopback": p.allow_loopback,
                "valid": p.errors.is_empty(),
                "errors": p.errors,
            },
            "decisions": { "allowed": c.allowed, "denied": c.denied.values().sum::<u64>(), "byReason": by_reason },
            "since": self.since,
        })
    }
}
