import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { peerKeyFingerprint, type PeerPublicKey } from "./peer-card.ts";
import { A2aPeerError } from "./peer-error.ts";

export interface A2aPeer {
  id: string; agentId: string; cardUrl: string; kid: string; fingerprint: string;
  targetKind: "external"; origin: "a2a"; state: "pending" | "trusted"; revision: string;
  createdAt: number; updatedAt: number; endpoint?: string; authenticated: boolean;
}
export interface StoredA2aPeer extends A2aPeer { publicKey: PeerPublicKey; credentialSecret?: string }
export interface AddA2aPeer { id: string; cardUrl: string; kid: string; publicKey: unknown; credentialSecret?: string }
interface PeerRow {
  id: string; card_url: string; kid: string; fingerprint: string; public_key: string; credential_secret: string | null;
  state: "pending" | "trusted"; revision: string; endpoint: string | null; created_at: number; updated_at: number;
}

export function peerId(id: unknown): string {
  if (typeof id !== "string" || !/^[a-z][a-z0-9._-]{0,63}$/.test(id)) throw new A2aPeerError("invalid-peer");
  return id;
}
export function peerUrl(raw: unknown): URL {
  try {
    if (typeof raw !== "string" || raw.length > 2048) throw new Error();
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error();
    return url;
  } catch { throw new A2aPeerError("invalid-peer"); }
}
const publicView = ({ publicKey: _key, credentialSecret: _secret, ...peer }: StoredA2aPeer): A2aPeer => peer;
const fromRow = (r: PeerRow): StoredA2aPeer => ({
  id: r.id, agentId: `a2a:${r.id}`, cardUrl: r.card_url, kid: r.kid, fingerprint: r.fingerprint,
  targetKind: "external", origin: "a2a", state: r.state, revision: r.revision, createdAt: r.created_at, updatedAt: r.updated_at,
  ...(r.endpoint ? { endpoint: r.endpoint } : {}), authenticated: r.credential_secret !== null,
  publicKey: JSON.parse(r.public_key) as PeerPublicKey, ...(r.credential_secret ? { credentialSecret: r.credential_secret } : {}),
});

/** Private pin registry. A replacement always needs remove/add and a new explicit trust decision. */
export class A2aPeerStore {
  readonly #db: DatabaseSync;
  readonly #now: () => number;
  readonly #maxPeers: number;
  #closed = false;

  constructor(options: { path: string; now: () => number; maxPeers?: number }) {
    this.#now = options.now;
    this.#maxPeers = options.maxPeers ?? 64;
    if (!Number.isSafeInteger(this.#maxPeers) || this.#maxPeers < 1 || this.#maxPeers > 1024) throw new A2aPeerError("invalid-peer");
    let db: DatabaseSync | undefined;
    try {
      mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
      const fd = openSync(options.path, constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || (process.platform !== "win32" && stat.uid !== process.getuid?.())) throw new Error();
        if (process.platform !== "win32") fchmodSync(fd, 0o600);
      } finally { closeSync(fd); }
      db = new DatabaseSync(options.path);
      if (Number(db.prepare("PRAGMA user_version").get()?.user_version) > 1) throw new Error();
      db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      db.exec(`CREATE TABLE IF NOT EXISTS peers (
        id TEXT PRIMARY KEY, card_url TEXT NOT NULL, kid TEXT NOT NULL, fingerprint TEXT NOT NULL,
        public_key TEXT NOT NULL, credential_secret TEXT, state TEXT NOT NULL CHECK(state IN ('pending','trusted')),
        revision TEXT NOT NULL, endpoint TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      ); PRAGMA user_version=1;`);
      this.#db = db;
    } catch { try { db?.close(); } catch {} throw new A2aPeerError("unavailable"); }
  }

  #run<T>(fn: () => T): T {
    if (this.#closed) throw new A2aPeerError("unavailable");
    try { return fn(); }
    catch (error) { throw error instanceof A2aPeerError ? error : new A2aPeerError("unavailable"); }
  }
  #write<T>(fn: () => T): T {
    return this.#run(() => {
      this.#db.exec("BEGIN IMMEDIATE");
      try { const result = fn(); this.#db.exec("COMMIT"); return result; }
      catch (error) { this.#db.exec("ROLLBACK"); throw error; }
    });
  }

  get(id: string): StoredA2aPeer | null {
    peerId(id);
    return this.#run(() => {
      const row = this.#db.prepare("SELECT * FROM peers WHERE id=?").get(id) as PeerRow | undefined;
      return row ? fromRow(row) : null;
    });
  }
  list(): A2aPeer[] {
    return this.#run(() => (this.#db.prepare("SELECT * FROM peers ORDER BY id").all() as unknown as PeerRow[]).map(r => publicView(fromRow(r))));
  }
  add(input: AddA2aPeer, maxPeers = this.#maxPeers): A2aPeer {
    const id = peerId(input.id), cardUrl = peerUrl(input.cardUrl).toString(), fingerprint = peerKeyFingerprint(input.publicKey);
    if (typeof input.kid !== "string" || !input.kid || input.kid.length > 128 || /[\u0000-\u001f\u007f]/.test(input.kid)) throw new A2aPeerError("invalid-peer");
    if (input.credentialSecret !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/.test(input.credentialSecret)) throw new A2aPeerError("invalid-peer");
    const key: PeerPublicKey = { kty: "OKP", crv: "Ed25519", x: (input.publicKey as PeerPublicKey).x };
    return this.#write(() => {
      if (this.get(id)) throw new A2aPeerError("peer-exists");
      if (!Number.isSafeInteger(maxPeers) || maxPeers < 1 || Number(this.#db.prepare("SELECT COUNT(*) AS n FROM peers").get()!.n) >= Math.min(maxPeers, this.#maxPeers)) throw new A2aPeerError("invalid-peer");
      const now = this.#now();
      this.#db.prepare("INSERT INTO peers VALUES (?,?,?,?,?,?,'pending',?,NULL,?,?)")
        .run(id, cardUrl, input.kid, fingerprint, JSON.stringify(key), input.credentialSecret ?? null, randomUUID(), now, now);
      return publicView(this.get(id)!);
    });
  }
  trust(id: string, fingerprint: string, revision: string, endpoint: string): A2aPeer {
    return this.#write(() => {
      const peer = this.get(id);
      if (!peer || peer.revision !== revision) throw new A2aPeerError("peer-revoked");
      if (peer.fingerprint !== fingerprint) throw new A2aPeerError("peer-untrusted");
      const url = peerUrl(endpoint);
      if (url.origin !== peerUrl(peer.cardUrl).origin) throw new A2aPeerError("card-signature");
      if (peer.state === "trusted" && peer.endpoint === url.toString()) return publicView(peer);
      this.#db.prepare("UPDATE peers SET state='trusted', endpoint=?, revision=?, updated_at=? WHERE id=?")
        .run(url.toString(), randomUUID(), this.#now(), id);
      return publicView(this.get(id)!);
    });
  }
  remove(id: string): boolean {
    peerId(id);
    return this.#write(() => Number(this.#db.prepare("DELETE FROM peers WHERE id=?").run(id).changes) > 0);
  }
  close(): void { if (!this.#closed) { this.#closed = true; this.#db.close(); } }
}
