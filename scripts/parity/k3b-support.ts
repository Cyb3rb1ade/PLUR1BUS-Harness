// Shared by the K3b exporters (`export-handoff.ts`, `export-delivery.ts`, `export-inbox.ts`; P4-K K3b, plan P4-22).
//
// RANDOMNESS. `randomBytes` and `randomUUID` of `node:crypto` are replaced for the duration of one build (then
// `syncBuiltinESMExports`; the real functions come back afterwards, other exporters share the process), by wrappers that return *scripted* values: draw number k is the SHA-256 of `draw:k` (truncated to
// the length asked for) and the UUID number k is the first 16 bytes of the SHA-256 of `uuid:k`, formatted as a UUID. A fixture
// never holds a real random draw; the Rust replay feeds the same values through its `Random` and `IdSource` ports. The product
// files stay untouched.
import crypto, { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";

let bytesDraw = 0;
let uuidDraw = 0;
export const scriptedBytes = (k: number, n: number): Buffer => {
  const d = createHash("sha256").update(`draw:${k}`).digest();
  if (n > d.length) throw new Error(`scripted draws hold at most ${d.length} bytes`);
  return d.subarray(0, n);
};
export const scriptedUuid = (k: number): string => {
  const h = createHash("sha256").update(`uuid:${k}`).digest("hex").slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};
/** Installs the scripted draws until `restore()`: the exporters of a process share `node:crypto`, so each build puts the real functions back. */
export function installScriptedRandom(): { reset(): void; restore(): void } {
  const real = { randomBytes: crypto.randomBytes, randomUUID: crypto.randomUUID };
  bytesDraw = 0; uuidDraw = 0;
  (crypto as any).randomBytes = (n: number) => Buffer.from(scriptedBytes(++bytesDraw, n));
  (crypto as any).randomUUID = () => scriptedUuid(++uuidDraw);
  syncBuiltinESMExports();
  return {
    reset() { bytesDraw = 0; uuidDraw = 0; },
    restore() { (crypto as any).randomBytes = real.randomBytes; (crypto as any).randomUUID = real.randomUUID; syncBuiltinESMExports(); },
  };
}

/** What a thrown value looks like in a vector: the RPC error code (`RpcError.error`) when it has one, the class name otherwise, and the message. */
export const errOf = (e: unknown): { code?: string; name?: string; message: string } => {
  const err = e as { error?: unknown; name?: string; message?: string };
  return typeof err?.error === "string" && err.error.startsWith("E_") ? { code: err.error, message: String(err.message) } : { name: err?.name ?? "Error", message: String(err?.message) };
};

/** Every row of the tables, in `rowid` order, as arrays; the columns in `json` are parsed (their member order is not compared). */
export function dumpTables(path: string, tables: Record<string, string[]>): Record<string, unknown[][]> {
  const db = new DatabaseSync(path);
  try {
    const out: Record<string, unknown[][]> = {};
    for (const [t, jsonCols] of Object.entries(tables)) {
      const rows = db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all() as Record<string, unknown>[];
      out[t] = rows.map((r) => Object.entries(r).map(([k, v]) => (jsonCols.includes(k) && typeof v === "string" ? JSON.parse(v) : v)));
    }
    return out;
  } finally { db.close(); }
}

/** `sqlite_master` without SQLite's own rows, in a stable order: what the code that made the file wrote. */
export const schemaOf = (path: string): unknown[] => {
  const db = new DatabaseSync(path);
  try { return db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all(); } finally { db.close(); }
};
