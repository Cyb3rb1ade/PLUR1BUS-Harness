// Memory exposure (owner decision 2026-10-29, ADR-003): which of an agent's memory scopes a turn that another agent or
// an outside protocol causes may read, and whether it is captured. `config.ts` holds the per-agent switches
// (`agents.<id>.memoryExposure.<channel>`), `resolve.ts` combines them with the principal's RBAC rights, and a channel
// adapter (`collab.ts` today) applies the result through the turn memory port. A further channel (a2a, mcp, acp) adds
// its config node, an entry in `CHANNEL_DEFAULTS` and its own adapter; it does not need another resolver.
export { CHANNEL_DEFAULTS, channelSwitches } from "./config.ts";
export { readRights, resolveExposure } from "./resolve.ts";
export { collabMemory, type CollabMemory, type CollabMemoryDeps, type CollabTurn } from "./collab.ts";
export { externalMemory, mcpMemory, a2aMemory, type ExternalMemory, type ExternalMemoryDeps, type ExternalTurn } from "./external.ts";
export { NO_SCOPES, type ChannelSwitches, type Exposure, type ExposureChannel, type MemoryExposureConfig, type ScopeAccess } from "./types.ts";
