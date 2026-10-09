// Trust rollover (desktop spec §6.2, owner decision 2026-10-02): any change of what a client pins — a regenerated
// self-signed certificate, self-signed ↔ company-ca, a new company CA — is staged, announced, then switched, so devices
// that were reachable never pair again.
//
//   harness:  none ──stage──▶ staged ──switch──▶ switched ──clear──▶ none        (cancel: staged ──▶ none)
//   device:   { current } ──announcement over the trusted connection──▶ { current, next } ──sees next──▶ { current: next }
//
// Everything is a pure function over plain data. The API package persists the harness state (serializeTrust), serves
// `GET /api/v1/devices/trust` from announcementFor(), pushes `devices.trust.next` through the AnnouncePort, and
// authenticates the device for `POST /api/v1/devices/trust/ack` before calling ackTrust(): wiring is a follow-up.
//
// The security rule the device side encodes: a next pin is accepted only from an authenticated request on a
// connection that the device's *current* trust already verified. Nothing else can plant one: no unauthenticated
// endpoint, no other connection, no typed field. A stolen device token pushes trust to nobody, because devices only
// pull from the harness they already trust.
import { parsePin, pinsEqual } from "./fingerprint.ts";
import type { Pin } from "./fingerprint.ts";
import type { EpochMs } from "./types.ts";

export type AnchorKind = "cert" | "ca";
/** What a device pins: the leaf certificate (self-signed) or the root CA (company-ca). */
export interface Anchor { readonly kind: AnchorKind; readonly pin: Pin }
export type Phase = "none" | "staged" | "switched";

export interface TrustState {
  readonly current: Anchor;
  readonly phase: Phase;
  readonly next?: Anchor;
  readonly stagedAt?: EpochMs;
  /** Device id → when it confirmed the staged next pin. */
  readonly acks: Readonly<Record<string, EpochMs>>;
  readonly switchedAt?: EpochMs;
  /** After a switch: the devices that had not confirmed and must pair again. */
  readonly repairIds?: readonly string[];
}

export interface TrustDevice { readonly id: string; readonly name: string; readonly lastSeenAt?: EpochMs }

export type TrustErrorCode =
  | "same-trust" | "already-staged" | "bad-pin" | "not-staged" | "not-switched" | "unknown-device" | "pin-mismatch"
  | "untrusted-channel" | "wrong-harness" | "bad-state";
export interface TrustError { readonly ok: false; readonly code: TrustErrorCode; readonly message: string }
export type TrustResult = { readonly ok: true; readonly state: TrustState } | TrustError;

const err = (code: TrustErrorCode, message: string): TrustError => ({ ok: false, code, message });

function validAnchor(a: Anchor): boolean {
  return (a.kind === "cert" || a.kind === "ca") && parsePin(a.pin) !== undefined;
}
const same = (a: Anchor, b: Anchor): boolean => a.kind === b.kind && pinsEqual(a.pin, b.pin);

export function initTrust(current: Anchor): TrustState {
  return { current, phase: "none", acks: {} };
}

/** Both anchors while a change is staged, otherwise just the current one: what the harness lets devices hold. */
export function acceptedAnchors(s: TrustState): Anchor[] {
  return s.phase === "staged" && s.next ? [s.current, s.next] : [s.current];
}

/** Pin fields for a new pairing offer (`BuildOfferInput`): current plus, while staged, the next. */
export function trustForNewPairing(s: TrustState): { certPin?: Pin; caPin?: Pin; nextCertPin?: Pin; nextCaPin?: Pin } {
  const out: { certPin?: Pin; caPin?: Pin; nextCertPin?: Pin; nextCaPin?: Pin } = {};
  if (s.current.kind === "cert") out.certPin = s.current.pin; else out.caPin = s.current.pin;
  if (s.phase === "staged" && s.next) {
    if (s.next.kind === "cert") out.nextCertPin = s.next.pin; else out.nextCaPin = s.next.pin;
  }
  return out;
}

export function stageTrust(s: TrustState, next: Anchor, now: EpochMs): TrustResult {
  if (!validAnchor(next)) return err("bad-pin", "the next trust is not a valid sha256 pin");
  if (s.phase === "staged") return err("already-staged", "a change is already staged; switch or cancel it first");
  if (same(s.current, next)) return err("same-trust", "the new certificate has the same fingerprint as the current one");
  return { ok: true, state: { current: s.current, phase: "staged", next, stagedAt: now, acks: {} } };
}

export function ackTrust(s: TrustState, o: { deviceId: string; pin: Pin; now: EpochMs; paired: readonly string[] }): TrustResult {
  if (s.phase !== "staged" || !s.next) return err("not-staged", "no trust change is staged");
  if (!o.paired.includes(o.deviceId)) return err("unknown-device", "only paired devices can confirm a trust change");
  if (!pinsEqual(o.pin, s.next.pin)) return err("pin-mismatch", "the confirmed pin is not the staged one");
  if (o.deviceId in s.acks) return { ok: true, state: s };
  return { ok: true, state: { ...s, acks: { ...s.acks, [o.deviceId]: o.now } } };
}

/** "4 of 6 devices": how many confirmed and who is still missing (empty unless a change is staged). */
export function trustProgress(s: TrustState, devices: readonly TrustDevice[]): { received: number; total: number; missing: TrustDevice[] } {
  if (s.phase !== "staged") return { received: 0, total: devices.length, missing: [] };
  const missing = devices.filter((d) => !(d.id in s.acks));
  return { received: devices.length - missing.length, total: devices.length, missing };
}

export function switchTrust(s: TrustState, devices: readonly TrustDevice[], now: EpochMs): { ok: true; state: TrustState; repair: TrustDevice[] } | TrustError {
  if (s.phase !== "staged" || !s.next) return err("not-staged", "no trust change is staged");
  const repair = devices.filter((d) => !(d.id in s.acks));
  return { ok: true, state: { current: s.next, phase: "switched", acks: {}, switchedAt: now, repairIds: repair.map((d) => d.id) }, repair };
}

export function cancelTrust(s: TrustState): TrustResult {
  if (s.phase !== "staged") return err("not-staged", "no trust change is staged");
  return { ok: true, state: initTrust(s.current) };
}

/** Dismisses the "switched" summary (the admin has seen who must pair again). */
export function clearSwitched(s: TrustState): TrustResult {
  if (s.phase !== "switched") return err("not-switched", "nothing to clear");
  return { ok: true, state: initTrust(s.current) };
}

// --- announcement --------------------------------------------------------------------------------------------------

export type TrustAnnouncement =
  | { readonly phase: "none"; readonly current: Anchor }
  | { readonly phase: "staged"; readonly current: Anchor; readonly next: Anchor; readonly stagedAt: EpochMs };

/** The body of `GET /api/v1/devices/trust` for an authenticated device. */
export function announcementFor(s: TrustState): TrustAnnouncement {
  return s.phase === "staged" && s.next && s.stagedAt !== undefined
    ? { phase: "staged", current: s.current, next: s.next, stagedAt: s.stagedAt }
    : { phase: "none", current: s.current };
}

export interface TrustNextEvent { readonly type: "devices.trust.next"; readonly next: Anchor; readonly stagedAt: EpochMs }

export function trustNextEvent(s: TrustState): TrustNextEvent | undefined {
  return s.phase === "staged" && s.next && s.stagedAt !== undefined ? { type: "devices.trust.next", next: s.next, stagedAt: s.stagedAt } : undefined;
}

export interface AnnouncePort {
  /** Sends the event over the device's live, authenticated connection; false = no such connection (it will pull). */
  push(deviceId: string, event: TrustNextEvent): Promise<boolean>;
}

export async function announceStaged(s: TrustState, devices: readonly TrustDevice[], port: AnnouncePort): Promise<{ delivered: string[]; pending: string[] }> {
  const event = trustNextEvent(s);
  const out = { delivered: [] as string[], pending: [] as string[] };
  if (!event) return out;
  for (const d of devices) {
    if (d.id in s.acks) continue;
    (await port.push(d.id, event) ? out.delivered : out.pending).push(d.id);
  }
  return out;
}

// --- persistence ---------------------------------------------------------------------------------------------------

export function serializeTrust(s: TrustState): string {
  return JSON.stringify(s);
}

export function parseTrust(text: string): { ok: true; state: TrustState } | TrustError {
  const bad = (m: string) => err("bad-state", m);
  let v: unknown;
  try { v = JSON.parse(text); } catch { return bad("not JSON"); }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return bad("not an object");
  const o = v as Record<string, unknown>;
  const anchor = (x: unknown): Anchor | undefined => {
    if (typeof x !== "object" || x === null) return undefined;
    const a = x as { kind?: unknown; pin?: unknown };
    return (a.kind === "cert" || a.kind === "ca") && typeof a.pin === "string" && parsePin(a.pin) !== undefined ? { kind: a.kind, pin: a.pin as Pin } : undefined;
  };
  const current = anchor(o["current"]);
  if (!current) return bad("current is not a valid anchor");
  const phase = o["phase"];
  if (phase !== "none" && phase !== "staged" && phase !== "switched") return bad("unknown phase");
  const acksRaw = o["acks"];
  if (typeof acksRaw !== "object" || acksRaw === null || Array.isArray(acksRaw) || !Object.values(acksRaw).every((t) => typeof t === "number")) return bad("acks must map device ids to times");
  const acks = { ...(acksRaw as Record<string, number>) };

  if (phase === "staged") {
    const next = anchor(o["next"]);
    if (!next || typeof o["stagedAt"] !== "number") return bad("a staged change needs next and stagedAt");
    if (o["switchedAt"] !== undefined || o["repairIds"] !== undefined) return bad("staged state carries switch data");
    return { ok: true, state: { current, phase, next, stagedAt: o["stagedAt"], acks } };
  }
  if (o["next"] !== undefined || o["stagedAt"] !== undefined) return bad("only a staged state has next/stagedAt");
  if (phase === "switched") {
    const repair = o["repairIds"];
    if (typeof o["switchedAt"] !== "number" || !Array.isArray(repair) || !repair.every((x) => typeof x === "string")) return bad("a switched state needs switchedAt and repairIds");
    return { ok: true, state: { current, phase, acks, switchedAt: o["switchedAt"], repairIds: repair as string[] } };
  }
  if (o["switchedAt"] !== undefined || o["repairIds"] !== undefined) return bad("state none carries switch data");
  return { ok: true, state: { current, phase, acks } };
}

// --- device side ---------------------------------------------------------------------------------------------------

export interface DeviceTrust { readonly current: Anchor; readonly next?: Anchor }
/** How the connection that carried a request was verified, and whether the request carried the device token. */
export interface Channel { readonly authenticated: boolean; readonly verifiedBy: "current" | "next" | "os-store" | "none" }
export type DeviceResult = { readonly ok: true; readonly device: DeviceTrust } | TrustError;
/** What the TLS layer saw: the leaf's pin, and the pin of the CA the chain verified to (when it verified to a pinned CA). */
export interface Presented { readonly leafPin: Pin; readonly chainCaPin?: Pin }
export type Verdict = "trusted" | "trusted-next" | "certificate-changed";

export function receiveAnnouncement(dev: DeviceTrust, ann: TrustAnnouncement, channel: Channel): DeviceResult {
  if (!channel.authenticated || channel.verifiedBy !== "current") {
    return err("untrusted-channel", "a trust announcement is accepted only over an authenticated connection the current trust verified");
  }
  if (!same(dev.current, ann.current)) return err("wrong-harness", "the announcement does not continue the trust this device holds");
  if (ann.phase === "none") return { ok: true, device: { current: dev.current } };
  if (!validAnchor(ann.next) || same(dev.current, ann.next)) return err("bad-pin", "the announced next trust is invalid");
  return { ok: true, device: { current: dev.current, next: ann.next } };
}

function matches(a: Anchor, p: Presented): boolean {
  return a.kind === "cert" ? pinsEqual(p.leafPin, a.pin) : p.chainCaPin !== undefined && pinsEqual(p.chainCaPin, a.pin);
}

export function evaluateConnection(dev: DeviceTrust, p: Presented): Verdict {
  if (matches(dev.current, p)) return "trusted";
  if (dev.next && matches(dev.next, p)) return "trusted-next";
  return "certificate-changed";
}

/** Once the harness serves the next trust, the device makes it current. Without a matching next nothing changes. */
export function promote(dev: DeviceTrust, p: Presented): DeviceTrust {
  if (dev.next && !matches(dev.current, p) && matches(dev.next, p)) return { current: dev.next };
  return dev;
}
