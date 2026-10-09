//! What keeps `update` honest about time and keys (`<home>/update/guard.json`, schema 1):
//!
//! - **Replay.** The highest release version ever accepted per channel is persisted. A correctly signed manifest that is
//!   older than that is a replay (an old, vulnerable release served again) and is refused.
//! - **Downgrade.** A target older than the installed version is refused. `--allow-downgrade` lifts both refusals; it is
//!   an explicit decision by the person at the keyboard and is audited.
//! - **Key rotation.** The baked release key can vouch for a *key list* (`<feed>.keys.json` with its own `.minisig`,
//!   or `keys.json` in an offline bundle): the keys in it, each with an expiry, sign releases from then on. A key list
//!   can itself be signed by a previously accepted key, so rotation chains. The baked key never expires; an accepted
//!   key stops being trusted at its `expires`. Accepted keys are kept in this file; `update --check` never writes it.
use super::UpdateError;
use crate::paths::Layout;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Write};
use std::path::PathBuf;

const SCHEMA_VERSION: u32 = 1;
/// A key list is a few hundred bytes per key.
pub const MAX_KEY_LIST_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RotatedKey {
    pub channel: String,
    /// The base64 minisign public key.
    pub public_key: String,
    /// `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM:SSZ` (UTC).
    pub expires: String,
    pub added_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Guard {
    pub schema_version: u32,
    /// Channel → highest accepted release version.
    #[serde(default)]
    pub highest_seen: BTreeMap<String, String>,
    #[serde(default)]
    pub keys: Vec<RotatedKey>,
}

impl Default for Guard {
    fn default() -> Self {
        Guard {
            schema_version: SCHEMA_VERSION,
            highest_seen: BTreeMap::new(),
            keys: Vec::new(),
        }
    }
}

pub fn path(layout: &Layout) -> PathBuf {
    super::state::dir(layout).join("guard.json")
}

/// A missing file is an empty guard; a file that does not parse (or is a newer schema) is an error, never "empty":
/// forgetting the highest-seen version would switch replay protection off.
pub fn load(layout: &Layout) -> Result<Guard, String> {
    let p = path(layout);
    match fs::read(&p) {
        Ok(raw) => {
            let g: Guard = serde_json::from_slice(&raw)
                .map_err(|e| format!("{} is unreadable: {e}", p.display()))?;
            if g.schema_version > SCHEMA_VERSION {
                return Err(format!(
                    "{} is schema {}, this build reads {SCHEMA_VERSION}",
                    p.display(),
                    g.schema_version
                ));
            }
            Ok(g)
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Guard::default()),
        Err(e) => Err(format!("{}: {e}", p.display())),
    }
}

pub fn save(layout: &Layout, g: &Guard) -> Result<(), String> {
    let dir = super::state::dir(layout);
    let p = path(layout);
    fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let tmp = dir.join(format!("guard.json.tmp-{}", std::process::id()));
    let result = (|| -> io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        let mut text = serde_json::to_string_pretty(g).map_err(io::Error::other)?;
        text.push('\n');
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, &p)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.map_err(|e| format!("{}: {e}", p.display()))
}

/// `major.minor.patch` of a release version (a pre-release or build suffix is ignored, like `is_newer`).
pub fn triple(v: &str) -> Option<(u64, u64, u64)> {
    let core = v.split(['-', '+']).next().unwrap_or(v);
    let mut it = core.split('.');
    let t = (
        it.next()?.parse().ok()?,
        it.next()?.parse().ok()?,
        it.next()?.parse().ok()?,
    );
    it.next().is_none().then_some(t)
}

fn compare(a: &str, b: &str) -> Result<Ordering, UpdateError> {
    match (triple(a), triple(b)) {
        (Some(x), Some(y)) => Ok(x.cmp(&y)),
        _ if a == b => Ok(Ordering::Equal),
        _ => Err(UpdateError::new(
            "release-version-invalid",
            format!("cannot order the versions {a:?} and {b:?}: both must be major.minor.patch"),
        )),
    }
}

/// Refuses a `target` older than what is installed (`downgrade-refused`) or older than the highest version this
/// install ever accepted on `channel` (`release-replay`), unless `allow_downgrade`.
pub fn check_version(
    guard: &Guard,
    channel: &str,
    installed: &str,
    target: &str,
    allow_downgrade: bool,
) -> Result<(), UpdateError> {
    if allow_downgrade {
        return Ok(());
    }
    if compare(target, installed)? == Ordering::Less {
        return Err(UpdateError::new(
            "downgrade-refused",
            format!(
                "{target} is older than the installed {installed}: re-run with --allow-downgrade to go back (nothing was changed)"
            ),
        ));
    }
    if let Some(seen) = guard.highest_seen.get(channel) {
        if compare(target, seen)? == Ordering::Less {
            return Err(UpdateError::new(
                "release-replay",
                format!(
                    "{target} is older than {seen}, which this install already accepted on the {channel} channel: the signed manifest looks replayed (--allow-downgrade overrides)"
                ),
            ));
        }
    }
    Ok(())
}

/// Raises the persisted highest-seen version of `channel` to `version` (never lowers it).
pub fn record_seen(layout: &Layout, channel: &str, version: &str) -> Result<(), String> {
    let mut g = load(layout)?;
    let higher = match g.highest_seen.get(channel) {
        Some(old) => compare(version, old).map_err(|e| e.message)? == Ordering::Greater,
        None => true,
    };
    if higher {
        g.highest_seen.insert(channel.into(), version.into());
        save(layout, &g)?;
    }
    Ok(())
}

/// Seconds since the epoch of `YYYY-MM-DD[THH:MM:SS[Z]]` (UTC).
pub fn parse_time(s: &str) -> Option<i64> {
    let s = s.trim().trim_end_matches('Z');
    let (date, time) = s.split_once('T').unwrap_or((s, "00:00:00"));
    let mut d = date.split('-');
    let (y, m, day): (i64, i64, i64) = (
        d.next()?.parse().ok()?,
        d.next()?.parse().ok()?,
        d.next()?.parse().ok()?,
    );
    if d.next().is_some() || !(1..=12).contains(&m) || !(1..=31).contains(&day) {
        return None;
    }
    let mut t = time.split(':');
    let (hh, mm, ss): (i64, i64, i64) = (
        t.next()?.parse().ok()?,
        t.next().unwrap_or("0").parse().ok()?,
        t.next().unwrap_or("0").split('.').next()?.parse().ok()?,
    );
    // Days from civil (Howard Hinnant).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + hh * 3600 + mm * 60 + ss)
}

pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub type SigErr = (&'static str, String);

fn sig_err(reason: &'static str, msg: impl Into<String>) -> SigErr {
    (reason, msg.into())
}

/// Whether `sig_text` is a valid minisign signature of `raw` under `key_b64`.
fn verifies(raw: &[u8], sig: &minisign_verify::Signature, key_b64: &str) -> bool {
    minisign_verify::PublicKey::from_base64(key_b64)
        .is_ok_and(|pk| pk.verify(raw, sig, false).is_ok())
}

fn decode(sig_text: &str, what: &str) -> Result<minisign_verify::Signature, SigErr> {
    minisign_verify::Signature::decode(sig_text).map_err(|e| {
        sig_err(
            "release-signature-invalid",
            format!("the {what} signature is malformed: {e}"),
        )
    })
}

/// The signed key list: `{ "schemaVersion": 1, "channel": "stable", "keys": [ { "publicKey": "…", "expires": "…" } ] }`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeyList {
    schema_version: u32,
    channel: String,
    keys: Vec<ListedKey>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListedKey {
    public_key: String,
    expires: String,
}

/// What [`verify_release`] needs besides the manifest.
#[derive(Clone, Copy)]
pub struct Ctx<'a> {
    pub channel: &'a str,
    pub baked: Option<&'a str>,
    pub persist: bool,
    pub now: i64,
    pub fetch_sig: &'a dyn Fn() -> Result<String, SigErr>,
    pub fetch_keys: &'a dyn Fn() -> Option<(Vec<u8>, String)>,
}

/// Verifies a release manifest (`raw`) the way every source does, rotation included.
///
/// - `baked`: the channel's compiled-in key. `None` and no accepted keys: `Ok(false)`, a dev build that verifies
///   nothing (the caller refuses to apply then).
/// - `fetch_sig`: the manifest's `.minisig` text. `fetch_keys`: the key list and its signature, asked for only when the
///   manifest does not verify under a key already trusted.
/// - `persist`: write a newly accepted key list into `guard.json` (`false` for `--check`, which writes nothing).
/// - `now`: epoch seconds, for key expiry.
pub fn verify_release(layout: &Layout, raw: &[u8], ctx: &Ctx) -> Result<bool, SigErr> {
    let Ctx {
        channel,
        baked,
        persist,
        now,
        fetch_sig,
        fetch_keys,
    } = *ctx;
    let mut guard = load(layout).map_err(|m| sig_err("guard-unreadable", m))?;
    let live = |g: &Guard| -> Vec<String> {
        g.keys
            .iter()
            .filter(|k| k.channel == channel && parse_time(&k.expires).is_some_and(|t| t > now))
            .map(|k| k.public_key.clone())
            .collect()
    };
    let expired = |g: &Guard| -> Vec<RotatedKey> {
        g.keys
            .iter()
            .filter(|k| k.channel == channel && parse_time(&k.expires).is_none_or(|t| t <= now))
            .cloned()
            .collect()
    };
    if baked.is_none() && live(&guard).is_empty() {
        return Ok(false);
    }
    if let Some(b) = baked {
        minisign_verify::PublicKey::from_base64(b).map_err(|e| {
            sig_err(
                "release-signature-invalid",
                format!("the baked release public key is invalid: {e}"),
            )
        })?;
    }
    let sig = decode(&fetch_sig()?, "release")?;
    let trusted = |g: &Guard| -> Vec<String> {
        baked
            .map(str::to_string)
            .into_iter()
            .chain(live(g))
            .collect()
    };
    if trusted(&guard).iter().any(|k| verifies(raw, &sig, k)) {
        return Ok(true);
    }
    // Not signed by a key we trust now: maybe by a rotated key that is announced in a key list, or one that expired.
    if let Some(k) = expired(&guard)
        .into_iter()
        .find(|k| verifies(raw, &sig, &k.public_key))
    {
        return Err(sig_err(
            "release-key-expired",
            format!(
                "the release is signed with a key that expired on {}",
                k.expires
            ),
        ));
    }
    if let Some((list_raw, list_sig)) = fetch_keys() {
        let lsig = decode(&list_sig, "key list")?;
        if !trusted(&guard)
            .iter()
            .any(|k| verifies(&list_raw, &lsig, k))
        {
            return Err(sig_err(
                "key-list-invalid",
                "the key list is not signed by a key this install trusts",
            ));
        }
        let list: KeyList = serde_json::from_slice(&list_raw).map_err(|e| {
            sig_err(
                "key-list-invalid",
                format!("the key list is malformed: {e}"),
            )
        })?;
        if list.schema_version != SCHEMA_VERSION || list.channel != channel {
            return Err(sig_err(
                "key-list-invalid",
                format!(
                    "the key list is for another channel or schema ({})",
                    list.channel
                ),
            ));
        }
        let mut signer_expired = None;
        for k in &list.keys {
            minisign_verify::PublicKey::from_base64(&k.public_key).map_err(|e| {
                sig_err("key-list-invalid", format!("a listed key is invalid: {e}"))
            })?;
            let Some(t) = parse_time(&k.expires) else {
                return Err(sig_err(
                    "key-list-invalid",
                    format!("a listed key has the expiry {:?}", k.expires),
                ));
            };
            if t <= now {
                if verifies(raw, &sig, &k.public_key) {
                    signer_expired = Some(k.expires.clone());
                }
                continue;
            }
            if !guard
                .keys
                .iter()
                .any(|g| g.channel == channel && g.public_key == k.public_key)
            {
                guard.keys.push(RotatedKey {
                    channel: channel.into(),
                    public_key: k.public_key.clone(),
                    expires: k.expires.clone(),
                    added_at: super::state::now_ms(),
                });
            }
        }
        if let Some(when) = signer_expired {
            return Err(sig_err(
                "release-key-expired",
                format!("the release is signed with a key that expired on {when}"),
            ));
        }
        if trusted(&guard).iter().any(|k| verifies(raw, &sig, k)) {
            if persist {
                save(layout, &guard).map_err(|m| sig_err("guard-unreadable", m))?;
            }
            return Ok(true);
        }
    }
    Err(sig_err(
        "release-signature-invalid",
        "the release signature does not match any key this install trusts",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kp() -> minisign::KeyPair {
        minisign::KeyPair::generate_unencrypted_keypair().unwrap()
    }
    fn sign(k: &minisign::KeyPair, data: &[u8]) -> String {
        minisign::sign(Some(&k.pk), &k.sk, data, Some("test"), Some("TEST ONLY"))
            .unwrap()
            .into_string()
    }
    fn layout() -> (tempfile::TempDir, Layout) {
        let d = tempfile::tempdir().unwrap();
        let l = Layout::new(d.path().join("h"));
        (d, l)
    }
    fn list(channel: &str, keys: &[(&minisign::KeyPair, &str)]) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1,
            "channel": channel,
            "keys": keys.iter().map(|(k, e)| serde_json::json!({"publicKey": k.pk.to_base64(), "expires": e})).collect::<Vec<_>>(),
        }))
        .unwrap()
    }
    const NOW: i64 = 1_790_000_000; // 2026-09
    const FUTURE: &str = "2999-01-01T00:00:00Z";
    const PAST: &str = "2020-01-01";

    #[test]
    fn times_parse_and_order() {
        assert_eq!(parse_time("1970-01-01"), Some(0));
        assert_eq!(parse_time("1970-01-02T00:00:01Z"), Some(86_401));
        assert!(parse_time("2999-01-01").unwrap() > NOW);
        assert!(parse_time("2020-01-01").unwrap() < NOW);
        assert_eq!(parse_time("nope"), None);
        assert_eq!(parse_time("2026-13-01"), None);
    }

    #[test]
    fn downgrade_and_replay_are_refused_unless_allowed() {
        let mut g = Guard::default();
        let ok = |g: &Guard, inst, to, allow| check_version(g, "stable", inst, to, allow);
        assert!(ok(&g, "0.2.0", "0.3.0", false).is_ok());
        assert!(ok(&g, "0.2.0", "0.2.0", false).is_ok());
        assert_eq!(
            ok(&g, "0.2.0", "0.1.9", false).unwrap_err().reason,
            "downgrade-refused"
        );
        assert!(ok(&g, "0.2.0", "0.1.9", true).is_ok());
        g.highest_seen.insert("stable".into(), "0.4.0".into());
        // Newer than installed, older than what was accepted before: a replay.
        assert_eq!(
            ok(&g, "0.2.0", "0.3.0", false).unwrap_err().reason,
            "release-replay"
        );
        assert!(ok(&g, "0.2.0", "0.3.0", true).is_ok());
        assert!(ok(&g, "0.2.0", "0.4.0", false).is_ok());
        // Another channel has its own highest version.
        assert!(check_version(&g, "beta", "0.2.0", "0.3.0", false).is_ok());
        assert_eq!(
            ok(&g, "0.2.0", "weird", false).unwrap_err().reason,
            "release-version-invalid"
        );
    }

    #[test]
    fn the_highest_seen_version_is_persisted_and_never_lowered() {
        let (_d, l) = layout();
        assert_eq!(load(&l).unwrap(), Guard::default());
        record_seen(&l, "stable", "0.3.0").unwrap();
        record_seen(&l, "stable", "0.2.0").unwrap();
        assert_eq!(load(&l).unwrap().highest_seen["stable"], "0.3.0");
        record_seen(&l, "stable", "0.10.0").unwrap();
        assert_eq!(load(&l).unwrap().highest_seen["stable"], "0.10.0");
        fs::write(path(&l), "{").unwrap();
        assert!(
            load(&l).is_err(),
            "a torn guard is an error, not an empty guard"
        );
        assert!(record_seen(&l, "stable", "9.0.0").is_err());
    }

    fn verify(
        l: &Layout,
        baked: Option<&str>,
        raw: &[u8],
        sig: &str,
        keys: Option<(Vec<u8>, String)>,
        persist: bool,
    ) -> Result<bool, SigErr> {
        verify_release(
            l,
            raw,
            &Ctx {
                channel: "stable",
                baked,
                persist,
                now: NOW,
                fetch_sig: &|| Ok(sig.to_string()),
                fetch_keys: &|| keys.clone(),
            },
        )
    }

    #[test]
    fn the_baked_key_verifies_and_a_stranger_does_not() {
        let (_d, l) = layout();
        let (baked, stranger) = (kp(), kp());
        let raw = b"{\"version\":\"0.2.0\"}";
        let b = baked.pk.to_base64();
        assert_eq!(
            verify(&l, Some(&b), raw, &sign(&baked, raw), None, true),
            Ok(true)
        );
        assert_eq!(
            verify(&l, Some(&b), raw, &sign(&stranger, raw), None, true)
                .unwrap_err()
                .0,
            "release-signature-invalid"
        );
        assert_eq!(
            verify(&l, None, raw, &sign(&stranger, raw), None, true),
            Ok(false),
            "dev build"
        );
    }

    #[test]
    fn a_rotated_key_announced_by_a_signed_list_is_accepted_and_remembered() {
        let (_d, l) = layout();
        let (old, new) = (kp(), kp());
        let b = old.pk.to_base64();
        let raw = b"{\"version\":\"0.3.0\"}";
        let list_raw = list("stable", &[(&new, FUTURE)]);
        let keys = Some((list_raw.clone(), sign(&old, &list_raw)));
        // Signed by the new key: accepted through the list, which is persisted.
        assert_eq!(
            verify(&l, Some(&b), raw, &sign(&new, raw), keys.clone(), true),
            Ok(true)
        );
        assert_eq!(load(&l).unwrap().keys.len(), 1);
        // Later, with no list at all, the remembered key still verifies.
        assert_eq!(
            verify(&l, Some(&b), raw, &sign(&new, raw), None, true),
            Ok(true)
        );
        // The new key can in turn announce its successor (a chain).
        let newer = kp();
        let l2 = list("stable", &[(&newer, FUTURE)]);
        let keys2 = Some((l2.clone(), sign(&new, &l2)));
        assert_eq!(
            verify(&l, Some(&b), raw, &sign(&newer, raw), keys2, true),
            Ok(true)
        );
        assert_eq!(load(&l).unwrap().keys.len(), 2);
    }

    #[test]
    fn check_mode_accepts_a_rotated_key_without_writing_anything() {
        let (_d, l) = layout();
        let (old, new) = (kp(), kp());
        let raw = b"{}";
        let list_raw = list("stable", &[(&new, FUTURE)]);
        let keys = Some((list_raw.clone(), sign(&old, &list_raw)));
        assert_eq!(
            verify(
                &l,
                Some(&old.pk.to_base64()),
                raw,
                &sign(&new, raw),
                keys,
                false
            ),
            Ok(true)
        );
        assert!(!path(&l).exists());
    }

    #[test]
    fn an_unsigned_or_foreign_key_list_and_an_expired_key_are_refused() {
        let (_d, l) = layout();
        let (old, new, evil) = (kp(), kp(), kp());
        let b = old.pk.to_base64();
        let raw = b"{}";
        // A list signed by a stranger.
        let lr = list("stable", &[(&new, FUTURE)]);
        let bad = Some((lr.clone(), sign(&evil, &lr)));
        assert_eq!(
            verify(&l, Some(&b), raw, &sign(&new, raw), bad, true)
                .unwrap_err()
                .0,
            "key-list-invalid"
        );
        // A list for another channel.
        let lr = list("beta", &[(&new, FUTURE)]);
        let other = Some((lr.clone(), sign(&old, &lr)));
        assert_eq!(
            verify(&l, Some(&b), raw, &sign(&new, raw), other, true)
                .unwrap_err()
                .0,
            "key-list-invalid"
        );
        // A valid list whose key has expired: the release it signed is refused as expired.
        let lr = list("stable", &[(&new, PAST)]);
        let expired = Some((lr.clone(), sign(&old, &lr)));
        assert_eq!(
            verify(&l, Some(&b), raw, &sign(&new, raw), expired, true)
                .unwrap_err()
                .0,
            "release-key-expired"
        );
        assert!(
            load(&l).unwrap().keys.is_empty(),
            "an expired key is not remembered"
        );
        // A remembered key that has expired since.
        let mut g = Guard::default();
        g.keys.push(RotatedKey {
            channel: "stable".into(),
            public_key: new.pk.to_base64(),
            expires: PAST.into(),
            added_at: 1,
        });
        save(&l, &g).unwrap();
        assert_eq!(
            verify(&l, Some(&b), raw, &sign(&new, raw), None, true)
                .unwrap_err()
                .0,
            "release-key-expired"
        );
        // And the baked key keeps working.
        assert_eq!(
            verify(&l, Some(&b), raw, &sign(&old, raw), None, true),
            Ok(true)
        );
    }
}
