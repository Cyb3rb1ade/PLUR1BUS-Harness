/** Profile-to-agent collisions use the same decisions in live planning and offline execution. */
import { ImportError, type AgentInfo } from "./types.ts";

export function planProfileTargets(agents: readonly AgentInfo[], mapping: Readonly<Record<string, string>>, merge: boolean) {
  const profilesByTarget = new Map<string, string[]>();
  for (const agent of agents) {
    const targetId = mapping[agent.agentId] ?? agent.agentId;
    const norm = targetId.toLowerCase();
    const profiles = profilesByTarget.get(norm) ?? [];
    profiles.push(agent.agentId);
    profilesByTarget.set(norm, profiles);
  }
  const mergedProfiles: { agentId: string; profiles: string[] }[] = [];
  for (const profiles of profilesByTarget.values()) {
    if (profiles.length < 2) continue;
    const targetId = mapping[profiles[0]!] ?? profiles[0]!;
    if (!merge) throw new ImportError("E_PROFILE_COLLISION", "profile-collision",
      `multiple profiles map to agent '${targetId}': ${profiles.join(", ")}; pass --merge-profiles to allow merging`);
    mergedProfiles.push({ agentId: targetId, profiles });
  }
  return mergedProfiles;
}
