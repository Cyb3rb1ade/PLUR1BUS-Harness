//! Additive host image updater: the existing guard verifies exact release bytes and key rotation.
use crate::{
    cli::{UpdateArgs, UpdateCmd},
    container_commands as host,
    install::{fetch, manifest, pins},
    output::Out,
    paths::Layout,
};
use plur1bus_containers::*;
use serde_json::{json, Value};
use std::{
    io::{self, IsTerminal, Write},
    time::Duration,
};
const DEADLINE: Duration = Duration::from_secs(30);
pub fn installed(layout: &Layout) -> bool {
    host::path(layout).exists()
}
fn offer(raw: &[u8], channel: &str, store_schema: u32) -> Result<(String, manifest::ReleaseHead)> {
    let (head, _) = manifest::parse_release(raw).map_err(|e| e.join("; "))?;
    if head.channel != channel {
        return Err("release channel mismatch".into());
    }
    let doc: Value = serde_json::from_slice(raw).map_err(|e| e.to_string())?;
    let image = doc["containers"]["image"]
        .as_str()
        .ok_or("signed release has no containers.image")?;
    validate_digest_image(image)?;
    if doc["containers"]["storeSchema"].as_u64() != Some(store_schema as u64) {
        return Err(
            "image changes store schema: image-only rollback cannot undo migrations".into(),
        );
    }
    Ok((image.into(), head))
}
pub fn run(out: &Out, layout: &Layout, args: UpdateArgs) -> ! {
    let result = execute(out, layout, &args);
    crate::update::bundle::cleanup(layout);
    match result {
        Ok((schema, v)) => {
            out.ok(schema, &v, || v.to_string());
            std::process::exit(0)
        }
        Err(e) => host::fail(out, "container-update", &e),
    }
}
fn execute(out: &Out, layout: &Layout, args: &UpdateArgs) -> Result<(&'static str, Value)> {
    let _lock = if args.check || args.plan || args.sub.is_some() {
        None
    } else {
        Some(host::lock(layout)?)
    };
    let mut state = host::read(layout)?;
    if matches!(args.sub, Some(UpdateCmd::Status)) {
        return Ok((
            "update.status/1",
            json!({"mode":"container","version":state.version,"recoveryPending":state.pending,"canRollback":state.previous.is_some()}),
        ));
    }
    if !args.require_addon.is_empty() || !args.unrequire_addon.is_empty() || args.force {
        return Err("container image updates do not support native add-on mutations".into());
    }
    let r = host::runtime(state.runtime);
    if args.rollback {
        host::recover(layout, &mut state, r.as_ref())?;
        let previous = state.previous.clone().ok_or("no previous image")?;
        let version = state
            .previous_version
            .clone()
            .ok_or("no previous version")?;
        let image = previous
            .iter()
            .find(|s| s.name == "plur1bus-harness")
            .ok_or("previous harness missing")?
            .image
            .clone();
        let current = state.services.clone();
        let current_version = state.version.clone();
        // Crash recovery restores the CURRENT image if this manual rollback is interrupted.
        state.previous = Some(current);
        state.previous_version = Some(current_version);
        state.pending = true;
        host::save(layout, &state)?;
        host::manager(r.as_ref(), &state).upgrade_image("plur1bus-harness", &image)?;
        state.services = previous;
        state.version = version;
        state.pending = false;
        host::save(layout, &state)?;
        return Ok((
            "update.rollback/1",
            json!({"mode":"container","outcome":"rolled-back","version":state.version}),
        ));
    }
    if let Some(ca) = &args.ca_bundle {
        fetch::load_ca_bundle(ca).map_err(|e| e.to_string())?;
        std::env::set_var(fetch::CA_BUNDLE_ENV, ca);
    }
    let channel = args.channel.as_deref().unwrap_or(&state.channel).to_owned();
    let source = args.manifest.clone().unwrap_or_else(|| {
        format!(
            "{}/{}.json",
            pins::release_base_url().unwrap_or("https://updates.plur1bus.app"),
            channel
        )
    });
    let bundle = args
        .from
        .as_ref()
        .map(|p| super::bundle::open(layout, p).map_err(|e| e.message))
        .transpose()?;
    let raw = match &bundle {
        Some(b) => b.manifest.clone(),
        None => fetch::fetch_bytes(&source, 1 << 20, DEADLINE).map_err(|e| e.to_string())?,
    };
    if !verify_bytes(layout, &raw, &channel, &source, bundle.as_ref(), false)? {
        return Err("release-unverified: no trusted release key".into());
    }
    let (image, head) = offer(&raw, &channel, state.store_schema)?;
    let guard = super::guard::load(layout)?;
    super::guard::check_version(
        &guard,
        &channel,
        &state.version,
        &head.version,
        args.allow_downgrade,
    )
    .map_err(|e| e.message)?;
    if super::guard::check_version(
        &super::guard::Guard::default(),
        &channel,
        &head.min_from_version,
        &state.version,
        false,
    )
    .is_err()
    {
        return Err(format!("upgrade to {} first", head.min_from_version));
    }
    let view = json!({"mode":"container","from":state.version,"to":head.version,"image":image,"verified":true,"recoveryPending":state.pending});
    if args.check || args.plan {
        return Ok((
            if args.check {
                "update.check/1"
            } else {
                "update.plan/1"
            },
            view,
        ));
    }
    if !args.yes {
        if out.json || !io::stdin().is_terminal() {
            return Err("confirmation-required: use --yes after reviewing update --plan".into());
        }
        println!("{view}");
        print!("Apply image update? [y/N] ");
        let _ = io::stdout().flush();
        let mut answer = String::new();
        let _ = io::stdin().read_line(&mut answer);
        if !matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes") {
            return Err("declined".into());
        }
    }
    host::recover(layout, &mut state, r.as_ref())?;
    let current = state
        .services
        .iter()
        .find(|s| s.name == "plur1bus-harness")
        .ok_or("harness missing")?;
    if current.image == image && state.version == head.version {
        return Ok((
            "update.apply/1",
            json!({"mode":"container","outcome":"up-to-date","version":state.version}),
        ));
    }
    verify_bytes(layout, &raw, &channel, &source, bundle.as_ref(), true)?;
    if !r.image_available(&image)? {
        r.pull(&image)?;
    }
    super::guard::record_seen(layout, &channel, &head.version)?;
    state.previous = Some(state.services.clone());
    state.previous_version = Some(state.version.clone());
    state.pending = true;
    host::save(layout, &state)?;
    if let Err(e) = host::manager(r.as_ref(), &state).upgrade_image("plur1bus-harness", &image) {
        // The stack attempted rollback; keep pending if it was unable to restore health.
        if host::manager(r.as_ref(), &state)
            .status()
            .ok()
            .is_some_and(|statuses| {
                statuses.iter().any(|(name, status)| {
                    name == "plur1bus-harness"
                        && status.as_ref().is_some_and(|v| {
                            v.owned
                                && v.running
                                && v.healthy
                                && state.services.iter().any(|s| {
                                    s.name == *name
                                        && canonical_image(&s.image) == canonical_image(&v.image)
                                })
                        })
                })
            })
        {
            state.pending = false;
            host::save(layout, &state)?;
        }
        return Err(e);
    }
    state
        .services
        .iter_mut()
        .find(|s| s.name == "plur1bus-harness")
        .ok_or("harness missing")?
        .image = image;
    state.version = head.version;
    state.channel = channel;
    state.pending = false;
    host::save(layout, &state)?;
    Ok((
        "update.apply/1",
        json!({"mode":"container","outcome":"committed","version":state.version}),
    ))
}
/// Shared by a fresh host installation and the image updater; the guard remains the verifier.
fn verify_bytes(
    layout: &Layout,
    raw: &[u8],
    channel: &str,
    source: &str,
    bundle: Option<&super::bundle::Bundle>,
    persist: bool,
) -> Result<bool> {
    let sig = || -> std::result::Result<String, (&'static str, String)> {
        if let Some(b) = bundle {
            return Ok(b.sig.clone());
        }
        let bytes = fetch::fetch_bytes(&format!("{source}.minisig"), 16 << 10, DEADLINE)
            .map_err(|e| (e.reason(), e.to_string()))?;
        String::from_utf8(bytes).map_err(|e| ("release-signature-invalid", e.to_string()))
    };
    let keys = || {
        if let Some(b) = bundle {
            return b.keys.clone();
        }
        let src = source.strip_suffix(".json").unwrap_or(source);
        let list = fetch::fetch_bytes(
            &format!("{src}.keys.json"),
            super::guard::MAX_KEY_LIST_BYTES,
            DEADLINE,
        )
        .ok()?;
        let signature =
            fetch::fetch_bytes(&format!("{src}.keys.json.minisig"), 16 << 10, DEADLINE).ok()?;
        Some((list, String::from_utf8(signature).ok()?))
    };
    let ctx = super::guard::Ctx {
        channel,
        baked: pins::release_pubkey_for(channel),
        persist,
        now: super::guard::now_secs(),
        fetch_sig: &sig,
        fetch_keys: &keys,
    };
    super::guard::verify_release(layout, raw, &ctx).map_err(|(reason, m)| format!("{reason}: {m}"))
}
/// Initial installs resolve the signed channel offer without needing a native install manifest.
pub(crate) fn install_offer(
    layout: &Layout,
    channel: &str,
    source: Option<&str>,
    persist: bool,
) -> Result<(String, String)> {
    let default = format!(
        "{}/{}.json",
        pins::release_base_url().unwrap_or("https://updates.plur1bus.app"),
        channel
    );
    let source = source.unwrap_or(&default);
    let raw = fetch::fetch_bytes(source, 1 << 20, DEADLINE).map_err(|e| e.to_string())?;
    if !verify_bytes(layout, &raw, channel, source, None, persist)? {
        return Err("release-unverified: no trusted release key".into());
    }
    let (image, head) = offer(&raw, channel, 1)?;
    super::guard::check_version(
        &super::guard::load(layout)?,
        channel,
        "0.0.0",
        &head.version,
        false,
    )
    .map_err(|e| e.message)?;
    Ok((image, head.version))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn signed_offer_contract_rejects_tags_channels_and_schema_migration() {
        let image = format!("ghcr.io/cyb3rb1ade/harness@sha256:{}", "a".repeat(64));
        let mut v = json!({"version":"0.2.0","channel":"stable","minFromVersion":"0.1.0","containers":{"image":image,"storeSchema":1}});
        assert!(offer(&serde_json::to_vec(&v).unwrap(), "stable", 1).is_ok());
        assert!(offer(&serde_json::to_vec(&v).unwrap(), "beta", 1).is_err());
        assert!(offer(&serde_json::to_vec(&v).unwrap(), "stable", 2).is_err());
        v["containers"]["image"] = json!("ghcr.io/harness:latest");
        assert!(offer(&serde_json::to_vec(&v).unwrap(), "stable", 1).is_err());
    }
}
