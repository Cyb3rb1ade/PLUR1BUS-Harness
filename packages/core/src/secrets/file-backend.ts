import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import type { SecurePath } from "@plur1bus/module-api";
import { SecretError, backendFailure, isSecretName, type BackendProbe, type SecretBackend, type SecretMeta } from "./types.ts";

export const FILE_SCHEMA = "plur1bus.secrets-file/1";
const KEY_BYTES = 32;
const NONCE_BYTES = 12; // GCM's native 96-bit nonce, fresh random per write of an entry
const TAG_BYTES = 16;

interface Entry { createdAt: string; updatedAt: string; nonce: string; ct: string; tag: string }
interface Doc { schema: typeof FILE_SCHEMA; entries: Record<string, Entry> }

export interface FileBackendOptions {
  /** `<home>/state/secrets`. */
  dir: string;
  /** The core's `securePath` (chmod 0600 on POSIX, a protected user + SYSTEM DACL on Windows). */
  secure: SecurePath;
  /** Test seams. */
  random?: (n: number) => Buffer;
  rename?: (from: string, to: string) => void;
}

const corrupt = (why: string, name?: string): SecretError =>
  new SecretError("corrupt", `encrypted secret store is corrupt (${why}); refusing to continue`, name === undefined ? { why } : { why, name });

/**
 * ADR-005's headless fallback (ruling R1, B19): AES-256-GCM with a machine-bound key file next to the store. Each entry
 * has its own random nonce, and its AAD binds the schema id and the entry's name, so a ciphertext moved to another name
 * does not decrypt. Every failure to authenticate is `corrupt`: nothing partial or empty is ever returned, and the key
 * is never regenerated over existing entries (that would silently orphan them).
 * What this does not defend: anyone who can read both files as this user (the same boundary as the keyring on an
 * unlocked session), and whole-entry rollback to an older valid copy.
 */
export function createFileBackend(o: FileBackendOptions): SecretBackend {
  const storePath = path.join(o.dir, "store.json");
  const keyPath = path.join(o.dir, "store.key");
  const rand = o.random ?? randomBytes;
  const rename = o.rename ?? renameSync;
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => T): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };

  const ensureDir = (): void => {
    mkdirSync(o.dir, { recursive: true, mode: 0o700 });
    o.secure(o.dir, { mode: 0o700 });
  };

  function readDoc(): Doc {
    if (!existsSync(storePath)) return { schema: FILE_SCHEMA, entries: {} };
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(storePath, "utf8")); } catch { throw corrupt("unreadable-store"); }
    const d = raw as Partial<Doc> | null;
    if (!d || typeof d !== "object" || d.schema !== FILE_SCHEMA || !d.entries || typeof d.entries !== "object" || Array.isArray(d.entries)) throw corrupt("bad-schema");
    for (const [name, e] of Object.entries(d.entries)) {
      const x = e as Partial<Entry>;
      if (!isSecretName(name) || typeof x?.createdAt !== "string" || typeof x.updatedAt !== "string" || typeof x.nonce !== "string" || typeof x.ct !== "string" || typeof x.tag !== "string") throw corrupt("bad-entry", name);
    }
    return d as Doc;
  }

  function readKey(): Buffer | null {
    if (!existsSync(keyPath)) return null;
    const key = Buffer.from(readFileSync(keyPath, "utf8").trim(), "base64");
    if (key.length !== KEY_BYTES) throw corrupt("bad-key");
    return key;
  }

  /** Reads the key; creates it only when there is nothing yet to orphan. */
  function key(doc: Doc, create: boolean): Buffer {
    const k = readKey();
    if (k) return k;
    if (Object.keys(doc.entries).length > 0 || !create) throw corrupt("key-missing");
    ensureDir();
    const fresh = rand(KEY_BYTES);
    let fd: number | null = null;
    try {
      fd = openSync(keyPath, "wx", 0o600);
      o.secure(keyPath); // before any key byte is written
      writeSync(fd, `${fresh.toString("base64")}\n`);
      fsyncSync(fd);
    } catch (err) {
      if (fd !== null) { closeSync(fd); fd = null; rmSync(keyPath, { force: true }); }
      throw backendFailure(err, "creating the key file");
    } finally { if (fd !== null) closeSync(fd); }
    return fresh;
  }

  function writeDoc(doc: Doc): void {
    ensureDir();
    const tmp = path.join(o.dir, `store.json.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    let fd: number | null = null;
    try {
      fd = openSync(tmp, "wx", 0o600);
      o.secure(tmp); // restricted before any content exists
      writeSync(fd, JSON.stringify(doc));
      fsyncSync(fd);
      closeSync(fd); fd = null;
      rename(tmp, storePath);
    } catch (err) {
      if (fd !== null) closeSync(fd);
      rmSync(tmp, { force: true });
      throw backendFailure(err, "writing the encrypted store");
    }
    o.secure(storePath);
  }

  const aad = (name: string): Buffer => Buffer.from(`${FILE_SCHEMA}\u0000${name}`, "utf8");

  return {
    kind: "file",
    async probe(): Promise<BackendProbe> {
      try {
        ensureDir();
        readDoc();
        return { available: true };
      } catch (err) {
        return { available: false, reason: err instanceof SecretError ? err.code : "dir-not-writable" };
      }
    },
    get: (name) => serial(() => {
      const doc = readDoc();
      const e = doc.entries[name];
      if (!e) return null;
      const k = key(doc, false);
      try {
        const nonce = Buffer.from(e.nonce, "base64"); const tag = Buffer.from(e.tag, "base64");
        if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) throw new Error("shape");
        const d = createDecipheriv("aes-256-gcm", k, nonce);
        d.setAAD(aad(name)); d.setAuthTag(tag);
        return Buffer.concat([d.update(Buffer.from(e.ct, "base64")), d.final()]).toString("utf8");
      } catch { throw corrupt("authentication-failed", name); }
    }),
    put: (name, value, now) => serial(() => {
      const doc = readDoc();
      const k = key(doc, true);
      const nonce = rand(NONCE_BYTES);
      const c = createCipheriv("aes-256-gcm", k, nonce);
      c.setAAD(aad(name));
      const ct = Buffer.concat([c.update(Buffer.from(value, "utf8")), c.final()]);
      const at = now.toISOString();
      const createdAt = doc.entries[name]?.createdAt ?? at;
      doc.entries[name] = { createdAt, updatedAt: at, nonce: nonce.toString("base64"), ct: ct.toString("base64"), tag: c.getAuthTag().toString("base64") };
      writeDoc(doc);
      return { name, backend: "file" as const, createdAt, updatedAt: at };
    }),
    delete: (name) => serial(() => {
      const doc = readDoc();
      if (!(name in doc.entries)) return false;
      delete doc.entries[name];
      writeDoc(doc);
      return true;
    }),
    list: () => serial((): SecretMeta[] =>
      Object.entries(readDoc().entries).map(([name, e]) => ({ name, backend: "file" as const, createdAt: e.createdAt, updatedAt: e.updatedAt })).sort((a, b) => a.name.localeCompare(b.name))),
  };
}
