//! Voice V3 uses the existing UI's canonical RPC contract.
//! The core returns E_VOICE_BUDGET, E_VOICE_LICENSE (individual model install),
//! E_VOICE_LICENCE (UI language selection) and E_VOICE_UNAVAILABLE; these pass
//! through `Out::from_rpc_error` with the core's structured detail and IDs.
use crate::cli::{VoiceCmd, VoiceFeaturesCmd, VoiceModelsCmd, VoiceOverrideCmd, VoiceProfileCmd};
use crate::commands::memory_ops::{connect_core, require_supports};
use crate::output::Out;
use crate::paths::Layout;
use serde_json::{json, Value};
use std::time::Duration;

fn object(value: &str) -> Result<Value, String> {
    let v: Value = serde_json::from_str(value).map_err(|_| "--value must be a JSON object")?;
    if !v.is_object() {
        return Err("--value must be a JSON object".into());
    }
    Ok(v)
}
fn agent_params(agent: Option<String>) -> Value {
    agent.map_or_else(|| json!({}), |id| json!({"agentId":id}))
}
pub fn request(cmd: VoiceCmd) -> Result<(&'static str, Value), String> {
    Ok(match cmd {
        VoiceCmd::Status => ("voice.status", json!({})),
        VoiceCmd::Profile { sub } => match sub {
            VoiceProfileCmd::List => ("voice.language.list", json!({})),
            VoiceProfileCmd::Get { agent } => ("voice.language.get", agent_params(agent)),
            VoiceProfileCmd::Set {
                language,
                profile,
                agent,
                accept_licence,
            } => {
                let mut p = agent_params(agent);
                p["language"] = json!(language);
                p["profile"] = json!(profile);
                p["acceptLicences"] = json!(accept_licence);
                ("voice.language.set", p)
            }
        },
        VoiceCmd::Features { sub } => match sub {
            VoiceFeaturesCmd::Get { agent } => ("voice.realtime.profile.get", agent_params(agent)),
            VoiceFeaturesCmd::Set { value, agent } => {
                let mut p = object(&value)?;
                if let Some(id) = agent {
                    p["agentId"] = json!(id);
                }
                ("voice.realtime.profile.set", p)
            }
        },
        VoiceCmd::Override { sub } => match sub {
            VoiceOverrideCmd::Get { agent } => {
                ("voice.agent.override.get", json!({"agentId":agent}))
            }
            VoiceOverrideCmd::Set { agent, value } => (
                "voice.agent.override.set",
                json!({"agentId":agent,"override":object(&value)?}),
            ),
            VoiceOverrideCmd::Clear { agent } => {
                ("voice.agent.override.clear", json!({"agentId":agent}))
            }
        },
        VoiceCmd::Models { sub } => match sub {
            VoiceModelsCmd::List => ("voice.models.list", json!({})),
            VoiceModelsCmd::Install {
                model,
                license_accepted,
            } => (
                "voice.models.install",
                json!({"modelId":model,"licenseAccepted":license_accepted}),
            ),
        },
    })
}
pub fn run(out: &Out, layout: &Layout, cmd: VoiceCmd) {
    let (method, params) = match request(cmd) {
        Ok(v) => v,
        Err(detail) => out.fail("E_INVALID_PARAMS", &detail, json!({})),
    };
    let mut client = connect_core(out, layout, "voice", Duration::from_secs(600));
    require_supports(out, &client, method);
    match client.call(method, params) {
        Ok(value) => out.ok(&format!("{method}/1"), &value, || {
            serde_json::to_string_pretty(&value).unwrap_or_default()
        }),
        Err(e) => out.from_rpc_error(&e),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn licence_acceptance_is_never_implied() {
        let (method, params) = request(VoiceCmd::Models {
            sub: VoiceModelsCmd::Install {
                model: "research-voice".into(),
                license_accepted: false,
            },
        })
        .unwrap();
        assert_eq!(method, "voice.models.install");
        assert_eq!(params["licenseAccepted"], false);
    }
    #[test]
    fn rejects_non_object_profile_input() {
        assert!(request(VoiceCmd::Features {
            sub: VoiceFeaturesCmd::Set {
                value: "[]".into(),
                agent: None
            }
        })
        .is_err());
    }
    #[test]
    fn clears_sparse_override_through_core() {
        let (method, params) = request(VoiceCmd::Override {
            sub: VoiceOverrideCmd::Clear {
                agent: "main".into(),
            },
        })
        .unwrap();
        assert_eq!(method, "voice.agent.override.clear");
        assert_eq!(params, json!({"agentId":"main"}));
    }
}
