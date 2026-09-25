use crate::cli::ConfigCmd;
use crate::output::Out;
use crate::paths::Layout;
use plur1bus_config as cfg;
use serde_json::{json, Value};
use std::io::{IsTerminal, Write};

fn parse_value(raw: &str) -> Value {
    serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.to_string()))
}

fn class_name(k: &str) -> String {
    match cfg::restart_class_of(k) {
        cfg::RestartClass::Live => "live".into(),
        cfg::RestartClass::Core => "core".into(),
        cfg::RestartClass::Module => "module".into(),
    }
}

pub fn run(out: &Out, layout: &Layout, cmd: ConfigCmd) {
    match cmd {
        ConfigCmd::Schema => {
            let s: Value = serde_json::from_str(cfg::SCHEMA_JSON)
                .unwrap_or_else(|e| out.fail("E_INTERNAL", &e.to_string(), json!({}), 1));
            out.ok(&s, || serde_json::to_string_pretty(&s).unwrap());
        }
        ConfigCmd::Get { key } => {
            let loaded = cfg::load(&layout.config_path())
                .unwrap_or_else(|e| out.fail("E_CONFIG_INVALID", &e.to_string(), json!({}), 1));
            match cfg::get(&loaded.config, key.as_deref()) {
                Some(v) => {
                    let k = key.clone().unwrap_or_default();
                    out.ok(
                        &json!({
                            "key": key,
                            "value": v,
                            "restart": key.as_deref().map(class_name)
                        }),
                        || {
                            if k.is_empty() {
                                serde_json::to_string_pretty(&v).unwrap()
                            } else {
                                format!("{k} = {v}  [{}]", class_name(&k))
                            }
                        },
                    );
                }
                None => out.fail(
                    "E_INVALID_PARAMS",
                    &format!("no such key: {}", key.unwrap_or_default()),
                    json!({}),
                    1,
                ),
            }
        }
        ConfigCmd::Set {
            key,
            value,
            yes,
            dry_run,
        } => {
            let loaded = cfg::load(&layout.config_path())
                .unwrap_or_else(|e| out.fail("E_CONFIG_INVALID", &e.to_string(), json!({}), 1));
            let plan = cfg::set(&loaded.config, &key, parse_value(&value)).unwrap_or_else(|e| {
                out.fail("E_CONFIG_INVALID", &e.to_string(), json!({"key": key}), 1)
            });
            let restart = json!({
                "live": plan.restart.live,
                "core": plan.restart.core,
                "modules": plan.restart.modules
            });
            let describe = || {
                let mut s = format!("changes: {}\n", plan.changed.join(", "));
                if !plan.restart.live.is_empty() {
                    s.push_str(&format!("applies live: {}\n", plan.restart.live.join(", ")));
                }
                if plan.restart.core {
                    s.push_str(
                        "restarts core: yes (H1: takes effect at the next `plur1bus core run`)\n",
                    );
                }
                for m in &plan.restart.modules {
                    s.push_str(&format!("restarts module {m}\n"));
                }
                s.trim_end().to_string()
            };
            if dry_run {
                out.ok(
                    &json!({
                        "dryRun": true,
                        "changed": plan.changed,
                        "restart": restart
                    }),
                    describe,
                );
                return;
            }
            if !yes {
                if std::io::stdin().is_terminal() && !out.json {
                    eprintln!("{}", describe());
                    eprint!("apply? [y/N] ");
                    std::io::stderr().flush().ok();
                    let mut line = String::new();
                    std::io::stdin().read_line(&mut line).ok();
                    if !line.trim().eq_ignore_ascii_case("y") {
                        out.fail(
                            "E_INVALID_PARAMS",
                            "not applied",
                            json!({"applied": false}),
                            2,
                        );
                    }
                } else {
                    out.fail(
                        "E_INVALID_PARAMS",
                        &format!("{}\nre-run with --yes to apply", describe()),
                        json!({
                            "applied": false,
                            "changed": plan.changed,
                            "restart": restart
                        }),
                        2,
                    );
                }
            }
            cfg::write_atomic(&layout.config_path(), &plan.after)
                .unwrap_or_else(|e| out.fail("E_INTERNAL", &e.to_string(), json!({}), 1));
            out.ok(
                &json!({
                    "applied": true,
                    "changed": plan.changed,
                    "restart": restart
                }),
                || format!("{}\napplied", describe()),
            );
        }
    }
}
