// The `a2a-peer` principal and its authorisation. Deliberately NOT a human `Role` in rbac/policy.ts: an external A2A
// caller is not a harness user and must never be able to inherit a role-shaped right (ADR-007, ADR-008 "Security").
// Deny by default: a peer holds exactly the actions listed for exactly the agents listed, and only on an opted-in agent.
import { createHash, timingSafeEqual } from "node:crypto";
import { A2A_ACTIONS, type A2aAction, type A2aAgentInfo, type A2aPeerConfig } from "./types.ts";

export interface A2aPeer { readonly kind: "a2a-peer"; readonly peerId: string }
export type A2aDeny = "unknown-agent" | "agent-not-exposed" | "peer-not-granted-agent" | "action-not-granted";
export type A2aDecision = { effect: "allow" } | { effect: "deny"; reason: A2aDeny };

const ID = /^[A-Za-z0-9._-]{1,64}$/;
const HEX64 = /^[0-9a-f]{64}$/;
export const validAgentId = (s: string): boolean => ID.test(s);

export const hashKey = (key: string): string => createHash("sha256").update(key, "utf8").digest("hex");

/** Throws on a malformed peer table: a typo must fail at start, never become an accidental grant. */
export function validatePeers(peers: readonly A2aPeerConfig[]): void {
  const ids = new Set<string>(); const keys = new Set<string>();
  for (const p of peers) {
    if (!ID.test(p.id)) throw new Error(`a2a peer id ${JSON.stringify(p.id)} is invalid`);
    if (ids.has(p.id)) throw new Error(`a2a peer ${p.id} is listed twice`);
    if (!HEX64.test(p.keySha256)) throw new Error(`a2a peer ${p.id}: keySha256 must be 64 lower-case hex characters`);
    if (keys.has(p.keySha256)) throw new Error(`a2a peer ${p.id}: key shared with another peer`);
    ids.add(p.id); keys.add(p.keySha256);
    for (const [agent, actions] of Object.entries(p.grants)) {
      if (!ID.test(agent)) throw new Error(`a2a peer ${p.id}: agent id ${JSON.stringify(agent)} is invalid`);
      for (const a of actions) if (!(A2A_ACTIONS as readonly string[]).includes(a)) throw new Error(`a2a peer ${p.id}: unknown action ${JSON.stringify(a)}`);
    }
  }
}

/** Resolves a bearer key to a peer. Compares against every peer (no early exit) in constant time per comparison. */
export function resolvePeer(peers: readonly A2aPeerConfig[], key: string): A2aPeer | undefined {
  const presented = Buffer.from(hashKey(key), "hex");
  let found: string | undefined;
  for (const p of peers) {
    const stored = Buffer.from(p.keySha256, "hex");
    if (stored.length === presented.length && timingSafeEqual(stored, presented) && found === undefined) found = p.id;
  }
  return found === undefined ? undefined : { kind: "a2a-peer", peerId: found };
}

export function authorizePeer(peers: readonly A2aPeerConfig[], peer: A2aPeer, action: A2aAction, agentId: string, info: A2aAgentInfo | undefined): A2aDecision {
  if (info === undefined) return { effect: "deny", reason: "unknown-agent" };
  if (info.optIn !== true) return { effect: "deny", reason: "agent-not-exposed" };
  const cfg = peers.find((p) => p.id === peer.peerId);
  const granted = cfg !== undefined && Object.hasOwn(cfg.grants, agentId) ? cfg.grants[agentId] : undefined;
  if (granted === undefined) return { effect: "deny", reason: "peer-not-granted-agent" };
  return granted.includes(action) ? { effect: "allow" } : { effect: "deny", reason: "action-not-granted" };
}
