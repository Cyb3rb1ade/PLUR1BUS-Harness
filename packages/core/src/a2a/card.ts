// The Agent Card (ADR-008): identity, skills and security schemes only. Never memory content, workspace paths or
// model/provider names: the card is built from a closed set of host-supplied display fields and nothing else.
import type { A2aAgentInfo, A2aSkill } from "./types.ts";

export const A2A_PROTOCOL_VERSION = "0.3.0";
export interface AgentCard {
  protocolVersion: string; name: string; description: string; url: string; preferredTransport: "JSONRPC"; version: string;
  capabilities: { streaming: false; pushNotifications: false; stateTransitionHistory: false };
  defaultInputModes: string[]; defaultOutputModes: string[]; skills: A2aSkill[];
  securitySchemes: { peerKey: { type: "http"; scheme: "bearer"; description: string } };
  security: { peerKey: string[] }[];
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;
const clean = (s: string | undefined, max: number, fallback: string): string => {
  const t = (s ?? "").replace(CONTROL, " ").trim().slice(0, max);
  return t === "" ? fallback : t;
};

export function buildAgentCard(agentId: string, info: A2aAgentInfo, baseUrl: string, version: string): AgentCard {
  const skills: A2aSkill[] = (info.skills ?? []).slice(0, 32).map((s) => ({
    id: clean(s.id, 64, "skill"), name: clean(s.name, 80, "Skill"), description: clean(s.description, 400, "No description."),
    tags: (s.tags ?? []).slice(0, 8).map((t) => clean(t, 32, "tag")),
  }));
  if (skills.length === 0) skills.push({ id: "chat", name: "Chat", description: "Answers a text message.", tags: [] });
  return {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: clean(info.displayName, 80, agentId),
    description: clean(info.description, 400, "A PLUR1BUS agent."),
    url: `${baseUrl.replace(/\/+$/, "")}/a2a/${agentId}/`,
    preferredTransport: "JSONRPC", version,
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain"], skills,
    securitySchemes: { peerKey: { type: "http", scheme: "bearer", description: "A per-peer API key issued by the operator." } },
    security: [{ peerKey: [] }],
  };
}

const CARD_KEYS = ["protocolVersion", "name", "description", "url", "preferredTransport", "version", "capabilities", "defaultInputModes", "defaultOutputModes", "skills", "securitySchemes", "security"];
const SKILL_KEYS = ["id", "name", "description", "tags"];
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const closed = (o: Record<string, unknown>, keys: string[], at: string, errs: string[]): void => {
  for (const k of Object.keys(o)) if (!keys.includes(k)) errs.push(`${at}: unexpected key ${k}`);
  for (const k of keys) if (!(k in o)) errs.push(`${at}: missing key ${k}`);
};

/** The closed card schema this server emits (no JSON-Schema dependency: the shape is small and fixed). [] = valid. */
export function validateAgentCard(card: unknown): string[] {
  const errs: string[] = [];
  if (typeof card !== "object" || card === null || Array.isArray(card)) return ["card: not an object"];
  const c = card as Record<string, unknown>;
  closed(c, CARD_KEYS, "card", errs);
  for (const k of ["protocolVersion", "name", "description", "version"]) if (!isStr(c[k])) errs.push(`card.${k}: non-empty string required`);
  if (c.preferredTransport !== "JSONRPC") errs.push("card.preferredTransport: must be JSONRPC");
  if (!isStr(c.url) || !/^https?:\/\/[^\s]+\/a2a\/[A-Za-z0-9._-]+\/$/.test(c.url)) errs.push("card.url: must be an http(s) URL ending in /a2a/<agent>/");
  const cap = c.capabilities as Record<string, unknown> | undefined;
  if (typeof cap !== "object" || cap === null) errs.push("card.capabilities: object required");
  else if (cap.streaming !== false || cap.pushNotifications !== false || cap.stateTransitionHistory !== false) errs.push("card.capabilities: streaming/push/stateTransitionHistory must be false");
  for (const k of ["defaultInputModes", "defaultOutputModes"]) if (!isStrArr(c[k]) || (c[k] as string[]).length === 0) errs.push(`card.${k}: non-empty string array required`);
  if (!Array.isArray(c.skills) || c.skills.length === 0) errs.push("card.skills: non-empty array required");
  else c.skills.forEach((s, i) => {
    if (typeof s !== "object" || s === null) { errs.push(`card.skills[${i}]: not an object`); return; }
    const so = s as Record<string, unknown>; closed(so, SKILL_KEYS, `card.skills[${i}]`, errs);
    for (const k of ["id", "name", "description"]) if (!isStr(so[k])) errs.push(`card.skills[${i}].${k}: non-empty string required`);
    if (!isStrArr(so.tags)) errs.push(`card.skills[${i}].tags: string array required`);
  });
  const ss = c.securitySchemes as Record<string, Record<string, unknown>> | undefined;
  if (typeof ss !== "object" || ss === null || ss.peerKey?.type !== "http" || ss.peerKey?.scheme !== "bearer") errs.push("card.securitySchemes.peerKey: http bearer required");
  if (!Array.isArray(c.security) || c.security.length === 0) errs.push("card.security: non-empty array required");
  return errs;
}
