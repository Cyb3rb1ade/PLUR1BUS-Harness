//! What a check tells the shell (spec §5.3, §7.2, §8). Codes and parameters only: the UI owns the texts.

use super::{Category, TailscaleView};
use serde::{Serialize, Serializer};
use std::collections::BTreeMap;

/// How a hint is shown.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Info,
    Notice,
    Warning,
    Error,
}

/// One notice for the UI: a stable code of spec §8 and the text parameters of spec §7.2 (`host`, `address`,
/// `addresses`, `peer`, `port`, `range`, `example`, `suggestion`). `note` names a text variant of spec §7.2:
/// `cgnat` on `tailscale-peer-unknown` (add `transport.tailscale.peer-unknown.cgnat`) and `flatpak` on
/// `tailscale-check-unavailable` (use `transport.tailscale.check-unavailable.flatpak`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hint {
    pub code: &'static str,
    pub severity: Severity,
    pub params: BTreeMap<&'static str, String>,
}

impl Hint {
    pub fn new(
        code: &'static str,
        severity: Severity,
        params: BTreeMap<&'static str, String>,
    ) -> Self {
        Self {
            code,
            severity,
            params,
        }
    }
}

/// The result of a check as the shell receives it: the category, at most eight addresses for the banner, the hints,
/// the Tailscale state (code, matched peer label, online flag only; spec §9.4), whether a confirmation is needed and
/// the classifier snapshot.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransportReport {
    #[serde(serialize_with = "category_name")]
    pub category: Option<Category>,
    pub addresses: Vec<String>,
    pub hints: Vec<Hint>,
    pub tailscale: Option<TailscaleView>,
    pub needs_public_ack: bool,
    pub classifier: &'static str,
}

/// `Category` lives in the std-only classifier crate; its wire names are spec §3.1's.
fn category_name<S: Serializer>(c: &Option<Category>, s: S) -> Result<S::Ok, S::Error> {
    match c {
        None => s.serialize_none(),
        Some(c) => s.serialize_str(wire_name(*c)),
    }
}

/// The wire name of a category (spec §3.1).
pub(crate) fn wire_name(c: Category) -> &'static str {
    match c {
        Category::Loopback => "loopback",
        Category::Tailnet => "tailnet",
        Category::Private => "private",
        Category::Special => "special",
        Category::Public => "public",
    }
}
