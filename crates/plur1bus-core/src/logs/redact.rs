//! The core side of redaction (`packages/core/src/logs/redact.ts` and the registry half of `secrets/redaction.ts`).
//!
//! The algorithm is `plur1bus_log_schema::redact`, one implementation for the CLI and the core. What lives here is what
//! only a long-running core has: the **registry of secret values** (rule 1, [`SecretSet`]: every value the process holds,
//! registered the moment it exists), the **live redactor** that always masks the values registered at the time of each
//! call ([`SecretSet::redactor`]), and the [`TextRedactor`] seam the loggers and writers take, so a test can inject a
//! redactor the way the TypeScript functions take theirs.
//!
//! Not here yet: the named slots of `secrets/redaction.ts` (a value that a store name holds now is pinned, a rotated value
//! retires under the bound `MAX_REGISTERED_SECRETS`) belong to the secrets package; [`SecretSet`] is the exact-value
//! membership those slots feed.
use plur1bus_log_schema::redact::{
    min_length, utf16::utf16_len, RedactError, RedactOptions, SecretFormsCache, SecretFormsSnapshot,
};
use serde_json::Value;
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
            let trimmed = rest.trim_start();
            if trimmed.len() < rest.len() {
                return trimmed;
            }
        }
    }
    value
}

struct Registry {
    values: Vec<String>,
    cache: SecretFormsCache,
    snapshot: Arc<SecretFormsSnapshot>,
    version: u64,
}

/// Every secret value this process holds, in memory only. A value is registered the moment it exists (set, rotated,
/// revealed, leased); each redactor made by [`redactor`](Self::redactor) learns it before the value can reach a line.
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
                values: Vec::new(),
                cache: SecretFormsCache::default(),
                snapshot: SecretFormsSnapshot::empty(),
                version: 0,
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Registry> {
        // A panic elsewhere must not stop the masking of a value that is already registered.
        self.registry.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Registers a value (and, for an authorization header value, its bare credential). A value shorter than the rule's
    /// minimum (8 UTF-16 code units) is ignored: it would blank ordinary words in every line.
    pub fn register(&self, value: &str) {
        let mut registry = self.lock();
        let mut changed = false;
        for candidate in [value, bare_credential(value)] {
            if utf16_len(candidate) >= min_length()
                && !registry.values.iter().any(|v| v == candidate)
            {
                registry.values.push(candidate.to_string());
                changed = true;
            }
        }
        if changed {
            let Registry {
                values,
                cache,
                snapshot,
                version,
            } = &mut *registry;
            *snapshot = cache.snapshot(values.iter().map(String::as_str));
            *version += 1;
        }
    }

    /// Every value that is masked now, as registered.
    pub fn values(&self) -> Vec<String> {
        self.lock().values.clone()
    }

    /// True when `text` contains a value registered so far (plain, as the user typed it).
    pub fn contains(&self, text: &str) -> bool {
        self.lock().values.iter().any(|v| text.contains(v.as_str()))
    }

    /// Immutable forms and compiled matcher for this membership generation.
    pub fn snapshot(&self) -> Arc<SecretFormsSnapshot> {
        self.lock().snapshot.clone()
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
            let registry = self.set.lock();
            (registry.version, registry.snapshot.clone())
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
