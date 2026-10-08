// pair-proof (desktop spec §6.2, owner decision 2026-10-02): lets a device that only has a typed `XXXX-XXXX` code check,
// before it reveals the code, that the certificate it is looking at belongs to the harness that issued the code.
//
//   1. The client opens TLS, records fp = SHA-256 of the leaf certificate it was shown, and sends
//      POST /api/v1/devices/pair-proof { clientNonce }   (unauthenticated, no code).
//   2. The harness answers { salt, serverNonce, proof[, caPin] } with
//        proof = HMAC-SHA256(K, "plur1bus-pair-v1" | fp_served | [caPin] | origin | clientNonce | serverNonce),
//        K = Argon2id(code, salt)   (derived once when the code was issued).
//   3. The client derives K from the typed code and checks the proof against ITS fp. Match: it pins fp and redeems.
//      Mismatch: it refuses and never sends the code.
//
// This file is the handler function and the client-side check; routing, TLS and reading the served certificate are the
// API package's job (follow-up). The route layer must pass `origin` from its configuration (the origin a client
// reaches this listener by), not a raw Host header, and `servedFingerprint` from the socket the request arrived on.
//
// The spec writes the HMAC input as a plain concatenation. Nonces and origin are variable-length, so the concrete
// encoding here prefixes them with their lengths (and the CA pin with a presence byte): no byte can migrate between
// fields. Server and client use the same proofInput().
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { DEFAULT_ARGON2, deriveKey, normalizeCode } from "./pair-code.ts";
import type { Argon2Params, DeriveKey, PairCodeStore } from "./pair-code.ts";
import { parsePin } from "./fingerprint.ts";
import type { Pin } from "./fingerprint.ts";
import { SlidingWindowLimiter } from "./rate-limit.ts";
import type { EpochMs } from "./types.ts";

const LABEL = Buffer.from("plur1bus-pair-v1", "ascii");

export interface PairProofResponse {
  readonly salt: string;
  readonly serverNonce: string;
  readonly proof: string;
  readonly caPin?: Pin;
}

export interface ProofLimiter {
  readonly perSource: SlidingWindowLimiter;
  readonly perCode: SlidingWindowLimiter;
}

export function createProofLimiter(o: { perSourceMax?: number; perSourceWindowMs?: number; perCodeMax?: number; perCodeWindowMs?: number } = {}): ProofLimiter {
  return {
    perSource: new SlidingWindowLimiter({ max: o.perSourceMax ?? 10, windowMs: o.perSourceWindowMs ?? 60_000 }),
    perCode: new SlidingWindowLimiter({ max: o.perCodeMax ?? 60, windowMs: o.perCodeWindowMs ?? 3_600_000 }),
  };
}

export function createClientNonce(): string {
  return randomBytes(16).toString("base64url");
}

function fpBytes(fp: Pin | Uint8Array): Buffer | undefined {
  if (typeof fp === "string") return parsePin(fp);
  return fp.length === 32 ? Buffer.from(fp) : undefined;
}

export function proofInput(i: { fp: Uint8Array; origin: string; clientNonce: Uint8Array; serverNonce: Uint8Array; caPin?: Uint8Array | undefined }): Buffer {
  if (i.fp.length !== 32) throw new Error("fingerprint must be 32 bytes");
  if (i.caPin !== undefined && i.caPin.length !== 32) throw new Error("caPin must be 32 bytes");
  const origin = Buffer.from(i.origin, "utf8");
  if (origin.length > 0xffff || i.clientNonce.length > 0xff || i.serverNonce.length > 0xff) throw new Error("field too long");
  const originLen = Buffer.alloc(2);
  originLen.writeUInt16BE(origin.length);
  return Buffer.concat([
    LABEL, i.fp,
    i.caPin ? Buffer.concat([Buffer.from([1]), i.caPin]) : Buffer.from([0]),
    originLen, origin,
    Buffer.from([i.clientNonce.length]), i.clientNonce,
    Buffer.from([i.serverNonce.length]), i.serverNonce,
  ]);
}

// --- server --------------------------------------------------------------------------------------------------------

export interface PairProofContext {
  readonly store: PairCodeStore;
  readonly now: EpochMs;
  /** The origin a client reaches this listener by, from configuration. */
  readonly origin: string;
  /** SHA-256 of the DER leaf certificate as served on the connection this request arrived on. */
  readonly servedFingerprint: Pin | Uint8Array;
  /** Present for company-ca with the root CA held: the proof then binds it. */
  readonly caPin?: Pin;
  /** The client's address, for rate limiting. */
  readonly source: string;
  readonly limiter: ProofLimiter;
}

export type PairProofHttp =
  | { readonly status: 200; readonly body: PairProofResponse }
  | { readonly status: 400 | 404 | 429; readonly body: { readonly code: string; readonly message: string; readonly retryAfterMs?: number } };

const fail = (status: 400 | 404 | 429, code: string, message: string, retryAfterMs?: number): PairProofHttp =>
  ({ status, body: { code, message, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) } });

function parseNonce(v: unknown): Buffer | undefined {
  if (typeof v !== "string" || !/^[A-Za-z0-9_-]+$/.test(v)) return undefined;
  const bytes = Buffer.from(v, "base64url");
  return bytes.length >= 16 && bytes.length <= 64 && bytes.toString("base64url") === v ? bytes : undefined;
}

/** The handler behind POST /api/v1/devices/pair-proof. It never accepts the code and never consumes one. */
export function handlePairProof(body: unknown, ctx: PairProofContext): PairProofHttp {
  const source = ctx.limiter.perSource.hit(ctx.source, ctx.now);
  if (!source.allowed) return fail(429, "rate-limited", "too many requests from this address", source.retryAfterMs);

  if (typeof body !== "object" || body === null || Array.isArray(body)) return fail(400, "bad-request", "expected a JSON object");
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "clientNonce") return fail(400, "bad-request", "only clientNonce is accepted: the code must never be sent here");
  const clientNonce = parseNonce((body as { clientNonce?: unknown }).clientNonce);
  if (!clientNonce) return fail(400, "bad-request", "clientNonce must be 16 to 64 random bytes, base64url");

  const code = ctx.store.open(ctx.now)[0];
  if (!code) return fail(404, "no-open-code", "no pairing is open on this harness");
  const perCode = ctx.limiter.perCode.hit(code.id, ctx.now);
  if (!perCode.allowed) return fail(429, "rate-limited", "too many proofs for the open pairing code", perCode.retryAfterMs);

  const fp = fpBytes(ctx.servedFingerprint);
  if (!fp) throw new Error("servedFingerprint must be a sha256 pin or 32 bytes");
  const caPin = ctx.caPin !== undefined ? parsePin(ctx.caPin) : undefined;
  if (ctx.caPin !== undefined && !caPin) throw new Error("caPin is not a sha256 pin");
  const serverNonce = randomBytes(16);
  const proof = createHmac("sha256", code.key).update(proofInput({ fp, origin: ctx.origin, clientNonce, serverNonce, caPin })).digest();
  return {
    status: 200,
    body: {
      salt: code.salt.toString("base64url"),
      serverNonce: serverNonce.toString("base64url"),
      proof: proof.toString("base64url"),
      ...(ctx.caPin !== undefined ? { caPin: ctx.caPin } : {}),
    },
  };
}

// --- client --------------------------------------------------------------------------------------------------------

export interface VerifyProofInput {
  /** What the person typed. */
  readonly code: string;
  readonly response: PairProofResponse;
  /** SHA-256 of the leaf certificate the client itself was shown by the TLS handshake. */
  readonly fingerprintSeen: Pin | Uint8Array;
  readonly origin: string;
  /** The nonce the client sent. */
  readonly clientNonce: string;
  readonly params?: Argon2Params;
  readonly derive?: DeriveKey;
}

/** `ok: true` means the certificate the client saw belongs to the harness that issued the code. A `caPin` is returned
 *  only when the proof covered it. Never throws on hostile input. */
export function verifyPairProof(i: VerifyProofInput): { ok: true; caPin?: Pin } | { ok: false } {
  const code = normalizeCode(i.code);
  const fp = fpBytes(i.fingerprintSeen);
  const clientNonce = parseNonce(i.clientNonce);
  const r = i.response as Partial<PairProofResponse> | undefined;
  if (!code || !fp || !clientNonce || typeof r !== "object" || r === null) return { ok: false };
  const salt = typeof r.salt === "string" ? Buffer.from(r.salt, "base64url") : undefined;
  const serverNonce = typeof r.serverNonce === "string" ? Buffer.from(r.serverNonce, "base64url") : undefined;
  const given = typeof r.proof === "string" ? Buffer.from(r.proof, "base64url") : undefined;
  if (!salt || salt.length < 8 || !serverNonce || serverNonce.length < 8 || serverNonce.length > 64 || !given || given.length !== 32) return { ok: false };
  const caPin = r.caPin !== undefined ? parsePin(r.caPin) : undefined;
  if (r.caPin !== undefined && !caPin) return { ok: false };

  const key = (i.derive ?? deriveKey)(code, salt, i.params ?? DEFAULT_ARGON2);
  const expected = createHmac("sha256", key).update(proofInput({ fp, origin: i.origin, clientNonce, serverNonce, caPin })).digest();
  if (!timingSafeEqual(expected, given)) return { ok: false };
  return r.caPin !== undefined ? { ok: true, caPin: r.caPin } : { ok: true };
}
