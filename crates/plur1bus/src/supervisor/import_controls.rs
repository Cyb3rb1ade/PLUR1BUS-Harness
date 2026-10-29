//! Private worker host controls. Source records and credentials never become public RPC responses.
use super::{config, import_records as records, imports::Job, relock, Shared};
use crate::ext::commit::ModuleHost;
use crate::ext::ExtError;
use crate::paths::Layout;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::Arc;

fn refused() -> ExtError {
    ExtError::new(
        "E_IMPORT_FAILED",
        "worker-control-unavailable",
        "private import control is unavailable",
    )
}

fn closed(value: &Value, keys: &[&str]) -> Result<(), ExtError> {
    if value
        .as_object()
        .is_none_or(|map| map.keys().any(|key| !keys.contains(&key.as_str())))
    {
        Err(refused())
    } else {
        Ok(())
    }
}

fn set_error(error: config::SetError) -> ExtError {
    match error {
        config::SetError::Conflict { .. } => ExtError::new(
            "E_CONFLICT",
            "config-changed",
            "target configuration changed",
        ),
        config::SetError::Invalid(_) | config::SetError::ForeignHostStorePath(_) => ExtError::new(
            "E_CONFIG_INVALID",
            "config-invalid",
            "import configuration was refused",
        ),
        _ => refused(),
    }
}

pub struct Host<'a> {
    pub shared: &'a Arc<Shared>,
    pub layout: &'a Layout,
    pub job: &'a Job,
    pub deadline: Option<std::time::Instant>,
}

impl Host<'_> {
    fn principal(&self) -> Value {
        json!({"kind":"person","userId":self.job.owner_id,"role":self.job.role})
    }

    fn restore(&self, params: &Value) -> Result<Value, ExtError> {
        closed(params, &["sha256"])?;
        let base = self.layout.home.join("imports").join(&self.job.run_id);
        let journal: Value = serde_json::from_slice(&records::read(
            self.layout,
            &base.join("maintenance.json"),
            256 * 1024,
        )?)
        .map_err(|_| refused())?;
        let snapshot = records::read(
            self.layout,
            &base.join("cold-snapshot/manifest.json"),
            32 * 1024 * 1024,
        )?;
        let manifest: Value = serde_json::from_slice(&snapshot).map_err(|_| refused())?;
        if journal["schema"] != "import.maintenance/1"
            || journal["runId"] != self.job.run_id
            || journal["phase"] != "rolling-back"
            || journal["snapshotSha256"] != format!("{:x}", Sha256::digest(&snapshot))
            || manifest["schema"] != "import.cold-snapshot/1"
            || manifest["runId"] != self.job.run_id
        {
            return Err(refused());
        }
        if manifest["config"]["existed"] == false
            && params.get("sha256") == Some(&Value::Null)
            && manifest["config"]["sha256"] == Value::Null
            && manifest["config"]["size"] == 0
        {
            return config::restore_maintenance(self.shared, self.layout, None).map_err(set_error);
        }
        let digest = params["sha256"]
            .as_str()
            .filter(|value| records::hash(value))
            .ok_or_else(refused)?;
        let bytes = records::read(
            self.layout,
            &base.join("cold-snapshot/config.json"),
            4 * 1024 * 1024,
        )?;
        if manifest["config"]["existed"] != true
            || manifest["config"]["sha256"] != digest
            || manifest["config"]["size"] != bytes.len()
            || format!("{:x}", Sha256::digest(&bytes)) != digest
        {
            return Err(refused());
        }
        config::restore_maintenance(self.shared, self.layout, Some(&bytes)).map_err(set_error)
    }

    pub fn request(&mut self, method: &str, params: &Value) -> Result<Value, ExtError> {
        match method {
            "config.get" => {
                closed(params, &[])?;
                let state = relock(&self.shared.config);
                Ok(json!({"config":state.running.as_ref().ok_or_else(refused)?,
                    "revision":state.revision.as_ref().ok_or_else(refused)?}))
            }
            "config.set" => {
                closed(params, &["changes", "dryRun", "ifRevision"])?;
                let changes = params["changes"]
                    .as_array()
                    .filter(|list| !list.is_empty() && list.len() <= 64)
                    .ok_or_else(refused)?;
                let changes = changes
                    .iter()
                    .map(|change| {
                        closed(change, &["key", "value"])?;
                        let key = change["key"]
                            .as_str()
                            .filter(|key| !key.is_empty() && key.len() <= 4096)
                            .ok_or_else(refused)?;
                        Ok((
                            key.to_string(),
                            change.get("value").cloned().ok_or_else(refused)?,
                        ))
                    })
                    .collect::<Result<Vec<_>, ExtError>>()?;
                let dry = params["dryRun"].as_bool().ok_or_else(refused)?;
                if params
                    .get("ifRevision")
                    .is_some_and(|revision| !revision.is_string())
                {
                    return Err(refused());
                }
                // Source-model preparation clears only the prior generation selector. Other null values keep
                // their ordinary meaning and cannot silently become deletions in the same private batch.
                let remove_generation = changes
                    .iter()
                    .any(|(key, value)| key == "engine.reembedding" && value.is_null());
                if remove_generation
                    && changes
                        .iter()
                        .any(|(key, value)| value.is_null() && key != "engine.reembedding")
                {
                    return Err(refused());
                }
                config::set_maintenance(
                    self.shared,
                    self.layout,
                    changes,
                    params["ifRevision"].as_str(),
                    dry,
                    remove_generation,
                    &self.principal(),
                )
                .map_err(set_error)
            }
            "config.restore" => self.restore(params),
            "extension.plan" => {
                closed(params, &["candidate"])?;
                super::import_extensions::plan_for_run(
                    self.layout,
                    &params["candidate"],
                    &self.job.run_id,
                )
            }
            "extension.install" => {
                closed(params, &["candidate", "runId"])?;
                if params["runId"] != self.job.run_id {
                    return Err(refused());
                }
                let layout = self.layout;
                let run_id = self.job.run_id.clone();
                super::import_extensions::install(layout, self, &params["candidate"], &run_id)
            }
            "extension.rollback" => {
                closed(params, &["receipt"])?;
                let layout = self.layout;
                super::import_extensions::rollback(layout, self, &params["receipt"])
            }
            _ => Err(refused()),
        }
    }
}

impl ModuleHost for Host<'_> {
    fn check_cancelled(&self) -> Result<(), ExtError> {
        let now = std::time::Instant::now();
        let expired = self.deadline.is_some_and(|deadline| now >= deadline) || {
            let state = self.shared.lock();
            state
                .stopping
                .is_some_and(|stop| now >= stop.requested_at + stop.budget)
        };
        if expired {
            return Err(ExtError::new(
                "E_NOT_AVAILABLE",
                "import-deadline",
                "import control deadline passed",
            ));
        }
        if self.job.mode == "apply" && !self.job.automatic_rollback {
            let state = relock(&self.shared.maintenance);
            if state.abort_requested
                && state.active.as_ref().is_some_and(|active| {
                    active.run_id == self.job.run_id
                        && active.attempt == self.job.attempt
                        && active.invocation_id == self.job.invocation_id
                })
            {
                return Err(ExtError::new(
                    "E_NOT_AVAILABLE",
                    "import-aborted",
                    "import control was aborted",
                ));
            }
        }
        Ok(())
    }

    fn config(&self) -> Value {
        relock(&self.shared.config)
            .running
            .clone()
            .unwrap_or(Value::Null)
    }
    fn set_config(
        &mut self,
        changes: Vec<(String, Value)>,
        dry_run: bool,
    ) -> Result<Value, ExtError> {
        config::set_maintenance(
            self.shared,
            self.layout,
            changes,
            None,
            dry_run,
            true,
            &self.principal(),
        )
        .map_err(set_error)
    }
    fn install_module(
        &mut self,
        _staged: crate::modules::install::Staged,
    ) -> Result<bool, ExtError> {
        Err(refused())
    }
    fn remove_module(&mut self, _name: &str, _into: &Path) -> Result<(), ExtError> {
        Err(refused())
    }
    fn notify(&mut self, change: Value) {
        self.shared
            .subscribers
            .broadcast(super::subscribers::Topic::Ext, "ext.changed", &change);
    }
    fn via(&self) -> &'static str {
        "supervisor"
    }
}

#[cfg(test)]
#[path = "import_controls_tests.rs"]
mod tests;
