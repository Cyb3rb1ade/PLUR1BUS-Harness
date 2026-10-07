// D109 §5 "Surfaces and channel trust": the trust level (T0-T3) of the surface a decision arrives on, as a pure function
// of facts the core itself established (the connection, the OS, the channel module's link record), never of anything a
// client or the model claims. Anything the table does not name is T0, and so is any input that is not well formed.
//
//   T3  desktop app; CLI on a TTY of the owning OS user; web with a step-up (WebAuthn/TOTP) within the last 5 minutes
//   T2  web session without step-up; a private chat with a D24-linked identity and a valid one-time nonce on a first-party
//       channel module (a third-party module only when the person opted that module into T2)
//   T1  the inbound ACP editor that started the session
//   T0  group chats, unlinked identities, MCP clients, A2A peers, other agents, model output, tool results, everything else
export type SurfaceTrustLevel = 0 | 1 | 2 | 3;

export const STEP_UP_WINDOW_MS = 5 * 60_000;

export type SurfaceFacts =
  | { kind: "desktop-app" }
  | { kind: "cli"; tty: boolean; osUserIsOwner: boolean }
  /** `stepUpAt` and `now` are epoch ms. `authenticated`: a live session of a person. */
  | { kind: "web"; authenticated: boolean; stepUpAt?: number; now: number }
  /** `nonceValid`: the one-time nonce was issued to this linked person and this private chat and has not been used or expired. */
  | { kind: "channel"; firstParty: boolean; optedIntoT2: boolean; chat: "private" | "group"; identityLinked: boolean; nonceValid: boolean }
  | { kind: "acp-editor"; startedSession: boolean }
  | { kind: "mcp-client" | "a2a-peer" | "agent" | "model-output" | "tool-result" | "unknown" };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const get = (o: Record<string, unknown>, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined);

export function surfaceTrust(facts: SurfaceFacts): SurfaceTrustLevel {
  if (!isObj(facts)) return 0;
  switch (get(facts, "kind")) {
    case "desktop-app": return 3;
    case "cli": return get(facts, "tty") === true && get(facts, "osUserIsOwner") === true ? 3 : 0;
    case "web": {
      if (get(facts, "authenticated") !== true) return 0;
      const now = get(facts, "now");
      if (typeof now !== "number" || !Number.isFinite(now)) return 0;
      const up = get(facts, "stepUpAt");
      return typeof up === "number" && Number.isFinite(up) && up <= now && now - up <= STEP_UP_WINDOW_MS ? 3 : 2;
    }
    case "channel": {
      const trusted = get(facts, "firstParty") === true || get(facts, "optedIntoT2") === true;
      return trusted && get(facts, "chat") === "private" && get(facts, "identityLinked") === true && get(facts, "nonceValid") === true ? 2 : 0;
    }
    case "acp-editor": return get(facts, "startedSession") === true ? 1 : 0;
    default: return 0;
  }
}

/** Does a decision made on a surface of level `have` meet what the request needs? T0 satisfies nothing, and `null` (a capability that never asks) cannot be decided anywhere. */
export function surfaceSatisfies(have: SurfaceTrustLevel, required: SurfaceTrustLevel | null): boolean {
  if (required === null || ![1, 2, 3].includes(have) || ![0, 1, 2, 3].includes(required)) return false;
  return have >= required;
}
