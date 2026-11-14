//! `memory-exposure/types.ts`, and the token binding of `module-api/src/api-principal.ts` that the resolution reads.
use crate::rbac::types::Principal;

/// `ExposureChannel`: the internal channels with a `memoryExposure` entry in the agent configuration.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExposureChannel {
    /// `collab`
    Collab,
    /// `mcp`
    Mcp,
    /// `a2a`
    A2a,
}

/// Every channel, in the order of `CHANNEL_DEFAULTS`.
pub const CHANNELS: [ExposureChannel; 3] = [
    ExposureChannel::Collab,
    ExposureChannel::Mcp,
    ExposureChannel::A2a,
];

impl ExposureChannel {
    /// The configuration key.
    pub fn as_str(self) -> &'static str {
        match self {
            ExposureChannel::Collab => "collab",
            ExposureChannel::Mcp => "mcp",
            ExposureChannel::A2a => "a2a",
        }
    }

    /// The channel of a configuration key.
    pub fn parse(s: &str) -> Option<ExposureChannel> {
        CHANNELS.into_iter().find(|c| c.as_str() == s)
    }
}

/// `ScopeAccess`: the three memory scopes of the engine, named as the configuration names them.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ScopeAccess {
    /// `workspace`
    pub workspace: bool,
    /// `user`
    pub user: bool,
    /// `agentPrivate`
    pub agent_private: bool,
}

/// `NO_SCOPES`.
pub const NO_SCOPES: ScopeAccess = ScopeAccess {
    workspace: false,
    user: false,
    agent_private: false,
};

/// `ChannelSwitches`: what one channel is configured to do for one agent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChannelSwitches {
    /// The recall switches.
    pub recall: ScopeAccess,
    /// The capture switch.
    pub capture: bool,
}

/// `Exposure`: the effective decision for one turn of a channel; the switches and the rights are kept for the log.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Exposure {
    /// The channel.
    pub channel: ExposureChannel,
    /// The agent.
    pub agent_id: String,
    /// What the channel is configured to do.
    pub switches: ChannelSwitches,
    /// What the principal may read by the RBAC table.
    pub rights: ScopeAccess,
    /// What the principal may read and the agent exposes.
    pub recall: ScopeAccess,
    /// Whether a capture is allowed.
    pub capture: bool,
}

/// `ApiTokenMemoryPolicyOverride.disclose`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Disclose {
    /// `agent-decides`
    AgentDecides,
    /// `never`
    Never,
}

/// `ApiTokenMemoryPolicyOverride.recall`: an unset member keeps the switch as it is.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RecallOverride {
    /// `workspace`
    pub workspace: Option<bool>,
    /// `user`
    pub user: Option<bool>,
    /// `agentPrivate`
    pub agent_private: Option<bool>,
}

/// `ApiTokenMemoryPolicyOverride` (the `filter` member belongs to the external-memory path, not to this resolution).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MemoryOverride {
    /// `recall`
    pub recall: Option<RecallOverride>,
    /// `disclose`
    pub disclose: Option<Disclose>,
    /// `capture`
    pub capture: Option<bool>,
}

/// `ApiTokenBinding`, as far as the resolution reads it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TokenBinding {
    /// `agentId`
    pub agent_id: String,
    /// `groups`
    pub groups: Option<Vec<String>>,
    /// `memory`
    pub memory: Option<MemoryOverride>,
}

/// An RBAC [`Principal`] with the two members of the TypeScript `Principal` the RBAC decision does not read: `tokenId` and
/// `binding`.
#[derive(Clone, Debug, PartialEq)]
pub struct ExposurePrincipal {
    /// The RBAC principal.
    pub principal: Principal,
    /// `tokenId`: set for a personal API token (an empty string counts as unset, as in JavaScript).
    pub token_id: Option<String>,
    /// `binding`.
    pub binding: Option<TokenBinding>,
}
