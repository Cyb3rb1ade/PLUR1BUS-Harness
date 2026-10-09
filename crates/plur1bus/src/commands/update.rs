//! `plur1bus update --check` (spec §6.5, D78, HB10, H3b-b-2). Compares the install manifest with the signed
//! release feed and names the units that would restart. Never
//! writes anything: `update --check` only reads the install manifest and the release feed. Applying (D78) lives in
//! `update_apply.rs` beside it and in `crate::update`.
use crate::cli::{UpdateArgs, UpdateCmd};
use crate::install;
use crate::output::Out;
use crate::paths::Layout;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::time::Duration;

/// The whole exchange (the manifest and, when a key is baked, its signature) must finish inside this deadline
/// (Review Focus 4). `fetch_bytes` itself bounds each individual read.
const DEADLINE: Duration = Duration::from_secs(30);
/// The release manifest is capped at 1 MiB (Task 5 interfaces).
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
/// A minisign `.minisig` file is a few hundred bytes; anything past this is not one.
const MAX_SIG_BYTES: u64 = 16 * 1024;

/// The installed manifest and a parsed (and, when a key is baked, signature-verified) release feed.
pub(super) struct Feed {
    pub manifest: install::manifest::InstallManifest,
    pub channel: String,
    pub raw: Vec<u8>,
    pub head: install::manifest::ReleaseHead,
    pub native: Option<install::manifest::ReleaseNative>,
    pub verified: bool,
    /// The extracted offline bundle (`--from`), whose files the artefact URLs resolve to.
    pub bundle: Option<std::path::PathBuf>,
}

/// Fails the command; an extracted bundle is removed first.
fn fail_feed(out: &Out, layout: &Layout, reason: &str, message: &str) -> ! {
    crate::update::bundle::cleanup(layout);
    out.fail("E_NOT_AVAILABLE", message, json!({ "reason": reason }), 1)
}

/// `--ca-bundle` is the same as `PLUR1BUS_CA_BUNDLE`: checked now, so a bad file is one clear refusal.
fn apply_ca_bundle(out: &Out, args: &UpdateArgs) {
    let Some(p) = &args.ca_bundle else { return };
    if let Err(e) = install::fetch::load_ca_bundle(p) {
        out.fail(
            "E_INVALID_PARAMS",
            &e.to_string(),
            json!({ "reason": "ca-bundle-invalid" }),
            2,
        );
    }
    std::env::set_var(install::fetch::CA_BUNDLE_ENV, p);
}

fn load_feed(out: &Out, layout: &Layout, args: &UpdateArgs, persist: bool) -> Feed {
    apply_ca_bundle(out, args);
    let manifest = match install::manifest::read(layout) {
        Ok(Some(m)) => m,
        Ok(None) => out.fail(
            "E_NOT_AVAILABLE",
            "no install manifest here: run `plur1bus setup` first",
            json!({ "reason": "not-installed" }),
            1,
        ),
        Err(e) => out.fail(
            "E_NOT_AVAILABLE",
            &format!("install manifest is unreadable: {e}"),
            json!({ "reason": "not-installed" }),
            1,
        ),
    };

    let bundle = args.from.as_ref().map(|path| {
        crate::update::bundle::open(layout, path).unwrap_or_else(|e| {
            out.fail(
                "E_NOT_AVAILABLE",
                &e.message,
                json!({ "reason": e.reason }),
                1,
            )
        })
    });

    let mut channel = args
        .channel
        .clone()
        .unwrap_or_else(|| manifest.channel.clone());
    let src = release_source(args, &channel);

    let raw = match &bundle {
        Some(b) => b.manifest.clone(),
        None => match install::fetch::fetch_bytes(&src, MAX_MANIFEST_BYTES, DEADLINE) {
            Ok(b) => b,
            Err(e) => out.fail(
                "E_NOT_AVAILABLE",
                &format!("could not read the release manifest: {e}"),
                json!({ "reason": e.reason() }),
                1,
            ),
        },
    };

    let (head, native) = match install::manifest::parse_release(&raw) {
        Ok(v) => v,
        Err(errs) => fail_feed(
            out,
            layout,
            "release-malformed",
            &format!("the release manifest is malformed: {}", errs.join("; ")),
        ),
    };
    if bundle.is_some() {
        // A bundle names its own channel; it may not quietly move the install to another one.
        if head.channel != channel {
            fail_feed(
                out,
                layout,
                "channel-mismatch",
                &format!(
                    "the bundle is for the {} channel, this install follows {channel}: pass --channel {} to switch",
                    head.channel, head.channel
                ),
            );
        }
        channel = head.channel.clone();
    }

    let verified = match verify_release(layout, &raw, &channel, &src, bundle.as_ref(), persist) {
        Ok(v) => v,
        Err((reason, message)) => fail_feed(out, layout, reason, &message),
    };
    Feed {
        manifest,
        channel,
        raw,
        head,
        native,
        verified,
        bundle: bundle.map(|b| b.dir),
    }
}

pub fn run(out: &Out, layout: &Layout, args: UpdateArgs) -> ! {
    if let Some(UpdateCmd::Status) = args.sub {
        super::update_apply::status(out, layout);
    }
    if args.rollback {
        super::refuse_in_container(out, "update --rollback");
        super::update_apply::recover_at_start(layout);
        super::update_apply::rollback(out, layout);
    }
    if !args.check {
        super::refuse_in_container(out, "update");
        super::update_apply::recover_at_start(layout);
        let feed = load_feed(out, layout, &args, true);
        super::update_apply::apply(out, layout, &args, feed);
    }
    super::refuse_in_container(out, "update --check");

    let Feed {
        manifest,
        channel: _,
        raw,
        head,
        native,
        verified: verified_flag,
        bundle: _,
    } = load_feed(out, layout, &args, false);

    let doc: Value = serde_json::from_slice(&raw).unwrap_or(json!({}));
    let installed_modules = installed_modules(layout);
    let installed_json = json!({
        "version": manifest.binary.version,
        "core": manifest.core.version,
        "node": manifest.node.version,
        "modules": installed_modules,
    });

    let newer = is_newer(&head.version, &manifest.binary.version);
    let (available, changes, restart_core, restart_modules, supervisor_restart, blocked) = if !newer
    {
        (
            Value::Null,
            Vec::new(),
            false,
            Vec::new(),
            false,
            Value::Null,
        )
    } else {
        let available = json!({
            "version": head.version,
            "channel": head.channel,
            "kind": doc.get("kind").cloned().unwrap_or(Value::Null),
            "security": doc.get("security").cloned().unwrap_or(Value::Null),
            "minFromVersion": head.min_from_version,
            "notes": doc.get("notes").cloned().unwrap_or(Value::Null),
        });
        if is_newer(&head.min_from_version, &manifest.binary.version) {
            let blocked =
                json!({ "reason": "min-from-version", "minFromVersion": head.min_from_version });
            (available, Vec::new(), false, Vec::new(), false, blocked)
        } else {
            let (changes, restart_core, restart_modules, supervisor_restart) =
                plan_changes(&manifest, &native, &head, &installed_modules);
            (
                available,
                changes,
                restart_core,
                restart_modules,
                supervisor_restart,
                Value::Null,
            )
        }
    };

    let result = json!({
        "installed": installed_json,
        "available": available,
        "verified": verified_flag,
        "changes": changes,
        "restart": { "live": Vec::<String>::new(), "core": restart_core, "modules": restart_modules },
        "supervisorRestart": supervisor_restart,
        "blocked": blocked,
    });
    out.ok("update.check/1", &result, || human(&result));
    std::process::exit(0);
}

fn human(result: &Value) -> String {
    if result["available"].is_null() {
        return "up to date".to_string();
    }
    if !result["blocked"].is_null() {
        return format!(
            "blocked: upgrade to {} first ({})",
            result["blocked"]["minFromVersion"].as_str().unwrap_or("?"),
            result["blocked"]["reason"].as_str().unwrap_or("?")
        );
    }
    let mut lines = vec![format!(
        "update available: {}",
        result["available"]["version"].as_str().unwrap_or("?")
    )];
    for c in result["changes"].as_array().into_iter().flatten() {
        lines.push(format!(
            "  {}: {} -> {}",
            c["unit"].as_str().unwrap_or("?"),
            c["from"].as_str().unwrap_or("-"),
            c["to"].as_str().unwrap_or("-"),
        ));
    }
    lines.join("\n")
}

/// `--manifest <path|url>`, else `release_base_url()`'s `{channel}.json`, else the default feed (DR21).
fn release_source(args: &UpdateArgs, channel: &str) -> String {
    if let Some(m) = &args.manifest {
        return m.clone();
    }
    match install::pins::release_base_url() {
        Some(base) => format!("{base}/{channel}.json"),
        None => format!("https://updates.plur1bus.app/{channel}.json"),
    }
}

/// `Ok(true)` verified, `Ok(false)` no key baked (dev build), `Err((reason, message))` a bad signature or an
/// unreachable/malformed one. The baked key, a rotated key and the key list that announces one are all handled by
/// `update::guard`; this only says where the signature and the key list come from.
fn verify_release(
    layout: &Layout,
    raw: &[u8],
    channel: &str,
    src: &str,
    bundle: Option<&crate::update::bundle::Bundle>,
    persist: bool,
) -> Result<bool, (&'static str, String)> {
    let fetch_sig = || -> Result<String, (&'static str, String)> {
        if let Some(b) = bundle {
            return Ok(b.sig.clone());
        }
        let sig_src = format!("{src}.minisig");
        let sig_raw =
            install::fetch::fetch_bytes(&sig_src, MAX_SIG_BYTES, DEADLINE).map_err(|e| {
                (
                    e.reason(),
                    format!("could not read the release signature: {e}"),
                )
            })?;
        String::from_utf8(sig_raw).map_err(|_| {
            (
                "release-signature-invalid",
                "the release signature is not valid UTF-8".to_string(),
            )
        })
    };
    let fetch_keys = || -> Option<(Vec<u8>, String)> {
        if let Some(b) = bundle {
            return b.keys.clone();
        }
        let keys_src = key_list_source(src);
        let list = install::fetch::fetch_bytes(
            &keys_src,
            crate::update::guard::MAX_KEY_LIST_BYTES,
            DEADLINE,
        )
        .ok()?;
        let sig =
            install::fetch::fetch_bytes(&format!("{keys_src}.minisig"), MAX_SIG_BYTES, DEADLINE)
                .ok()?;
        Some((list, String::from_utf8(sig).ok()?))
    };
    crate::update::guard::verify_release(
        layout,
        raw,
        &crate::update::guard::Ctx {
            channel,
            baked: install::pins::release_pubkey_for(channel),
            persist,
            now: crate::update::guard::now_secs(),
            fetch_sig: &fetch_sig,
            fetch_keys: &fetch_keys,
        },
    )
}

/// Where the key list of the feed at `src` lives: `stable.json` -> `stable.keys.json`.
pub(super) fn key_list_source(src: &str) -> String {
    match src.strip_suffix(".json") {
        Some(base) => format!("{base}.keys.json"),
        None => format!("{src}.keys.json"),
    }
}

/// The installed modules (`{name, version, apiVersion}`), read from `<home>/modules/*/module.json`, the on-disk
/// truth D14 module-guide.md gives — never from the install manifest, which carries no `apiVersion`.
pub(super) fn installed_modules(layout: &Layout) -> Vec<Value> {
    crate::modules::manifest::scan(layout)
        .into_iter()
        .filter_map(|i| {
            i.manifest.ok().map(|m| {
                json!({
                    "name": i.name,
                    "version": m.version,
                    "apiVersion": m.api_version,
                })
            })
        })
        .collect()
}

/// `a > b`, comparing `major.minor.patch` numerically when both parse as semver's release triple; otherwise a
/// plain string mismatch (a release build never ships a non-semver version, so this fallback is unreached in
/// practice).
pub(super) fn is_newer(a: &str, b: &str) -> bool {
    match (parse_semver_triple(a), parse_semver_triple(b)) {
        (Some(x), Some(y)) => x > y,
        _ => a != b,
    }
}

fn parse_semver_triple(v: &str) -> Option<(u64, u64, u64)> {
    let core = v.split(['-', '+']).next().unwrap_or(v);
    let mut it = core.split('.');
    let major = it.next()?.parse().ok()?;
    let minor = it.next()?.parse().ok()?;
    let patch = it.next()?.parse().ok()?;
    if it.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

/// The units that differ between the installed manifest and the release's `native` object (`None` for an
/// app-only release, HB10), and the restart consequence of each (Task 5 interfaces rules).
pub(super) fn plan_changes(
    manifest: &install::manifest::InstallManifest,
    native: &Option<install::manifest::ReleaseNative>,
    head: &install::manifest::ReleaseHead,
    installed_modules: &[Value],
) -> (Vec<Value>, bool, Vec<String>, bool) {
    let mut changes = Vec::new();
    let mut restart_core = false;
    let mut restart_modules: BTreeSet<String> = BTreeSet::new();
    let mut supervisor_restart = false;

    let Some(native) = native else {
        return (
            changes,
            restart_core,
            restart_modules.into_iter().collect(),
            supervisor_restart,
        );
    };

    if let Some(t) = install::targets::Target::current() {
        if let Some(asset) = native.binary.get(t.id()) {
            let differs = manifest.binary.sha256.as_deref() != Some(asset.sha256.as_str());
            if differs {
                changes.push(json!({ "unit": "binary", "from": manifest.binary.version, "to": head.version }));
                supervisor_restart = true;
            }
        }
    }

    let core_changed = native.core.version != manifest.core.version
        || native.core.contract != manifest.core.contract
        || native.core.rpc != manifest.core.rpc;
    if core_changed {
        changes.push(
            json!({ "unit": "core", "from": manifest.core.version, "to": native.core.version }),
        );
        restart_core = true;
    }

    if native.node.version != manifest.node.version {
        changes.push(
            json!({ "unit": "node", "from": manifest.node.version, "to": native.node.version }),
        );
        restart_core = true;
        for m in installed_modules {
            if let Some(name) = m["name"].as_str() {
                restart_modules.insert(name.to_string());
            }
        }
    }

    let installed_by_name: std::collections::BTreeMap<&str, (&str, &str)> = installed_modules
        .iter()
        .filter_map(|m| {
            let name = m["name"].as_str()?;
            let version = m["version"].as_str()?;
            let api = m["apiVersion"].as_str()?;
            Some((name, (version, api)))
        })
        .collect();

    // The host profile installs no bundled modules (HM2-R9): for it the release carries none, so they are not drift
    // (F35). A module a host user installed is theirs: the release has no update information for it and does not
    // remove it, so it stays out of the diff (it is still listed under `installed.modules`).
    let host = manifest.profile() == install::manifest::PROFILE_HOST;
    let release_modules: &[install::manifest::ReleaseModule] =
        if host { &[] } else { &native.modules };
    for nm in release_modules {
        match installed_by_name.get(nm.name.as_str()) {
            None => {
                changes.push(json!({ "unit": format!("module:{}", nm.name), "from": Value::Null, "to": nm.version }));
            }
            Some((cur_version, cur_api)) => {
                if *cur_version != nm.version || *cur_api != nm.api_version {
                    let mut entry = json!({
                        "unit": format!("module:{}", nm.name),
                        "from": *cur_version,
                        "to": nm.version,
                    });
                    let new_api: u32 = nm.api_version.parse().unwrap_or(0);
                    if !crate::modules::manifest::api_version_supported(cur_api, new_api) {
                        entry["detail"] = json!("api-version-unsupported");
                    }
                    changes.push(entry);
                    restart_modules.insert(nm.name.clone());
                }
            }
        }
    }

    let in_release: std::collections::BTreeSet<&str> =
        release_modules.iter().map(|m| m.name.as_str()).collect();
    for (name, (version, _)) in &installed_by_name {
        if !host && !in_release.contains(name) {
            changes.push(
                json!({ "unit": format!("module:{name}"), "from": *version, "to": Value::Null }),
            );
        }
    }

    (
        changes,
        restart_core,
        restart_modules.into_iter().collect(),
        supervisor_restart,
    )
}
