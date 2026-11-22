//! The egress policy as data (TypeScript: `egress/policy.ts`, B4): which destinations the core may talk to. Pure, no I/O.
//! Default deny: an empty host list allows nothing, and an invalid entry never widens the policy (the whole host list becomes
//! deny-all and the error is reported by `egress.status`).
//!
//! The live configuration is not trusted to be well typed, so it comes in as a JSON value, exactly as the TypeScript code
//! reads its (unchecked) `EgressConfig`.
use super::ip::{format_address, parse_address};
use super::Idna;
use crate::js;
use serde_json::{json, Value};

/// One compiled `egress.allowHosts` entry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HostRule {
    /// An exact name (normalised: lower case, ASCII, no trailing dot).
    Exact(String),
    /// `*.suffix`: subdomains of any depth, never the apex.
    Suffix(String),
    /// `*`: any name, never an IP literal.
    AnyName,
    /// An exact IP literal in `formatAddress` spelling.
    Ip(String),
}

impl HostRule {
    /// The rule as the TypeScript object (`{ kind, host }`, ...).
    pub fn json(&self) -> Value {
        match self {
            HostRule::Exact(h) => json!({ "kind": "exact", "host": h }),
            HostRule::Suffix(s) => json!({ "kind": "suffix", "suffix": s }),
            HostRule::AnyName => json!({ "kind": "any-name" }),
            HostRule::Ip(a) => json!({ "kind": "ip", "address": a }),
        }
    }

    /// The entry as normalised, for `egress.status`.
    pub fn spelling(&self) -> String {
        match self {
            HostRule::Exact(h) => h.clone(),
            HostRule::Suffix(s) => format!("*.{s}"),
            HostRule::AnyName => "*".to_owned(),
            HostRule::Ip(a) => a.clone(),
        }
    }
}

/// `EgressPolicy`: the compiled configuration.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EgressPolicy {
    /// The compiled `allowHosts`.
    pub host_rules: Vec<HostRule>,
    /// The allowed ports (empty after any configuration error).
    pub allow_ports: Vec<u16>,
    /// Whether a loopback host may be reached (off after any configuration error).
    pub allow_loopback: bool,
    /// Human-readable problems with the configuration; non-empty means the policy is deny-all.
    pub errors: Vec<String>,
}

impl EgressPolicy {
    /// The entries as normalised (`allowHosts` of the compiled policy).
    pub fn allow_hosts(&self) -> Vec<String> {
        self.host_rules.iter().map(HostRule::spelling).collect()
    }

    /// The compiled policy as the TypeScript object (the replay compares it whole).
    pub fn json(&self) -> Value {
        json!({
            "hostRules": self.host_rules.iter().map(HostRule::json).collect::<Vec<_>>(),
            "allowPorts": self.allow_ports,
            "allowLoopback": self.allow_loopback,
            "errors": self.errors,
            "allowHosts": self.allow_hosts(),
        })
    }
}

/// The outcome of `normaliseName` with an IDNA step that may be unable to answer.
enum Name {
    Ok(String),
    Invalid,
    /// The name needs IDNA and the [`Idna`] port cannot apply it: the caller fails closed.
    NeedsIdna,
}

/// `LABEL`: `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`.
fn label_ok(l: &str) -> bool {
    let b = l.as_bytes();
    let edge = |c: &u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    !b.is_empty()
        && b.len() <= 63
        && edge(&b[0])
        && edge(&b[b.len() - 1])
        && b.iter().all(|c| edge(c) || *c == b'-')
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn normalise_name(raw: &str, idna: &dyn Idna) -> Name {
    let mut n = js::to_lower_case(raw.trim_matches(js::is_js_space));
    if n.ends_with('.') {
        n.pop();
    }
    // `/[^\x21-\x7e\u0080-￿]/` runs on UTF-16 units, so an astral character (two surrogates) passes it.
    if n.is_empty()
        || utf16_len(&n) > 253
        || n.chars().any(|c| c <= ' ' || c == '\u{7f}')
        || n.chars()
            .any(|c| matches!(c, '/' | '\\' | '@' | ':' | '?' | '#' | '%') || js::is_js_space(c))
    {
        return Name::Invalid;
    }
    let ascii = match idna.domain_to_ascii(&n) {
        Some(a) => a,
        None => return Name::NeedsIdna,
    };
    if ascii.is_empty() || ascii.len() > 253 {
        return Name::Invalid;
    }
    let labels: Vec<&str> = ascii.split('.').collect();
    if !labels.iter().all(|l| label_ok(l)) {
        return Name::Invalid;
    }
    let last = labels[labels.len() - 1];
    if last.bytes().all(|b| b.is_ascii_digit()) {
        return Name::Invalid; // numeric last label = an IP spelling, not a name
    }
    Name::Ok(ascii)
}

/// `JSON.stringify(e.slice(0, 64))`: the first 64 UTF-16 units, escaped as JavaScript escapes them.
fn quoted_head(e: &str) -> String {
    let units: Vec<u16> = e.encode_utf16().take(64).collect();
    js::json_stringify_units(&units)
}

fn needs_idna(e: &str) -> String {
    format!(
        "host entry {} needs IDNA, which this build cannot apply (fail closed)",
        quoted_head(e)
    )
}

fn compile_host(entry: &Value, idna: &dyn Idna) -> Result<HostRule, String> {
    let Some(raw) = entry.as_str() else {
        return Err("host entry is not a string".to_owned());
    };
    let e = raw.trim_matches(js::is_js_space);
    if e == "*" {
        return Ok(HostRule::AnyName);
    }
    if parse_address(e, false).is_some() {
        return match parse_address(e, true) {
            Some(a) if e.starts_with('[') == a.is_ipv6() => Ok(HostRule::Ip(format_address(a))),
            _ => Err(format!(
                "host entry {} is not a canonical IP literal (IPv6 in brackets)",
                quoted_head(e)
            )),
        };
    }
    if let Some(rest) = e.strip_prefix("*.") {
        return match normalise_name(rest, idna) {
            Name::Ok(s) if !rest.contains('*') => Ok(HostRule::Suffix(s)),
            Name::NeedsIdna if !rest.contains('*') => Err(needs_idna(e)),
            _ => Err(format!(
                "host entry {} is not a valid wildcard",
                quoted_head(e)
            )),
        };
    }
    let name = if e.contains('*') {
        Name::Invalid
    } else {
        normalise_name(e, idna)
    };
    match name {
        Name::Ok(h) => Ok(HostRule::Exact(h)),
        Name::NeedsIdna => Err(needs_idna(e)),
        Name::Invalid => Err(format!(
            "host entry {} is not a valid host name",
            quoted_head(e)
        )),
    }
}

/// `Number.isInteger(p) && p >= 1 && p <= 65535` for a JSON value.
fn port_of(p: &Value) -> Option<u16> {
    let n = p.as_f64()?;
    (n.fract() == 0.0 && (1.0..=65535.0).contains(&n)).then_some(n as u16)
}

/// `compileEgressPolicy`. RULING (TypeScript): a configuration error never widens or half-applies the policy; any error
/// empties both lists and turns loopback off.
pub fn compile_egress_policy(cfg: &Value, idna: &dyn Idna) -> EgressPolicy {
    let mut errors = Vec::new();
    let mut rules = Vec::new();
    let hosts = match cfg.get("allowHosts") {
        Some(Value::Array(a)) => a.as_slice(),
        _ => {
            errors.push("egress.allowHosts is not a list".to_owned());
            &[]
        }
    };
    let ports = match cfg.get("allowPorts") {
        Some(Value::Array(a)) => a.as_slice(),
        _ => {
            errors.push("egress.allowPorts is not a list".to_owned());
            &[]
        }
    };
    for entry in hosts {
        match compile_host(entry, idna) {
            Ok(r) => rules.push(r),
            Err(e) => errors.push(e),
        }
    }
    let bad_port = ports.iter().find(|p| port_of(p).is_none());
    if let Some(bad) = bad_port {
        errors.push(format!(
            "port {} is not an integer in 1..65535",
            serde_json::to_string(bad).unwrap_or_default()
        ));
    }
    let failed = !errors.is_empty();
    EgressPolicy {
        host_rules: if failed { Vec::new() } else { rules },
        allow_ports: if failed {
            Vec::new()
        } else {
            ports.iter().filter_map(port_of).collect()
        },
        allow_loopback: cfg.get("allowLoopback") == Some(&Value::Bool(true)) && !failed,
        errors,
    }
}

/// The two options of `hostAllowed`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct HostMatch {
    /// `*` does not count: the host must be listed by name (or suffix).
    pub explicit_only: bool,
    /// Only an exact name (or an IP literal) counts.
    pub exact_only: bool,
}

/// `hostAllowed`: `host` is a URL hostname (lower case, brackets on IPv6).
pub fn host_allowed(p: &EgressPolicy, host: &str, opts: HostMatch) -> bool {
    let mut h = js::to_lower_case(host);
    if h.ends_with('.') {
        h.pop();
    }
    if let Some(lit) = parse_address(&h, false) {
        let addr = format_address(lit);
        return p
            .host_rules
            .iter()
            .any(|r| matches!(r, HostRule::Ip(a) if *a == addr));
    }
    p.host_rules.iter().any(|r| {
        if opts.exact_only {
            return matches!(r, HostRule::Exact(x) if *x == h);
        }
        match r {
            HostRule::AnyName => !opts.explicit_only,
            HostRule::Exact(x) => *x == h,
            HostRule::Suffix(s) => h.ends_with(&format!(".{s}")),
            HostRule::Ip(_) => false,
        }
    })
}
