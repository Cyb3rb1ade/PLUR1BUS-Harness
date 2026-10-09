//! Add-on compatibility for `update` (read-only on the ext layer until the swap): before anything is written, every
//! installed skill, module and channel is judged against what the *target* release offers, and the person sees the
//! verdict in the plan.
//!
//! - **Source of truth.** An add-on installed from a package carries a `compat` block (`harness`, `moduleApi`, `rpc`,
//!   `platforms`, `container`, spec §5.2) in its cached manifest; `plur1bus_ext::compat::check_compat` judges it, with
//!   the *target's* facts: the release version, the module APIs it speaks (`native.provides.moduleApi`, optional in the
//!   release manifest), its RPC version. A module that was not installed from a package is judged by its
//!   `module.json` `apiVersion`.
//! - **Verdicts.** `compatible`, `incompatible`, `unknown` (no cached manifest, or the release does not say what the
//!   verdict depends on). Unknown never blocks and never disables.
//! - **Action.** An enabled incompatible add-on is disabled for the new version (through `ext::lifecycle::disable`, so
//!   the skills index and `modules.<name>.enabled` stay the one source of the flag) and recorded in
//!   `<home>/update/addons.json`. If the add-on is *required* (`--require-addon`, remembered here) the update is
//!   refused unless `--force`. A later update that finds a recorded add-on compatible again re-enables it, best effort.
use crate::ext;
use crate::ext::commit::{enabled_in, OfflineHost};
use crate::ext::lifecycle::{self, ToggleOpts};
use crate::ext::paths::ExtPaths;
use crate::install::manifest::{ReleaseHead, ReleaseNative};
use crate::paths::Layout;
use plur1bus_ext::compat::{check_compat, HostFacts};
use plur1bus_ext::manifest::P1xManifest;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;
use std::fs;
use std::io::{self, Write};
use std::path::PathBuf;

const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Status {
    Compatible,
    Incompatible,
    Unknown,
}

/// One add-on and what the update would mean for it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    pub name: String,
    pub kind: String,
    pub version: String,
    pub status: Status,
    pub enabled: bool,
    pub required: bool,
    /// Why (the first failing `compat` field, or what is missing).
    pub detail: Option<String>,
    /// Disabled by an earlier update (recorded in `addons.json`).
    pub held_by_update: bool,
}

/// The verdicts and the actions they imply.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddonPlan {
    pub items: Vec<Verdict>,
    /// Enabled and incompatible: disabled for the new version.
    pub disable: Vec<String>,
    /// Recorded as disabled by an update and compatible now: re-enabled after the new version is healthy.
    pub reenable: Vec<String>,
    /// Required and incompatible: the update is refused without `--force`.
    pub blocked: Vec<String>,
    /// Why the check could not run completely (an unreadable state file), shown as an attention item.
    pub note: Option<String>,
}

impl AddonPlan {
    pub fn count(&self, s: Status) -> usize {
        self.items.iter().filter(|v| v.status == s).count()
    }
}

/// What the target release offers add-ons.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Offer {
    pub harness: String,
    /// `native.provides.moduleApi`; `None`: the release does not say.
    pub module_api: Option<Vec<String>>,
    pub rpc: String,
}

pub fn offer_of(head: &ReleaseHead, native: Option<&ReleaseNative>) -> Offer {
    let provides = native.and_then(|n| n.provides.as_ref());
    Offer {
        harness: head.version.clone(),
        module_api: provides.and_then(|p| p.module_api.clone()),
        rpc: provides
            .and_then(|p| p.rpc.clone())
            .or_else(|| native.map(|n| n.core.rpc.clone()))
            .unwrap_or_else(|| plur1bus_rpc::RPC_VERSION.to_string()),
    }
}

/// Judges one package manifest (the `manifest` object of the cache's `<sha256>.json`) against `offer`.
pub fn judge_manifest(manifest: &Value, offer: &Offer) -> (Status, Option<String>) {
    let m: P1xManifest = match serde_json::from_value(manifest.clone()) {
        Ok(m) => m,
        Err(e) => {
            return (
                Status::Unknown,
                Some(format!("its manifest is unreadable: {e}")),
            )
        }
    };
    let facts = |api: u32| HostFacts {
        harness_version: offer.harness.clone(),
        module_api_current: api,
        rpc_version: offer.rpc.clone(),
        platform: crate::install::targets::Target::current().map(|t| t.id().to_string()),
        container: crate::container::container_mode(),
    };
    match &offer.module_api {
        Some(list) => {
            let mut first_err = None;
            for api in list.iter().filter_map(|a| a.parse::<u32>().ok()) {
                match check_compat(&m, &facts(api)) {
                    Ok(()) => return (Status::Compatible, None),
                    Err(e) => {
                        first_err.get_or_insert(e.detail);
                    }
                }
            }
            (Status::Incompatible, first_err)
        }
        None => {
            // Everything but the module API can be judged; that one needs the release to say what it speaks.
            let mut stripped = m.clone();
            let had_api = stripped
                .compat
                .as_object_mut()
                .and_then(|o| o.remove("moduleApi"))
                .is_some()
                && matches!(
                    m.kind,
                    plur1bus_ext::manifest::Kind::Module | plur1bus_ext::manifest::Kind::Channel
                );
            match check_compat(
                &stripped,
                &facts(crate::modules::manifest::current_api_version()),
            ) {
                Err(e) => (Status::Incompatible, Some(e.detail)),
                Ok(()) if had_api => (
                    Status::Unknown,
                    Some("the release does not say which module API it speaks".into()),
                ),
                Ok(()) => (Status::Compatible, None),
            }
        }
    }
}

/// A module that was not installed from a package: its `module.json` `apiVersion` against the release's list.
fn judge_api_version(api_version: &str, offer: &Offer) -> (Status, Option<String>) {
    match &offer.module_api {
        None => (
            Status::Unknown,
            Some("the release does not say which module API it speaks".into()),
        ),
        Some(list) if list.iter().any(|a| a == api_version) => (Status::Compatible, None),
        Some(list) => (
            Status::Incompatible,
            Some(format!(
                "needs module API {api_version}, the release speaks {}",
                list.join(", ")
            )),
        ),
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The record: <home>/update/addons.json

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Held {
    pub name: String,
    pub kind: String,
    pub version: String,
    pub reason: String,
    pub from: String,
    pub to: String,
    pub at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub schema_version: u32,
    /// Add-ons the person marked required (`--require-addon`).
    #[serde(default)]
    pub required: BTreeSet<String>,
    /// Add-ons an update disabled and has not re-enabled.
    #[serde(default)]
    pub disabled: Vec<Held>,
}

impl Default for Record {
    fn default() -> Self {
        Record {
            schema_version: SCHEMA_VERSION,
            required: BTreeSet::new(),
            disabled: Vec::new(),
        }
    }
}

pub fn record_path(layout: &Layout) -> PathBuf {
    super::state::dir(layout).join("addons.json")
}

/// A missing file is an empty record; one that does not parse is an error (the record says what to re-enable).
pub fn load(layout: &Layout) -> Result<Record, String> {
    let p = record_path(layout);
    match fs::read(&p) {
        Ok(raw) => {
            serde_json::from_slice(&raw).map_err(|e| format!("{} is unreadable: {e}", p.display()))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(Record::default()),
        Err(e) => Err(format!("{}: {e}", p.display())),
    }
}

pub fn save(layout: &Layout, r: &Record) -> Result<(), String> {
    let dir = super::state::dir(layout);
    let p = record_path(layout);
    fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let tmp = dir.join(format!("addons.json.tmp-{}", std::process::id()));
    let result = (|| -> io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        let mut text = serde_json::to_string_pretty(r).map_err(io::Error::other)?;
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

/// Remembers (`add`) or forgets (`remove`) required add-ons.
pub fn set_required(layout: &Layout, add: &[String], remove: &[String]) -> Result<(), String> {
    let mut r = load(layout)?;
    for a in add {
        r.required.insert(a.clone());
    }
    for a in remove {
        r.required.remove(a);
    }
    save(layout, &r)
}

/// Adds `held` entries (replacing an older entry of the same name).
pub fn record_disabled(layout: &Layout, held: Vec<Held>) -> Result<(), String> {
    let mut r = load(layout)?;
    for h in held {
        r.disabled.retain(|x| x.name != h.name);
        r.disabled.push(h);
    }
    save(layout, &r)
}

/// Drops the entries named in `names`.
pub fn clear_disabled(layout: &Layout, names: &[String]) -> Result<(), String> {
    let mut r = load(layout)?;
    r.disabled.retain(|x| !names.contains(&x.name));
    save(layout, &r)
}

// ---------------------------------------------------------------------------------------------------------------
// Evaluation

/// Judges every installed add-on against `offer`. `extra_required` / `forget` are the `--require-addon` and
/// `--unrequire-addon` names of this run (nothing is written here).
pub fn evaluate(
    layout: &Layout,
    offer: &Offer,
    extra_required: &[String],
    forget: &[String],
) -> AddonPlan {
    let mut plan = AddonPlan::default();
    let record = match load(layout) {
        Ok(r) => r,
        Err(m) => {
            plan.note = Some(m);
            Record::default()
        }
    };
    let required: BTreeSet<&str> = record
        .required
        .iter()
        .map(String::as_str)
        .chain(extra_required.iter().map(String::as_str))
        .filter(|n| !forget.iter().any(|f| f == n) || extra_required.iter().any(|e| e == n))
        .collect();
    let paths = ExtPaths::of(layout);
    let state = match ext::state::read(&paths) {
        Ok(s) => s,
        Err(m) => {
            plan.note = Some(m);
            ext::state::ExtState::default()
        }
    };
    let cfg = plur1bus_config::read(&layout.config_path()).unwrap_or(Value::Null);
    let idx = ext::index::read_index(layout).ok();

    let mut seen: BTreeSet<String> = BTreeSet::new();
    for rec in state.items.values() {
        if rec.removed_by_user || !matches!(rec.kind.as_str(), "skill" | "module" | "channel") {
            continue;
        }
        seen.insert(rec.name.clone());
        let enabled = enabled_in(layout, idx.as_ref(), &cfg, &rec.name, &rec.kind);
        let (status, detail) = match ext::list::cached_meta(&paths, &rec.package_sha256) {
            Some(meta) => judge_manifest(&meta["manifest"], offer),
            None => (
                Status::Unknown,
                Some("its package manifest is not cached".into()),
            ),
        };
        plan.items.push(Verdict {
            name: rec.name.clone(),
            kind: rec.kind.clone(),
            version: rec.version.clone(),
            status,
            enabled,
            required: required.contains(rec.name.as_str()),
            detail,
            held_by_update: false,
        });
    }
    // Modules on disk that no package record explains (local installs); the release's own bundled ones are
    // replaced by the release and are not add-ons.
    let bundled: BTreeSet<String> = crate::ext::list::install_units(layout, "modules")
        .into_iter()
        .filter(|(_, (source, _))| source == "bundled")
        .map(|(n, _)| n)
        .collect();
    for m in crate::modules::manifest::scan(layout) {
        if seen.contains(&m.name) || bundled.contains(&m.name) {
            continue;
        }
        let Ok(man) = m.manifest else { continue };
        let kind = man.kind.clone().unwrap_or_else(|| "module".into());
        let (status, detail) = judge_api_version(&man.api_version, offer);
        plan.items.push(Verdict {
            enabled: cfg["modules"][m.name.as_str()]["enabled"] != false,
            required: required.contains(m.name.as_str()),
            name: m.name,
            kind,
            version: man.version,
            status,
            detail,
            held_by_update: false,
        });
    }
    for v in &mut plan.items {
        v.held_by_update = record.disabled.iter().any(|h| h.name == v.name);
        if v.status == Status::Incompatible && v.enabled {
            plan.disable.push(v.name.clone());
            if v.required {
                plan.blocked.push(v.name.clone());
            }
        }
        if v.status == Status::Compatible && v.held_by_update && !v.enabled {
            plan.reenable.push(v.name.clone());
        }
    }
    plan.items.sort_by(|a, b| a.name.cmp(&b.name));
    plan
}

// ---------------------------------------------------------------------------------------------------------------
// Actions (the daemon is stopped, so the offline ext host applies)

fn toggle(layout: &Layout, name: &str, on: bool) -> Result<(), String> {
    let mut host = OfflineHost::new(layout);
    let o = ToggleOpts::default();
    let r = if on {
        lifecycle::enable(layout, &mut host, name, &o)
    } else {
        lifecycle::disable(layout, &mut host, name, &o)
    };
    r.map(|_| ()).map_err(|e| format!("{name}: {}", e.message))
}

/// Disables `names` and records them as held by update `from -> to`. All or nothing as far as the caller is
/// concerned: on a failure the ones already disabled are enabled again before the error is returned.
pub fn disable_for_update(
    layout: &Layout,
    items: &[Verdict],
    names: &[String],
    from: &str,
    to: &str,
) -> Result<(), String> {
    let mut done: Vec<&String> = Vec::new();
    for n in names {
        if let Err(m) = toggle(layout, n, false) {
            for d in done {
                let _ = toggle(layout, d, true);
            }
            return Err(m);
        }
        done.push(n);
    }
    let held = names
        .iter()
        .filter_map(|n| items.iter().find(|v| &v.name == n))
        .map(|v| Held {
            name: v.name.clone(),
            kind: v.kind.clone(),
            version: v.version.clone(),
            reason: v.detail.clone().unwrap_or_else(|| "incompatible".into()),
            from: from.into(),
            to: to.into(),
            at: super::state::now_ms(),
        })
        .collect();
    record_disabled(layout, held)
}

/// Puts back what a rolled-back update disabled: the flag of a module is restored with `config.json`, a skill's lives
/// in `skills/index.json`, which no snapshot covers. Best effort; returns the names that could not be re-enabled.
pub fn restore_after_rollback(layout: &Layout, names: &[String]) -> Vec<String> {
    let failed: Vec<String> = names
        .iter()
        .filter(|n| toggle(layout, n, true).is_err())
        .cloned()
        .collect();
    let _ = clear_disabled(layout, names);
    failed
}

/// Re-enables add-ons an earlier update disabled that are compatible again. Returns `(name, error)` for the ones
/// that refused (they stay recorded; the person can enable them by hand).
pub fn reenable(layout: &Layout, names: &[String]) -> Vec<(String, String)> {
    let mut failed = Vec::new();
    let mut ok = Vec::new();
    for n in names {
        match toggle(layout, n, true) {
            Ok(()) => ok.push(n.clone()),
            Err(m) => failed.push((n.clone(), m)),
        }
    }
    let _ = clear_disabled(layout, &ok);
    failed
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn manifest(kind: &str, compat: Value) -> Value {
        json!({
            "format": 1, "id": "dev.test/x", "name": "x", "version": "1.0.0", "kind": kind,
            "title": {"en": "x"}, "summary": {"en": "x"},
            "publisher": {"name": "t"}, "licence": "MIT",
            "compat": compat, "requires": {"runtime": {"type": "none"}},
            "capabilities": {}, "scripts": [], "files": {},
        })
    }

    fn offer(api: Option<&[&str]>) -> Offer {
        Offer {
            harness: "0.3.0".into(),
            module_api: api.map(|l| l.iter().map(|s| s.to_string()).collect()),
            rpc: "1.5.0".into(),
        }
    }

    #[test]
    fn a_manifest_is_judged_against_the_targets_facts() {
        let ok = manifest("skill", json!({"harness": ">=0.2.0"}));
        assert_eq!(judge_manifest(&ok, &offer(None)).0, Status::Compatible);
        let old = manifest("skill", json!({"harness": "<0.3.0"}));
        let (s, why) = judge_manifest(&old, &offer(None));
        assert_eq!(s, Status::Incompatible);
        assert!(why.unwrap().contains("compat.harness"));
        let rpc = manifest("skill", json!({"harness": ">=0.1.0", "rpc": ">=2.0.0"}));
        assert_eq!(judge_manifest(&rpc, &offer(None)).0, Status::Incompatible);
    }

    #[test]
    fn the_module_api_needs_the_release_to_say_what_it_speaks() {
        let m = manifest("module", json!({"harness": ">=0.1.0", "moduleApi": ["1"]}));
        assert_eq!(
            judge_manifest(&m, &offer(Some(&["1", "2"]))).0,
            Status::Compatible
        );
        assert_eq!(
            judge_manifest(&m, &offer(Some(&["2"]))).0,
            Status::Incompatible
        );
        let (s, why) = judge_manifest(&m, &offer(None));
        assert_eq!(s, Status::Unknown);
        assert!(why.unwrap().contains("module API"));
        // A skill's moduleApi is ignored by the compat rules, so it is never unknown for that.
        let sk = manifest("skill", json!({"harness": ">=0.1.0", "moduleApi": ["1"]}));
        assert_eq!(judge_manifest(&sk, &offer(None)).0, Status::Compatible);
        // Another failing field wins over an unknown one.
        let bad = manifest("module", json!({"harness": ">=9.0.0", "moduleApi": ["1"]}));
        assert_eq!(judge_manifest(&bad, &offer(None)).0, Status::Incompatible);
        assert_eq!(
            judge_manifest(&json!({"nope": 1}), &offer(None)).0,
            Status::Unknown
        );
    }

    #[test]
    fn a_local_modules_api_version_is_matched_against_the_list() {
        assert_eq!(
            judge_api_version("1", &offer(Some(&["1", "2"]))).0,
            Status::Compatible
        );
        assert_eq!(
            judge_api_version("3", &offer(Some(&["1", "2"]))).0,
            Status::Incompatible
        );
        assert_eq!(judge_api_version("1", &offer(None)).0, Status::Unknown);
    }

    #[test]
    fn the_record_round_trips_and_a_torn_one_is_an_error() {
        let d = tempfile::tempdir().unwrap();
        let l = Layout::new(d.path().join("h"));
        assert_eq!(load(&l).unwrap(), Record::default());
        set_required(&l, &["a".into(), "b".into()], &[]).unwrap();
        set_required(&l, &[], &["a".into()]).unwrap();
        record_disabled(
            &l,
            vec![Held {
                name: "x".into(),
                kind: "module".into(),
                version: "1".into(),
                reason: "r".into(),
                from: "0.1.0".into(),
                to: "0.2.0".into(),
                at: 1,
            }],
        )
        .unwrap();
        let r = load(&l).unwrap();
        assert_eq!(r.required.iter().collect::<Vec<_>>(), ["b"]);
        assert_eq!(r.disabled.len(), 1);
        clear_disabled(&l, &["x".into()]).unwrap();
        assert!(load(&l).unwrap().disabled.is_empty());
        fs::write(record_path(&l), "{").unwrap();
        assert!(load(&l).is_err());
    }

    #[test]
    fn the_offer_comes_from_the_release_with_fallbacks() {
        let head = ReleaseHead {
            version: "0.3.0".into(),
            channel: "stable".into(),
            min_from_version: "0.1.0".into(),
        };
        let o = offer_of(&head, None);
        assert_eq!((o.harness.as_str(), o.module_api), ("0.3.0", None));
        assert_eq!(o.rpc, plur1bus_rpc::RPC_VERSION);
    }

    /// A packaged skill: its record, its cached manifest (with `compat`), its folder, and an enabled index entry.
    fn install_skill(l: &Layout, name: &str, compat: Value) {
        use crate::ext::state::{ExtState, ItemRecord};
        let paths = ExtPaths::of(l);
        let sha = format!(
            "{:0>64}",
            name.bytes().map(|b| format!("{b:02x}")).collect::<String>()
        );
        let caps = json!({});
        let rec = ItemRecord {
            id: format!("dev.test/{name}"),
            name: name.into(),
            kind: "skill".into(),
            version: "1.0.0".into(),
            source: "file".into(),
            trust: "unsigned".into(),
            key_id: None,
            key_label: None,
            package_sha256: sha.clone(),
            installed_at: "2026-10-01T00:00:00.000Z".into(),
            previous_version: None,
            files: Default::default(),
            capabilities: caps.clone(),
            capabilities_ack: Some(crate::ext::commit::capabilities_hash(&caps)),
            scripts: vec![],
            required_secrets: vec![],
            removed_by_user: false,
            integrity: None,
        };
        let mut st: ExtState = crate::ext::state::read(&paths).unwrap();
        st.items.insert(name.into(), rec.clone());
        fs::create_dir_all(&paths.root).unwrap();
        crate::ext::state::write(&paths, &st).unwrap();
        fs::create_dir_all(&paths.cache).unwrap();
        fs::write(
            paths.cached_meta(&sha),
            serde_json::to_vec(&json!({ "manifest": manifest("skill", compat), "scripts": [] }))
                .unwrap(),
        )
        .unwrap();
        fs::create_dir_all(l.skills().join(name)).unwrap();
        fs::write(l.skills().join(name).join("SKILL.md"), "# skill\n").unwrap();
        let mut idx = ext::index::read_index(l).unwrap();
        idx.upsert(ext::index::package_entry(
            &rec,
            "-",
            true,
            "2026-10-01T00:00:00.000Z",
            None,
        ));
        ext::index::write_index(l, &idx).unwrap();
    }

    fn skill_enabled(l: &Layout, name: &str) -> bool {
        ext::index::read_index(l)
            .unwrap()
            .entry(name)
            .is_some_and(|e| e["enabled"] == true)
    }

    #[test]
    fn a_packaged_addon_is_judged_disabled_recorded_and_brought_back() {
        let d = tempfile::tempdir().unwrap();
        let l = Layout::new(d.path().join("h"));
        install_skill(&l, "narrow", json!({"harness": "<0.3.0"}));
        install_skill(&l, "wide", json!({"harness": ">=0.1.0"}));
        let o = offer(Some(&["1"]));
        let plan = evaluate(&l, &o, &["narrow".into()], &[]);
        let by = |n: &str| plan.items.iter().find(|v| v.name == n).unwrap();
        assert_eq!(by("narrow").status, Status::Incompatible);
        assert!(by("narrow").required && by("narrow").enabled);
        assert_eq!(by("wide").status, Status::Compatible);
        assert_eq!(
            (plan.disable.clone(), plan.blocked.clone()),
            (vec!["narrow".to_string()], vec!["narrow".to_string()])
        );
        assert!(plan.reenable.is_empty());
        // `--unrequire-addon` wins over the remembered marker.
        set_required(&l, &["narrow".into()], &[]).unwrap();
        assert_eq!(evaluate(&l, &o, &[], &[]).blocked, ["narrow"]);
        assert!(evaluate(&l, &o, &[], &["narrow".into()]).blocked.is_empty());

        disable_for_update(&l, &plan.items, &plan.disable, "0.2.0", "0.3.0").unwrap();
        assert!(!skill_enabled(&l, "narrow") && skill_enabled(&l, "wide"));
        let rec = load(&l).unwrap();
        assert_eq!(rec.disabled.len(), 1);
        assert_eq!(rec.disabled[0].name, "narrow");
        assert!(rec.disabled[0].reason.contains("compat.harness"));

        // Against a release it fits, the held add-on is slated for re-enabling, and re-enabling works.
        let fits = Offer {
            harness: "0.2.5".into(),
            ..o.clone()
        };
        let again = evaluate(&l, &fits, &[], &[]);
        assert_eq!(again.reenable, ["narrow"]);
        assert!(
            again
                .items
                .iter()
                .find(|v| v.name == "narrow")
                .unwrap()
                .held_by_update
        );
        assert!(reenable(&l, &again.reenable).is_empty());
        assert!(skill_enabled(&l, "narrow"));
        assert!(load(&l).unwrap().disabled.is_empty());

        // A failed disable undoes the ones already done.
        let items = evaluate(&l, &o, &[], &[]).items;
        let err = disable_for_update(
            &l,
            &items,
            &["narrow".into(), "ghost".into()],
            "0.2.0",
            "0.3.0",
        )
        .unwrap_err();
        assert!(err.contains("ghost"), "{err}");
        assert!(skill_enabled(&l, "narrow"), "rolled back");
        assert!(load(&l).unwrap().disabled.is_empty());
    }

    #[test]
    fn an_addon_without_a_cached_manifest_is_unknown_and_never_acted_on() {
        let d = tempfile::tempdir().unwrap();
        let l = Layout::new(d.path().join("h"));
        install_skill(&l, "odd", json!({"harness": "<0.1.0"}));
        let paths = ExtPaths::of(&l);
        fs::remove_file(paths.cached_meta(&format!("{:0>64}", "6f6464"))).unwrap();
        let plan = evaluate(&l, &offer(None), &["odd".into()], &[]);
        assert_eq!(plan.items[0].status, Status::Unknown);
        assert!(plan.disable.is_empty() && plan.blocked.is_empty());
        // An unreadable state file is reported, not fatal.
        fs::write(&paths.state, "{").unwrap();
        let plan = evaluate(&l, &offer(None), &[], &[]);
        assert!(plan.note.is_some() && plan.items.is_empty());
    }
}
