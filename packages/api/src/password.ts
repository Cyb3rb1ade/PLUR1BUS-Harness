import { argon2, randomBytes, timingSafeEqual } from "node:crypto";

/** Argon2id parameters of the web login. ADR-007 defers them to ADR-005, which does not state any; these are the OWASP
 *  Password Storage Cheat Sheet minimum for Argon2id (19 MiB, 2 passes, 1 lane) and are a decision to confirm.
 *  `node:crypto`'s argon2 (Node >= 24.7) needs no dependency; it runs on the thread pool, not the event loop. */
export interface Argon2Params { memoryKiB: number; passes: number; parallelism: number }
export const ARGON2_PARAMS: Readonly<Argon2Params> = Object.freeze({ memoryKiB: 19_456, passes: 2, parallelism: 1 });

const SALT_BYTES = 16; const TAG_BYTES = 32;
/** A stored hash is trusted only inside these bounds, so a corrupted or planted record cannot make a login allocate gigabytes. */
const BOUNDS = { memoryKiB: [8_192, 262_144], passes: [1, 10], parallelism: [1, 4] } as const;
export const MAX_PASSWORD_BYTES = 1024;

const inBounds = (v: number, [lo, hi]: readonly [number, number]) => Number.isInteger(v) && v >= lo && v <= hi;

export interface Phc extends Argon2Params { salt: Buffer; tag: Buffer }

/** Parses `$argon2id$v=19$m=…,t=…,p=…$salt$tag` (unpadded base64); `undefined` for anything else or out of bounds. */
export function parsePhc(s: unknown): Phc | undefined {
  if (typeof s !== "string" || s.length > 300) return undefined;
  const m = /^\$argon2id\$v=19\$m=(\d{1,9}),t=(\d{1,3}),p=(\d{1,3})\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(s);
  if (!m) return undefined;
  const memoryKiB = Number(m[1]); const passes = Number(m[2]); const parallelism = Number(m[3]);
  if (!inBounds(memoryKiB, BOUNDS.memoryKiB) || !inBounds(passes, BOUNDS.passes) || !inBounds(parallelism, BOUNDS.parallelism)) return undefined;
  const salt = Buffer.from(m[4]!, "base64"); const tag = Buffer.from(m[5]!, "base64");
  if (salt.length !== SALT_BYTES || tag.length !== TAG_BYTES) return undefined;
  return { memoryKiB, passes, parallelism, salt, tag };
}

function derive(password: string, salt: Buffer, p: Argon2Params): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2("argon2id", { message: password, nonce: salt, memory: p.memoryKiB, passes: p.passes, parallelism: p.parallelism, tagLength: TAG_BYTES }, (e, key) => (e ? reject(e) : resolve(key)));
  });
}

const b64 = (b: Buffer) => b.toString("base64").replace(/=+$/, "");

export async function hashPassword(password: string, params: Argon2Params = ARGON2_PARAMS): Promise<string> {
  if (typeof password !== "string" || Buffer.byteLength(password) > MAX_PASSWORD_BYTES) throw new Error("password too long");
  const salt = randomBytes(SALT_BYTES);
  const tag = await derive(password, salt, params);
  return `$argon2id$v=19$m=${params.memoryKiB},t=${params.passes},p=${params.parallelism}$${b64(salt)}$${b64(tag)}`;
}

/** Constant-time comparison of the derived tag; false (never a throw) for a bad password type, an oversized password or a hostile hash. */
export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const phc = parsePhc(stored);
  if (!phc || typeof password !== "string" || password === "" || Buffer.byteLength(password) > MAX_PASSWORD_BYTES) return false;
  try { return timingSafeEqual(await derive(password, phc.salt, phc), phc.tag); } catch { return false; }
}

/** True when the record was made with other parameters than `current` (or cannot be read): rehash after the next good login. */
export function needsRehash(stored: string, current: Argon2Params = ARGON2_PARAMS): boolean {
  const p = parsePhc(stored);
  return !p || p.memoryKiB !== current.memoryKiB || p.passes !== current.passes || p.parallelism !== current.parallelism;
}
