//! The child's environment (`tools/exec/env.ts`): built from an allowlist of names, never inherited wholesale.
use super::{ExecFailure, ExecFailureCode};
use plur1bus_core::js;
use serde_json::Value;
use sha2::{Digest, Sha256};

/// The names that may reach a child unless the configuration says otherwise.
pub const DEFAULT_ENV_ALLOW: [&str; 12] = [
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "TERM",
    // Windows cannot start most programs without these.
    "SystemRoot",
    "SYSTEMROOT",
    "PATHEXT",
    "COMSPEC",
    "TEMP",
    "TMP",
];

/// `isSecretishName`. RULING (TypeScript): even a name the person allowlisted is not passed *from the inherited
/// environment* when it looks like a credential; a secret reaches a child only as an explicit request value, which the
/// caller sees in the audit names.
///
/// The TypeScript pattern is
/// `/(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API[_-]?KEY|PRIVATE[_-]?KEY|(^|_)KEY$|AUTH|COOKIE|SESSION)/i`, without the
/// `u` flag: only ASCII letters fold.
pub fn is_secretish_name(name: &str) -> bool {
    let up = name.to_ascii_uppercase();
    const ANYWHERE: [&str; 14] = [
        "TOKEN",
        "SECRET",
        "PASSWORD",
        "PASSWD",
        "CREDENTIAL",
        "APIKEY",
        "API_KEY",
        "API-KEY",
        "PRIVATEKEY",
        "PRIVATE_KEY",
        "PRIVATE-KEY",
        "AUTH",
        "COOKIE",
        "SESSION",
    ];
    ANYWHERE.iter().any(|w| up.contains(w)) || up == "KEY" || up.ends_with("_KEY")
}

/// `/^[A-Za-z_][A-Za-z0-9_]*$/`.
fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// `buildEnv`: the environment of the child, as `(name, value)` in the order the TypeScript map holds them. `base` is the
/// inherited environment (a name without a value is skipped), `requested` the `env` member of the call in its order.
/// `windows` folds names (the last spelling wins).
pub fn build_env(
    allow: &[String],
    base: &[(String, Option<String>)],
    requested: &[(String, Value)],
    windows: bool,
) -> Result<Vec<(String, String)>, ExecFailure> {
    let fold = |s: &str| {
        if windows {
            s.to_uppercase()
        } else {
            s.to_owned()
        }
    };
    let allowed: Vec<String> = allow.iter().map(|a| fold(a)).collect();
    // folded name -> (name, value), in first-insertion order (a JavaScript `Map`).
    let mut out: Vec<(String, (String, String))> = Vec::new();
    let mut set = |folded: String, name: &str, value: &str| {
        let entry = (name.to_owned(), value.to_owned());
        match out.iter_mut().find(|(k, _)| *k == folded) {
            Some(slot) => slot.1 = entry,
            None => out.push((folded, entry)),
        }
    };
    for (name, value) in base {
        let Some(value) = value else { continue };
        let folded = fold(name);
        if !allowed.contains(&folded) || is_secretish_name(name) {
            continue;
        }
        set(folded, name, value);
    }
    let refused = |m: String| ExecFailure::new(ExecFailureCode::EnvRefused, &m);
    for (name, value) in requested {
        if !valid_name(name) {
            return Err(refused("invalid environment variable name".to_owned()));
        }
        let folded = fold(name);
        if !allowed.contains(&folded) {
            return Err(refused(format!(
                "environment variable {name} is not on the allowlist"
            )));
        }
        match value.as_str() {
            Some(v) if !v.contains('\0') => set(folded, name, v),
            _ => return Err(refused(format!("invalid value for {name}"))),
        }
    }
    Ok(out.into_iter().map(|(_, e)| e).collect())
}

/// `[[name, value], ...]` sorted by name the way JavaScript's default sort orders strings, as `JSON.stringify` writes it.
pub(super) fn sorted_pairs_json(env: &[(String, String)]) -> String {
    let mut names: Vec<String> = env.iter().map(|(n, _)| n.clone()).collect();
    js::sort_default(&mut names);
    names.dedup();
    let pairs: Vec<String> = names
        .iter()
        .map(|n| {
            // An object holds one value per name: the last one written.
            let v = env
                .iter()
                .rev()
                .find(|(k, _)| k == n)
                .map_or("", |(_, v)| v.as_str());
            format!("[{},{}]", js::json_stringify(n), js::json_stringify(v))
        })
        .collect();
    format!("[{}]", pairs.join(","))
}

/// `envFingerprint`: a stable hash of the name/value pairs; a one-time grant is bound to values, not just names.
pub fn env_fingerprint(env: &[(String, String)]) -> String {
    hex(&Sha256::digest(sorted_pairs_json(env).as_bytes()))
}

pub(super) fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}
