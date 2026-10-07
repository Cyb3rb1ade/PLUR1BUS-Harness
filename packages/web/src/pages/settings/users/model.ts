// Users & roles: wire types of the RPCs that exist (identity.list, config.get), the view model of the people list and the
// validation of the invite form. No RPC lists roles or assigns them (docs/web-ui.md F40), so a role is shown only for the
// signed-in principal.
import { t, type Key } from "../../../i18n.ts";
import type { RolePreset } from "../../common/load.ts";

export type IdentityLink = { id: string; humanId: string; channel: string; revokedAt: number | null; displayName?: string };
export type IdentityHuman = { id: string; displayName: string; createdAt: number; identities: IdentityLink[] };
export type IdentityPairing = { id: string; humanId: string; channel: string; state: string };
export type IdentityList = { humans: IdentityHuman[]; pairings: IdentityPairing[] };

declare module "../../../api/index.ts" {
  interface RpcMethods {
    "identity.list": { params: { includeRevoked?: boolean }; result: IdentityList };
    "config.get": { params: { key?: string; tier?: "basic" | "advanced" }; result: { key: string | null; value: unknown; revision: string } };
  }
}

export const NAME_MAX = 128;
export const presetName = (r: string): string => (r in PRESET_TEXT ? t(`users.preset.${r}.name` as Key) : r);
const PRESET_TEXT: Record<RolePreset, true> = { owner: true, admin: true, operator: true, member: true, viewer: true };

export type Row = { id: string; name: string; self: boolean; role: string | null; statusKeys: { key: Key; n?: number }[] };

/** The signed-in principal first, then the humans identity.list returns (their roles are not served). */
export function buildRows(self: { id: string; role: string }, list: IdentityList | null): Row[] {
  const rows: Row[] = [{ id: self.id, name: self.id, self: true, role: self.role, statusKeys: [{ key: "users.status.signedIn" }] }];
  for (const hu of list?.humans ?? []) {
    if (hu.id === self.id) continue;
    const active = hu.identities.filter((l) => l.revokedAt === null).length;
    const status: Row["statusKeys"] = [active === 0 ? { key: "users.status.noLink" } : active === 1 ? { key: "users.status.linkedOne" } : { key: "users.status.linkedMany", n: active }];
    if ((list?.pairings ?? []).some((p) => p.humanId === hu.id)) status.push({ key: "users.status.pairing" });
    rows.push({ id: hu.id, name: hu.displayName, self: false, role: null, statusKeys: status });
  }
  return rows;
}

/** Agent ids from the value of `config.get agents` (an object keyed by id; a list of ids or `{id}` objects is accepted too). */
export function agentIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? v : (v as { id?: unknown; agentId?: unknown } | null)?.id ?? (v as { agentId?: unknown } | null)?.agentId)).filter((v): v is string => typeof v === "string");
  return typeof value === "object" && value !== null ? Object.keys(value) : [];
}

export type Rights = Record<string, "use" | "manage">;
/** Toggles one right; Manage includes Use. */
export function toggleRight(rights: Rights, agent: string, right: "use" | "manage", on: boolean): Rights {
  const next = { ...rights };
  if (on) next[agent] = right === "manage" ? "manage" : (next[agent] ?? "use");
  else if (right === "manage") next[agent] = "use";
  else delete next[agent];
  return next;
}

export function validateName(raw: string): boolean {
  const n = raw.trim().length;
  return n >= 1 && n <= NAME_MAX;
}
