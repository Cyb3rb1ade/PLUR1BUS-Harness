import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DeviceError, type DeviceStore, type DeviceAudit } from "../../../remote-access/src/device-store.ts";

/** Initial desktop scope pending Owner confirmation. Neither role inheritance nor a browser request can widen it. */
export const DESKTOP_SCOPES = Object.freeze(["chat:read", "chat:write", "chat:delete", "agent.list", "agent.read", "agent.use", "sessions.read", "admin.sessions.read", "admin.sessions.write", "admin.sessions.transcript", "models.read", "activity.read", "device.list"]);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
export interface DesktopAttachOptions {
  file: string; devices: DeviceStore; now(): number; audit: DeviceAudit; securePath(file: string): void; personVersion?(id: string): number | null;
}
/** Core-owned, serialized one-use codes and hashed bearer credentials. DeviceStore remains the revocation authority. */
export class DesktopAttach {
  readonly #db: DatabaseSync;
  readonly #o: DesktopAttachOptions;
  constructor(o: DesktopAttachOptions) {
    this.#o = o;
    mkdirSync(dirname(o.file), { recursive: true, mode: 0o700 });
    try { const st = lstatSync(o.file); if (!st.isFile() || st.isSymbolicLink()) throw new DeviceError("storage"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    closeSync(openSync(o.file, "a", 0o600)); o.securePath(o.file);
    this.#db = new DatabaseSync(o.file);
    this.#db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS codes (hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,kind TEXT NOT NULL,person_version INTEGER NOT NULL,expires_at INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS credentials (hash TEXT PRIMARY KEY,device_id TEXT NOT NULL UNIQUE,person_version INTEGER NOT NULL,expires_at INTEGER NOT NULL) STRICT;`);
  }
  issue(userId: string, kind: string) {
    if (kind !== "desktop" || !userId) throw new DeviceError("invalid");
    const version = this.#version(userId);
    const now = this.#o.now();
    this.#db.prepare("DELETE FROM codes WHERE expires_at<=?").run(now);
    if (Number(this.#db.prepare("SELECT COUNT(*) AS n FROM codes").get()?.n) >= 256) throw new DeviceError("denied");
    const code = secret(), expiresAt = now + 600_000;
    this.#audit("device.attach.opened", userId);
    this.#db.prepare("INSERT INTO codes VALUES (?,?,?,?,?)").run(digest(code),userId,kind,version,expiresAt);
    return { code, kind: "desktop" as const, expiresAt, scopes: [...DESKTOP_SCOPES] };
  }
  redeem(code: string, kind: string, name: string, publicKey: string) {
    if (typeof code !== "string" || code.length !== 43 || kind !== "desktop") throw new DeviceError("denied");
    // DELETE RETURNING spends the code atomically, including across process connections. A failed enrolment needs a new code.
    const row = this.#db.prepare("DELETE FROM codes WHERE hash=? AND kind=? AND expires_at>? RETURNING user_id,person_version").get(digest(code),kind,this.#o.now());
    if (!row || this.#version(row.user_id as string) !== row.person_version) throw new DeviceError("denied");
    const device = this.#o.devices.recordPairing({ name, platform:kind,publicKey,pairedBy:row.user_id as string,scope:[...DESKTOP_SCOPES] });
    const token = secret(), expiresAt = this.#o.now() + 30 * 86400_000;
    this.#audit("device.attach.redeemed",device.pairedBy,device.id);
    this.#db.prepare("INSERT INTO credentials VALUES (?,?,?,?)").run(digest(token),device.id,row.person_version as number,expiresAt);
    return { device, token, expiresAt };
  }
  authenticate(token: string) {
    if (typeof token !== "string" || token.length !== 43) throw new DeviceError("denied");
    const row = this.#db.prepare("SELECT device_id FROM credentials WHERE hash=? AND expires_at>?").get(digest(token),this.#o.now());
    if (!row) throw new DeviceError("denied");
    return this.resolve(row.device_id as string);
  }
  resolve(deviceId: string) {
    const row = this.#db.prepare("SELECT expires_at,person_version FROM credentials WHERE device_id=? AND expires_at>?").get(deviceId,this.#o.now());
    const d = this.#o.devices.get(deviceId);
    if (!row || d.revoked || d.platform !== "desktop" || this.#version(d.pairedBy) !== row.person_version) throw new DeviceError("denied");
    return { deviceId:d.id,userId:d.pairedBy,scopes:DESKTOP_SCOPES.filter(s=>d.scope.includes(s)),expiresAt:Number(row.expires_at) };
  }
  #version(id: string): number { const v = this.#o.personVersion ? this.#o.personVersion(id) : 0; if (v === null) throw new DeviceError("denied"); return v; }
  #audit(action: string,user: string,target="desktop") { this.#o.audit.append({at:this.#o.now(),actor:{user,host:"desktop-attach"},action,target,detail:{}}); }
  close() { this.#db.close(); }
}
