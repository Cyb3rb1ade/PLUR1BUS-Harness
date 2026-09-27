//! `plur1bus service install|uninstall|status` (spec §6.5, S10).
use crate::cli::ServiceCmd;
use crate::output::Out;
use crate::paths::{self, Layout};
use crate::service::{self, fake::FakeRunner, Manager, Runner, ServiceError, SystemRunner};
use serde_json::json;

/// The real service manager, or the recording fake when the test seam asks for it. `PLUR1BUS_SERVICE_FAKE` without
/// `PLUR1BUS_ALLOW_TEST_INTERNALS=1` is a usage error rather than silently falling through to the real manager.
/// Also used by `commands::daemon` (`daemon start`'s "start via the registered service" branch and `daemon
/// status`), so a test never has either command touch a real systemd/launchd/Task Scheduler.
pub(crate) fn runner(out: &Out) -> Box<dyn Runner> {
    match std::env::var_os("PLUR1BUS_SERVICE_FAKE") {
        None => Box::new(SystemRunner),
        Some(dir) => {
            if std::env::var("PLUR1BUS_ALLOW_TEST_INTERNALS").as_deref() != Ok("1") {
                out.fail(
                    "E_INVALID_PARAMS",
                    "PLUR1BUS_SERVICE_FAKE requires PLUR1BUS_ALLOW_TEST_INTERNALS=1",
                    json!({}),
                    2,
                );
            }
            Box::new(FakeRunner::new(dir.into()))
        }
    }
}

/// `KEY=VALUE` pairs from the hidden `--env`. The key must be a portable variable name (`[A-Za-z_][A-Za-z0-9_]*`),
/// the value must not contain NUL; anything else is a usage error (exit 2).
fn parse_env(out: &Out, raw: &[String]) -> Vec<(String, String)> {
    raw.iter()
        .map(|kv| match kv.split_once('=') {
            Some((k, v)) if valid_env_key(k) && !v.contains('\0') => (k.to_string(), v.to_string()),
            _ => out.fail(
                "E_INVALID_PARAMS",
                &format!(
                    "--env expects KEY=VALUE with KEY matching [A-Za-z_][A-Za-z0-9_]*, got {kv:?}"
                ),
                json!({ "reason": "env-malformed" }),
                2,
            ),
        })
        .collect()
}

fn valid_env_key(k: &str) -> bool {
    let mut chars = k.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn fail_service(out: &Out, e: &ServiceError) -> ! {
    let (code, reason) = match e {
        ServiceError::PathNotUtf8 { .. } => ("E_INVALID_PARAMS", "path-not-utf8"),
        ServiceError::PathHasPercent { .. } => ("E_INVALID_PARAMS", "path-percent"),
        ServiceError::Io { .. } => ("E_INTERNAL", "unit-file"),
        ServiceError::Spawn { .. }
        | ServiceError::Command { .. }
        | ServiceError::StillLoaded { .. } => ("E_INTERNAL", "service-manager"),
    };
    out.fail(code, &e.to_string(), json!({ "reason": reason }), 1)
}

pub fn run(out: &Out, layout: &Layout, cmd: ServiceCmd) {
    let manager = Manager::current();
    match cmd {
        ServiceCmd::Install { no_start, env } => {
            let env = parse_env(out, &env);
            if manager == Manager::TaskScheduler && !env.is_empty() {
                out.fail(
                    "E_INVALID_PARAMS",
                    "--env is not supported by Task Scheduler",
                    json!({ "reason": "env-unsupported" }),
                    1,
                );
            }
            let r = runner(out);
            let bin = std::env::current_exe().unwrap_or_else(|e| {
                out.fail(
                    "E_INTERNAL",
                    &format!("cannot locate the plur1bus binary: {e}"),
                    json!({}),
                    1,
                )
            });
            let name = service::service_name(layout, &paths::default_home());
            let unit = service::render(manager, &bin, layout, &name, &env)
                .unwrap_or_else(|e| fail_service(out, &e));
            // launchd opens StandardErrorPath there before `supervise` creates the directory itself.
            if let Err(err) = std::fs::create_dir_all(layout.logs()) {
                fail_service(
                    out,
                    &ServiceError::Io {
                        path: layout.logs(),
                        err,
                    },
                );
            }
            let start = !no_start;
            if let Err(e) = service::install(r.as_ref(), &unit, start) {
                fail_service(out, &e);
            }
            out.ok(
                "service.install/1",
                &json!({
                    "installed": true,
                    "started": start,
                    "manager": manager,
                    "name": unit.name,
                    "path": unit.path,
                }),
                || {
                    format!(
                        "installed {} ({}) at {}{}",
                        unit.name,
                        manager.as_str(),
                        unit.path.display(),
                        if start {
                            "; started"
                        } else {
                            "; starts at the next login"
                        }
                    )
                },
            );
        }
        ServiceCmd::Uninstall => {
            let r = runner(out);
            let name = service::service_name(layout, &paths::default_home());
            if manager == Manager::TaskScheduler {
                // `/End` can only terminate the supervisor (and leaves its core to the grace timer): ask for a clean
                // stop first, so the core is shut down too; `/End` then only catches a supervisor that did not answer.
                let _ = super::daemon::stop_supervisor(layout, None);
            }
            let removed =
                service::uninstall(r.as_ref(), layout).unwrap_or_else(|e| fail_service(out, &e));
            out.ok(
                "service.uninstall/1",
                &json!({ "removed": removed, "name": name }),
                || {
                    if removed {
                        format!("removed {name}")
                    } else {
                        format!("{name} was not registered")
                    }
                },
            );
        }
        ServiceCmd::Status => {
            let r = runner(out);
            let st = service::status(r.as_ref(), layout);
            out.ok("service.status/1", &st, || {
                format!(
                    "{} ({}): {}, {} — {}",
                    st.name,
                    st.manager.as_str(),
                    if st.registered {
                        "registered"
                    } else {
                        "not registered"
                    },
                    if st.running { "running" } else { "not running" },
                    st.path.display()
                )
            });
        }
    }
}
