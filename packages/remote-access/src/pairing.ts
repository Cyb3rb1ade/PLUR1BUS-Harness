// The pairing payload (desktop spec §6.2 "Pairing payload"): what a harness shows as a QR code, a `plur1bus://pair` deep
// link or a typed code so that a device can find the harness, pin its certificate and redeem the one-time code.
//
//   plur1bus://pair?origin=…[&origin=…]&code=XXXX-XXXX&exp=<epoch s>[&pin=sha256:…|&ca=sha256:…][&nextpin=…][&nextca=…]&tag=…
//
// Pins follow the exposure level: `pin` (certificate) exactly for network + self-signed, `ca` (root CA) exactly for
// network + company-ca with the root CA held on the harness, nothing at tailnet/local (valid certificate / loopback).
// During a trust rollover (trust-rollover.ts) new offers carry the next pin as well (`nextpin` / `nextca`).
//
// The `tag` is an HMAC over every field under a harness-held key. Clients cannot verify it, and nothing here claims
// they can: a link altered in transit is defeated by the channel the person trusts, not by a MAC. The tag lets the
// harness recognise its own, unmodified offer when a client echoes it back (e.g. at redeem), so a redeem cannot be
// bound to origins or pins the harness never issued.
//
// QR: this package returns the exact text to encode and the recommended parameters (qrData). It does not rasterise a
// QR matrix: that needs Reed–Solomon coding, mask selection and format information, which the web UI and the desktop
// app render with the QR libraries they need for scanning anyway; carrying a second encoder here would only add a
// place for bugs.
import { createHmac, timingSafeEqual } from "node:crypto";
import { PairCodeStore, formatCode, normalizeCode } from "./pair-code.ts";
import { parsePin } from "./fingerprint.ts";
import type { Pin } from "./fingerprint.ts";
import type { PublishMode, TlsMode } from "./exposure.ts";
import type { EpochMs, Note } from "./types.ts";

export const MAX_ORIGINS = 3;
/** Byte-mode capacity of QR version 40 at error correction M. */
export const QR_MAX_BYTES = 2331;

export interface PairingOffer {
  readonly origins: readonly string[];
  readonly code: string;
  readonly expiresAt: EpochMs;
  readonly certPin?: Pin;
  readonly caPin?: Pin;
  readonly nextCertPin?: Pin;
  readonly nextCaPin?: Pin;
}
export interface SignedOffer extends PairingOffer { readonly tag: string }

export interface QrData {
  readonly text: string;
  readonly mode: "byte";
  readonly errorCorrection: "M";
  readonly length: number;
  readonly maxLength: number;
  readonly fits: boolean;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Spec §6.2 origin rules: `https://host[:port]` or http on loopback; no userinfo, path, query or fragment. IDN comes
 *  back as punycode. Returns the canonical origin or undefined. */
export function parseOrigin(raw: string): string | undefined {
  if (!/^https?:\/\//i.test(raw)) return undefined;
  const authority = raw.slice(raw.indexOf("//") + 2);
  if (authority === "" || /[/?#@\\\s]/.test(authority)) return undefined;
  let u: URL;
  try { u = new URL(raw); } catch { return undefined; }
  if (u.username !== "" || u.password !== "") return undefined;
  if (u.protocol === "http:" && !LOOPBACK_HOSTS.has(u.hostname)) return undefined;
  return u.origin;
}

function isLoopbackOrigin(origin: string): boolean {
  return LOOPBACK_HOSTS.has(new URL(origin).hostname);
}

// --- integrity tag -------------------------------------------------------------------------------------------------

function canonical(o: PairingOffer): string {
  return [
    "plur1bus-offer-v1",
    ...o.origins.map((x) => `origin=${x}`),
    `code=${normalizeCode(o.code) ?? o.code}`,
    `exp=${o.expiresAt}`,
    `pin=${o.certPin ?? ""}`,
    `ca=${o.caPin ?? ""}`,
    `nextpin=${o.nextCertPin ?? ""}`,
    `nextca=${o.nextCaPin ?? ""}`,
  ].join("\n");
}

function mac(o: PairingOffer, key: Uint8Array): Buffer {
  return createHmac("sha256", key).update(canonical(o)).digest().subarray(0, 16);
}

export function offerTag(offer: PairingOffer, key: Uint8Array): string {
  return mac(offer, key).toString("base64url");
}

export function verifyOfferTag(offer: SignedOffer, key: Uint8Array): boolean {
  if (!/^[A-Za-z0-9_-]{22}$/.test(offer.tag)) return false;
  const given = Buffer.from(offer.tag, "base64url");
  return given.length === 16 && timingSafeEqual(given, mac(offer, key));
}

// --- link ----------------------------------------------------------------------------------------------------------

const enc = (v: string): string => encodeURIComponent(v);
const encPin = (v: string): string => enc(v).replace(/%3A/g, ":");

export function encodePairingLink(o: SignedOffer): string {
  const parts = [
    ...o.origins.map((x) => `origin=${enc(x)}`),
    `code=${enc(o.code)}`,
    `exp=${Math.floor(o.expiresAt / 1000)}`,
    ...(o.certPin ? [`pin=${encPin(o.certPin)}`] : []),
    ...(o.caPin ? [`ca=${encPin(o.caPin)}`] : []),
    ...(o.nextCertPin ? [`nextpin=${encPin(o.nextCertPin)}`] : []),
    ...(o.nextCaPin ? [`nextca=${encPin(o.nextCaPin)}`] : []),
    `tag=${enc(o.tag)}`,
  ];
  return `plur1bus://pair?${parts.join("&")}`;
}

export type ParseLinkResult =
  | { readonly ok: true; readonly offer: SignedOffer }
  | { readonly ok: false; readonly issues: readonly Note[] };

const PARAMS = new Set(["origin", "code", "exp", "pin", "ca", "nextpin", "nextca", "tag"]);

export function parsePairingLink(link: string): ParseLinkResult {
  const issues: Note[] = [];
  const add = (code: string, message: string) => issues.push({ code, message });
  let u: URL;
  try { u = new URL(link); } catch { return { ok: false, issues: [{ code: "bad-link", message: "not a URL" }] }; }
  if (u.protocol !== "plur1bus:") return { ok: false, issues: [{ code: "bad-scheme", message: "expected plur1bus://" }] };
  if (u.hostname !== "pair") return { ok: false, issues: [{ code: "bad-action", message: "expected plur1bus://pair" }] };

  const single = new Map<string, string>();
  const origins: string[] = [];
  for (const [k, v] of u.searchParams) {
    if (!PARAMS.has(k)) { add("unknown-param", `unknown parameter ${k}`); continue; }
    if (k === "origin") { origins.push(v); continue; }
    if (single.has(k)) { add("duplicate-param", `parameter ${k} given twice`); continue; }
    single.set(k, v);
  }

  if (origins.length === 0) add("missing-param", "origin is required");
  if (origins.length > MAX_ORIGINS) add("too-many-origins", `at most ${MAX_ORIGINS} origins`);
  const canonicalOrigins: string[] = [];
  for (const o of origins) {
    const c = parseOrigin(o);
    if (c === undefined) add("bad-origin", `not a valid origin: ${o}`); else canonicalOrigins.push(c);
  }

  const rawCode = single.get("code");
  let code = "";
  if (rawCode === undefined) add("missing-param", "code is required");
  else {
    const n = normalizeCode(rawCode);
    if (n === undefined) add("bad-code", "the code must be 8 characters from the pairing alphabet"); else code = formatCode(n);
  }
  const rawExp = single.get("exp");
  let expiresAt = 0;
  if (rawExp === undefined) add("missing-param", "exp is required");
  else if (!/^\d{1,12}$/.test(rawExp)) add("bad-expiry", "exp must be epoch seconds");
  else expiresAt = Number(rawExp) * 1000;
  const tag = single.get("tag");
  if (tag === undefined) add("missing-param", "tag is required");

  const pins: Partial<Record<"pin" | "ca" | "nextpin" | "nextca", Pin>> = {};
  for (const k of ["pin", "ca", "nextpin", "nextca"] as const) {
    const v = single.get(k);
    if (v === undefined) continue;
    if (parsePin(v) === undefined) add("bad-pin", `${k} is not a sha256 pin`); else pins[k] = v as Pin;
  }

  if (issues.length > 0 || tag === undefined) return { ok: false, issues };
  const offer: SignedOffer = {
    origins: canonicalOrigins, code, expiresAt,
    ...(pins.pin ? { certPin: pins.pin } : {}),
    ...(pins.ca ? { caPin: pins.ca } : {}),
    ...(pins.nextpin ? { nextCertPin: pins.nextpin } : {}),
    ...(pins.nextca ? { nextCaPin: pins.nextca } : {}),
    tag,
  };
  return { ok: true, offer };
}

export function qrData(text: string): QrData {
  const length = Buffer.byteLength(text, "utf8");
  return { text, mode: "byte", errorCorrection: "M", length, maxLength: QR_MAX_BYTES, fits: length <= QR_MAX_BYTES };
}

// --- building an offer ---------------------------------------------------------------------------------------------

export interface BuildOfferInput {
  readonly store: PairCodeStore;
  readonly now: EpochMs;
  readonly publish: PublishMode;
  readonly tls: TlsMode;
  readonly origins: readonly string[];
  /** Pin of the leaf certificate (network + self-signed). */
  readonly certPin?: Pin;
  /** Pin of the root CA certificate (network + company-ca with the root CA held). */
  readonly caPin?: Pin;
  readonly nextCertPin?: Pin;
  readonly nextCaPin?: Pin;
  /** Harness-held key for the integrity tag. */
  readonly signKey: Uint8Array;
}

export type BuildOfferResult =
  | { readonly ok: true; readonly offer: SignedOffer; readonly link: string; readonly qr: QrData }
  | { readonly ok: false; readonly issues: readonly Note[] };

export function buildPairingOffer(i: BuildOfferInput): BuildOfferResult {
  const issues: Note[] = [];
  const add = (code: string, message: string) => issues.push({ code, message });

  if (i.origins.length === 0) add("no-origin", "an offer needs at least one origin");
  else if (i.origins.length > MAX_ORIGINS) add("too-many-origins", `at most ${MAX_ORIGINS} origins fit an offer`);
  const origins: string[] = [];
  for (const raw of i.origins) {
    const c = parseOrigin(raw);
    if (c === undefined) { add("bad-origin", `not a valid origin: ${raw}`); continue; }
    if (i.publish === "local" && !isLoopbackOrigin(c)) add("origin-not-reachable-at-local", `${c} is not reachable at remote.publish=local`);
    origins.push(c);
  }

  const network = i.publish === "network";
  const needsCertPin = network && i.tls === "self-signed";
  if (needsCertPin && i.certPin === undefined) add("cert-pin-required", "network + self-signed needs the certificate pin in the offer");
  if (issues.length > 0) return { ok: false, issues };

  let issued;
  try { issued = i.store.issue(i.now); } catch (err) {
    return { ok: false, issues: [{ code: "too-many-pending", message: err instanceof Error ? err.message : "too many pending codes" }] };
  }
  const unsigned: PairingOffer = {
    origins,
    code: issued.code,
    expiresAt: Math.floor(issued.expiresAt / 1000) * 1000,
    ...(needsCertPin && i.certPin ? { certPin: i.certPin } : {}),
    ...(network && i.tls === "company-ca" && i.caPin ? { caPin: i.caPin } : {}),
    ...(network && i.nextCertPin ? { nextCertPin: i.nextCertPin } : {}),
    ...(network && i.nextCaPin ? { nextCaPin: i.nextCaPin } : {}),
  };
  const offer: SignedOffer = { ...unsigned, tag: offerTag(unsigned, i.signKey) };
  const link = encodePairingLink(offer);
  return { ok: true, offer, link, qr: qrData(link) };
}
