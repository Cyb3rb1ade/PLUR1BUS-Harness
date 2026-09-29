//! Where the verbs go (B6): the supervisor's `ext.*`, or the `ext::` code in-process under the supervisor's lock with
//! the offline `ModuleHost`, both answering through [`Failure`].
use super::{fail, Failure};
use crate::commands::config::{call, route, Route};
use crate::commands::module::try_offline_lock;
use crate::ext;
use crate::ext::commit::{install_commit, Agents, InstallOpts, OfflineHost};
use crate::ext::inspect::Source;
use crate::ext::lifecycle::{self, ToggleOpts};
use crate::ext::list::{list_items, show_item, ListFilter};
use crate::ext::remove::{self, RemoveOpts};
use crate::output::Out;
use crate::paths::Layout;
use plur1bus_rpc::Client;
use serde_json::{json, Value};
use std::io::Read;
use std::path::PathBuf;

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
pub(super) fn valid_name(name: &str) -> bool {
    let b = name.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"._-".contains(c))
}

pub(super) fn check_name(name: &str) -> Result<(), Failure> {
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

pub(super) fn offline_config(layout: &Layout) -> Value {
    plur1bus_config::read(&layout.config_path()).unwrap_or(Value::Null)
}

pub(super) fn agents_json(a: &Agents) -> Value {
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
                // A lock refusal goes through `fail` like every other ext failure, so `E_NOT_AVAILABLE
                // supervisor-running` exits 2 here as `supervisor-unresponsive` does online (G18).
                let lock = lock.then(|| {
                    let l = try_offline_lock(layout).unwrap_or_else(|e| {
                        let f = Failure {
                            code: e.code.into(),
                            message: e.message,
                            reason: e.extra["reason"].as_str().map(str::to_string),
                            detail: None,
                            ids: None,
                            data: None,
                        };
                        fail(out, &f, None)
                    });
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
pub(super) struct Spool(PathBuf);

impl Drop for Spool {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Copies stdin into `run/inspect/stdin-<pid>.p1x` (0600), at most `extensions.limits.packageBytes` bytes (one more is
/// `download-too-large`, as the offline spool answers).
pub(super) fn spool_stdin(layout: &Layout) -> Result<Spool, Failure> {
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

#[cfg(test)]
mod tests {
    use super::*;

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
