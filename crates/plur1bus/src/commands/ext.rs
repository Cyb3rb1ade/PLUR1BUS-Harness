//! `plur1bus ext inspect|pack|verify` and the shared verbs of `plur1bus skill` and `plugin` ([`ext_verbs`]) (spec
//! §8.3, §10.1; X1-R10, X1-R13, X1-R24; acceptance 1 and 3).
//!
//! - **Routing** as `config` and `module` (B6): with a supervisor that answers, every verb is its `ext.*` method; without
//!   one, the CLI takes the supervisor's single-instance lock (`module::offline_lock`, so no supervisor can start
//!   half-way), runs `ext::recover`, and calls the same `ext::` functions in-process with the offline `ModuleHost`
//!   (inspection and staging in-process too, X1-R2). Both paths answer the same documents, errors and exit codes: an
//!   offline refusal's data is narrowed exactly as the supervisor narrows it into `error.data.ext` (X1-C19).
//! - **Disclosure.** An install inspects first and prints the disclosure (trust tier and why, signer key, id, version,
//!   publisher, licence, summary, capabilities in plain language, scripts, runtime, secrets, `replaces`). On a terminal
//!   one `[y/N]` names the tier and acknowledges what the inspection shows; with `--yes` each trust tier or downgrade
//!   needs its `--allow-*` flag, and `--yes` itself acknowledges the capabilities. Without a terminal and without the
//!   flags the CLI refuses with `E_APPROVAL_REQUIRED acknowledge-<x>` and the inspection in `data` (exit 2), and never
//!   acknowledges on its own. An acknowledgment the engine still asks for (an enabled item whose capabilities change)
//!   is disclosed and asked for the same way.
//! - **Enable** dry-runs first; `acknowledge-capabilities` shows the capabilities, asks (or needs `--yes`), dry-runs
//!   again with the acknowledgment, prints a module's plan (`will restart`, `will be held back`) and applies.
//! - `ext pack` and `ext verify` need no home; `verify` trusts only the pinned keys (and the test seam), checks no
//!   revocations and no installed names.
use super::config::{call, route, Route};
use super::module::{confirm, offline_lock};
use crate::cli::ExtCmd;
use crate::ext::commit::{install_commit, Agents, InstallOpts, OfflineHost};
use crate::ext::inspect::Source;
use crate::ext::lifecycle::{self, ToggleOpts};
use crate::ext::list::{list_items, show_item, ListFilter};
use crate::ext::remove::{self, RemoveOpts};
use crate::ext::{self, ExtError};
use crate::output::Out;
use crate::paths::Layout;
use plur1bus_rpc::{Client, RpcError};
use serde_json::{json, Value};
use std::io::{IsTerminal, Read, Write};
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

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|x| x.as_str().map(str::to_string))
        .collect()
}

/// The human lines a refusal's data adds: who blocks an uninstall, who was disabled first, which files changed.
fn data_lines(data: Option<&Value>) -> Vec<String> {
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
fn flag_for(x: &str) -> &'static str {
    match x {
        "unsigned" => "--allow-unsigned",
        "unknown-signer" => "--allow-unknown-signer",
        "downgrade" => "--allow-downgrade",
        _ => "--yes",
    }
}

fn ack_hint(x: &str) -> String {
    match x {
        "capabilities" => "re-run with --yes to acknowledge the capabilities".to_string(),
        _ => format!(
            "re-run with {} --yes to acknowledge it (nothing was changed)",
            flag_for(x)
        ),
    }
}

// ---- disclosure ------------------------------------------------------------------------------------------------------

fn lang(v: &Value) -> Option<String> {
    v.get("en")
        .or_else(|| v.as_object().and_then(|m| m.values().next()))
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// The capability block in plain language, one line per key (spec §8.3).
fn capability_lines(caps: &Value) -> Vec<String> {
    let mut out = Vec::new();
    let net = &caps["network"];
    out.push(match net["mode"].as_str() {
        Some("none") => "network: no network access".to_string(),
        Some("allowlist") => format!(
            "network: may connect to {}",
            strings(&net["hosts"]).join(", ")
        ),
        Some("any") => "network: may connect to any host".to_string(),
        _ => "network: not declared".to_string(),
    });
    match caps["filesystem"].as_array() {
        Some(list) if list.is_empty() => out.push("files: no access outside its own folder".into()),
        Some(list) => {
            for e in list {
                let what = match e["scope"].as_str() {
                    Some("agent-workspace") => "the agent's workspace".to_string(),
                    Some("extension-data") => "its own data folder".to_string(),
                    Some("home") => "your home folder".to_string(),
                    Some("path") => e["path"].as_str().unwrap_or("?").to_string(),
                    Some(o) => o.to_string(),
                    None => "?".to_string(),
                };
                let how = match e["access"].as_str() {
                    Some("read-write") => "may read and write",
                    _ => "may read",
                };
                out.push(format!("files: {how} {what}"));
            }
        }
        None => out.push("files: not declared".into()),
    }
    let procs = &caps["processes"];
    out.push(match procs["spawn"].as_bool() {
        Some(true) => {
            let cmds = strings(&procs["commands"]);
            if cmds.is_empty() {
                "programs: may start any program".to_string()
            } else {
                format!("programs: may start {}", cmds.join(", "))
            }
        }
        Some(false) => "programs: starts no programs".to_string(),
        None => "programs: not declared".to_string(),
    });
    let harness = &caps["harness"];
    out.push(match harness["authority"].as_str() {
        Some("none") => "harness: no access to the harness".to_string(),
        Some("scoped") => format!("harness: may call {}", strings(&harness["rpc"]).join(", ")),
        Some("full") => "harness: full control of the harness".to_string(),
        _ => "harness: not declared".to_string(),
    });
    let secrets: Vec<String> = caps["secrets"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|s| {
            let slot = s["slot"].as_str().unwrap_or("?");
            let label = lang(&s["label"]).unwrap_or_default();
            let req = if s["required"] == true {
                "required"
            } else {
                "optional"
            };
            format!("{slot} ({label}, {req})")
        })
        .collect();
    out.push(if secrets.is_empty() {
        "secrets: none".to_string()
    } else {
        format!("secrets: {}", secrets.join(", "))
    });
    out
}

/// "contains N programs your agents can run" and one line per script: path, size, first line.
fn script_lines(scripts: &Value) -> Vec<String> {
    let list = scripts.as_array().cloned().unwrap_or_default();
    let mut out = vec![format!(
        "contains {} program{} your agents can run",
        list.len(),
        if list.len() == 1 { "" } else { "s" }
    )];
    for s in &list {
        let mut l = format!(
            "  {} ({} bytes)",
            s["path"].as_str().unwrap_or("?"),
            s["size"].as_u64().unwrap_or(0)
        );
        if let Some(first) = s["firstLine"].as_str() {
            l.push_str(&format!(": {first}"));
        }
        out.push(l);
    }
    out
}

fn trust_line(trust: &Value) -> String {
    let tier = trust["tier"].as_str().or(trust.as_str()).unwrap_or("?");
    let key = trust["keyId"].as_str();
    match tier {
        "first-party" => format!(
            "trust: first-party (signed by {}{})",
            trust["label"].as_str().unwrap_or("a pinned key"),
            key.map(|k| format!(", key {k}")).unwrap_or_default()
        ),
        "unknown-signer" => format!(
            "trust: unknown signer (signed with key {}, which this harness does not trust; anyone can make a key)",
            key.unwrap_or("?")
        ),
        "unsigned" => {
            "trust: unsigned (nobody vouches for this package; anyone could have made or changed it)".to_string()
        }
        "release" => "trust: release (shipped with the harness)".to_string(),
        "dev" => "trust: dev (a local folder)".to_string(),
        other => format!("trust: {other}"),
    }
}

fn runtime_line(requires: &Value) -> String {
    let rt = &requires["runtime"];
    match rt["type"].as_str() {
        Some("none") | None => "runtime: none".to_string(),
        Some(t) => match rt["range"].as_str() {
            Some(r) => format!("runtime: {t} {r}"),
            None => format!("runtime: {t}"),
        },
    }
}

/// The disclosure of an inspection (`ExtInspection`, or `ext verify`'s document): what the person confirms.
pub(crate) fn describe_inspection(v: &Value) -> String {
    let m = &v["manifest"];
    let tier = v["trust"]["tier"].as_str().unwrap_or("?");
    let mut lines = vec![format!(
        "{} {} ({}){}",
        m["id"].as_str().unwrap_or("?"),
        m["version"].as_str().unwrap_or("?"),
        m["kind"].as_str().unwrap_or("?"),
        lang(&m["title"])
            .map(|t| format!(": {t}"))
            .unwrap_or_default()
    )];
    lines.push(trust_line(&v["trust"]));
    if let Some(k) = v["trust"]["keyId"].as_str() {
        lines.push(format!("signer key: {k}"));
    }
    let verified = matches!(tier, "first-party" | "release");
    lines.push(format!(
        "publisher: {} ({}){}",
        m["publisher"]["name"].as_str().unwrap_or("?"),
        m["publisher"]["id"].as_str().unwrap_or("?"),
        if verified { "" } else { ", unverified" }
    ));
    lines.push(format!("licence: {}", m["licence"].as_str().unwrap_or("?")));
    if let Some(s) = lang(&m["summary"]) {
        lines.push(format!("summary: {s}"));
    }
    if matches!(m["kind"].as_str(), Some("module" | "channel")) {
        lines.push("authority: runs as a harness process with full authority".into());
    }
    let caps = if v["capabilities"].is_object() {
        &v["capabilities"]
    } else {
        &m["capabilities"]
    };
    lines.extend(capability_lines(caps));
    lines.extend(script_lines(&v["scripts"]));
    let requires = if v["requires"].is_object() {
        &v["requires"]
    } else {
        &m["requires"]
    };
    lines.push(runtime_line(requires));
    if let Some(r) = v.get("replaces").filter(|r| r.is_object()) {
        let changed = strings(&r["capabilityDiff"]["changed"]);
        lines.push(format!(
            "replaces: the installed {}{}",
            r["version"].as_str().unwrap_or("?"),
            if changed.is_empty() {
                " (same capabilities)".to_string()
            } else {
                format!(" (capabilities changed: {})", changed.join(", "))
            }
        ));
    }
    if let Some(prev) = v.get("previousCapabilities").filter(|p| p.is_object()) {
        lines.push("capabilities acknowledged before:".into());
        lines.extend(capability_lines(prev).into_iter().map(|l| format!("  {l}")));
    }
    for c in v["checks"].as_array().into_iter().flatten() {
        if c["status"] != "pass" {
            lines.push(format!(
                "check {} {}: {}",
                c["id"].as_str().unwrap_or("?"),
                c["status"].as_str().unwrap_or("?"),
                c["detail"].as_str().unwrap_or("")
            ));
        }
    }
    lines.join("\n")
}

/// The capability disclosure of an enable (`acknowledge-capabilities` data): what enabling lets the item do.
fn describe_capabilities(d: &Value) -> String {
    let mut lines = vec![format!(
        "{} {} ({}), {}",
        d["id"].as_str().or(d["name"].as_str()).unwrap_or("?"),
        d["version"].as_str().unwrap_or("?"),
        d["kind"].as_str().unwrap_or("?"),
        trust_line(&d["trust"]).replacen("trust: ", "trust ", 1)
    )];
    if d["authority"] == "full" {
        lines.push("authority: runs as a harness process with full authority".into());
    }
    lines.extend(capability_lines(&d["capabilities"]));
    lines.extend(script_lines(&d["scripts"]));
    lines.join("\n")
}

// ---- the two paths ---------------------------------------------------------------------------------------------------

/// What an install or inspection reads.
#[derive(Clone, Debug)]
pub(crate) enum Input {
    Path(PathBuf),
    Stdin,
}

impl Input {
    pub(crate) fn parse(arg: &str) -> Input {
        if arg == "-" {
            Input::Stdin
        } else {
            let p = PathBuf::from(arg);
            // The supervisor runs elsewhere: an absolute path (not canonicalised, so a symlink is still one).
            Input::Path(std::path::absolute(&p).unwrap_or(p))
        }
    }
}

/// Where the verbs go: the supervisor, or the `ext::` code in-process under the supervisor's lock.
pub(crate) enum Backend<'a> {
    Online {
        client: Box<Client>,
        layout: &'a Layout,
    },
    Offline {
        layout: &'a Layout,
        _lock: Option<std::fs::File>,
    },
}

/// The name rule of `ext.*` params (the importer's SKILL_ID pattern): checked here so both paths refuse alike.
fn valid_name(name: &str) -> bool {
    let b = name.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"._-".contains(c))
}

fn check_name(name: &str) -> Result<(), Failure> {
    if valid_name(name) {
        return Ok(());
    }
    Err(Failure {
        code: "E_INVALID_PARAMS".into(),
        message: format!("{name:?} is not an extension name"),
        reason: None,
        detail: None,
        ids: None,
        data: None,
    })
}

fn offline_config(layout: &Layout) -> Value {
    plur1bus_config::read(&layout.config_path()).unwrap_or(Value::Null)
}

fn agents_json(a: &Agents) -> Value {
    match a {
        Agents::All => json!("all"),
        Agents::Some(l) => json!(l),
    }
}

impl<'a> Backend<'a> {
    /// The supervisor when one answers; else the offline path, which for `lock` takes the supervisor's lock and runs
    /// `ext::recover` first (a mutation or an inspection writes; a listing only reads).
    pub(crate) fn open(out: &Out, layout: &'a Layout, lock: bool) -> Backend<'a> {
        match route(layout) {
            Ok(Route::Supervisor(c)) => {
                if !c.supports("ext.install") {
                    fail(
                        out,
                        &Failure::new(
                            "E_NOT_AVAILABLE",
                            "supervisor-lacks-method",
                            "the running supervisor predates extensions; restart it with `plur1bus daemon restart`",
                        ),
                        None,
                    );
                }
                Backend::Online {
                    client: Box::new(c),
                    layout,
                }
            }
            Ok(Route::Direct) => {
                let lock = lock.then(|| {
                    let l = offline_lock(out, layout);
                    let _ = ext::recover(layout);
                    l
                });
                Backend::Offline {
                    layout,
                    _lock: lock,
                }
            }
            Err(e) => fail(out, &Failure::from_rpc(e), None),
        }
    }

    fn rpc(c: &mut Client, method: &str, params: Value) -> Result<Value, Failure> {
        call(c, method, params).map_err(Failure::from_rpc)
    }

    pub(crate) fn list(&mut self, filter: &ListFilter) -> Result<Value, Failure> {
        match self {
            Backend::Online { client: c, .. } => {
                let mut params = json!({});
                if let Some(k) = &filter.kind {
                    params["kind"] = json!(k);
                }
                if let Some(s) = &filter.state {
                    params["state"] = json!(s);
                }
                if let Some(a) = &filter.agent {
                    params["agent"] = json!(a);
                }
                Self::rpc(c, "ext.list", params)
            }
            Backend::Offline { layout, .. } => {
                Ok(list_items(layout, &offline_config(layout), filter))
            }
        }
    }

    pub(crate) fn show(&mut self, name: &str) -> Result<Value, Failure> {
        check_name(name)?;
        match self {
            Backend::Online { client: c, .. } => Self::rpc(c, "ext.show", json!({ "name": name })),
            Backend::Offline { layout, .. } => {
                show_item(layout, &offline_config(layout), name).map_err(Failure::from_ext)
            }
        }
    }

    /// `ext.inspect`: the `ExtInspection`. Online, stdin is spooled to `run/inspect/stdin-<pid>.p1x` (the supervisor
    /// copies it into its own spool) and removed after the call.
    pub(crate) fn inspect(&mut self, input: &Input) -> Result<Value, Failure> {
        match self {
            Backend::Online { client, layout } => {
                let (path, spool) = match input {
                    Input::Path(p) => (p.clone(), None),
                    Input::Stdin => {
                        let s = spool_stdin(layout)?;
                        (s.0.clone(), Some(s))
                    }
                };
                let r = Self::rpc(
                    client,
                    "ext.inspect",
                    json!({ "source": { "path": path.to_string_lossy() } }),
                );
                drop(spool);
                r
            }
            Backend::Offline { layout, .. } => {
                let src = match input {
                    Input::Path(p) => Source::Path(p.clone()),
                    Input::Stdin => Source::Stdin,
                };
                let id = ext::worker::new_inspection_id();
                ext::inspect::inspect(layout, src, &id)
                    .map(|r| crate::supervisor::ext::inspection_result(&r))
                    .map_err(Failure::from_ext)
            }
        }
    }

    pub(crate) fn install(
        &mut self,
        id: &str,
        acknowledge: &[String],
        enable: Option<&Agents>,
    ) -> Result<Value, Failure> {
        match self {
            Backend::Online { client: c, .. } => {
                let mut params = json!({ "inspectionId": id });
                if !acknowledge.is_empty() {
                    params["acknowledge"] = json!(acknowledge);
                }
                if let Some(a) = enable {
                    params["enable"] = json!({ "agents": agents_json(a) });
                }
                Self::rpc(c, "ext.install", params)
            }
            Backend::Offline { layout, .. } => {
                let opts = InstallOpts {
                    acknowledge: acknowledge.to_vec(),
                    enable: enable.cloned(),
                };
                ext::record::load(layout, id)
                    .and_then(|rec| {
                        let staged = ext::stage::stage(layout, id)?;
                        install_commit(layout, &mut OfflineHost::new(layout), &rec, staged, &opts)
                    })
                    .map_err(Failure::from_ext)
            }
        }
    }

    pub(crate) fn toggle(
        &mut self,
        name: &str,
        on: bool,
        agents: Option<&Agents>,
        acknowledge: &[String],
        dry_run: bool,
    ) -> Result<Value, Failure> {
        check_name(name)?;
        match self {
            Backend::Online { client: c, .. } => {
                let mut params = json!({ "name": name });
                if let Some(a) = agents {
                    params["agents"] = agents_json(a);
                }
                if on && !acknowledge.is_empty() {
                    params["acknowledge"] = json!(acknowledge);
                }
                if dry_run {
                    params["dryRun"] = json!(true);
                }
                Self::rpc(c, if on { "ext.enable" } else { "ext.disable" }, params)
            }
            Backend::Offline { layout, .. } => {
                let o = ToggleOpts {
                    agents: agents.cloned(),
                    acknowledge: acknowledge.to_vec(),
                    dry_run,
                };
                let mut host = OfflineHost::new(layout);
                if on {
                    lifecycle::enable(layout, &mut host, name, &o)
                } else {
                    lifecycle::disable(layout, &mut host, name, &o)
                }
                .map_err(Failure::from_ext)
            }
        }
    }

    pub(crate) fn uninstall(
        &mut self,
        name: &str,
        purge: bool,
        cascade: bool,
    ) -> Result<Value, Failure> {
        check_name(name)?;
        match self {
            Backend::Online { client: c, .. } => Self::rpc(
                c,
                "ext.uninstall",
                json!({ "name": name, "purge": purge, "cascade": cascade }),
            ),
            Backend::Offline { layout, .. } => remove::uninstall(
                layout,
                &mut OfflineHost::new(layout),
                name,
                &RemoveOpts { purge, cascade },
            )
            .map_err(Failure::from_ext),
        }
    }

    pub(crate) fn restore(&mut self, trash_id: &str) -> Result<Value, Failure> {
        match self {
            Backend::Online { client: c, .. } => {
                Self::rpc(c, "ext.restore", json!({ "trashId": trash_id }))
            }
            Backend::Offline { layout, .. } => {
                remove::restore(layout, &mut OfflineHost::new(layout), trash_id)
                    .map_err(Failure::from_ext)
            }
        }
    }
}

/// A spooled copy of stdin for the supervisor, removed on drop.
struct Spool(PathBuf);

impl Drop for Spool {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Copies stdin into `run/inspect/stdin-<pid>.p1x` (0600), at most `extensions.limits.packageBytes` bytes (one more is
/// `download-too-large`, as the offline spool answers).
fn spool_stdin(layout: &Layout) -> Result<Spool, Failure> {
    let dir = crate::ext::paths::ExtPaths::of(layout).inspect;
    let io = |what: &str, e: std::io::Error| {
        Failure::new("E_INTERNAL", "io", format!("{what} {}: {e}", dir.display()))
    };
    std::fs::create_dir_all(&dir).map_err(|e| io("cannot create", e))?;
    let cap = offline_config(layout)["extensions"]["limits"]["packageBytes"]
        .as_u64()
        .unwrap_or(268_435_456);
    let spool = Spool(dir.join(format!("stdin-{}.p1x", std::process::id())));
    let mut f = crate::audit::create_private(&spool.0, true).map_err(|e| io("cannot create", e))?;
    let n = std::io::copy(&mut std::io::stdin().lock().take(cap + 1), &mut f)
        .map_err(|e| io("cannot write", e))?;
    if n > cap {
        return Err(Failure::new(
            "E_INVALID_PARAMS",
            "download-too-large",
            format!("the package is at least {n} bytes; the limit is {cap}"),
        ));
    }
    f.sync_all().map_err(|e| io("cannot write", e))?;
    Ok(spool)
}

// ---- the shared verbs of `skill` and `plugin` ------------------------------------------------------------------------

/// `skill …` and `plugin …`: the same verbs over `ext.*`, told apart by [`Verb`].
pub(crate) mod ext_verbs {
    use super::*;
    use crate::cli::{ExtState, InstallFlags};

    /// Which command runs: the `--json` id prefix, the kinds it lists and installs, and the other command's name.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(crate) enum Verb {
        Skill,
        Plugin,
    }

    impl Verb {
        fn name(self) -> &'static str {
            match self {
                Verb::Skill => "skill",
                Verb::Plugin => "plugin",
            }
        }
        fn other(self) -> &'static str {
            match self {
                Verb::Skill => "plugin",
                Verb::Plugin => "skill",
            }
        }
        fn kinds(self) -> Vec<String> {
            match self {
                Verb::Skill => vec!["skill".into()],
                Verb::Plugin => vec!["module".into(), "channel".into()],
            }
        }
        fn owns(self, kind: &str) -> bool {
            self.kinds().iter().any(|k| k == kind)
        }
        fn schema(self, op: &str) -> String {
            format!("{}.{op}/1", self.name())
        }
    }

    fn interactive(out: &Out) -> bool {
        std::io::stdin().is_terminal() && !out.json
    }

    /// One `[y/N]` on the terminal.
    fn ask(question: &str) -> bool {
        eprint!("{question} [y/N] ");
        std::io::stderr().flush().ok();
        let mut line = String::new();
        std::io::stdin().read_line(&mut line).ok();
        line.trim().eq_ignore_ascii_case("y")
    }

    fn declined(out: &Out) -> ! {
        out.fail(
            "E_INVALID_PARAMS",
            "not applied",
            json!({ "applied": false }),
            2,
        )
    }

    fn state_filter(s: Option<ExtState>) -> Option<Vec<String>> {
        s.map(|s| {
            vec![match s {
                ExtState::Installed => "installed".to_string(),
                ExtState::Enabled => "enabled".to_string(),
            }]
        })
    }

    fn agents_text(a: &Value) -> String {
        match a {
            Value::String(s) => s.clone(),
            Value::Array(l) if l.is_empty() => "none".into(),
            other => strings(other).join(","),
        }
    }

    fn describe_list(v: &Value, verb: Verb) -> String {
        let items = v["items"].as_array().cloned().unwrap_or_default();
        if items.is_empty() {
            return format!(
                "no {} installed",
                if verb == Verb::Skill {
                    "skills"
                } else {
                    "modules or channels"
                }
            );
        }
        let mut s = String::new();
        for i in &items {
            s.push_str(&format!(
                "{} {}  {}  {}  source {}  trust {}",
                i["name"].as_str().unwrap_or("?"),
                i["version"].as_str().unwrap_or("?"),
                i["kind"].as_str().unwrap_or("?"),
                i["state"].as_str().unwrap_or("?"),
                i["source"].as_str().unwrap_or("?"),
                i["trust"].as_str().unwrap_or("?"),
            ));
            if verb == Verb::Skill {
                s.push_str(&format!("  agents {}", agents_text(&i["agents"])));
            }
            let overlays = strings(&i["overlays"]);
            if !overlays.is_empty() {
                s.push_str(&format!("  [{}]", overlays.join(", ")));
            }
            if i["integrity"] == "tampered" {
                s.push_str("  files changed");
            }
            s.push('\n');
        }
        s.trim_end().to_string()
    }

    /// `list`: `ext.list` of this command's kinds (`plugin --kind` narrows them); `--source` filters here, since
    /// `ext.list` has no source filter.
    pub(crate) fn list(
        out: &Out,
        layout: &Layout,
        verb: Verb,
        kind: Option<&str>,
        state: Option<ExtState>,
        agent: Option<String>,
        source: Option<String>,
    ) {
        let filter = ListFilter {
            kind: Some(kind.map_or_else(|| verb.kinds(), |k| vec![k.to_string()])),
            state: state_filter(state),
            agent,
        };
        let mut v = Backend::open(out, layout, false)
            .list(&filter)
            .unwrap_or_else(|f| fail(out, &f, None));
        if let Some(src) = source {
            let kept: Vec<Value> = v["items"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|i| i["source"] == src.as_str())
                .cloned()
                .collect();
            v["items"] = json!(kept);
        }
        out.ok(&verb.schema("list"), &v, || describe_list(&v, verb));
    }

    fn describe_show(v: &Value) -> String {
        let i = &v["item"];
        let mut lines = vec![format!(
            "{} {} ({}), {}",
            i["name"].as_str().unwrap_or("?"),
            i["version"].as_str().unwrap_or("?"),
            i["kind"].as_str().unwrap_or("?"),
            i["state"].as_str().unwrap_or("?")
        )];
        if let Some(id) = i["id"].as_str() {
            lines.push(format!("package: {id}"));
        }
        lines.push(format!("source: {}", i["source"].as_str().unwrap_or("?")));
        lines.push(trust_line(&v["trust"]));
        if i["kind"] == "skill" {
            lines.push(format!("agents: {}", agents_text(&i["agents"])));
        }
        let overlays = strings(&i["overlays"]);
        if !overlays.is_empty() {
            lines.push(format!("overlays: {}", overlays.join(", ")));
        }
        if let Some(ig) = i["integrity"].as_str() {
            lines.push(format!("integrity: {ig}"));
        }
        if v["capabilities"].as_object().is_some_and(|c| !c.is_empty()) {
            lines.extend(capability_lines(&v["capabilities"]));
            lines.extend(script_lines(&v["scripts"]));
        }
        lines.push(format!(
            "files: {} ({} bytes)",
            v["files"]["count"], v["files"]["bytes"]
        ));
        let deps = strings(&v["dependents"]);
        if !deps.is_empty() {
            lines.push(format!("needed by: {}", deps.join(", ")));
        }
        for t in v["trash"].as_array().into_iter().flatten() {
            lines.push(format!(
                "in the trash: {} ({}, removed {})",
                t["trashId"].as_str().unwrap_or("?"),
                t["version"].as_str().unwrap_or("?"),
                t["removedAt"].as_str().unwrap_or("?")
            ));
        }
        lines.join("\n")
    }

    fn not_this_kind(verb: Verb, name: &str, kind: &str) -> Failure {
        let mut f = Failure::new(
            "E_NOT_FOUND",
            "extension-unknown",
            format!("{name} is a {kind}, not a {}", verb.name()),
        );
        f.detail = Some(format!("use {} show {name}", verb.other()));
        f
    }

    /// `show`: `ext.show`; an item of the other command's kind is `extension-unknown` with a pointer to it.
    pub(crate) fn show(out: &Out, layout: &Layout, verb: Verb, name: &str) {
        let v = Backend::open(out, layout, false)
            .show(name)
            .unwrap_or_else(|f| fail(out, &f, None));
        let kind = v["item"]["kind"].as_str().unwrap_or("");
        if !verb.owns(kind) {
            fail(out, &not_this_kind(verb, name, kind), None);
        }
        out.ok(&verb.schema("show"), &v, || describe_show(&v));
    }

    /// The acknowledgments an inspection shows it needs: the trust tier's, a downgrade, and `capabilities` for an
    /// install that enables (or, on the terminal's one question, a replacement whose capabilities change).
    fn predicted(insp: &Value, enable: bool) -> Vec<String> {
        let mut need = Vec::new();
        match insp["trust"]["tier"].as_str() {
            Some("unsigned") => need.push("unsigned".to_string()),
            Some("unknown-signer") => need.push("unknown-signer".to_string()),
            _ => {}
        }
        let new = semver::Version::parse(insp["manifest"]["version"].as_str().unwrap_or(""));
        let old = semver::Version::parse(insp["replaces"]["version"].as_str().unwrap_or(""));
        if let (Ok(n), Ok(o)) = (new, old) {
            if n < o {
                need.push("downgrade".into());
            }
        }
        if enable {
            need.push("capabilities".into());
        }
        need
    }

    fn question(insp: &Value) -> &'static str {
        match insp["trust"]["tier"].as_str() {
            Some("unsigned") => "Install unsigned package?",
            Some("unknown-signer") => "Install package from unknown signer?",
            _ => "Install?",
        }
    }

    fn describe_install(v: &Value, verb: Verb) -> String {
        let name = v["name"].as_str().unwrap_or("?");
        let version = v["version"].as_str().unwrap_or("?");
        let state = v["state"].as_str().unwrap_or("installed");
        let head = if v["replaced"] == true {
            format!("replaced {name} with {version}")
        } else {
            format!("installed {name} {version}")
        };
        if state == "enabled" {
            format!("{head} (enabled)")
        } else {
            format!(
                "{head} (disabled); enable it with `plur1bus {} enable {name}`",
                verb.name()
            )
        }
    }

    /// `install` (see the module documentation).
    pub(crate) fn install(
        out: &Out,
        layout: &Layout,
        verb: Verb,
        path: &str,
        enable: Option<Agents>,
        flags: &InstallFlags,
    ) {
        let input = Input::parse(path);
        let mut be = Backend::open(out, layout, true);
        let insp = be.inspect(&input).unwrap_or_else(|f| fail(out, &f, None));
        let kind = insp["manifest"]["kind"].as_str().unwrap_or("");
        if !verb.owns(kind) {
            let mut f = Failure::new(
                "E_INVALID_PARAMS",
                "package-invalid",
                format!(
                    "{} is a {kind} package; `plur1bus {} install` takes {}",
                    insp["manifest"]["id"].as_str().unwrap_or("the package"),
                    verb.name(),
                    if verb == Verb::Skill {
                        "skills"
                    } else {
                        "modules and channels"
                    }
                ),
            );
            f.detail = Some(format!("use {} install", verb.other()));
            fail(out, &f, None);
        }
        if flags.dry_run {
            out.ok("ext.inspect/1", &insp, || {
                format!(
                    "{}\n(dry run: nothing was installed)",
                    describe_inspection(&insp)
                )
            });
            return;
        }
        if !out.json {
            println!("{}", describe_inspection(&insp));
        }
        // stdin carries the package, so it cannot answer a question.
        let tty = interactive(out) && !flags.yes && matches!(input, Input::Path(_));
        let mut given: Vec<String> = Vec::new();
        for (on, a) in [
            (flags.allow_unsigned, "unsigned"),
            (flags.allow_unknown_signer, "unknown-signer"),
            (flags.allow_downgrade, "downgrade"),
            (flags.yes, "capabilities"),
        ] {
            if on {
                given.push(a.to_string());
            }
        }
        let changed = insp["replaces"]["capabilityDiff"]["changed"]
            .as_array()
            .is_some_and(|c| !c.is_empty());
        if tty {
            if !ask(question(&insp)) {
                declined(out);
            }
            for a in predicted(&insp, enable.is_some() || changed) {
                if !given.contains(&a) {
                    given.push(a);
                }
            }
        } else if let Some(missing) = predicted(&insp, enable.is_some())
            .into_iter()
            .find(|a| !given.contains(a))
        {
            let what = match missing.as_str() {
                "unsigned" => "the package is not signed",
                "unknown-signer" => "the package is signed by a key this harness does not trust",
                "downgrade" => "the package is a lower version than the installed one",
                _ => "enabling lets the extension use the capabilities it declares",
            };
            // The data the engine's refusal carries: the inspection, plus the authority for the capabilities.
            let mut data = insp.clone();
            if missing == "capabilities" {
                data["authority"] = if kind == "skill" {
                    insp["capabilities"]["harness"]["authority"].clone()
                } else {
                    json!("full")
                };
            }
            let f = Failure {
                code: "E_APPROVAL_REQUIRED".into(),
                message: format!("{what}; acknowledge {missing:?} to go ahead"),
                reason: Some(format!("acknowledge-{missing}")),
                detail: None,
                ids: None,
                data: Some(Box::new(data)),
            };
            fail(out, &f, Some(&ack_hint(&missing)));
        }
        let id = insp["inspectionId"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let v = loop {
            match be.install(&id, &given, enable.as_ref()) {
                Ok(v) => break v,
                Err(f) => {
                    let Some(x) = f.wants().map(str::to_string) else {
                        fail(out, &f, None)
                    };
                    if given.contains(&x) || !tty {
                        fail(out, &f, Some(&ack_hint(&x)));
                    }
                    if let Some(d) = &f.data {
                        println!("{}", describe_inspection(d));
                    }
                    if !ask(&format!("{}; go ahead?", f.message)) {
                        declined(out);
                    }
                    given.push(x);
                }
            }
        };
        // Review Focus 5: the identical package again is a no-op; an `--enable` that it skipped is said here.
        if enable.is_some() && v["replaced"] == false && v["state"] == "installed" {
            eprintln!(
                "plur1bus: note: {} {} is already installed from this very package, so nothing was installed or \
                 enabled; enable it with `plur1bus {} enable {}`",
                v["name"].as_str().unwrap_or("?"),
                v["version"].as_str().unwrap_or("?"),
                verb.name(),
                v["name"].as_str().unwrap_or("?")
            );
        }
        out.ok(&verb.schema("install"), &v, || describe_install(&v, verb));
    }

    fn plan_lines(plan: &Value) -> String {
        let or_nothing = |l: Vec<String>| {
            if l.is_empty() {
                "nothing".to_string()
            } else {
                l.join(", ")
            }
        };
        format!(
            "will restart: {}\nwill be held back: {}",
            or_nothing(strings(&plan["restart"]["modules"])),
            or_nothing(strings(&plan["heldBack"]))
        )
    }

    fn agents_of(list: Vec<String>) -> Option<Agents> {
        (!list.is_empty()).then_some(Agents::Some(list))
    }

    /// `enable` (see the module documentation).
    pub(crate) fn enable(
        out: &Out,
        layout: &Layout,
        verb: Verb,
        name: &str,
        agents: Vec<String>,
        yes: bool,
    ) {
        let agents = agents_of(agents);
        let mut be = Backend::open(out, layout, true);
        let mut ack: Vec<String> = Vec::new();
        let plan = match be.toggle(name, true, agents.as_ref(), &ack, true) {
            Ok(p) => p,
            Err(f) if f.wants() == Some("capabilities") => {
                if !out.json {
                    if let Some(d) = &f.data {
                        println!("{}", describe_capabilities(d));
                    }
                }
                if !yes {
                    if !interactive(out) {
                        fail(out, &f, Some(&ack_hint("capabilities")));
                    }
                    if !ask(&format!("Enable {name} with these capabilities?")) {
                        declined(out);
                    }
                }
                ack.push("capabilities".into());
                be.toggle(name, true, agents.as_ref(), &ack, true)
                    .unwrap_or_else(|f| fail(out, &f, None))
            }
            Err(f) => fail(out, &f, None),
        };
        if verb == Verb::Plugin && !out.json {
            println!("{}", plan_lines(&plan));
        }
        let v = be
            .toggle(name, true, agents.as_ref(), &ack, false)
            .unwrap_or_else(|f| fail(out, &f, None));
        out.ok(&verb.schema("enable"), &v, || match &agents {
            Some(Agents::Some(l)) => format!("enabled {name} for {}", l.join(", ")),
            _ => format!("enabled {name}"),
        });
    }

    /// `disable`: always allowed; a module's plan is printed first, and holding dependents back is asked.
    pub(crate) fn disable(
        out: &Out,
        layout: &Layout,
        verb: Verb,
        name: &str,
        agents: Vec<String>,
        yes: bool,
    ) {
        let agents = agents_of(agents);
        let mut be = Backend::open(out, layout, true);
        if verb == Verb::Plugin {
            let plan = be
                .toggle(name, false, None, &[], true)
                .unwrap_or_else(|f| fail(out, &f, None));
            if !out.json {
                println!("{}", plan_lines(&plan));
            }
            let held = strings(&plan["heldBack"]);
            if !held.is_empty() {
                confirm(
                    out,
                    &format!("disable {name} and hold back {}?", held.join(", ")),
                    yes,
                );
            }
        }
        let v = be
            .toggle(name, false, agents.as_ref(), &[], false)
            .unwrap_or_else(|f| fail(out, &f, None));
        out.ok(&verb.schema("disable"), &v, || match &agents {
            Some(Agents::Some(l)) => format!("disabled {name} for {}", l.join(", ")),
            _ => format!("disabled {name}"),
        });
    }

    /// `uninstall`: asks, and for `--purge` asks a second, separate question naming what goes.
    pub(crate) fn uninstall(
        out: &Out,
        layout: &Layout,
        verb: Verb,
        name: &str,
        purge: bool,
        cascade: bool,
        yes: bool,
    ) {
        confirm(
            out,
            &format!("uninstall {name} (it moves to the trash, from where `plur1bus {} restore` brings it back)?", verb.name()),
            yes,
        );
        if purge {
            confirm(
                out,
                &format!(
                    "also purge data/ext/{name} and its configuration section (no secrets are stored yet)?"
                ),
                yes,
            );
        }
        let v = Backend::open(out, layout, true)
            .uninstall(name, purge, cascade)
            .unwrap_or_else(|f| fail(out, &f, None));
        out.ok(&verb.schema("uninstall"), &v, || {
            match v["trashId"].as_str() {
                Some(tid) => format!(
                    "uninstalled {name}{}; restore it with `plur1bus {} restore {tid}`",
                    if v["purged"] == true {
                        " with its data and configuration"
                    } else {
                        ""
                    },
                    verb.name()
                ),
                // A bundled skill is hidden, not moved (X1-R18): there is no trash entry.
                None => {
                    format!("hid {name} (bundled with the harness; nothing was moved to the trash)")
                }
            }
        });
    }

    pub(crate) fn restore(out: &Out, layout: &Layout, verb: Verb, trash_id: &str) {
        let v = Backend::open(out, layout, true)
            .restore(trash_id)
            .unwrap_or_else(|f| fail(out, &f, None));
        out.ok(&verb.schema("restore"), &v, || {
            format!(
                "restored {} {} (disabled); enable it with `plur1bus {} enable {}`",
                v["name"].as_str().unwrap_or("?"),
                v["version"].as_str().unwrap_or("?"),
                verb.name(),
                v["name"].as_str().unwrap_or("?")
            )
        });
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn insp(tier: &str, version: &str, replaces: Option<&str>) -> Value {
            let mut v = json!({ "manifest": { "version": version }, "trust": { "tier": tier } });
            if let Some(r) = replaces {
                v["replaces"] = json!({ "version": r, "capabilityDiff": { "changed": [] } });
            }
            v
        }

        #[test]
        fn the_inspection_predicts_the_acknowledgments_in_the_engines_order() {
            assert_eq!(
                predicted(&insp("unsigned", "1.0.0", None), false),
                ["unsigned"]
            );
            assert_eq!(
                predicted(&insp("unknown-signer", "1.0.0", Some("2.0.0")), true),
                ["unknown-signer", "downgrade", "capabilities"]
            );
            assert!(predicted(&insp("first-party", "2.0.0", Some("1.0.0")), false).is_empty());
            // A version that is not semver never reads as a downgrade.
            assert!(predicted(&insp("first-party", "x", Some("1.0.0")), false).is_empty());
        }

        #[test]
        fn the_one_question_names_the_tier() {
            assert_eq!(
                question(&insp("unsigned", "1.0.0", None)),
                "Install unsigned package?"
            );
            assert_eq!(
                question(&insp("unknown-signer", "1.0.0", None)),
                "Install package from unknown signer?"
            );
            assert_eq!(question(&insp("first-party", "1.0.0", None)), "Install?");
        }

        #[test]
        fn each_acknowledgment_names_its_flag() {
            assert_eq!(flag_for("unsigned"), "--allow-unsigned");
            assert_eq!(flag_for("unknown-signer"), "--allow-unknown-signer");
            assert_eq!(flag_for("downgrade"), "--allow-downgrade");
            assert_eq!(flag_for("capabilities"), "--yes");
            assert!(ack_hint("downgrade").contains("--allow-downgrade --yes"));
        }

        #[test]
        fn the_plan_names_restarts_and_held_back_modules() {
            assert_eq!(
                plan_lines(&json!({ "restart": { "modules": ["fixture"] }, "heldBack": [] })),
                "will restart: fixture\nwill be held back: nothing"
            );
        }
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
    fn capabilities_read_in_plain_language() {
        let lines = capability_lines(&json!({
            "network": { "mode": "allowlist", "hosts": ["api.example.org"] },
            "filesystem": [{ "scope": "agent-workspace", "access": "read-write" }],
            "processes": { "spawn": true },
            "harness": { "authority": "scoped", "rpc": ["memory.recall"] },
            "secrets": [{ "slot": "TOKEN", "label": { "en": "API token" }, "required": true }]
        }));
        assert_eq!(
            lines,
            [
                "network: may connect to api.example.org",
                "files: may read and write the agent's workspace",
                "programs: may start any program",
                "harness: may call memory.recall",
                "secrets: TOKEN (API token, required)",
            ]
        );
    }

    #[test]
    fn scripts_are_counted_and_listed_with_size_and_first_line() {
        let lines = script_lines(&json!([
            { "path": "payload/scripts/run.sh", "size": 18, "firstLine": "#!/bin/sh" },
            { "path": "payload/bin/tool", "size": 3 }
        ]));
        assert_eq!(
            lines,
            [
                "contains 2 programs your agents can run",
                "  payload/scripts/run.sh (18 bytes): #!/bin/sh",
                "  payload/bin/tool (3 bytes)",
            ]
        );
        assert_eq!(
            script_lines(&json!([]))[0],
            "contains 0 programs your agents can run"
        );
    }

    #[test]
    fn the_publisher_is_unverified_below_first_party() {
        let insp = |tier: &str| {
            json!({
                "manifest": { "id": "demo/x", "version": "1.0.0", "kind": "skill", "licence": "MIT",
                              "publisher": { "id": "demo", "name": "Demo" } },
                "trust": { "tier": tier, "keyId": "ABCDEF0123456789" },
                "capabilities": {}, "scripts": [], "requires": { "runtime": { "type": "none" } },
            })
        };
        assert!(describe_inspection(&insp("unknown-signer")).contains("Demo (demo), unverified"));
        assert!(describe_inspection(&insp("unsigned")).contains("unverified"));
        let fp = describe_inspection(&insp("first-party"));
        assert!(!fp.contains("unverified"), "{fp}");
        assert!(fp.contains("signer key: ABCDEF0123456789"), "{fp}");
    }

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

    #[test]
    fn names_follow_the_ext_param_pattern() {
        assert!(valid_name("demo-skill") && valid_name("a.b_c") && valid_name("9x"));
        assert!(
            !valid_name("")
                && !valid_name("Demo")
                && !valid_name("-x")
                && !valid_name(&"a".repeat(65))
        );
    }
}
