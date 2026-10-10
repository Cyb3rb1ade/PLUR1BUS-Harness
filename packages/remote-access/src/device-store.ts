import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import type { PairCodeStore } from "./pair-code.ts";

export interface Device {
  id: string;
  name: string;
  platform: string;
  /** Canonical base64 DER SubjectPublicKeyInfo, never a private key. */
  publicKey: string;
  fingerprint: string;
  pairedAt: number;
  lastSeenAt: number;
  pairedBy: string;
  scope: string[];
  revoked: boolean;
  revokedAt?: number;
  revokedBy?: string;
}
export type PairDevice = Pick<Device, "name" | "platform" | "publicKey" | "pairedBy" | "scope">;
export type DeviceErrorCode = "invalid" | "not-found" | "denied" | "revoked" | "conflict" | "storage";
export class DeviceError extends Error {
  readonly code: DeviceErrorCode;
  constructor(code: DeviceErrorCode) { super(`device ${code}`); this.code = code; }
}
export interface DeviceAudit {
  append(event: { at: number; actor: { user: string; host: string }; action: string; target: string; detail: Record<string, unknown> }): void;
}
export interface DeviceStoreOptions {
  file: string;
  clock: () => number;
  audit: DeviceAudit;
  /** Required host port: POSIX chmod / Windows owner-only ACL, as for other state files. */
  securePath: (file: string) => void;
  lastSeenIntervalMs?: number;
}
const text = (v: unknown, max = 128): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
function keyInfo(value: string): { publicKey: string; fingerprint: string } {
  try {
    if (!text(value, 4096)) throw new Error();
    const der = Buffer.from(value, "base64");
    if (der.toString("base64") !== value) throw new Error();
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    // One signature algorithm, no ambiguous key encodings or attacker-selected algorithms.
    if (key.asymmetricKeyType !== "ed25519") throw new Error();
    const canonical = key.export({ format: "der", type: "spki" });
    if (!canonical.equals(der)) throw new Error();
    return { publicKey: value, fingerprint: createHash("sha256").update(canonical).digest("hex") };
  } catch { throw new DeviceError("invalid"); }
}
function validatePair(p: PairDevice): void {
  if (!text(p.name) || !text(p.platform, 64) || !text(p.pairedBy) || !Array.isArray(p.scope) || p.scope.length > 128 || !p.scope.every(s => text(s))) throw new DeviceError("invalid");
  keyInfo(p.publicKey);
}
function validateDevice(v: unknown): v is Device {
  try {
    if (!v || typeof v !== "object" || Array.isArray(v)) return false;
    const d = v as Device;
    validatePair(d);
    return /^dev_[a-f0-9-]{36}$/.test(d.id) && keyInfo(d.publicKey).fingerprint === d.fingerprint
      && Number.isSafeInteger(d.pairedAt) && d.pairedAt >= 0 && Number.isSafeInteger(d.lastSeenAt) && d.lastSeenAt >= d.pairedAt
      && typeof d.revoked === "boolean"
      && (d.revoked ? Number.isSafeInteger(d.revokedAt) && d.revokedAt! >= d.pairedAt && text(d.revokedBy) : d.revokedAt === undefined && d.revokedBy === undefined)
      && Object.keys(d).every(k => ["id", "name", "platform", "publicKey", "fingerprint", "pairedAt", "lastSeenAt", "pairedBy", "scope", "revoked", "revokedAt", "revokedBy"].includes(k));
  } catch { return false; }
}

/** One process owns this file, like the core's other state stores. Mutations are synchronous and serialized.
 *  Transport adapters must share this instance, authenticate each handshake through connect(), and retain its cleanup.
 *  No listener, metrics, private keys or bearer credentials are created here. */
export class DeviceStore {
  private devices: Device[] = [];
  private readonly connections = new Map<string, Set<() => void>>();
  private readonly pendingRevocations = new Set<string>();
  private readonly challenges = new Map<string, number>();
  private readonly options: DeviceStoreOptions;
  constructor(options: DeviceStoreOptions) {
    this.options = options;
    if (!Number.isFinite(options.lastSeenIntervalMs ?? 60_000) || (options.lastSeenIntervalMs ?? 60_000) < 0) throw new DeviceError("invalid");
    try {
      if (existsSync(options.file)) {
        if (!lstatSync(options.file).isFile() || lstatSync(options.file).isSymbolicLink()) throw new Error();
        options.securePath(options.file);
        const state: unknown = JSON.parse(readFileSync(options.file, "utf8"));
        const s = state as { version: number; devices: unknown[] };
        if (s?.version !== 1 || Object.keys(s).some(k => k !== "version" && k !== "devices") || !Array.isArray(s.devices) || !s.devices.every(validateDevice)) throw new Error();
        const devices = s.devices as Device[];
        if (new Set(devices.map(d => d.id)).size !== devices.length || new Set(devices.map(d => d.fingerprint)).size !== devices.length) throw new Error();
        this.devices = structuredClone(devices);
      }
    } catch { throw new DeviceError("storage"); }
  }
  list(): Device[] { return structuredClone(this.devices); }
  get(id: string): Device {
    const device = this.devices.find(d => d.id === id);
    if (!device) throw new DeviceError("not-found");
    return structuredClone(device);
  }
  /** Called only after a trusted pairing flow authenticated the person and bound the device key.
   *  pairedBy/scope are server-established facts; never take them from an anonymous request. */
  recordPairing(input: PairDevice): Device {
    validatePair(input);
    const key = keyInfo(input.publicKey);
    const existing = this.devices.find(d => d.fingerprint === key.fingerprint);
    if (existing) throw new DeviceError(existing.revoked ? "revoked" : "conflict");
    const now = this.options.clock();
    const d: Device = { ...structuredClone(input), ...key, id: `dev_${randomUUID()}`, pairedAt: now, lastSeenAt: now, revoked: false };
    this.change([...this.devices, d], "device.paired", d, input.pairedBy);
    return structuredClone(d);
  }
  /** Consumes a one-use code before enrolling the key; failed storage requires a new pairing code. */
  pair(codes: PairCodeStore, code: string, input: PairDevice, source: string): Device {
    validatePair(input);
    const redeemed = codes.redeem(code, this.options.clock(), source);
    if (!redeemed.ok) throw new DeviceError("denied");
    return this.recordPairing(input);
  }
  /** Server-generated, one-use, 30-second challenge. A transport sends this on the connection being authenticated. */
  challenge(): Buffer {
    const now = this.options.clock();
    for (const [key, expires] of this.challenges) if (expires <= now) this.challenges.delete(key);
    if (this.challenges.size >= 1024) throw new DeviceError("denied");
    const nonce = randomBytes(32);
    this.challenges.set(nonce.toString("hex"), now + 30_000);
    return nonce;
  }
  /** Proves possession before admitting a connection. No claimed device id authenticates a caller. */
  connect(input: { publicKey: string; challenge: Uint8Array; signature: Uint8Array; close: () => void }): () => void {
    const challenge = Buffer.from(input.challenge).toString("hex");
    const expires = this.challenges.get(challenge);
    this.challenges.delete(challenge);
    if (!expires || expires <= this.options.clock()) throw new DeviceError("denied");
    const key = keyInfo(input.publicKey);
    const d = this.devices.find(d => d.fingerprint === key.fingerprint);
    if (!d || d.revoked) throw new DeviceError("denied");
    let verified = false;
    try { verified = verify(null, input.challenge, createPublicKey({ key: Buffer.from(key.publicKey, "base64"), format: "der", type: "spki" }), input.signature); } catch { /* deny */ }
    if (!verified) throw new DeviceError("denied");
    const now = this.options.clock();
    if (now - d.lastSeenAt >= (this.options.lastSeenIntervalMs ?? 60_000)) {
      const next = this.devices.map(device => device.id === d.id ? { ...device, lastSeenAt: now } : device);
      this.persist(next); this.devices = next;
    }
    const live = this.connections.get(d.id) ?? new Set<() => void>();
    live.add(input.close); this.connections.set(d.id, live);
    return () => { live.delete(input.close); if (!live.size) this.connections.delete(d.id); };
  }
  revoke(id: string, actor: string): Device {
    const d = this.get(id);
    if (d.revoked) {
      if (this.pendingRevocations.has(id)) { this.persist(this.devices); this.pendingRevocations.clear(); }
      return d;
    }
    const next = { ...d, revoked: true, revokedAt: this.options.clock(), revokedBy: actor };
    const devices = this.devices.map(device => device.id === id ? next : device);
    // Audit first; after authorization/audit, a storage failure still denies this key in memory and disconnects it.
    this.audit("device.revoked", next, actor);
    this.devices = devices;
    this.pendingRevocations.add(id);
    try { this.persist(devices); this.pendingRevocations.clear(); }
    finally {
      const live = this.connections.get(id); this.connections.delete(id);
      for (const close of live ?? []) { try { close(); } catch { /* attempt every connection */ } }
    }
    return structuredClone(next);
  }
  rename(id: string, name: string, actor: string): Device {
    if (!text(name)) throw new DeviceError("invalid");
    const d = { ...this.get(id), name };
    this.change(this.devices.map(device => device.id === id ? d : device), "device.renamed", d, actor);
    return structuredClone(d);
  }
  private audit(action: string, d: Device, user: string): void {
    try { this.options.audit.append({ at: this.options.clock(), actor: { user, host: "device-store" }, action, target: d.id, detail: {} }); }
    catch { throw new DeviceError("storage"); }
  }
  private change(devices: Device[], action: string, d: Device, actor: string): void {
    this.audit(action, d, actor); this.persist(devices); this.devices = devices;
  }
  private persist(devices: Device[]): void {
    const file = this.options.file;
    const dir = dirname(file);
    const temp = `${file}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      fd = openSync(temp, "wx", 0o600);
      if (process.platform !== "win32") chmodSync(temp, 0o600);
      this.options.securePath(temp);
      writeFileSync(fd, `${JSON.stringify({ version: 1, devices })}\n`); fsyncSync(fd);
      closeSync(fd); fd = undefined;
      renameSync(temp, file);
      if (process.platform !== "win32") {
        const directory = openSync(dir, "r");
        try { fsyncSync(directory); } finally { closeSync(directory); }
      }
    } catch { throw new DeviceError("storage"); }
    finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temp); } catch { /* already renamed / never created */ }
    }
  }
}
