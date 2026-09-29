//! `plur1bus ext inspect|pack|verify` and the shared verbs of `plur1bus skill` and `plugin` ([`ext_verbs`]) (spec
//! §8.3, §10.1; X1-R10, X1-R13, X1-R24; acceptance 1 and 3).
//!
//! - **Routing** as `config` and `module` (B6): with a supervisor that answers, every verb is its `ext.*` method; without
//!   one, the CLI takes the supervisor's single-instance lock (`module::try_offline_lock`, so no supervisor can start
//!   half-way; held elsewhere it is `E_NOT_AVAILABLE supervisor-running`, exit 2 like every ext failure), runs `ext::recover`, and calls the same `ext::` functions in-process with the offline `ModuleHost`
//!   (inspection and staging in-process too, X1-R2). Both paths answer the same documents, errors and exit codes: an
//!   offline refusal's data is narrowed exactly as the supervisor narrows it into `error.data.ext` (X1-C19).
//! - **Disclosure.** An install inspects first and prints the disclosure (trust tier and why, signer key, id, version,
//!   publisher, licence, summary, capabilities in plain language, scripts, runtime, secrets, `replaces`). On a terminal
//!   one `[y/N]` names the tier (and the capabilities, with `--enable`) and acknowledges what the inspection shows.
//!   Outside a terminal a due tier or downgrade needs its `--allow-*` flag *and* `--yes` (spec §8.3; X1-C24 waives
//!   `--yes` only when nothing is due), and `--yes` itself acknowledges the capabilities. Without them the CLI refuses with `E_APPROVAL_REQUIRED acknowledge-<x>` and the inspection in `data` (exit 2), and never
//!   acknowledges on its own. An acknowledgment the engine still asks for (an enabled item whose capabilities change)
//!   is disclosed and asked for the same way.
//! - **Enable** dry-runs first; `acknowledge-capabilities` shows the capabilities, asks (or needs `--yes`), dry-runs
//!   again with the acknowledgment, prints a module's plan (`will restart`, `will be held back`) and applies.
//! - Layout: [`disclosure`] renders, [`backend`] routes, [`ext_verbs`] holds the `skill`/`plugin` verbs; failures,
//!   `pack`, `verify` and dispatch live here.
//! - `ext pack` and `ext verify` need no home; `verify` trusts only the pinned keys (and the test seam), checks no
//!   revocations and no installed names.
mod backend;
mod disclosure;
pub(crate) mod ext_verbs;

use crate::cli::ExtCmd;
use crate::ext::{self, ExtError};
use crate::output::Out;
use crate::paths::Layout;
use backend::{Backend, Input};
use disclosure::describe_inspection;
use plur1bus_rpc::RpcError;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

// ---- failures --------------------------------------------------------------------------------------------------------

/// A failed verb, from either path: the closed error name, its reason, detail and ids, the refusal's data (what
/// `error.data.ext` carries online), and a hint for the human text (the flag that would acknowledge it).
#[derive(Debug, Clone)]
pub(crate) struct Failure {
    pub code: String,
    pub message: String,
    pub reason: Option<String>,
    pub detail: Option<String>,
    pub ids: Option<Box<Value>>,
    pub data: Option<Box<Value>>,
}

impl Failure {
    pub(crate) fn new(code: &str, reason: &str, message: impl Into<String>) -> Self {
        Failure {
            code: code.into(),
            message: message.into(),
            reason: Some(reason.into()),
            detail: None,
            ids: None,
            data: None,
        }
    }

    /// An offline refusal, with its data narrowed as the supervisor narrows it into `error.data.ext`.
    pub(crate) fn from_ext(e: ExtError) -> Self {
        Failure {
            code: e.code.into(),
            message: e.message,
            reason: e.reason.map(str::to_string),
            detail: None,
            ids: None,
            data: crate::supervisor::ext::error_data(&e.data).map(Box::new),
        }
    }

    /// An online refusal: `error.data.{error,reason,detail,ids,ext}` and the message the supervisor sent.
    pub(crate) fn from_rpc(e: RpcError) -> Self {
        let code = e.code_name();
        let ids = e.ids().map(|i| Box::new(json!(i)));
        let data = e.ext().map(|x| Box::new(x.clone()));
        match e {
            RpcError::Call {
                message,
                reason,
                detail,
                ..
            } => Failure {
                code,
                message,
                reason,
                detail,
                ids,
                data,
            },
            other => Failure {
                code,
                message: other.to_string(),
                reason: None,
                detail: None,
                ids,
                data,
            },
        }
    }

    fn reason(&self) -> &str {
        self.reason.as_deref().unwrap_or("")
    }

    /// The acknowledgment an `E_APPROVAL_REQUIRED acknowledge-<x>` asks for.
    fn wants(&self) -> Option<&str> {
        (self.code == "E_APPROVAL_REQUIRED")
            .then(|| self.reason().strip_prefix("acknowledge-"))
            .flatten()
    }

    /// `E_LOCKED` → 3, `E_NOT_AVAILABLE` and `E_APPROVAL_REQUIRED` → 2, everything else → 1 (G18, X1-R14).
    fn exit(&self) -> i32 {
        match self.code.as_str() {
            "E_LOCKED" => 3,
            "E_NOT_AVAILABLE" | "E_APPROVAL_REQUIRED" => 2,
            _ => 1,
        }
    }
}

pub(super) fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|x| x.as_str().map(str::to_string))
        .collect()
}

/// The human lines a refusal's data adds: who blocks an uninstall, who was disabled first, which files changed.
pub(super) fn data_lines(data: Option<&Value>) -> Vec<String> {
    let Some(d) = data else {
        return vec![];
    };
    let mut out = Vec::new();
    let deps = strings(&d["dependents"]);
    if !deps.is_empty() {
        out.push(format!(
            "required by: {} (re-run with --cascade to disable them first)",
            deps.join(", ")
        ));
    }
    let off = strings(&d["disabledDependents"]);
    if !off.is_empty() {
        out.push(format!("disabled first: {}", off.join(", ")));
    }
    let paths = strings(&d["paths"]);
    if !paths.is_empty() {
        out.push(format!("files that no longer match: {}", paths.join(", ")));
    }
    out
}

/// Prints `f` (`error/1` with `reason`, `detail`, `ids` and `data`; on stderr the message, the error name and reason,
/// what the data says, and `hint`) and exits with its code.
pub(crate) fn fail(out: &Out, f: &Failure, hint: Option<&str>) -> ! {
    let mut extra = json!({});
    if let Some(r) = &f.reason {
        extra["reason"] = json!(r);
    }
    if let Some(d) = &f.detail {
        extra["detail"] = json!(d);
    }
    if let Some(i) = &f.ids {
        extra["ids"] = (**i).clone();
    }
    if let Some(d) = &f.data {
        extra["data"] = (**d).clone();
    }
    let message = if out.json {
        f.message.clone()
    } else {
        let mut m = f.message.clone();
        if let Some(d) = &f.detail {
            m.push_str(&format!(": {d}"));
        }
        m.push_str(&format!(" ({}", f.code));
        if let Some(r) = &f.reason {
            m.push_str(&format!(" {r}"));
        }
        m.push(')');
        for l in data_lines(f.data.as_deref()) {
            m.push_str(&format!("\n{l}"));
        }
        if let Some(h) = hint {
            m.push_str(&format!("\n{h}"));
        }
        m
    };
    out.fail(&f.code, &message, extra, f.exit())
}

/// The flag that gives acknowledgment `x`.
pub(super) fn flag_for(x: &str) -> &'static str {
    match x {
        "unsigned" => "--allow-unsigned",
        "unknown-signer" => "--allow-unknown-signer",
        "downgrade" => "--allow-downgrade",
        _ => "--yes",
    }
}

pub(super) fn ack_hint(x: &str) -> String {
    match x {
        "capabilities" => "re-run with --yes to acknowledge the capabilities".to_string(),
        _ => format!(
            "re-run with {} --yes to acknowledge it (nothing was changed)",
            flag_for(x)
        ),
    }
}

// ---- ext inspect | pack | verify -------------------------------------------------------------------------------------

fn hex_sha256_file(p: &Path) -> std::io::Result<(String, u64)> {
    use sha2::{Digest, Sha256};
    let mut f = std::fs::File::open(p)?;
    let mut h = Sha256::new();
    let n = std::io::copy(&mut f, &mut h)?;
    Ok((h.finalize().iter().map(|b| format!("{b:02x}")).collect(), n))
}

/// `ext pack <dir> [-o <file>]`: `p1x.template.json` + `payload/` packed, or a skill folder normalised; written to a
/// temp file beside the output, synced and renamed (never half a package under the final name).
fn pack(out: &Out, dir: &Path, output: Option<PathBuf>) {
    use plur1bus_ext::normalise::{normalise_skill, SkillInput};
    fn io_fail(out: &Out, what: &str, p: &Path, e: &dyn std::fmt::Display) -> ! {
        fail(
            out,
            &Failure::new("E_INTERNAL", "io", format!("{what} {}: {e}", p.display())),
            None,
        )
    }
    let io = |what: &str, p: &Path, e: &dyn std::fmt::Display| -> ! { io_fail(out, what, p, e) };
    let template_path = dir.join("p1x.template.json");
    let template: Option<Value> = if template_path.is_file() {
        let text = std::fs::read_to_string(&template_path)
            .unwrap_or_else(|e| io("cannot read", &template_path, &e));
        Some(serde_json::from_str(&text).unwrap_or_else(|e| {
            fail(
                out,
                &Failure::new(
                    "E_INVALID_PARAMS",
                    "package-invalid",
                    format!("{}: not JSON: {e}", template_path.display()),
                ),
                None,
            )
        }))
    } else if dir.join("SKILL.md").is_file() {
        None
    } else {
        fail(
            out,
            &Failure::new(
                "E_INVALID_PARAMS",
                "package-invalid",
                format!(
                    "{} holds neither p1x.template.json (with payload/) nor a SKILL.md",
                    dir.display()
                ),
            ),
            None,
        )
    };
    let out_dir = output
        .as_deref()
        .and_then(Path::parent)
        .filter(|p| !p.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let tmp = out_dir.join(format!(".p1x-pack.tmp-{}", std::process::id()));
    let mut f = std::fs::File::create(&tmp).unwrap_or_else(|e| io("cannot create", &tmp, &e));
    let created = ext::now_iso();
    let result = match &template {
        Some(t) => plur1bus_ext::pack::pack_dir(t, &dir.join("payload"), &created, &mut f),
        None => normalise_skill(&SkillInput::Dir(dir.to_path_buf()), &created, &mut f),
    };
    let manifest = match result.and_then(|m| {
        f.sync_all()
            .map_err(|e| plur1bus_ext::refusal::Refusal::io(&e))?;
        Ok(m)
    }) {
        Ok(m) => m,
        Err(r) => {
            drop(f);
            let _ = std::fs::remove_file(&tmp);
            fail(out, &Failure::from_ext(ExtError::from(r)), None)
        }
    };
    drop(f);
    let dest = output
        .unwrap_or_else(|| PathBuf::from(format!("{}-{}.p1x", manifest.name, manifest.version)));
    if let Err(e) = std::fs::rename(&tmp, &dest) {
        let _ = std::fs::remove_file(&tmp);
        io("cannot write", &dest, &e);
    }
    let (sha256, size) = hex_sha256_file(&dest).unwrap_or_else(|e| io("cannot read", &dest, &e));
    let v = json!({
        "path": dest.to_string_lossy(),
        "id": manifest.id,
        "name": manifest.name,
        "version": manifest.version,
        "kind": crate::ext::record::kind_name(manifest.kind),
        "sha256": sha256,
        "size": size,
        "scripts": manifest.scripts,
        "signed": false,
    });
    out.ok("ext.pack/1", &v, || {
        format!(
            "packed {} {} into {} ({} bytes, sha256 {sha256}); unsigned",
            v["id"].as_str().unwrap_or("?"),
            v["version"].as_str().unwrap_or("?"),
            dest.display(),
            size
        )
    });
}

/// `ext verify <file.p1x>`: the inspection pipeline with no home: the pinned keys (plus the test seam), no revocations,
/// no reserved or installed names, the default limits.
fn verify(out: &Out, file: &Path) {
    use plur1bus_ext::verify::{inspect_file, Policy};
    let store = ext::host::trust_store();
    let host = ext::host::host_facts();
    let none = |_: &str, _: &str| None;
    let policy = Policy {
        limits: plur1bus_ext::zipaudit::Limits::default(),
        skill_bytes: plur1bus_ext::normalise::MAX_SKILL_BYTES,
        store: &store,
        host: &host,
        reserved: &[],
        revoked: &none,
    };
    let insp = inspect_file(file, &policy)
        .unwrap_or_else(|r| fail(out, &Failure::from_ext(ExtError::from(r)), None));
    let mut trust = json!({ "tier": insp.trust.tier });
    if let Some(k) = &insp.trust.key_id {
        trust["keyId"] = json!(k);
    }
    if let Some(l) = &insp.trust.key_label {
        trust["label"] = json!(l);
    }
    let manifest: Value = serde_json::from_slice(&insp.manifest_raw).unwrap_or(Value::Null);
    let v = json!({
        "sha256": insp.sha256,
        "size": insp.size,
        "manifest": manifest,
        "trust": trust,
        "checks": insp.checks,
        "capabilities": insp.manifest.capabilities,
        "scripts": insp.scripts,
        "requires": insp.manifest.requires,
    });
    out.ok("ext.verify/1", &v, || {
        format!(
            "{}\nverified: {} ({} bytes, sha256 {})",
            describe_inspection(&v),
            file.display(),
            insp.size,
            insp.sha256
        )
    });
}

pub fn run(out: &Out, layout: &Layout, cmd: ExtCmd) {
    match cmd {
        ExtCmd::Inspect { path } => {
            let v = Backend::open(out, layout, true)
                .inspect(&Input::parse(&path))
                .unwrap_or_else(|f| fail(out, &f, None));
            out.ok("ext.inspect/1", &v, || describe_inspection(&v));
        }
        ExtCmd::Pack { dir, output } => pack(out, &dir, output),
        ExtCmd::Verify { file } => verify(out, &file),
        // Dispatched by main before this module is reached.
        ExtCmd::Worker { op } => crate::ext::stage::worker_main(layout, op),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refusal_data_adds_its_lines() {
        let lines = data_lines(Some(&json!({
            "dependents": ["fixture-b"], "disabledDependents": ["c"], "paths": ["index.js"]
        })));
        assert_eq!(lines.len(), 3);
        assert!(lines[0].contains("fixture-b") && lines[0].contains("--cascade"));
        assert!(data_lines(None).is_empty());
    }

    #[test]
    fn an_offline_refusal_is_narrowed_like_the_supervisors() {
        let e = ExtError::new("E_APPROVAL_REQUIRED", "acknowledge-capabilities", "m")
            .with_data(json!({ "capabilities": {}, "authority": "full" }));
        let f = Failure::from_ext(e);
        assert_eq!(f.wants(), Some("capabilities"));
        assert_eq!(f.exit(), 2);
        assert_eq!(f.data.unwrap()["authority"], "full");
        let f = Failure::from_ext(ExtError::new("E_LOCKED", "skills-locked", "m"));
        assert_eq!((f.exit(), f.data.is_none(), f.wants()), (3, true, None));
    }
}
