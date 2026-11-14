//! `memory-exposure/config.ts`.
use super::types::{ChannelSwitches, ExposureChannel, ScopeAccess};
use serde_json::Value;

/// `CHANNEL_DEFAULTS`: standard everywhere, exposed and captured (owner decision 2026-10-29, ADR-003).
pub fn channel_defaults(_channel: ExposureChannel) -> ChannelSwitches {
    ChannelSwitches {
        recall: ScopeAccess {
            workspace: true,
            user: true,
            agent_private: true,
        },
        capture: true,
    }
}

/// The configured switches of one agent for one channel; an unset switch keeps its default. `config` is the validated
/// configuration (`agents.<id>.memoryExposure.<channel>.{recall.{workspace,user,agentPrivate},capture}`, booleans); a member
/// that is not a boolean counts as unset (the schema forbids it). Read on every call, so a `live` change applies to the next turn.
pub fn channel_switches(
    config: &Value,
    agent_id: &str,
    channel: ExposureChannel,
) -> ChannelSwitches {
    let base = channel_defaults(channel);
    let set = config
        .get("agents")
        .and_then(Value::as_object)
        .and_then(|agents| agents.get(agent_id))
        .and_then(|a| a.get("memoryExposure"))
        .and_then(|m| m.get(channel.as_str()));
    let flag = |pointer: &str, default: bool| {
        set.and_then(|s| s.pointer(pointer))
            .and_then(Value::as_bool)
            .unwrap_or(default)
    };
    ChannelSwitches {
        recall: ScopeAccess {
            workspace: flag("/recall/workspace", base.recall.workspace),
            user: flag("/recall/user", base.recall.user),
            agent_private: flag("/recall/agentPrivate", base.recall.agent_private),
        },
        capture: flag("/capture", base.capture),
    }
}
