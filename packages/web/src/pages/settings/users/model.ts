// Users & roles model: wire types and helper methods for user.list, user.role.set,
// user.invite.*, agent.rights.* and breakglass.*.
import { t, type Key } from "../../../i18n.ts";
import type { RolePreset } from "../../common/load.ts";
import { getApi } from "../../common/load.ts";
import "../../common/admin-rpc.ts";
import type {
  UserListResult,
  UserInviteCreateResult,
  UserInviteListResult,
  BreakglassListResult,
  AgentRightsGetResult,
} from "../../common/admin-rpc.ts";

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

export type Row = { id: string; name: string; self: boolean; role: RolePreset | null; disabled?: boolean; statusKeys: { key: Key; n?: number }[] };

/** Builds rows when user.list is supported. */
export function buildRowsFromUserList(self: { id: string; role: string }, list: UserListResult | null): Row[] {
  if (!list) return [];
  const rows: Row[] = [];
  // Presentation alias for the bootstrap row only; RPC authority still comes from the API session/Core.
  const selfUser = list.users.find((u) => u.id === self.id) ?? (self.id === "owner" ? list.users.find(u => u.id === "local-owner") : undefined);
  const selfId = selfUser?.id ?? self.id;
  rows.push({
    id: selfId,
    ...(selfUser ? { disabled: selfUser.disabled ?? false } : {}),
    name: selfUser?.displayName ?? self.id,
    self: true,
    role: (selfUser?.role ?? self.role) as RolePreset,
    statusKeys: [{ key: "users.status.signedIn" }],
  });
  for (const u of list.users) {
    if (u.id === selfId) continue;
    rows.push({
      id: u.id,
      name: u.displayName || u.id,
      self: false,
      role: u.role as RolePreset,
      disabled: u.disabled ?? false,
      statusKeys: u.disabled ? [{ key: "users.status.disabled" }] : [],
    });
  }
  return rows;
}

/** Fallback when user.list is not available: the signed-in principal first, then humans from identity.list. */
export function buildRows(self: { id: string; role: string }, list: IdentityList | null): Row[] {
  const rows: Row[] = [{ id: self.id, name: self.id, self: true, role: self.role as RolePreset, statusKeys: [{ key: "users.status.signedIn" }] }];
  for (const hu of list?.humans ?? []) {
    if (hu.id === self.id) continue;
    const active = hu.identities.filter((l) => l.revokedAt === null).length;
    const status: Row["statusKeys"] = [active === 0 ? { key: "users.status.noLink" } : active === 1 ? { key: "users.status.linkedOne" } : { key: "users.status.linkedMany", n: active }];
    if ((list?.pairings ?? []).some((p) => p.humanId === hu.id)) status.push({ key: "users.status.pairing" });
    rows.push({ id: hu.id, name: hu.displayName, self: false, role: null, statusKeys: status });
  }
  return rows;
}

export async function fetchUsers(self: { id: string; role: string }, signal?: AbortSignal): Promise<Row[]> {
  const api = getApi();
  const opts = { write: false, ...(signal ? { signal } : {}) };
  try {
    const res = await api.rpc("user.list", {}, opts);
    return buildRowsFromUserList(self, res);
  } catch (e: unknown) {
    const err = e as { kind?: string; errorCode?: string; code?: number };
    if (err.kind === "unavailable" || err.errorCode === "E_NOT_AVAILABLE" || err.code === -32601) {
      const idRes = await api.rpc("identity.list", {}, opts);
      return buildRows(self, idRes);
    }
    throw e;
  }
}

export type SetRoleResult = { ok: true } | { ok: false; error: "last-owner" | "forbidden" | "failed"; message?: string };

export async function setUserRole(userId: string, role: RolePreset): Promise<SetRoleResult> {
  try {
    await getApi().rpc("user.role.set", { userId, role });
    return { ok: true };
  } catch (e: unknown) {
    const err = e as { kind?: string; errorCode?: string; reason?: string; message?: string };
    if (err.reason === "last-owner" || err.errorCode === "E_CONFLICT" || (typeof err.message === "string" && err.message.includes("last owner"))) {
      return { ok: false, error: "last-owner" };
    }
    if (err.kind === "forbidden" || err.errorCode === "E_DENIED") return { ok: false, error: "forbidden" };
    return { ok: false, error: "failed", ...(err.message !== undefined ? { message: err.message } : {}) };
  }
}

/** Validity presets of an invitation link; a custom value (whole hours) goes up to the server's 30-day ceiling. */
export const TTL_PRESETS = [{ id: "1h", minutes: 60 }, { id: "24h", minutes: 24 * 60 }, { id: "7d", minutes: 7 * 24 * 60 }, { id: "30d", minutes: 30 * 24 * 60 }] as const;
export type TtlChoice = (typeof TTL_PRESETS)[number]["id"] | "custom";
export const TTL_MAX_HOURS = 30 * 24;
export const DEFAULT_TTL: TtlChoice = "24h";

/** The validity in minutes, or null for a custom value that is not a whole number of hours from 1 to 720. */
export function ttlMinutes(choice: TtlChoice, customHours: string): number | null {
  if (choice !== "custom") return TTL_PRESETS.find((p) => p.id === choice)?.minutes ?? null;
  const raw = customHours.trim();
  if (!/^\d{1,3}$/.test(raw)) return null;
  const hours = Number(raw);
  return hours >= 1 && hours <= TTL_MAX_HOURS ? hours * 60 : null;
}

/** The origin the invitation link is built on: this page's, when it is a web origin (not tauri:// or file://). */
export function shareOrigin(): string | undefined {
  const o = globalThis.location?.origin;
  return typeof o === "string" && /^https?:\/\//.test(o) ? o : undefined;
}

export async function createInvite(displayName: string, role: RolePreset, channel: string, ttl: number = 24 * 60, origin: string | undefined = shareOrigin()): Promise<UserInviteCreateResult> {
  return await getApi().rpc("user.invite.create", { displayName, role, channel, ttlMinutes: ttl, ...(origin ? { origin } : {}) });
}

export async function listInvites(): Promise<UserInviteListResult> {
  try {
    return await getApi().rpc("user.invite.list", {}, { write: false });
  } catch {
    return { invites: [] };
  }
}

export async function revokeInvite(inviteId: string): Promise<void> {
  await getApi().rpc("user.invite.revoke", { inviteId });
}

export async function listGrants(): Promise<BreakglassListResult> {
  try {
    return await getApi().rpc("breakglass.list", {}, { write: false });
  } catch {
    return { grants: [] };
  }
}

export async function revokeGrant(grantId: string): Promise<void> {
  await getApi().rpc("breakglass.revoke", { grantId });
}

export async function getAgentRights(agentId: string): Promise<AgentRightsGetResult> {
  return await getApi().rpc("agent.rights.get", { agentId }, { write: false });
}

export async function setAgentRight(agentId: string, userId: string, right: "use" | "manage" | null): Promise<void> {
  await getApi().rpc("agent.rights.set", { agentId, userId, right });
}

/** Agent ids from the value of `config.get agents`. */
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
