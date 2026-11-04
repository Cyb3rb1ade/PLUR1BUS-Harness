// API-private persistence. SPKI history never becomes part of an Anchor or a pairing/trust announcement.
import { parsePin, parseTrust, switchTrust, type Anchor, type Pin, type TrustDevice, type TrustState } from "../../remote-access/src/index.ts";

export interface TrustKeys {
  readonly current: Pin | null;
  readonly next?: Pin | null;
  readonly retired: readonly Pin[];
  /** Legacy DER hashes cannot establish the corresponding public-key identity. */
  readonly unresolved: readonly Anchor[];
}
export interface StoredTrust {
  readonly version: 2;
  readonly state: TrustState;
  readonly keys: TrustKeys;
  readonly activation?: { readonly devices: readonly TrustDevice[]; readonly at: number };
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const bad = (): never => { throw new Error("remote trust state unavailable"); };
const pin = (value: unknown): value is Pin => typeof value === "string" && parsePin(value) !== undefined;
const nullablePin = (value: unknown): value is Pin | null => value === null || pin(value);
const identity = (value: Anchor) => `${value.kind}:${value.pin}`;

function activation(value: unknown, state: TrustState): StoredTrust["activation"] {
  if (value === undefined) return undefined;
  if (!object(value) || state.phase !== "staged" || !Number.isSafeInteger(value.at) || (value.at as number) < 0 || !Array.isArray(value.devices)) return bad();
  const ids = new Set<string>(), devices: TrustDevice[] = [];
  for (const device of value.devices) {
    if (!object(device) || typeof device.id !== "string" || !device.id || typeof device.name !== "string" || ids.has(device.id)) return bad();
    ids.add(device.id); devices.push({ id: device.id, name: device.name });
  }
  return { devices, at: value.at as number };
}

export function parseStoredTrust(text: string): { stored: StoredTrust; legacy: boolean } {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return bad(); }
  if (!object(raw) || (raw.version !== 1 && raw.version !== 2) || !object(raw.state)) return bad();
  if (raw.version === 2 && (!Object.hasOwn(raw.state, "revoked") || !Array.isArray(raw.state.revoked))) return bad();
  const parsed = parseTrust(JSON.stringify(raw.state)); if (!parsed.ok) return bad();
  const state = parsed.state, intent = activation(raw.activation, state);
  if (state.phase === "staged" && state.next?.kind === state.current.kind && state.next.pin === state.current.pin) return bad();
  if (raw.version === 1) return { legacy: true, stored: { version: 2, state, keys: { current: null, ...(state.phase === "staged" ? { next: null } : {}), retired: [], unresolved: state.revoked }, ...(intent ? { activation: intent } : {}) } };
  const keys = raw.keys;
  if (!object(keys) || !Object.hasOwn(keys, "current") || !nullablePin(keys.current) || !Array.isArray(keys.retired) || !Array.isArray(keys.unresolved)) return bad();
  if (Object.keys(keys).some(key => !["current", "next", "retired", "unresolved"].includes(key))) return bad();
  if (state.phase === "staged" ? !Object.hasOwn(keys, "next") || !nullablePin(keys.next) : Object.hasOwn(keys, "next")) return bad();
  const retired: Pin[] = [], seen = new Set<Pin>();
  for (const value of keys.retired) { if (!pin(value) || seen.has(value)) return bad(); seen.add(value); retired.push(value); }
  if (keys.current !== null && seen.has(keys.current) || pin(keys.next) && seen.has(keys.next)) return bad();
  const revoked = new Map(state.revoked.map(value => [identity(value), value])), unresolved: Anchor[] = [], unresolvedIds = new Set<string>();
  for (const value of keys.unresolved) {
    if (!object(value) || (value.kind !== "cert" && value.kind !== "ca") || !pin(value.pin)) return bad();
    const id = identity({ kind: value.kind, pin: value.pin }), anchor = revoked.get(id);
    if (!anchor || unresolvedIds.has(id)) return bad(); unresolvedIds.add(id); unresolved.push(anchor);
  }
  if (intent && (keys.current === null || keys.next === null || unresolved.length)) return bad();
  return { legacy: false, stored: { version: 2, state, keys: { current: keys.current, ...(state.phase === "staged" ? { next: keys.next as Pin | null } : {}), retired, unresolved }, ...(intent ? { activation: intent } : {}) } };
}

/** Check complete envelopes, including the newline written by privateAtomicJson. Never trim retained history. */
export function assertTrustSize(value: StoredTrust): void {
  if (Buffer.byteLength(JSON.stringify(value) + "\n", "utf8") > 256 * 1024) throw new Error("remote trust state unavailable (capacity)");
}

export function validateStoredTrust(value: StoredTrust): void {
  assertTrustSize(value);
  if (parseStoredTrust(JSON.stringify(value)).legacy) return bad();
}

export function switchedTrust(stored: StoredTrust, devices: readonly TrustDevice[], at: number, legacyRecovery = false): StoredTrust {
  const { state, keys } = stored, next = keys.next ?? null;
  if (!legacyRecovery && (keys.current === null || next === null || keys.unresolved.length)) return bad();
  if (next !== null && keys.retired.includes(next)) return bad();
  const switched = switchTrust(state, devices, at); if (!switched.ok) return bad();
  const retired = [...keys.retired], unresolved = [...keys.unresolved];
  if (keys.current === null) {
    if (!unresolved.some(value => identity(value) === identity(state.current))) unresolved.push(state.current);
  } else if (keys.current !== next && !retired.includes(keys.current)) retired.push(keys.current);
  return { version: 2, state: switched.state, keys: { current: next, retired, unresolved } };
}
