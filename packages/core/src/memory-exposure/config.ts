import type { HarnessConfig } from "@plur1bus/config-schema";
import type { ChannelSwitches, ExposureChannel } from "./types.ts";

/** Standard everywhere: exposed and captured. Owner decision 2026-10-29 (ADR-003). */
export const CHANNEL_DEFAULTS: Readonly<Record<ExposureChannel, ChannelSwitches>> = Object.freeze({
  collab: Object.freeze({ recall: Object.freeze({ workspace: true, user: true, agentPrivate: true }), capture: true }),
  mcp: Object.freeze({ recall: Object.freeze({ workspace: true, user: true, agentPrivate: true }), capture: true }),
  a2a: Object.freeze({ recall: Object.freeze({ workspace: true, user: true, agentPrivate: true }), capture: true }),
});

/** The configured switches of one agent for one channel; an unset switch keeps its default. Read on every call, so a
 *  `live` config change applies to the next turn. */
export function channelSwitches(config: HarnessConfig, agentId: string, channel: ExposureChannel): ChannelSwitches {
  const base = CHANNEL_DEFAULTS[channel];
  const set = Object.hasOwn(config.agents, agentId) ? config.agents[agentId]?.memoryExposure?.[channel] : undefined;
  return {
    recall: {
      workspace: set?.recall?.workspace ?? base.recall.workspace,
      user: set?.recall?.user ?? base.recall.user,
      agentPrivate: set?.recall?.agentPrivate ?? base.recall.agentPrivate,
    },
    capture: set?.capture ?? base.capture,
  };
}
