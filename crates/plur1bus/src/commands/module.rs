//! `plur1bus module list|graph|install|uninstall|start|stop|restart` (B13, B14). With a supervisor that answers, every
//! command is its `module.*` method. Without one (the same routing as `config`, B6), `list`, `graph`, `install` and
//! `uninstall` work on `modules/` directly through the same Rust code (`child: null`), while `start`, `stop` and
//! `restart` fail with `E_NOT_AVAILABLE reason=supervisor-not-running`. A present supervisor that does not answer is
//! `supervisor-unresponsive`, and nothing is changed.
use super::config::{call, fail_rpc, route, Route};
use crate::cli::ModuleCmd;
use crate::modules::{self, install};
use crate::output::Out;
use crate::paths::Layout;
use plur1bus_rpc::Client;
use serde_json::{json, Value};
use std::io::{IsTerminal, Write};
use std::path::Path;

/// The supervisor's client, or `None` when no supervisor runs; an unresponsive one fails the command.
fn supervisor(out: &Out, layout: &Layout) -> Option<Client> {
    match route(layout) {
        Ok(Route::Supervisor(c)) => Some(c),
        Ok(Route::Direct) => None,
        Err(e) => fail_rpc(out, &e),
    }
}

fn rpc(out: &Out, client: &mut Client, method: &str, params: Value) -> Value {
    call(client, method, params).unwrap_or_else(|e| fail_rpc(out, &e))
}

/// `modules.*` of config.json (the defaults' when it is missing, which is not created; nothing when it cannot be
/// read: `list` still lists).
fn modules_config(layout: &Layout) -> Value {
    plur1bus_config::read(&layout.config_path())
        .map(|c| c["modules"].clone())
        .unwrap_or(Value::Null)
}

/// I2: an offline change of `modules/` holds the supervisor's single-instance lock (`run/supervisor.lock`) until it is
/// done, so a supervisor cannot start (and scan `modules/`) half-way through it. A supervisor that holds the lock but
/// did not answer is starting (or stopping): the command is refused and changes nothing.
pub(crate) fn offline_lock(out: &Out, layout: &Layout) -> std::fs::File {
    let run = layout.run();
    let created = !run.exists();
    let lock = std::fs::create_dir_all(&run)
        .and_then(|_| {
            #[cfg(unix)]
            if created {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&run, std::fs::Permissions::from_mode(0o700))?;
            }
            let _ = created;
            std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(layout.supervisor_lock())
        })
        .unwrap_or_else(|e| {
            out.fail(
                "E_INTERNAL",
                &format!("cannot open {}: {e}", layout.supervisor_lock().display()),
                json!({}),
                1,
            )
        });
    match lock.try_lock() {
        Ok(()) => lock,
        Err(std::fs::TryLockError::WouldBlock) => out.fail(
            "E_NOT_AVAILABLE",
            "a supervisor is starting or stopping; nothing was changed, re-run in a moment",
            json!({ "reason": "supervisor-running" }),
            1,
        ),
        Err(std::fs::TryLockError::Error(e)) => out.fail(
            "E_INTERNAL",
            &format!("cannot lock {}: {e}", layout.supervisor_lock().display()),
            json!({}),
            1,
        ),
    }
}

/// I2: the pid of a process of module `name` that still runs without a supervisor (orphaned inside its grace), from
/// `run/module-<name>.pid`. Changing its directory now would leave it running the old code, or adopted later as the new
/// version.
fn running_pid(layout: &Layout, name: &str) -> Option<u32> {
    std::fs::read_to_string(layout.run().join(format!("module-{name}.pid")))
        .ok()
        .and_then(|s| s.split_whitespace().next()?.parse::<u32>().ok())
        .filter(|p| crate::proc::pid_alive(*p))
}

fn module_running(out: &Out, name: &str, pid: u32) -> ! {
    out.fail(
        "E_NOT_AVAILABLE",
        &format!("module {name} still runs (pid {pid}) without a supervisor; start the supervisor (`plur1bus daemon start`) or wait for it to exit"),
        json!({ "reason": "module-running", "ids": { "pid": pid.to_string() } }),
        1,
    )
}

fn install_failed(out: &Out, e: &install::InstallError) -> ! {
    if e.is_io() {
        out.fail(
            "E_INTERNAL",
            &format!("the module could not be copied: {e}"),
            json!({ "detail": e.to_string() }),
            1,
        )
    }
    out.fail(
        "E_INVALID_PARAMS",
        &format!("the module was not installed: {e}"),
        json!({ "reason": e.reason(), "detail": e.to_string() }),
        1,
    )
}

/// G18: a destructive command asks on a terminal (not with `--json`); a script needs `--yes`.
pub(crate) fn confirm(out: &Out, question: &str, yes: bool) {
    if yes {
        return;
    }
    if std::io::stdin().is_terminal() && !out.json {
        eprint!("{question} [y/N] ");
        std::io::stderr().flush().ok();
        let mut line = String::new();
        std::io::stdin().read_line(&mut line).ok();
        if line.trim().eq_ignore_ascii_case("y") {
            return;
        }
        out.fail(
            "E_INVALID_PARAMS",
            "not applied",
            json!({ "applied": false }),
            2,
        );
    }
    out.fail(
        "E_INVALID_PARAMS",
        &format!("{question}\nre-run with --yes to apply"),
        json!({ "applied": false }),
        2,
    );
}

fn strs(v: &Value) -> Vec<&str> {
    v.as_array()
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default()
}

/// The human `module list`: one line per module, then its errors.
fn describe_list(v: &Value) -> String {
    let mods = v["modules"].as_array().cloned().unwrap_or_default();
    if mods.is_empty() {
        return "no modules installed".into();
    }
    let mut s = String::new();
    for m in &mods {
        let name = m["name"].as_str().unwrap_or("?");
        match m["version"].as_str() {
            Some(version) => s.push_str(&format!(
                "{name} {version}  priority {} ({})  scope {}",
                m["priority"],
                m["band"].as_str().unwrap_or("?"),
                m["scope"].as_str().unwrap_or("?")
            )),
            None => s.push_str(&format!("{name}  (invalid manifest)")),
        }
        s.push_str(if m["enabled"] == false {
            "  disabled"
        } else {
            "  enabled"
        });
        if let Some(c) = m["child"].as_object() {
            let state = c["process"]["state"].as_str().unwrap_or("?");
            s.push_str(&format!("  {state}"));
            if let Some(r) = c["process"]["reason"].as_str() {
                s.push_str(&format!(": {r}"));
            }
            if let Some(pid) = c["pid"].as_u64() {
                s.push_str(&format!("  pid {pid}"));
            }
        }
        s.push('\n');
        for e in strs(&m["errors"]) {
            s.push_str(&format!("  error: {e}\n"));
        }
    }
    s.trim_end().to_string()
}

/// D14 band order.
const BANDS: &[&str] = &[
    "foundation",
    "core-services",
    "services",
    "aggregators",
    "orchestration",
    "add-ons",
];

/// The human `module graph`: the core, the modules as a tree by band (their edges under each), the invalid ones,
/// then the needs-cycles and what does not resolve.
fn describe_graph(g: &Value) -> String {
    let nodes = g["nodes"].as_array().cloned().unwrap_or_default();
    let edges = g["edges"].as_array().cloned().unwrap_or_default();
    let mut s = String::from("core\n");
    let edges_of = |name: &str| -> Vec<String> {
        edges
            .iter()
            .filter(|e| e["from"] == name)
            .map(|e| match e["capability"].as_str() {
                Some(c) => format!("consumes {c} from {}", e["to"].as_str().unwrap_or("?")),
                None => format!("needs {}", e["to"].as_str().unwrap_or("?")),
            })
            .collect()
    };
    for band in BANDS {
        let in_band: Vec<&Value> = nodes.iter().filter(|n| n["band"] == *band).collect();
        if in_band.is_empty() {
            continue;
        }
        s.push_str(&format!("{band}:\n"));
        for n in in_band {
            let name = n["name"].as_str().unwrap_or("?");
            s.push_str(&format!(
                "  {name} {} (priority {})\n",
                n["version"].as_str().unwrap_or("?"),
                n["priority"]
            ));
            for e in edges_of(name) {
                s.push_str(&format!("    {e}\n"));
            }
        }
    }
    let invalid: Vec<&str> = nodes
        .iter()
        .filter(|n| n["valid"] == false)
        .filter_map(|n| n["name"].as_str())
        .collect();
    if !invalid.is_empty() {
        s.push_str("invalid manifest:\n");
        for n in invalid {
            s.push_str(&format!("  {n}\n"));
        }
    }
    for c in g["cycles"].as_array().into_iter().flatten() {
        s.push_str(&format!("cycle: {}\n", strs(c).join(", ")));
    }
    for u in g["unresolved"].as_array().into_iter().flatten() {
        let from = u["from"].as_str().unwrap_or("?");
        match (u["name"].as_str(), u["capability"].as_str()) {
            (Some(n), _) => s.push_str(&format!("unresolved: {from} needs {n}\n")),
            (_, Some(c)) => s.push_str(&format!("unresolved: {from} consumes {c} (no provider)\n")),
            _ => {}
        }
    }
    s.trim_end().to_string()
}

pub fn run(out: &Out, layout: &Layout, cmd: ModuleCmd) {
    match cmd {
        ModuleCmd::List => {
            let v = match supervisor(out, layout) {
                Some(mut c) => rpc(out, &mut c, "module.list", json!({})),
                None => {
                    let installed = modules::scan(layout);
                    json!({ "modules": modules::list_entries(&installed, &modules_config(layout)) })
                }
            };
            out.ok("module.list/1", &v, || describe_list(&v));
        }
        ModuleCmd::Graph => {
            let v = match supervisor(out, layout) {
                Some(mut c) => rpc(out, &mut c, "module.graph", json!({})),
                None => json!(modules::graph(&modules::scan(layout))),
            };
            out.ok("module.graph/1", &v, || describe_graph(&v));
        }
        ModuleCmd::Install { path } => {
            // The supervisor runs elsewhere: it gets an absolute path (not canonicalised, so a symlinked source is
            // still refused as one).
            let path = std::path::absolute(&path).unwrap_or(path);
            let v = match supervisor(out, layout) {
                Some(mut c) => rpc(
                    out,
                    &mut c,
                    "module.install",
                    json!({ "path": path.to_string_lossy() }),
                ),
                None => {
                    let _lock = offline_lock(out, layout);
                    let staged = install::stage(layout, Path::new(&path))
                        .unwrap_or_else(|e| install_failed(out, &e));
                    let m = staged.manifest.clone();
                    if let Some(pid) = running_pid(layout, &m.name) {
                        drop(staged); // removes the staged copy: `out.fail` exits without running destructors
                        module_running(out, &m.name, pid);
                    }
                    let replaced =
                        install::commit(staged).unwrap_or_else(|e| install_failed(out, &e));
                    json!({ "name": m.name, "version": m.version, "replaced": replaced })
                }
            };
            out.ok("module.install/1", &v, || {
                let (name, version) = (
                    v["name"].as_str().unwrap_or("?"),
                    v["version"].as_str().unwrap_or("?"),
                );
                if v["replaced"] == true {
                    format!("replaced {name} with {version}")
                } else {
                    format!("installed {name} {version}")
                }
            });
        }
        ModuleCmd::Uninstall { name, yes } => {
            confirm(
                out,
                &format!("uninstall module {name} (modules.{name} stays in config.json)?"),
                yes,
            );
            let v = match supervisor(out, layout) {
                Some(mut c) => rpc(out, &mut c, "module.uninstall", json!({ "name": name })),
                None => {
                    let _lock = offline_lock(out, layout);
                    if install::installed_dir(layout, &name).is_none() {
                        out.fail(
                            "E_MODULE_UNKNOWN",
                            &format!("no module named {name} is installed"),
                            json!({}),
                            1,
                        );
                    }
                    if let Some(pid) = running_pid(layout, &name) {
                        module_running(out, &name, pid);
                    }
                    install::uninstall(layout, &name).unwrap_or_else(|e| install_failed(out, &e));
                    json!({ "name": name, "removed": true })
                }
            };
            out.ok("module.uninstall/1", &v, || {
                format!("uninstalled {name} (modules.{name} stays in config.json)")
            });
        }
        ModuleCmd::Start { name } => control(out, layout, "start", &name),
        ModuleCmd::Stop { name } => control(out, layout, "stop", &name),
        ModuleCmd::Restart { name } => control(out, layout, "restart", &name),
    }
}

/// `module start|stop|restart`: only through a running supervisor.
fn control(out: &Out, layout: &Layout, verb: &str, name: &str) {
    let Some(mut c) = supervisor(out, layout) else {
        out.fail(
            "E_NOT_AVAILABLE",
            &format!("no supervisor runs, so there is nothing to {verb}; start it with `plur1bus daemon start`"),
            json!({ "reason": "supervisor-not-running" }),
            1,
        )
    };
    let method = format!("module.{verb}");
    let v = rpc(out, &mut c, &method, json!({ "name": name }));
    out.ok(&format!("{method}/1"), &v, || match verb {
        "stop" => format!("{name} stopped (until `plur1bus module start {name}`)"),
        "start" => format!("{name} started"),
        _ => format!("{name} restarted"),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_graph_text_is_a_tree_by_band_then_cycles_and_unresolved() {
        let g = json!({
            "nodes": [
                { "name": "core", "version": null, "priority": null, "band": null, "scope": "installation", "extensionPoints": {}, "valid": true },
                { "name": "base", "version": "1.0.0", "priority": 50, "band": "foundation", "scope": "installation", "extensionPoints": {}, "valid": true },
                { "name": "fixture", "version": "0.1.0", "priority": 500, "band": "add-ons", "scope": "installation", "extensionPoints": {}, "valid": true },
                { "name": "broken", "version": null, "priority": null, "band": null, "scope": null, "extensionPoints": {}, "valid": false }
            ],
            "edges": [
                { "from": "fixture", "to": "core", "kind": "needs" },
                { "from": "fixture", "to": "core", "kind": "consumes", "capability": "memory" }
            ],
            "cycles": [["a", "b"]],
            "unresolved": [{ "from": "x", "kind": "consumes", "capability": "weather" }]
        });
        let text = describe_graph(&g);
        let foundation = text.find("foundation:").unwrap();
        let addons = text.find("add-ons:").unwrap();
        assert!(foundation < addons, "{text}");
        assert!(
            text.contains(
                "  fixture 0.1.0 (priority 500)\n    needs core\n    consumes memory from core"
            ),
            "{text}"
        );
        assert!(text.contains("invalid manifest:\n  broken"), "{text}");
        assert!(text.contains("cycle: a, b"), "{text}");
        assert!(
            text.contains("unresolved: x consumes weather (no provider)"),
            "{text}"
        );
    }
}
