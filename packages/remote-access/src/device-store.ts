import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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
  private storageFailed = false;
  /** A revocation took effect in memory but could not be written yet: the next successful write carries it. */
  private unflushed = false;
  private readonly connections = new Map<string, Set<() => void>>();
  private readonly challenges = new Map<string, number>();
  private readonly options: DeviceStoreOptions;
  constructor(options: DeviceStoreOptions) {
    this.options = options;
    if (!Number.isFinite(options.lastSeenIntervalMs ?? 60_000) || (options.lastSeenIntervalMs ?? 60_000) < 0) throw new DeviceError("invalid");
    this.devices = this.readDisk(true) ?? [];
  }
  /** The file is the shared truth: null only when it does not exist yet. Anything unreadable, malformed or unsafe is a
   *  storage error, never an empty list, so damage cannot turn into "nobody is revoked". */
  private readDisk(secure: boolean): Device[] | null {
    const file = this.options.file;
    let stat;
    try { stat = lstatSync(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new DeviceError("storage");
    }
    try {
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
      if (secure) this.options.securePath(file);
      const state: unknown = JSON.parse(readFileSync(file, "utf8"));
      const s = state as { version: number; devices: unknown[] };
      if (s?.version !== 1 || Object.keys(s).some(k => k !== "version" && k !== "devices") || !Array.isArray(s.devices) || !s.devices.every(validateDevice)) throw new Error();
      const devices = s.devices as Device[];
      if (new Set(devices.map(d => d.id)).size !== devices.length || new Set(devices.map(d => d.fingerprint)).size !== devices.length) throw new Error();
      return structuredClone(devices);
    } catch { throw new DeviceError("storage"); }
  }
  /** Re-reads the file before every decision that must not rest on a stale copy. A revocation is never undone: a device
   *  revoked on disk (by another instance) or in memory (not yet flushed) stays revoked, and its live connections close. */
  private sync(): void {
    const disk = this.readDisk(false);
    if (!disk) return;
    const mine = new Map(this.devices.map(d => [d.id, d]));
    const merged = disk.map(d => { const m = mine.get(d.id); return m?.revoked && !d.revoked ? m : d; });
    const ids = new Set(disk.map(d => d.id)); const prints = new Set(disk.map(d => d.fingerprint));
    for (const d of this.devices) if (!ids.has(d.id) && !prints.has(d.fingerprint)) merged.push(d);
    this.devices = merged;
    for (const d of merged) if (d.revoked) this.closeAll(d.id);
  }
  private closeAll(id: string): void {
    const live = this.connections.get(id); this.connections.delete(id);
    for (const close of live ?? []) { try { close(); } catch { /* attempt every connection */ } }
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
    this.checkStorage();
    validatePair(input);
    this.sync();
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
    this.checkStorage();
    const now = this.options.clock();
    for (const [key, expires] of this.challenges) if (expires <= now) this.challenges.delete(key);
    if (this.challenges.size >= 1024) throw new DeviceError("denied");
    const nonce = randomBytes(32);
    this.challenges.set(nonce.toString("hex"), now + 30_000);
    return nonce;
  }
  /** Proves possession before admitting a connection. No claimed device id authenticates a caller. */
  connect(input: { publicKey: string; challenge: Uint8Array; signature: Uint8Array; close: () => void }): () => void {
    this.checkStorage();
    // What a client echoes back is untrusted: wrong types are a refusal, not a TypeError, and spend no challenge.
    if (!input || !(input.challenge instanceof Uint8Array) || !(input.signature instanceof Uint8Array) || typeof input.close !== "function") throw new DeviceError("denied");
    const challenge = Buffer.from(input.challenge).toString("hex");
    const expires = this.challenges.get(challenge);
    this.challenges.delete(challenge);
    if (!expires || expires <= this.options.clock()) throw new DeviceError("denied");
    this.sync();
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
  /** Fail closed: once this is called for a known device, no handshake and no live connection of it survives in this
   *  process, whatever the disk does. If the write fails the revocation still holds here (E_STORAGE is thrown so the
   *  caller knows it is not durable yet); calling revoke() again retries the write. */
  revoke(id: string, actor: string): Device {
    this.checkStorage();
    // An unreadable file must not stop a revocation: it takes effect from memory, and the damaged file is not overwritten.
    let readable = true;
    try { this.sync(); } catch { readable = false; }
    const d = this.get(id);
    if (d.revoked && !this.unflushed) return d;
    const next = d.revoked ? d : { ...d, revoked: true, revokedAt: this.options.clock(), revokedBy: actor };
    const devices = this.devices.map(device => device.id === id ? next : device);
    if (!d.revoked) this.audit("device.revoked", next, actor);
    try { if (!readable) throw new DeviceError("storage"); this.persist(devices); }
    catch (error) {
      // Before the rename nothing durable changed, but the key is blocked here at once. After it, persist() already
      // refused everything and closed every connection.
      if (!this.storageFailed) { this.devices = devices; this.unflushed = true; this.closeAll(id); }
      this.audit("device.revoke.failed", next, actor);
      throw error;
    }
    this.devices = devices;
    this.closeAll(id);
    return structuredClone(next);
  }
  rename(id: string, name: string, actor: string): Device {
    this.checkStorage();
    if (!text(name)) throw new DeviceError("invalid");
    this.sync();
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
  private checkStorage(): void {
    if (this.storageFailed) throw new DeviceError("storage");
  }
  private persist(devices: Device[]): void {
    const file = this.options.file;
    const dir = dirname(file);
    const temp = `${file}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    let renamed = false;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      fd = openSync(temp, "wx", 0o600);
      if (process.platform !== "win32") chmodSync(temp, 0o600);
      this.options.securePath(temp);
      writeFileSync(fd, `${JSON.stringify({ version: 1, devices })}\n`); fsyncSync(fd);
      closeSync(fd); fd = undefined;
      renameSync(temp, file);
      renamed = true;
      if (process.platform !== "win32") {
        const directory = openSync(dir, "r");
        try { fsyncSync(directory); } finally { closeSync(directory); }
      }
      // Every caller derives `devices` from this.devices, so a successful write also carries any unflushed revocation.
      this.unflushed = false;
    } catch {
      // After rename, durability is uncertain: never authenticate against the stale in-memory state.
      if (renamed) {
        this.storageFailed = true;
        const live = [...this.connections.values()].flatMap(callbacks => [...callbacks]);
        this.connections.clear();
        this.challenges.clear();
        for (const close of live) { try { close(); } catch { /* attempt every connection */ } }
      }
      throw new DeviceError("storage");
    }
    finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temp); } catch { /* already renamed / never created */ }
    }
  }
}
