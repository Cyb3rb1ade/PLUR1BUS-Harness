import type { HarnessConfig } from "@plur1bus/config-schema";

/** `agents.<id>.memoryExposure`: one entry per internal channel. A channel is added here by extending the config schema
 *  and its `HarnessConfig` type; `CHANNEL_DEFAULTS` then refuses to compile until it names the channel's defaults. */
export type MemoryExposureConfig = NonNullable<HarnessConfig["agents"][string]["memoryExposure"]>;
export type ExposureChannel = keyof MemoryExposureConfig;

/** The three memory scopes of the engine (`agent-private`, `workspace`, `user`), named as the config names them. */
export interface ScopeAccess {
  readonly workspace: boolean;
  readonly user: boolean;
  readonly agentPrivate: boolean;
}

/** What one channel is configured to do for one agent. */
export interface ChannelSwitches {
  readonly recall: ScopeAccess;
  readonly capture: boolean;
}

/** The effective decision for one turn of a channel: switches and rights combined. `recall` is what the principal may
 *  read and the agent exposes; the switches and the rights are kept for the log. */
export interface Exposure {
  readonly channel: ExposureChannel;
  readonly agentId: string;
  readonly switches: ChannelSwitches;
  readonly rights: ScopeAccess;
  readonly recall: ScopeAccess;
  readonly capture: boolean;
}

export const NO_SCOPES: ScopeAccess = Object.freeze({ workspace: false, user: false, agentPrivate: false });
