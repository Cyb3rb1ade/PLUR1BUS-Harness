//! Open/resume one native coding binding; folder and model confirmations happen before the terminal editor takes stdin.
use super::{lang::Language, pump, CodeArgs, CodeError};
use crate::{
    identity::{self, CallerIdentity},
    output::Out,
    paths::Layout,
};
use plur1bus_rpc::Client;
use serde_json::{json, Value};
use std::{
    io::{self, Write},
    sync::atomic::AtomicBool,
    time::Duration,
};

pub(super) struct Bound {
    pub client: Client,
    pub caller: CallerIdentity,
    pub agent: String,
    pub session: String,
    pub opened: Value,
    pub params: Value,
}
pub(super) fn call(client: &mut Client, method: &str, params: Value) -> Result<Value, CodeError> {
    pump::request(
        client,
        method,
        params,
        &AtomicBool::new(false),
        Duration::from_secs(90),
    )
}
pub(super) fn open(
    out: &Out,
    layout: &Layout,
    args: &CodeArgs,
    interactive: bool,
    lang: Language,
) -> Result<Bound, CodeError> {
    let config = plur1bus_config::read_for_lookup(&layout.config_path(), &[])
        .map_err(|e| CodeError::new("E_CONFIG_INVALID", e.to_string()))?;
    let caller = identity::caller();
    let mut client = super::connect(layout)?;
    if !client.supports("code.session.open") {
        return Err(CodeError::new(
            "E_NOT_AVAILABLE",
            "core does not provide code.session.open",
        ));
    }
    let agent = if args.agent.is_none() {
        if let Some(session) = &args.session {
            call(
                &mut client,
                "session.get",
                json!({"caller":caller,"sessionId":session}),
            )?["session"]["agentId"]
                .as_str()
                .ok_or_else(|| CodeError::new("E_RPC_PROTOCOL", "session has no agent"))?
                .to_string()
        } else {
            crate::commands::session::pick_agent(out, &config, None)
        }
    } else {
        crate::commands::session::pick_agent(out, &config, args.agent.clone())
    };
    let root = std::fs::canonicalize(&args.path)?;
    let root = root
        .to_str()
        .ok_or_else(|| CodeError::new("E_INVALID_PARAMS", "worktree path must be valid Unicode"))?;
    let mut params = json!({"caller":caller,"agentId":agent,"root":root,"interactive":interactive});
    if let Some(id) = &args.session {
        params["sessionId"] = json!(id);
    }
    if let Some(id) = &args.project {
        params["projectId"] = json!(id);
    }
    if let Some(id) = &args.card {
        params["cardId"] = json!(id);
    }
    if args.no_memory {
        params["memoryMode"] = json!("incognito");
    }
    let mut opened = call(&mut client, "code.session.open", params.clone())?;
    if opened["state"] == "grant-required" {
        if !interactive {
            return Err(CodeError::new(
                "E_APPROVAL_REQUIRED",
                "folder approval requires an interactive local terminal",
            ));
        }
        let id = opened["grant"]["approvalId"]
            .as_str()
            .ok_or_else(|| CodeError::new("E_RPC_PROTOCOL", "folder request has no approval id"))?
            .to_string();
        let record = call(&mut client, "approval.get", json!({"id":id}))?;
        let decision = folder_decision(&opened, &record, &agent)?;
        let scope = opened["grant"]["scope"].as_str().unwrap_or("?");
        let question = format!(
            "{}\n{}\n{} ({scope}) [y/N] ",
            lang.text(
                "Allow this agent to read and write this folder recursively?",
                "Darf dieser Agent diesen Ordner rekursiv lesen und schreiben?"
            ),
            super::render::safe(opened["root"].as_str().unwrap_or("?"), false),
            lang.text("Scope", "Geltung")
        );
        match record["status"].as_str() {
            Some("pending") => {
                if !confirm(&question)? {
                    let _ = call(&mut client, "approval.cancel", json!({"id":id}));
                    return Err(CodeError::new(
                        "E_APPROVAL_REQUIRED",
                        lang.text("folder approval declined", "Ordnerfreigabe abgelehnt"),
                    ));
                }
                let approved = match call(&mut client, "approval.decide", decision) {
                    Ok(value) => value,
                    Err(error) => {
                        let _ = call(&mut client, "approval.cancel", json!({"id":id}));
                        return Err(error);
                    }
                };
                if approved["approval"]["status"] != "approved" {
                    return Err(CodeError::new(
                        "E_APPROVAL_REQUIRED",
                        "folder approval was not granted",
                    ));
                }
            }
            Some("approved") => {} // A person may have answered this exact request on another surface.
            _ => {
                return Err(CodeError::new(
                    "E_APPROVAL_REQUIRED",
                    "folder request was denied, cancelled or expired",
                ))
            }
        }
        params["sessionId"] = opened["session"]["id"].clone();
        opened = call(&mut client, "code.session.open", params.clone())?;
    }
    if opened["state"] != "open" {
        return Err(CodeError::new(
            "E_APPROVAL_REQUIRED",
            "coding folder is not granted",
        ));
    }
    let session = opened["session"]["id"]
        .as_str()
        .ok_or_else(|| CodeError::new("E_RPC_PROTOCOL", "code binding has no session"))?
        .to_string();
    params["sessionId"] = json!(session);
    if args.model.is_some() || args.reasoning.is_some() {
        let current = if args.model.is_none() {
            Some(call(
                &mut client,
                "session.model.get",
                json!({"caller":caller,"sessionId":session}),
            )?)
        } else {
            None
        };
        let profile = args
            .model
            .as_deref()
            .or_else(|| {
                current
                    .as_ref()
                    .and_then(|v| v["profile"].as_str().or(v["defaultProfile"].as_str()))
            })
            .ok_or_else(|| {
                CodeError::new(
                    "E_NOT_AVAILABLE",
                    "no current model profile; choose --model",
                )
            })?;
        let change = crate::commands::session::model_switch_params(
            &caller,
            &session,
            profile,
            args.reasoning.as_deref(),
        );
        let preview = call(&mut client, "session.model.set", change.clone())?;
        if current
            .as_ref()
            .is_some_and(|value| value["revision"] != preview["revision"])
        {
            return Err(CodeError::new(
                "E_CONFLICT",
                "model changed during preview; retry",
            ));
        }
        let warning = crate::commands::session::model_switch_warning(lang.0);
        if !args.yes && (!interactive || !confirm(&format!("{warning} [y/N] "))?) {
            return Err(CodeError::new(
                "E_APPROVAL_REQUIRED",
                "model switch requires confirmation (--yes in scripts)",
            ));
        }
        if args.yes {
            eprintln!("{warning}");
        }
        call(
            &mut client,
            "session.model.set",
            crate::commands::session::confirm_model_switch(change, &preview),
        )?;
    }
    Ok(Bound {
        client,
        caller,
        agent,
        session,
        opened,
        params,
    })
}

fn confirm(question: &str) -> Result<bool, CodeError> {
    let mut error = io::stderr().lock();
    error.write_all(question.as_bytes())?;
    error.flush()?;
    drop(error);
    let mut answer = String::new();
    io::stdin().read_line(&mut answer)?;
    Ok(matches!(
        answer.trim().to_ascii_lowercase().as_str(),
        "y" | "yes" | "j" | "ja"
    ))
}

/// Bind the terminal question to the Core's actual request; no grant.create path or caller-chosen target exists here.
fn folder_decision(opened: &Value, record: &Value, agent: &str) -> Result<Value, CodeError> {
    let plan = &opened["grant"];
    let root = opened["root"].as_str().filter(|s| !s.is_empty());
    let session = opened["session"]["id"].as_str().filter(|s| !s.is_empty());
    let id = plan["approvalId"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 256);
    let capabilities = plan["capabilities"].as_array();
    let options = record["grantOptions"].as_array();
    if root.is_none()
        || session.is_none()
        || id.is_none()
        || plan["path"].as_str() != root
        || plan["recursive"] != true
        || plan["scope"] != "session"
        || record["id"].as_str() != id
        || record["sessionId"].as_str() != session
        || record["tool"] != "code.session.open"
        || record["capability"] != "fs.write"
        || record["subject"]["kind"] != "agent"
        || record["subject"]["id"] != agent
        || record["requiredSurface"] != 2
        || record["delegable"] == true
        || record["flags"]["systemTree"] == true
        || record["targets"] != json!([root])
        || !options.is_some_and(|items| {
            items.len() == 1 && items[0]["scope"] == "session" && items[0]["requiredSurface"] == 2
        })
        || !capabilities.is_some_and(|c| {
            c.len() == 2 && c.contains(&json!("fs.read")) && c.contains(&json!("fs.write"))
        })
    {
        return Err(CodeError::new(
            "E_RPC_PROTOCOL",
            "invalid folder approval request",
        ));
    }
    Ok(json!({"id":id,"decision":"approve","scope":"session","attest":true}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn folder_decision_is_one_os_confirmed_session_request_and_never_a_direct_or_always_grant() {
        let mut opened = json!({"root":"/repo","session":{"id":"s"},"grant":{"path":"/repo","recursive":true,"scope":"session","approvalId":"request","capabilities":["fs.read","fs.write"]}});
        let record = json!({"id":"request","sessionId":"s","tool":"code.session.open","capability":"fs.write",
            "subject":{"kind":"agent","id":"worker"},"targets":["/repo"],"grantOptions":[{"scope":"session","requiredSurface":2}],"requiredSurface":2,"delegable":false});
        let decision = folder_decision(&opened, &record, "worker").unwrap();
        assert_eq!(
            decision,
            json!({"id":"request","decision":"approve","scope":"session","attest":true})
        );
        opened["grant"]["scope"] = json!("always");
        assert!(folder_decision(&opened, &record, "worker").is_err());
        opened["grant"]["scope"] = json!("session");
        opened["grant"]["path"] = json!("/");
        assert!(folder_decision(&opened, &record, "worker").is_err());
        opened["grant"]["path"] = json!("/repo");
        assert!(folder_decision(&opened, &record, "another-agent").is_err());
        let mut wrong = record.clone();
        wrong["sessionId"] = json!("other-session");
        assert!(folder_decision(&opened, &wrong, "worker").is_err());
        let mut helper = record.clone();
        helper["delegable"] = json!(true);
        assert!(folder_decision(&opened, &helper, "worker").is_err());
    }
}
