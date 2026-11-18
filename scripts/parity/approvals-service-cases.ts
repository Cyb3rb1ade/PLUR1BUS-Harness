// Service-level parity vectors (mode V) for review B of P4-K K3a: the real `createApprovalService` over a real approvals
// database, every operation recorded with its answer, its audit lines, its events and the rows the file holds afterwards.
// The replay in `crates/plur1bus-core/src/approvals/vectors_service.rs` runs the same operations on the Rust service and
// must give the same record. Imported by `export-approvals.ts`; never run on its own.
//
// Two tables:
// - `regex`: the inputs each regular expression of `approvals/` and `grants/` sees through the product code: the directory
//   of a path target (`parentOf`), the flattened name of a recurring job, with line terminators, Unicode spaces, empty and
//   very long inputs (RB-2).
// - `cells`: one file per case, built by the product code, then one column of one row given a value of a foreign storage
//   class (a blob, a non-numeric text, a fraction, a null where the column allows one), then every public operation
//   (RB-3). The SQL is recorded; the base rows are recorded once and loaded into each case's file.
//
// Random draws (approval ids and nonces, grant ids) are recorded as hex beside the operation that drew them (`rand`); the
// replay hands them to its random port in the same order.
import crypto, { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openApprovalsDb } from "../../packages/core/src/approvals/db.ts";
import { staticKeySource } from "../../packages/core/src/approvals/keys.ts";
import { loadDecisionSigner } from "../../packages/core/src/approvals/signing.ts";
import { createApprovalStore } from "../../packages/core/src/approvals/store.ts";
import { createApprovalService } from "../../packages/core/src/approvals/service.ts";
import { GrantStore } from "../../packages/core/src/grants/store.ts";
import { canonicalJson } from "../../packages/core/src/tools/dispatcher.ts";

export const SVC_NOW = Date.UTC(2026, 10, 18, 9, 0, 0);
const HOME = "/home/vector-user";
const KEY = createHash("sha256").update("p4-k review b service: chain key").digest();
const SIGNING = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), createHash("sha256").update("p4-k review b service: signing key").digest()]);
const parts = (text: string): { parts: string[] } => {
  const n = Math.ceil(text.length / 4);
  return { parts: [0, 1, 2, 3].map((i) => text.slice(i * n, (i + 1) * n)) };
};

const TABLES = ["approval_chain", "chain_head", "approvals", "grants", "approval_signatures"] as const;

/** Every row as SQLite's `quote()` spells it: storage class and bytes, so a blob is told from a text. */
function dump(db: DatabaseSync): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const t of TABLES) {
    const cols = (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    out[t] = (db.prepare(`SELECT ${cols.map((c) => `quote(${c})`).join(" || '|' || ")} AS l FROM ${t} ORDER BY rowid`).all() as { l: string }[]).map((x) => x.l);
  }
  return out;
}

/** The rows of every table as values (`SELECT *`), to load into another file; at the time they are taken they hold only texts, integers and nulls. */
function rowsOf(db: DatabaseSync): Record<string, Record<string, unknown>[]> {
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const t of TABLES) out[t] = db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all().map((r) => ({ ...r }));
  return out;
}

function load(db: DatabaseSync, rows: Record<string, Record<string, unknown>[]>): void {
  for (const t of TABLES) {
    for (const r of rows[t]!) {
      const cols = Object.keys(r);
      db.prepare(`INSERT INTO ${t} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...(cols.map((c) => r[c]) as never[]));
    }
  }
}

/** JSON of a value the way a vector holds it (a `Uint8Array` becomes `{ "0": .., "1": .. }`, as `JSON.stringify` writes it). */
const plain = (v: unknown): unknown => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

const hexOf = (id: string): string => id.replace(/^(apr_|grt_)/, "");

/**
 * Runs `f` with the process's randomness fixed: `crypto.randomBytes` (approval ids and nonces), `Math.random` and
 * `process.pid` (a grant id the service creates hashes both) draw from a stream seeded by `label`. Without this a vector
 * would differ on every run and `--check` could not hold; with it, every case of a table draws the same ids, so a case
 * records only what differs from its reference. Test tooling only: the product code is the code that runs.
 */
let draws: string[] = [];

async function deterministic<T>(label: string, f: () => Promise<T>): Promise<T> {
  const original = { randomBytes: crypto.randomBytes, random: Math.random, pid: Object.getOwnPropertyDescriptor(process, "pid")! };
  let counter = 0;
  const next = (): Buffer => createHash("sha256").update(`${label} ${counter++}`).digest();
  crypto.randomBytes = ((n: number) => {
    const out: Buffer[] = [];
    for (let k = 0; k < n; k += 32) out.push(next());
    const bytes = Buffer.concat(out).subarray(0, n);
    draws.push(bytes.toString("hex"));
    return bytes;
  }) as typeof crypto.randomBytes;
  syncBuiltinESMExports();
  Math.random = () => next().readUInt32BE(0) / 2 ** 32;
  Object.defineProperty(process, "pid", { value: 4242, configurable: true, writable: false });
  try {
    return await f();
  } finally {
    crypto.randomBytes = original.randomBytes;
    syncBuiltinESMExports();
    Math.random = original.random;
    Object.defineProperty(process, "pid", original.pid);
  }
}

interface Session {
  store: Awaited<ReturnType<typeof createApprovalStore>>;
  db: DatabaseSync;
  raw: DatabaseSync;
  ops: Record<string, unknown>[];
  clock: { t: number; now(): number };
  /** Request id -> what the replay needs to refer to it. */
  pending: Map<string, AbortController>;
  run(op: string, input: Record<string, unknown>, f: () => unknown): Promise<unknown>;
  request(ask: Record<string, unknown>): Promise<{ id: string; nonce: string } | undefined>;
  svc: ReturnType<typeof createApprovalService>;
  grants: GrantStore;
  close(): void;
}

const thrown = (e: any): unknown => (e?.name === "ApprovalChainError" || e?.name === "ApprovalIntegrityError" || e?.code === "chain-broken")
  ? { throw: "integrity", brokenAt: e.brokenAt, reason: e.reason }
  : e?.name === "GrantError" ? { throw: "grant", code: e.code, msg: String(e.message) } : { throw: "other" };

async function openSession(path: string, base?: Record<string, Record<string, unknown>[]>): Promise<Session> {
  const db = openApprovalsDb({ path });
  if (base) load(db, base);
  const clock = { t: SVC_NOW, now(): number { return this.t; } };
  let log: { audit: unknown[]; events: unknown[]; answers: unknown[] } = { audit: [], events: [], answers: [] };
  const audit = { record(action: string, fields: unknown): void { log.audit.push([action, plain(fields)]); } };
  const events = { emit(name: string, payload: unknown): void { log.events.push([name, plain(payload)]); } };
  const timers = { set(_fn: () => void, _ms: number): () => void { return () => {}; } };
  const signer = await loadDecisionSigner({ load: async () => Uint8Array.from(SIGNING) });
  const approvals = await createApprovalStore({ db, keys: staticKeySource(KEY), clock, signer });
  const grants = new GrantStore({ db, chain: approvals.chain, clock, audit: audit as never, home: HOME });
  const svc = createApprovalService({ stores: { db, approvals, grants }, clock, timers, events: events as never, audit: audit as never, redactor: { text: (s: string) => s, value: <V,>(v: V) => v } as never });
  const raw = new DatabaseSync(path);
  const ops: Record<string, unknown>[] = [];
  const pending = new Map<string, AbortController>();
  const ans = (a: any): unknown => ({ approved: a.approved === true, parked: a.parked === true, requestId: a.requestId ?? null, reason: a.reason ?? null, scope: a.scope ?? null, grantIds: a.grantIds ?? [] });
  const s: Session = {
    store: approvals, db, raw, ops, clock, pending, svc, grants,
    async run(op, input, f) {
      log = { audit: [], events: [], answers: [] };
      draws = [];
      let out: unknown;
      try { out = f(); } catch (e) { out = thrown(e); }
      await new Promise((res) => setImmediate(res));
      // K3-D2 (known, recorded elsewhere) would carry a view of a rolled-back write into the next operation: drop the cache.
      approvals.chain.setSigner(signer);
      const rec: Record<string, unknown> = { op, in: input, out: plain(out), audit: log.audit, events: log.events, answers: log.answers, now: clock.t };
      // Every draw of `randomBytes`, in order, then the ids of the grants the service created (TypeScript hashes those).
      const rand: string[] = [...draws];
      for (const [action, fields] of log.audit as [string, any][]) if (action === "grant.created" && typeof fields.grantId === "string" && !(input as any).id) rand.push(hexOf(fields.grantId));
      if (rand.length > 0) rec.rand = rand;
      ops.push(rec);
      return out;
    },
    async request(ask) {
      const ctrl = new AbortController();
      const a = { ...ask, canonical: canonicalJson(ask.args) };
      const { canonical: _c, ...rest } = a;
      let made: { id: string; nonce: string } | undefined;
      await s.run("request", { ask: a }, () => {
        void svc.request({ ...rest, signal: ctrl.signal } as never).then((x) => { log.answers.push(ans(x)); });
        return null;
      });
      const ev = (ops[ops.length - 1]!.events as [string, any][]).find((e) => e[0] === "approval.requested");
      if (ev) { made = { id: ev[1].approval.id, nonce: ev[1].nonce }; pending.set(made.id, ctrl); }
      return made;
    },
    // `dispose` answers every waiter; those answers belong to no recorded operation.
    close() { log = { audit: [], events: [], answers: [] }; svc.dispose(); raw.close(); db.close(); },
  };
  return s;
}

const ASK = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  request: { capability: "fs.write", effect: "local-write", risk: "low", reversible: true, flags: {}, requiredSurface: 1, originSurface: 1,
    grantOptions: [{ scope: "once", requiredSurface: 1 }, { scope: "task", requiredSurface: 1 }, { scope: "session", requiredSurface: 1 }], tainted: false, taintSuspended: false, actionHash: "h0" },
  callId: "call0", tool: "fs.write", args: { a: 1 }, agentId: "bernd", principal: "christian", sessionId: "s1", taskId: "t1", park: false, access: "write", ...o,
});

function tempPath(): { path: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "p1b-apr-svc-"));
  return { path: join(dir, "approvals.sqlite"), dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

// ---- RB-2: the regular expressions, through the product code ----

const LONG = "d".repeat(2000);
/** Directory parts: every character JavaScript's `.` refuses, the Unicode spaces `\s` takes, and plain ones. */
const DIRS = ["d", "d\n", "\nd", "d\r", "d\r\n", "\u2028", "d\u2028e", "d\u2029", "\u0085", "\u000b", "\u000c", "\t", " ", "\u00a0", "\u1680", "\u2000", "\u200a", "\u202f",
  "\u205f", "\u3000", "\ufeff", "\u180e", "\u200b", "\ud83d\ude00"];

/** Every target: a separator before and after, the directory part in the middle or at the root, a drive, and degenerate forms. */
function targets(): string[] {
  const out: string[] = [];
  for (const d of DIRS) out.push(`/work/${d}/f`, `/work/${d}`, `C:\\${d}\\f`, `${d}/f`);
  out.push("", "/", "//", "/f", "f", "\\", "\\f", "C:\\f", "C:/f", "c:\\x\\f", "1:\\x\\f", "CC:\\x\\f", "/work/f/", "/work/f\\", "/work\\f", "\\\\srv\\share\\f",
    "/work/\nf", "/work/f\n", "/work/\u2028", `/${LONG}`, `/${LONG}/f`, `/work/${LONG}\n/f`);
  return out;
}

const JOB_NAMES = ["", " ", "nightly", " nightly ", "\ufeffnightly\ufeff", "\u0085nightly\u0085", "\u180enightly", "a\u0000\u001fb", "a\u007f\u009fb", "a\u00a0b", "a\u200b\u200fb",
  "a\u2028\u202eb", "a\u2066\u2069b", "a\u2065b", "a\u206ab", "a\u2027b", "a\u202fb", " \u3000x\u3000 ", "\u2028 \u2029", "\ud83d\ude00".repeat(60), "x".repeat(200), "\t\n\r\u000b\u000cy"];

// ---- RB-5: a stored detail of another shape than `detailOf` writes ----

const DETAIL = { tool: "fs.write", effect: "local-write", risk: "low", reversible: true, flags: {}, requiredSurface: 1, originSurface: 1,
  grantOptions: [{ scope: "once", requiredSurface: 1 }, { scope: "task", requiredSurface: 1 }, { scope: "session", requiredSurface: 1 }],
  tainted: false, taintSuspended: false, agentId: "bernd", callId: "c", taskId: "t1", sessionId: "s1", targetsMasked: false };
const T = ["/work/a/f"];
const DETAILS: [string, Record<string, unknown>][] = [
  ["no targets", {}], ["targets null", { targets: null }], ["targets a number", { targets: 7 }], ["targets an empty string", { targets: "" }],
  ["targets a string", { targets: "/work/a/f" }], ["targets an object of length 0", { targets: { length: 0 } }], ["targets an object", { targets: { a: 1 } }],
  ["targets a number, masked", { targets: 7, targetsMasked: true }], ["a number among the targets", { targets: ["/work/a/f", 7] }],
  ["an array among the targets", { targets: [["/work/b/f", "x"]] }], ["null among the targets", { targets: [null] }], ["an object among the targets", { targets: [{}] }],
  ["true among the targets", { targets: [true] }], ["taskId a number", { targets: T, taskId: 7 }], ["sessionId null", { targets: T, sessionId: null }],
  ["access a number", { targets: T, access: 7 }], ["access read", { targets: T, access: "read" }], ["flags a string", { targets: T, flags: "x" }],
  ["grantOptions an object", { targets: T, grantOptions: {} }], ["risk a number", { targets: T, risk: 1 }],
];

async function detailOps(s: Session, from: number): Promise<void> {
  let n = from;
  for (const [, over] of DETAILS) {
    for (const scope of ["task", "session"]) {
      n += 1;
      s.clock.t = SVC_NOW + n * 1000;
      const input = { actionHash: `hd${n}`, principal: "christian", subject: { kind: "agent", id: "bernd" }, turnId: "turn", taskId: "t1", sessionId: "s1", capability: "fs.write", detail: { ...DETAIL, ...over } };
      const made = await s.run("storeRequest", input, () => s.store.request(input as never)) as { id?: string } | undefined;
      if (!made?.id) continue;
      const d = { requestId: made.id, decision: "approve", person: "christian", surface: 3, scope };
      await s.run("decideForSession", d, () => { const r: any = s.svc.decideForSession(d as never); return r.ok ? { ok: true, approved: r.status === "approved", scope: r.scope ?? null, grantIds: r.grantIds } : r; });
    }
  }
}

export async function regexVectors() {
  return deterministic("p4-k review b: regex", regexBody);
}

async function regexBody() {
  const { path, dispose } = tempPath();
  try {
    const s = await openSession(path);
    let n = 0;
    for (const t of targets()) {
      n += 1;
      s.clock.t = SVC_NOW + n * 1000;
      const made = await s.request(ASK({ callId: `c${n}`, targets: [t], request: { ...(ASK().request as object), actionHash: `h${n}` } }));
      if (!made) continue;
      await s.run("decideForSession", { requestId: made.id, decision: "approve", person: "christian", surface: 3, scope: "session" },
        () => { const r: any = s.svc.decideForSession({ requestId: made.id, decision: "approve", person: "christian", surface: 3, scope: "session" }); return r.ok ? { ok: true, approved: r.status === "approved", scope: r.scope ?? null, grantIds: r.grantIds } : r; });
    }
    for (const name of JOB_NAMES) {
      n += 1;
      s.clock.t = SVC_NOW + n * 1000;
      const made = await s.request(ASK({ callId: `c${n}`, recurring: { jobId: "j1", jobName: name }, request: { ...(ASK().request as object), actionHash: `h${n}` } }));
      if (made) await s.run("cancel", { requestId: made.id, person: "christian" }, () => s.svc.cancel({ requestId: made.id, person: "christian" }));
    }
    await detailOps(s, n);
    // H-4: a held grant without a task id against a handoff whose task id is null, absent, or a task.
    s.clock.t = SVC_NOW + 1_000_000;
    const held = { id: "grt_held", capability: "fs.read", person: "christian", agent: "bernd", scope: "always", match: { kind: "capability" }, createdBy: "christian", surface: 3, delegable: true };
    await s.run("gcreate", held, () => s.grants.create(held as never));
    for (const handoff of [{ taskId: null }, {}, { taskId: "t1" }]) {
      const base = { handoff: { ...handoff, scope: [], approvalsHeld: ["grt_held", "grt_unknown"] } };
      const ctx = { principal: "christian", agentId: "bernd", taskId: "t1", sessionId: "s1" };
      await s.run("policyContext", { ctx, base }, () => { const o: any = s.svc.policyContext(() => JSON.parse(JSON.stringify(base)))(ctx as never); return { held: o.handoff?.approvalsHeld ?? null }; });
    }
    // H-1: every call still waiting ends at `dispose`, in the order the requests came.
    await s.run("dispose", {}, () => { s.svc.dispose(); return null; });
    const out = { now: SVC_NOW, home: HOME, key: parts(KEY.toString("hex")), signing: parts(SIGNING.toString("base64")), ops: s.ops, grants: dump(s.raw).grants };
    s.close();
    return out;
  } finally { dispose(); }
}

// ---- RB-3: one cell of a foreign storage class, then every public operation ----

interface Base { rows: Record<string, Record<string, unknown>[]>; a: { id: string; nonce: string }; b: { id: string; nonce: string }; aGrants: string[]; seq: Record<string, number> }

async function base(): Promise<Base> {
  const { path, dispose } = tempPath();
  try {
    const s = await openSession(path);
    s.grants.create({ id: "grt_cap", capability: "fs.read", person: "christian", agent: "bernd", scope: "always", match: { kind: "capability" }, createdBy: "christian", surface: 3 });
    s.grants.create({ id: "grt_path", capability: "fs.write", person: "christian", agent: "bernd", scope: "session", sessionId: "s1", match: { kind: "path", path: "/work/proj", access: "write", recursive: true }, createdBy: "christian", surface: 2, effect: "local-write" });
    s.grants.create({ id: "grt_task", capability: "fs.read", person: "christian", agent: "bernd", scope: "task", taskId: "t1", match: { kind: "path", path: "/work/notes", access: "read", recursive: false }, createdBy: "christian", surface: 2, expiresAt: SVC_NOW + 3_600_000 });
    s.clock.t += 1;
    const a = (await s.request(ASK({ callId: "ca", targets: ["/work/proj/a.txt"], request: { ...(ASK().request as object), actionHash: "ha" } })))!;
    s.clock.t += 1;
    const ra: any = s.svc.decideForSession({ requestId: a.id, decision: "approve", person: "christian", surface: 3, scope: "once" });
    s.clock.t += 1;
    const b = (await s.request(ASK({ callId: "cb", request: { ...(ASK().request as object), actionHash: "hb" } })))!;
    s.clock.t += 1;
    const c = (await s.request(ASK({ callId: "cc", request: { ...(ASK().request as object), actionHash: "hc" } })))!;
    s.clock.t += 1;
    s.svc.decideForSession({ requestId: c.id, decision: "deny", person: "christian", surface: 3 });
    const q = (sql: string): number => Number((s.raw.prepare(sql).get() as { n: number }).n);
    const seq = {
      first: 1,
      second: 2,
      decided: q(`SELECT seq AS n FROM approval_chain WHERE kind = 'approval.decided' AND ref_id = '${a.id}'`),
      requested: q(`SELECT seq AS n FROM approval_chain WHERE kind = 'approval.requested' AND ref_id = '${a.id}'`),
      last: q("SELECT max(seq) AS n FROM approval_chain"),
    };
    // Close before the rows are taken: the service and the store keep nothing the file does not hold.
    s.svc.dispose();
    const rows = rowsOf(s.raw);
    s.raw.close(); s.db.close();
    return { rows, a, b, aGrants: ra.grantIds ?? [], seq };
  } finally { dispose(); }
}

/** The cases: a name and the statements. `$X` placeholders are filled from the base file. */
function cellCases(b: Base): { name: string; sql: string[] }[] {
  const L = b.seq.last, D = b.seq.decided, R = b.seq.requested;
  const out: { name: string; sql: string[] }[] = [];
  const add = (name: string, ...sql: string[]): void => { out.push({ name, sql }); };
  // approval_chain: seq is the rowid (always an integer); ts has INTEGER affinity, every other column TEXT affinity (a number
  // written to it is stored as text, so only a blob or a null can be foreign there).
  for (const [at, label] of [[1, "first"], [D, "decided"], [L, "last"]] as const) {
    add(`chain.ts text (${label})`, `UPDATE approval_chain SET ts = 'x' || ts WHERE seq = ${at}`);
    add(`chain.ts real (${label})`, `UPDATE approval_chain SET ts = ts + 0.25 WHERE seq = ${at}`);
    add(`chain.ts blob (${label})`, `UPDATE approval_chain SET ts = CAST(ts AS BLOB) WHERE seq = ${at}`);
    for (const c of ["kind", "ref_id", "payload", "prev_mac", "mac"]) add(`chain.${c} blob (${label})`, `UPDATE approval_chain SET ${c} = CAST(${c} AS BLOB) WHERE seq = ${at}`);
    add(`chain.prev_mac other blob (${label})`, `UPDATE approval_chain SET prev_mac = CAST(upper(prev_mac) AS BLOB) WHERE seq = ${at}`);
    add(`chain.mac wide text (${label})`, `UPDATE approval_chain SET mac = '${"\u00e9".repeat(64)}' WHERE seq = ${at}`);
    add(`chain.prev_mac wide text (${label})`, `UPDATE approval_chain SET prev_mac = '${"\u00e9".repeat(64)}' WHERE seq = ${at}`);
  }
  add("chain.ts empty blob", "UPDATE approval_chain SET ts = x'' WHERE seq = 1");
  add("chain.ts one-byte blob", "UPDATE approval_chain SET ts = x'07' WHERE seq = 1");
  add("chain.ts beyond 2^53", "UPDATE approval_chain SET ts = 9007199254740993 WHERE seq = 1");
  add("chain.nonce blob (request)", `UPDATE approval_chain SET nonce = CAST(nonce AS BLOB) WHERE seq = ${R}`);
  add("chain.nonce blob (decision)", `UPDATE approval_chain SET nonce = CAST(nonce AS BLOB) WHERE seq = ${D}`);
  add("chain.nonce null (decision)", `UPDATE approval_chain SET nonce = NULL WHERE seq = ${D}`);
  add("chain.mac blob (last) and head", `UPDATE approval_chain SET mac = CAST(mac AS BLOB) WHERE seq = ${L}`, "UPDATE chain_head SET mac = CAST(mac AS BLOB)");
  // chain_head
  add("head.seq text", "UPDATE chain_head SET seq = 'x' || seq");
  add("head.seq real", "UPDATE chain_head SET seq = seq + 0.5");
  add("head.seq blob", "UPDATE chain_head SET seq = CAST(seq AS BLOB)");
  add("head.mac blob", "UPDATE chain_head SET mac = CAST(mac AS BLOB)");
  add("head.tag blob", "UPDATE chain_head SET tag = CAST(tag AS BLOB)");
  add("head.tag other blob", "UPDATE chain_head SET tag = CAST(upper(tag) AS BLOB)");
  add("head.tag wide text", `UPDATE chain_head SET tag = '${"\u00e9".repeat(64)}'`);
  // approval_signatures
  add("signature.alg blob", "UPDATE approval_signatures SET alg = CAST(alg AS BLOB)");
  add("signature.public_key blob of its text", "UPDATE approval_signatures SET public_key = CAST(public_key AS BLOB)");
  add("signature.signature blob of its text", "UPDATE approval_signatures SET signature = CAST(signature AS BLOB)");
  add("signature.public_key blob of its bytes", "UPDATE approval_signatures SET public_key = unhex_public_key");
  add("signature.signature blob of its bytes", "UPDATE approval_signatures SET signature = unhex_signature");
  // approvals (the projection)
  for (const c of ["id", "principal", "subject_kind", "subject_id", "capability", "action_hash", "turn_id", "task_id", "session_id", "nonce", "status", "created_at", "expires_at", "decided_at", "decided_by", "decision_surface", "used_at", "delegable"]) {
    add(`approvals.${c} blob`, `UPDATE approvals SET ${c} = CAST(${c} AS BLOB)`);
  }
  for (const c of ["created_at", "expires_at", "decided_at", "used_at"]) add(`approvals.${c} text`, `UPDATE approvals SET ${c} = 'x' || ifnull(${c}, '')`);
  add("approvals.expires_at real", "UPDATE approvals SET expires_at = expires_at + 0.5");
  // grants
  for (const c of ["id", "person", "agent", "capability", "effect", "match_kind", "match_path", "match_access", "match_recursive", "duration", "created_by", "created_at", "expires_at",
    "revoked_at", "end_reason", "last_used_at", "consumed_at", "action_hash", "task_id", "session_id", "project_id", "job_id", "delegable", "surface", "acknowledged_unsandboxed",
    "def_hash", "chain_seq", "attested_via", "origin"]) {
    add(`grants.${c} blob`, `UPDATE grants SET ${c} = CAST(${c} AS BLOB) WHERE ${c} IS NOT NULL`);
  }
  for (const c of ["created_at", "expires_at", "chain_seq", "surface"]) add(`grants.${c} text`, `UPDATE grants SET ${c} = 'x' || ifnull(${c}, '')`);
  for (const c of ["created_at", "expires_at", "chain_seq"]) add(`grants.${c} real`, `UPDATE grants SET ${c} = ifnull(${c}, 0) + 0.5`);
  for (const c of ["effect", "project_id", "attested_via", "origin", "expires_at"]) add(`grants.${c} null`, `UPDATE grants SET ${c} = NULL`);
  add("grants.id blob (one)", "UPDATE grants SET id = CAST(id AS BLOB) WHERE id = 'grt_task'");
  add("grants.created_at beyond 2^53", "UPDATE grants SET created_at = 9007199254740993 WHERE id = 'grt_cap'");
  add("grants.surface real", "UPDATE grants SET surface = 2.5");
  return out;
}

/** The rows of `now` that differ from `before` (by position) and the row counts: the base rows are the same in every case. */
function changed(before: Record<string, string[]>, now: Record<string, string[]>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const t of TABLES) {
    const b = before[t]!, n = now[t]!;
    out[t] = { rows: n.length, changed: n.flatMap((l, i) => (l === b[i] ? [] : [[i, l]])) };
  }
  return out;
}

const BEGIN_ASK = (): Record<string, unknown> => {
  const ask = ASK({ callId: "ca", targets: ["/work/proj/a.txt"], request: { ...(ASK().request as object), actionHash: "ha" } });
  return { ...ask, canonical: canonicalJson(ask.args) };
};

export async function cellVectors(): Promise<{ cells: unknown; cellsGrants: unknown }> {
  const b = await deterministic("p4-k review b: base", base);
  let baseDump: Record<string, string[]> = {};
  {
    const { path, dispose } = tempPath();
    const s = await openSession(path, b.rows);
    baseDump = dump(s.raw);
    s.close();
    dispose();
  }
  const sigRow = b.rows.approval_signatures[0] as { public_key: string; signature: string } | undefined;
  const fill = (sql: string): string => sql
    .replace("unhex_public_key", `x'${Buffer.from(sigRow?.public_key ?? "", "base64").toString("hex")}'`)
    .replace("unhex_signature", `x'${Buffer.from(sigRow?.signature ?? "", "base64").toString("hex")}'`);
  const cases: unknown[] = [];
  let reference: Record<string, unknown>[] | undefined;
  for (const c of [{ name: "reference", sql: [] as string[] }, ...cellCases(b)]) {
    await deterministic("p4-k review b: cells", () => runCase(c));
  }
  async function runCase(c: { name: string; sql: string[] }): Promise<void> {
    const { path, dispose } = tempPath();
    try {
      const s = await openSession(path, b.rows);
      const sql = c.sql.map(fill);
      await s.run("sql", { sql }, () => { for (const x of sql) s.raw.exec(x); return null; });
      s.clock.t = SVC_NOW + 60_000;
      const decide = (requestId: string, scope?: string) => {
        const input: Record<string, unknown> = { requestId, decision: "approve", person: "christian", surface: 3, ...(scope ? { scope } : {}) };
        return s.run("decideForSession", input, () => { const r: any = s.svc.decideForSession(input as never); return r.ok ? { ok: true, approved: r.status === "approved", scope: r.scope ?? null, grantIds: r.grantIds } : r; });
      };
      await s.run("verify", {}, () => s.svc.verify());
      await s.run("list", {}, () => s.svc.list());
      await s.run("inspect", {}, () => s.grants.inspect());
      await s.run("glist", { person: "christian", agent: "bernd", capability: "fs.read" }, () => s.grants.list({ person: "christian", agent: "bernd", capability: "fs.read" }));
      await s.run("gget", { id: "grt_path" }, () => s.grants.get("grt_path") ?? null);
      await decide(b.b.id, "once");
      const ask = ASK({ callId: "ca", targets: ["/work/proj/a.txt"], request: { ...(ASK().request as object), actionHash: "ha" } });
      const { canonical: _c, ...rest } = { ...ask };
      const answer = { approved: true, requestId: b.a.id, scope: "once", grantIds: b.aGrants };
      await s.run("begin", { answer }, () => s.svc.begin(answer as never, { ...rest, signal: new AbortController().signal } as never));
      s.clock.t += 1;
      const d = await s.request(ASK({ callId: "cd", request: { ...(ASK().request as object), actionHash: "hd" } }));
      if (d) await s.run("abort", { id: d.id }, () => { s.pending.get(d.id)!.abort(); return null; });
      s.clock.t += 1;
      await s.run("grevoke", { id: "grt_cap", by: "christian", reason: "revoked" }, () => s.grants.revoke("grt_cap", "christian", "revoked"));
      await s.run("endTask", { taskId: "t1" }, () => s.grants.endTask("t1"));
      await s.run("endSession", { sessionId: "s1" }, () => s.grants.endSession("s1"));
      await s.run("markUsed", { id: "grt_path" }, () => { s.grants.markUsed("grt_path"); return null; });
      await s.run("verify", {}, () => s.svc.verify());
      // An operation recorded exactly as in the reference case is written as its index there.
      const same = (op: Record<string, unknown>, i: number): boolean => reference !== undefined && JSON.stringify(op) === JSON.stringify(reference[i]);
      if (reference === undefined) reference = s.ops;
      cases.push({ name: c.name, ops: c.sql.length === 0 ? s.ops : s.ops.map((op, i) => (same(op, i) ? i : op)), dump: changed(baseDump, dump(s.raw)) });
      s.close();
    } finally { dispose(); }
  }
  const head = { now: SVC_NOW, home: HOME, key: parts(KEY.toString("hex")), signing: parts(SIGNING.toString("base64")), base: b.rows, baseDump, beginAsk: BEGIN_ASK() };
  const grants = (c: any): boolean => c.name.startsWith("grants.");
  // The reference case leads both files.
  return { cells: { ...head, cases: cases.filter((c) => !grants(c)) }, cellsGrants: { ...head, cases: [cases[0], ...cases.filter(grants)] } };
}
