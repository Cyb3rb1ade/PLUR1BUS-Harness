//! The core side of redaction (`packages/core/src/logs/redact.ts` and the registry half of `secrets/redaction.ts`).
//!
//! The algorithm is `plur1bus_log_schema::redact`, one implementation for the CLI and the core. What lives here is what
//! only a long-running core has: the **registry of secret values** (rule 1, [`SecretSet`]: every value the process holds,
//! registered the moment it exists), the **live redactor** that always masks the values registered at the time of each
//! call ([`SecretSet::redactor`]), and the [`TextRedactor`] seam the loggers and writers take, so a test can inject a
//! redactor the way the TypeScript functions take theirs.
//!
//! The registry has the slots of `secrets/redaction.ts` (P4-20): the value a store name or an internal group holds now
//! is pinned, a value that is no longer current retires under the bound [`MAX_REGISTERED_SECRETS`], subscribers hear
//! every change, and [`SecretSet::mask`] is the mask of a description shown to the owner. One deliberate difference
//! (P4D-26): a retired value that is registered again moves to the newest place.
use plur1bus_log_schema::redact::{
    min_length, utf16::utf16_len, RedactError, RedactOptions, SecretFormsCache, SecretFormsSnapshot,
};
use serde_json::Value;
use std::collections::VecDeque;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

pub use plur1bus_log_schema::redact::{
    is_secret_key, mask, mask_secrets_in_json, mask_secrets_in_json_for, secret_forms_in,
    secret_forms_of, MaskedJson, RangeError, Redactor, SecretMatcher, MAX_DEPTH,
};

/// `createRedactor(options)`: a redactor for `options`. Errors when the redaction data cannot be read; nothing may be
/// written then.
pub fn create_redactor(options: RedactOptions) -> Result<Redactor, RedactError> {
    Redactor::new(options)
}

/// What the loggers and writers need of a redactor (`Redactor` of `redact.ts`): one string, one JSON value.
pub trait TextRedactor: Send + Sync {
    /// One string through the rules.
    fn text(&self, input: &str) -> String;
    /// Deep copy of a JSON value with every string redacted and every value under a secret-looking key replaced.
    fn value(&self, input: &Value) -> Value;
    /// The exact-value policy this redactor masks with, when it has one (`secretMatcher?.()`); an injected policy
    /// without one keeps its own transformations.
    fn secret_matcher(&self) -> Option<Arc<SecretMatcher>> {
        None
    }
    /// Whether rule 6 (PII) applies (`pii`).
    fn pii(&self) -> bool {
        false
    }
}

impl TextRedactor for Redactor {
    fn text(&self, input: &str) -> String {
        Redactor::text(self, input)
    }

    fn value(&self, input: &Value) -> Value {
        Redactor::value(self, input)
    }

    fn secret_matcher(&self) -> Option<Arc<SecretMatcher>> {
        Some(Redactor::secret_matcher(self).clone())
    }

    fn pii(&self) -> bool {
        Redactor::pii(self)
    }
}

/// `value` with a leading `Bearer ` or `Basic ` scheme removed: the bare credential an authorization header carries.
fn bare_credential(value: &str) -> &str {
    let lower = value.to_ascii_lowercase();
    for scheme in ["bearer", "basic"] {
        if lower.starts_with(scheme) {
            let rest = &value[scheme.len()..];
            // `\s+` of the TypeScript pattern: JavaScript's white space (U+FEFF is one, U+0085 is not).
            let trimmed = rest.trim_start_matches(crate::js::is_js_space);
            if trimmed.len() < rest.len() {
                return trimmed;
            }
        }
    }
    value
}

/// How many retired (and name-less) values are kept, the newest ones (`MAX_REGISTERED_SECRETS`). Pinned values are not
/// counted and never leave.
pub const MAX_REGISTERED_SECRETS: usize = 256;

/// The mask of [`SecretSet::mask`] (`mask()` of `secrets/redaction.ts`). Not the log redactor's `[REDACTED:secret]`: this
/// one goes into a description shown to the owner.
pub const DESCRIPTION_MASK: &str = "[redacted]";

/// What a value is current for: a store name, or an internal registration group (the `symbol` of `replaceGroup`). The two
/// never collide, whatever the name is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Slot {
    /// A store name (`register(value, name)`).
    Name(String),
    /// An internal group (`replaceGroup(group, values)`): the store's start-up snapshot, the configuration's values.
    Group(String),
}

/// A subscriber of the registry (`SecretSink`): called with a value and whether a slot holds it now (`pinned`). It hears a
/// value again when the value retires (`pinned: false`), so it can let go of it like any other transient value.
///
/// A sink runs while the registry is locked, so every sink hears the changes in the order they happened. It must not call
/// the registry, and not the secret store either (the store registers while it holds its own lock): it hands the value on
/// (a queue, a channel) and returns. A sink that panics is passed over; the others still hear the value.
pub type SecretSink = Box<dyn Fn(&str, bool) + Send + Sync>;

/// The handle [`SecretSet::subscribe`] returns, for [`SecretSet::unsubscribe`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SinkId(u64);

struct Registry {
    /// slot -> the values it holds now (a header value and its bare credential are two values of one slot), in the order
    /// they were given.
    current: Vec<(Slot, Vec<String>)>,
    /// value -> how many slots hold it now, in the order the values were first pinned (`Map` order).
    pins: Vec<(String, usize)>,
    /// Not current anywhere, oldest first.
    retired: VecDeque<String>,
    sinks: Vec<(u64, SecretSink)>,
    next_sink: u64,
    cache: SecretFormsCache,
    /// The forms and the matcher of generation `built`; rebuilt on the first use after a change, not on the change (a
    /// start-up that registers hundreds of values builds one matcher, as the TypeScript registry does).
    snapshot: Arc<SecretFormsSnapshot>,
    built: u64,
    version: u64,
}

impl Registry {
    fn pinned(&self, value: &str) -> bool {
        self.pins.iter().any(|(v, _)| v == value)
    }

    fn is_retired(&self, value: &str) -> bool {
        self.retired.iter().any(|v| v == value)
    }

    /// `known()`: the pinned values, then the retired ones, oldest first.
    fn known(&self) -> Vec<String> {
        self.pins
            .iter()
            .map(|(v, _)| v.clone())
            .chain(self.retired.iter().cloned())
            .collect()
    }

    /// Drops one slot's hold on `value`; true when no slot holds it any more.
    fn unpin(&mut self, value: &str) -> bool {
        let Some(at) = self.pins.iter().position(|(v, _)| v == value) else {
            return true;
        };
        if self.pins[at].1 > 1 {
            self.pins[at].1 -= 1;
            return false;
        }
        self.pins.remove(at);
        true
    }

    fn pin(&mut self, value: &str) {
        match self.pins.iter_mut().find(|(v, _)| v == value) {
            Some((_, n)) => *n += 1,
            None => self.pins.push((value.to_string(), 1)),
        }
        self.retired.retain(|v| v != value);
    }

    fn bound(&mut self) {
        while self.retired.len() > MAX_REGISTERED_SECRETS {
            self.retired.pop_front();
        }
    }

    /// A new membership generation. The forms and the matcher follow on the next [`snapshot`](Self::snapshot).
    fn changed(&mut self) {
        self.version += 1;
    }

    /// The forms and the matcher of the current generation.
    fn snapshot(&mut self) -> Arc<SecretFormsSnapshot> {
        if self.built != self.version {
            let known = self.known();
            self.snapshot = self.cache.snapshot(known.iter().map(String::as_str));
            self.built = self.version;
        }
        self.snapshot.clone()
    }

    fn tell(&self, value: &str) {
        let pinned = self.pinned(value);
        for (_, sink) in &self.sinks {
            // One failing sink must not stop the others or the caller.
            let _ = catch_unwind(AssertUnwindSafe(|| sink(value, pinned)));
        }
    }

    /// `addAnonymous`: a value without a slot is retired from the start. A value that is already retired moves to the
    /// newest place (P4D-26: the TypeScript registry leaves it where it is, so a value still in use can fall off the
    /// bound).
    fn add_anonymous(&mut self, value: &str) {
        if !eligible(value) || self.pinned(value) {
            return;
        }
        if self.is_retired(value) {
            self.retired.retain(|v| v != value);
            self.retired.push_back(value.to_string());
            return;
        }
        self.retired.push_back(value.to_string());
        self.bound();
        self.changed();
        self.tell(value);
    }

    /// `addNamed`: `values` become what `slot` holds now; what it held before and no slot holds any more retires.
    fn add_named(&mut self, slot: Slot, values: &[&str]) {
        let mut next: Vec<String> = Vec::new();
        for value in values {
            if eligible(value) && !next.iter().any(|v| v == value) {
                next.push((*value).to_string());
            }
        }
        let at = self.current.iter().position(|(s, _)| *s == slot);
        let prev: Vec<String> = at.map(|i| self.current[i].1.clone()).unwrap_or_default();
        // A value that is already current for this slot is a re-read (the common case): nothing changes.
        if next.len() == prev.len() && next.iter().all(|v| prev.contains(v)) {
            return;
        }
        let mut changed: Vec<String> = Vec::new();
        for value in &prev {
            if !next.contains(value) && self.unpin(value) {
                self.retired.push_back(value.clone());
                changed.push(value.clone());
            }
        }
        for value in &next {
            if !prev.contains(value) {
                self.pin(value);
                changed.push(value.clone());
            }
        }
        match (at, next.is_empty()) {
            (Some(i), true) => {
                self.current.remove(i);
            }
            (Some(i), false) => self.current[i].1 = next,
            (None, false) => self.current.push((slot, next)),
            (None, true) => {}
        }
        self.bound();
        self.changed();
        for value in &changed {
            self.tell(value);
        }
    }
}

/// Shorter values are not masked (a three-letter value would blank ordinary words in every line): the rule's minimum, in
/// UTF-16 code units.
fn eligible(value: &str) -> bool {
    utf16_len(value) >= min_length()
}

/// `value` and, for an authorization header value, its bare credential (`[value, bare]` when they differ).
fn with_bare(value: &str) -> Vec<&str> {
    let bare = bare_credential(value);
    if bare == value {
        vec![value]
    } else {
        vec![value, bare]
    }
}

/// Every secret value this process holds, in memory only (`createSecretRedaction` of `secrets/redaction.ts`). A value is
/// registered the moment it exists (set, rotated, revealed, leased); each redactor made by [`redactor`](Self::redactor)
/// learns it before the value can reach a line.
///
/// What is kept: the value a slot holds **now** is pinned and is never displaced, however many other values come and go
/// (256 token refreshes must not push the approval chain key out of the masking). A value that stops being current
/// (rotated away, or registered without a slot) is retired: it stays masked, but retired values are bounded to the newest
/// [`MAX_REGISTERED_SECRETS`], which keeps a token that refreshes every hour from growing the set without end.
pub struct SecretSet {
    registry: Mutex<Registry>,
}

impl Default for SecretSet {
    fn default() -> Self {
        SecretSet::new()
    }
}

impl SecretSet {
    /// An empty set.
    pub fn new() -> SecretSet {
        SecretSet {
            registry: Mutex::new(Registry {
                current: Vec::new(),
                pins: Vec::new(),
                retired: VecDeque::new(),
                sinks: Vec::new(),
                next_sink: 0,
                cache: SecretFormsCache::default(),
                snapshot: SecretFormsSnapshot::empty(),
                built: 0,
                version: 0,
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Registry> {
        // A panic elsewhere must not stop the masking of a value that is already registered.
        self.registry.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Registers a value without a slot (and, for an authorization header value, its bare credential). A value shorter
    /// than the rule's minimum (8 UTF-16 code units) is ignored: it would blank ordinary words in every line.
    pub fn register(&self, value: &str) {
        let mut registry = self.lock();
        for candidate in with_bare(value) {
            registry.add_anonymous(candidate);
        }
    }

    /// `register(value, name)`: the value becomes the current one of the store name `name` (pinned), and what the name
    /// held before retires. An empty name registers without a slot, as [`register`](Self::register) does. A value too
    /// short to mask changes nothing, not even the name's earlier value.
    pub fn register_named(&self, value: &str, name: &str) {
        if name.is_empty() {
            self.register(value);
            return;
        }
        let values: Vec<&str> = with_bare(value)
            .into_iter()
            .filter(|v| eligible(v))
            .collect();
        if !values.is_empty() {
            self.lock().add_named(Slot::Name(name.to_string()), &values);
        }
    }

    /// `replaceGroup(group, values)`: atomically replaces an internal registration group. Removed values retire under the
    /// normal bound; an empty list clears the group.
    pub fn replace_group(&self, group: &str, values: &[&str]) {
        let expanded: Vec<&str> = values.iter().flat_map(|value| with_bare(value)).collect();
        self.lock()
            .add_named(Slot::Group(group.to_string()), &expanded);
    }

    /// `subscribe(sink)`: `sink` hears every value registered so far, then every later change.
    pub fn subscribe(&self, sink: SecretSink) -> SinkId {
        let mut registry = self.lock();
        for value in registry.known() {
            let pinned = registry.pinned(&value);
            let _ = catch_unwind(AssertUnwindSafe(|| sink(&value, pinned)));
        }
        let id = registry.next_sink;
        registry.next_sink += 1;
        registry.sinks.push((id, sink));
        SinkId(id)
    }

    /// Ends a subscription. Unknown handles are ignored.
    pub fn unsubscribe(&self, id: SinkId) {
        self.lock().sinks.retain(|(n, _)| *n != id.0);
    }

    /// Every value that is masked now, as registered: the current ones of a slot, then the retired ones, oldest first.
    pub fn values(&self) -> Vec<String> {
        self.lock().known()
    }

    /// True when `text` contains a value registered so far (plain, as the user typed it).
    pub fn contains(&self, text: &str) -> bool {
        let registry = self.lock();
        registry.pins.iter().any(|(v, _)| text.contains(v.as_str()))
            || registry.retired.iter().any(|v| text.contains(v.as_str()))
    }

    /// `mask(text)`: `text` with every registered value replaced by [`DESCRIPTION_MASK`], the longest values first.
    /// Nothing else in the text is touched.
    pub fn mask(&self, text: &str) -> String {
        let mut values = self.values();
        // `Array.prototype.sort` is stable, and so is this one: equal lengths keep the registry's order.
        values.sort_by_key(|v| std::cmp::Reverse(utf16_len(v)));
        let mut out = text.to_string();
        for value in &values {
            if out.contains(value.as_str()) {
                out = out.replace(value.as_str(), DESCRIPTION_MASK);
            }
        }
        out
    }

    /// Immutable forms and compiled matcher for this membership generation.
    pub fn snapshot(&self) -> Arc<SecretFormsSnapshot> {
        self.lock().snapshot()
    }

    /// A redactor that always masks the values registered at the time of each call.
    pub fn redactor(self: &Arc<Self>, pii: bool, secrets_only: bool) -> LiveRedactor {
        LiveRedactor {
            set: self.clone(),
            pii,
            secrets_only,
            built: Mutex::new(None),
        }
    }
}

/// The redactor of a [`SecretSet`]: rebuilt when the set's generation changes, not on every call.
pub struct LiveRedactor {
    set: Arc<SecretSet>,
    pii: bool,
    secrets_only: bool,
    built: Mutex<Option<(u64, Arc<Redactor>)>>,
}

impl LiveRedactor {
    fn current(&self) -> Option<Arc<Redactor>> {
        let (version, snapshot) = {
            let mut registry = self.set.lock();
            (registry.version, registry.snapshot())
        };
        let mut built = self.built.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some((seen, redactor)) = built.as_ref() {
            if *seen == version {
                return Some(redactor.clone());
            }
        }
        let redactor = Arc::new(
            Redactor::new(RedactOptions {
                pii: self.pii,
                secrets_only: self.secrets_only,
                secret_matcher: Some(snapshot.matcher.clone()),
                ..RedactOptions::default()
            })
            .ok()?,
        );
        *built = Some((version, redactor.clone()));
        Some(redactor)
    }

    /// Whether rule 6 (PII) applies.
    pub fn pii(&self) -> bool {
        self.pii
    }

    /// The exact-value policy of the current generation.
    pub fn secret_matcher(&self) -> Arc<SecretMatcher> {
        self.set.snapshot().matcher.clone()
    }
}

/// The text of a message the redaction could not process: the payload is withheld, never passed on raw.
pub const WITHHELD: &str = "[REDACTED:withheld]";

impl TextRedactor for LiveRedactor {
    fn text(&self, input: &str) -> String {
        match self.current() {
            Some(redactor) => redactor.text(input),
            None => WITHHELD.to_string(),
        }
    }

    fn value(&self, input: &Value) -> Value {
        match self.current() {
            Some(redactor) => redactor.value(input),
            None => Value::String(WITHHELD.to_string()),
        }
    }

    fn secret_matcher(&self) -> Option<Arc<SecretMatcher>> {
        Some(LiveRedactor::secret_matcher(self))
    }

    fn pii(&self) -> bool {
        LiveRedactor::pii(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_registered_value_is_masked_from_the_next_call_on() {
        let set = Arc::new(SecretSet::new());
        let live = set.redactor(false, false);
        let secret = "fixture-live-0123456789abcdef";
        assert_eq!(live.text(&format!("a {secret} b")), format!("a {secret} b"));
        set.register(secret);
        assert_eq!(live.text(&format!("a {secret} b")), "a [REDACTED:secret] b");
        assert_eq!(
            live.value(&json!({"ordinary": [secret]})),
            json!({"ordinary": ["[REDACTED:secret]"]})
        );
    }

    #[test]
    fn short_values_are_ignored_and_the_bare_credential_of_a_header_value_is_registered_too() {
        let set = SecretSet::new();
        set.register("short");
        assert!(set.values().is_empty());
        set.register("Bearer fixture-bearer-0123456789");
        assert_eq!(
            set.values(),
            vec![
                "Bearer fixture-bearer-0123456789",
                "fixture-bearer-0123456789"
            ]
        );
        assert!(set.contains("x fixture-bearer-0123456789 y"));
        let generation = set.snapshot();
        set.register("fixture-bearer-0123456789");
        assert!(Arc::ptr_eq(&generation, &set.snapshot()));
    }

    /// `redactProtocolOutput`: A2A gets the secrets and PII, MCP the secrets only (Festlegung 5/6).
    #[test]
    fn pii_is_a_switch_of_the_redactor_not_of_the_registry() {
        let set = Arc::new(SecretSet::new());
        set.register("my-super-secret-token");
        let text = "IBAN: DE89 3704 0044 0532 0130 00, val: my-super-secret-token";
        assert_eq!(
            set.redactor(true, false).text(text),
            "IBAN: [REDACTED:pii], val: [REDACTED:secret]"
        );
        assert_eq!(
            set.redactor(false, false).text(text),
            "IBAN: DE89 3704 0044 0532 0130 00, val: [REDACTED:secret]"
        );
        let value =
            json!({"iban": "DE89 3704 0044 0532 0130 00", "customVal": "my-super-secret-token"});
        assert_eq!(
            set.redactor(true, false).value(&value),
            json!({"iban": "[REDACTED:pii]", "customVal": "[REDACTED:secret]"})
        );
        assert_eq!(
            set.redactor(false, false).value(&value),
            json!({"iban": "DE89 3704 0044 0532 0130 00", "customVal": "[REDACTED:secret]"})
        );
    }

    /// A stored vector string (`scripts/parity/export-logs.ts`): plain, `{units}` or `{parts}`.
    fn stored(e: &Value) -> String {
        fn units(e: &Value) -> Vec<u16> {
            match e {
                Value::String(s) => s.encode_utf16().collect(),
                Value::Object(o) if o.contains_key("units") => o["units"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter_map(|u| u.as_u64().map(|u| u as u16))
                            .collect()
                    })
                    .unwrap_or_default(),
                Value::Object(o) => o["parts"]
                    .as_array()
                    .map(|a| a.iter().flat_map(units).collect())
                    .unwrap_or_default(),
                _ => Vec::new(),
            }
        }
        String::from_utf16_lossy(&units(e))
    }

    /// The live redactor over a registry gives the answers of the recorded TypeScript redactor: the registry is the
    /// `secrets` option, PII and `secrets_only` are the redactor's switches.
    #[test]
    fn the_live_redactor_replays_the_recorded_text_vectors() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/parity/logs/redact.json"
        );
        let fixture: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        // Rust-side differences the log-schema replay pins (regex dialect); not the registry's business.
        let pinned = [
            "unicode-fold-kelvin-sign-in-a-header-name",
            "js-whitespace-bom-after-bearer",
            "js-whitespace-nel-after-bearer",
        ];
        let mut replayed = 0;
        for case in fixture["text"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let options = &case["options"];
            if pinned.contains(&name) || options.get("secretForms").is_some() {
                continue;
            }
            let set = Arc::new(SecretSet::new());
            for secret in options["secrets"].as_array().into_iter().flatten() {
                set.register(&stored(secret));
            }
            let live = set.redactor(options["pii"] == true, options["secretsOnly"] == true);
            assert_eq!(
                live.text(&stored(&case["input"])),
                stored(&case["output"]),
                "{name}"
            );
            replayed += 1;
        }
        assert!(replayed > 80, "{replayed}");
    }
}
