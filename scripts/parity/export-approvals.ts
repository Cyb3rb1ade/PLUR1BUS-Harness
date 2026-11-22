// Parity vectors (mode V) for the approval chain, its signatures and the grant rules (P4-K K3a, plan P4-22). The real
// `ApprovalChain`, `GrantStore`, `createApprovalStore` and `verifyDecisionSignature` run over a temporary approvals database
// with a fixed clock; the replay in `crates/plur1bus-core/src/approvals/vectors.rs` runs the same operations and must write
// the same rows byte for byte (MACs, head tag, signatures, grant definitions and their hashes) and give the same answers.
// Recorded, never edited by hand. `regex.json` and `cells.json` hold the service-level cases of review B
// (`approvals-service-cases.ts`).
//
// The grant paths are POSIX spellings: the store reads them with the rules of the platform it runs on, so the vectors are
// recorded and compared on POSIX only (the Rust replay applies the POSIX rules everywhere).
//
// Key material is test material made here from fixed seeds, and it is stored in pieces (`{ parts: [...] }`), never as one
// literal. The approval ids and nonces are fixed strings (the store draws random ones, which a vector cannot hold): the
// chain entries an approval writes are appended with the payloads `approvals/store.ts` builds; the store itself is proven
// against the same file through `list()` and in mode B.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-approvals.ts [--check]
import { createHash, createHmac, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { ApprovalChain, bindingTuple } from "../../packages/core/src/approvals/chain.ts";
import { openApprovalsDb, transaction } from "../../packages/core/src/approvals/db.ts";
import { staticKeySource } from "../../packages/core/src/approvals/keys.ts";
import { loadDecisionSigner, verifyDecisionSignature, type DecisionSigner } from "../../packages/core/src/approvals/signing.ts";
import { createApprovalStore } from "../../packages/core/src/approvals/store.ts";
import { GrantError, GrantStore, type CreateGrantInput } from "../../packages/core/src/grants/store.ts";
import type { PolicyAuditAction, PolicyAuditFields } from "../../packages/core/src/policy/audit.ts";
import { ed25519Cases, SMALL_ORDER_ENCODINGS } from "./ed25519-cases.ts";
import { cellVectors, regexVectors } from "./approvals-service-cases.ts";
import { exporterMain } from "./lib.mjs";

const NOW = Date.UTC(2026, 10, 18, 7, 0, 0);
const MIN = 60_000;
const HOME = "/home/vector-user";
const seed = (label: string): Buffer => createHash("sha256").update(`p4-k k3a vectors: ${label}`).digest();
const parts = (text: string): { parts: string[] } => {
  const n = Math.ceil(text.length / 4);
  return { parts: [0, 1, 2, 3].map((i) => text.slice(i * n, (i + 1) * n)) };
};
const PKCS8_V1 = Buffer.from("302e020100300506032b657004220420", "hex");
const pkcs8 = (label: string): Buffer => Buffer.concat([PKCS8_V1, seed(label)]);

const KEY = seed("chain key");
const OTHER_KEY = seed("other chain key");
const SIGNING = pkcs8("signing key");
const OTHER_SIGNING = pkcs8("other signing key");

const BINDING = { actionHash: "h1", principal: "christian", subject: { kind: "agent", id: "bernd" }, turnId: "turn1", taskId: "t1", sessionId: "s1" };

function tempDb(): { db: DatabaseSync; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "p1b-apr-vec-"));
  const db = openApprovalsDb({ path: join(dir, "approvals.sqlite") });
  return { db, dispose: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const signerOf = async (der: Buffer): Promise<DecisionSigner> => loadDecisionSigner({ load: async () => Uint8Array.from(der) });

const TABLES = {
  approval_chain: "SELECT * FROM approval_chain ORDER BY seq",
  chain_head: "SELECT * FROM chain_head",
  approval_signatures: "SELECT * FROM approval_signatures ORDER BY seq",
  grants: "SELECT * FROM grants ORDER BY id",
  approvals: "SELECT * FROM approvals ORDER BY id",
} as const;
type Rows = Record<keyof typeof TABLES, Record<string, unknown>[]>;
const dump = (db: DatabaseSync): Rows => Object.fromEntries(Object.entries(TABLES).map(([t, sql]) => [t, db.prepare(sql).all().map((r) => ({ ...r }))])) as Rows;

function load(db: DatabaseSync, rows: Rows): void {
  for (const [table, list] of Object.entries(rows)) {
    for (const r of list) {
      const cols = Object.keys(r);
      db.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...(cols.map((c) => r[c]) as never[]));
    }
  }
}

// ---- the main scenario: approvals and grants on one chain, every write an operation the replay repeats ----

type Op =
  | { op: "append"; at: number; kind: string; ref: string; payloadJson: string; nonce: string | null }
  | { op: "grant"; at: number; input: CreateGrantInput }
  | { op: "markUsed"; at: number; id: string }
  | { op: "revoke"; at: number; id: string; by: string; reason: string }
  | { op: "consumeOnce"; at: number; id: string; person: string; agent: string; actionHash: string }
  | { op: "endTask"; at: number; taskId: string };

const request = (id: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ capability: "fs.write", expiresAt: NOW + 24 * 60 * MIN, bound: BINDING, ...extra });
const decided = (decision: string, delegable = false) => JSON.stringify({ decision, person: "christian", surface: 3, delegable, bound: BINDING });

const OPS: Op[] = [
  { op: "append", at: NOW, kind: "approval.requested", ref: "apr_a", nonce: "n-a", payloadJson: request("apr_a", { detail: { tool: "fs.write", risk: "low", flags: { outsideRoots: true }, targets: ["/work/x/a.txt"], summary: "write \"a\" \u2028 \u00e9 \ud83d\ude00 \u0001" } }) },
  { op: "append", at: NOW + 1, kind: "approval.decided", ref: "apr_a", nonce: "n-a", payloadJson: decided("approve", true) },
  { op: "append", at: NOW + 2, kind: "approval.used", ref: "apr_a", nonce: null, payloadJson: JSON.stringify({ bound: BINDING }) },
  { op: "append", at: NOW + 3, kind: "approval.requested", ref: "apr_b", nonce: "n-b", payloadJson: request("apr_b") },
  { op: "append", at: NOW + 4, kind: "approval.decided", ref: "apr_b", nonce: "n-b", payloadJson: decided("deny") },
  { op: "append", at: NOW + 5, kind: "approval.requested", ref: "apr_c", nonce: "n-c", payloadJson: request("apr_c") },
  { op: "append", at: NOW + 6, kind: "approval.cancelled", ref: "apr_c", nonce: null, payloadJson: JSON.stringify({ by: "abort", bound: BINDING }) },
  { op: "append", at: NOW + 7, kind: "approval.requested", ref: "apr_d", nonce: "n-d", payloadJson: request("apr_d") },
  { op: "append", at: NOW + 8, kind: "note", ref: "x", nonce: null, payloadJson: JSON.stringify({ "10": 1, "2": [-0, 0.1, 1e21, 5e-7], b: "\u0000\u007f\u00ff", a: { "01": null } }) },
  { op: "grant", at: NOW + 10, input: { id: "grt_cap", capability: "fs.read", person: "christian", agent: "bernd", scope: "always", match: { kind: "capability" }, createdBy: "christian", surface: 3 } },
  { op: "grant", at: NOW + 11, input: { id: "grt_path", capability: "fs.write", person: "christian", agent: "bernd", scope: "session", sessionId: "s1", match: { kind: "path", path: "/work/proj", access: "write", recursive: true }, createdBy: "christian", surface: 2, effect: "local-write", delegable: true, projectId: "p1" } },
  { op: "grant", at: NOW + 12, input: { id: "grt_once", capability: "shell.exec", person: "christian", agent: "bernd", scope: "once", match: { kind: "action" }, actionHash: "h-once", createdBy: "christian", surface: 2, acknowledgedUnsandboxed: true, attestedVia: "attested:touch-id" } },
  { op: "grant", at: NOW + 13, input: { id: "grt_task", capability: "fs.read", person: "christian", agent: "bernd", scope: "task", taskId: "t1", match: { kind: "path", path: "/work/notes", access: "read", recursive: false }, createdBy: "christian", surface: 1, expiresAt: NOW + 60 * MIN } },
  { op: "grant", at: NOW + 14, input: { id: "grt_job", capability: "memory.jobs.run", person: "christian", agent: "bernd", scope: "always", jobId: "engine:dream", match: { kind: "capability" }, createdBy: "christian", surface: 2 } },
  { op: "grant", at: NOW + 15, input: { id: "grt_once2", capability: "fs.write", person: "christian", agent: "bernd", scope: "once", match: { kind: "action" }, actionHash: "h-late", createdBy: "christian", surface: 3 } },
  { op: "markUsed", at: NOW + 20, id: "grt_cap" },
  { op: "markUsed", at: NOW + 21, id: "grt_cap" },
  { op: "markUsed", at: NOW + 70 * MIN, id: "grt_cap" },
  { op: "markUsed", at: NOW + 70 * MIN, id: "grt_job" },
  { op: "consumeOnce", at: NOW + 71 * MIN, id: "grt_once", person: "christian", agent: "bernd", actionHash: "h-once" },
  { op: "consumeOnce", at: NOW + 16, id: "grt_once2", person: "christian", agent: "bernd", actionHash: "other" },
  { op: "consumeOnce", at: NOW + 17, id: "grt_once2", person: "christian", agent: "bernd", actionHash: "h-late" },
  { op: "consumeOnce", at: NOW + 18, id: "grt_once2", person: "christian", agent: "bernd", actionHash: "h-late" },
  { op: "revoke", at: NOW + 80 * MIN, id: "grt_path", by: "christian", reason: "revoked" },
  { op: "revoke", at: NOW + 81 * MIN, id: "grt_path", by: "christian", reason: "revoked" },
  { op: "endTask", at: NOW + 82 * MIN, taskId: "t1" },
];

function errorOf(e: unknown): Record<string, unknown> {
  if (e instanceof GrantError) return { error: e.code, message: e.message };
  throw e;
}

async function mainScenario() {
  const { db, dispose } = tempDb();
  try {
    const clock = { t: NOW, now() { return this.t; } };
    const signer = await signerOf(SIGNING);
    const chain = new ApprovalChain(db, KEY, clock, signer);
    const audit: { action: PolicyAuditAction; fields: PolicyAuditFields }[] = [];
    const grants = new GrantStore({ db, chain, clock, home: HOME, audit: { record: (action, fields) => { audit.push({ action, fields: { ...fields } }); } } });
    const results: unknown[] = [];
    for (const op of OPS) {
      clock.t = op.at;
      audit.length = 0;
      let result: unknown;
      try {
        if (op.op === "append") result = chain.append(op.kind, op.ref, JSON.parse(op.payloadJson), op.nonce);
        else if (op.op === "grant") result = grants.create(op.input);
        else if (op.op === "markUsed") { grants.markUsed(op.id); result = null; }
        else if (op.op === "revoke") result = grants.revoke(op.id, op.by, op.reason);
        else if (op.op === "consumeOnce") result = grants.consumeOnce(op.id, { person: op.person, agent: op.agent, actionHash: op.actionHash });
        else result = grants.endTask(op.taskId);
      } catch (e) { result = errorOf(e); }
      results.push({ ...op, result, audit: audit.map((a) => ({ action: a.action, fields: a.fields })) });
    }
    clock.t = NOW + 90 * MIN;
    const store = await createApprovalStore({ db, keys: staticKeySource(KEY), clock, signer });
    const rows = dump(db);
    return {
      now: NOW, home: HOME, key: parts(KEY.toString("hex")), signing: parts(SIGNING.toString("base64")),
      ops: results, rows,
      after: {
        at: clock.t,
        verify: chain.verify(),
        inspect: grants.inspect().map((v) => ({ grant: v.grant, state: v.state })),
        approvals: store.list().map((r) => ({ ...r })),
        listCap: grants.list({ person: "christian", agent: "bernd", capability: "fs.read" }),
      },
      tampers: await tampers(rows),
      phantomAfterRollback: phantomAfterRollback(),
    };
  } finally { dispose(); }
}

/** Each case changes a copy of the finished file the way an attacker with write access (but no key) could. */
const TAMPERS: { name: string; sql: string[] }[] = [
  { name: "payload", sql: ["UPDATE approval_chain SET payload = replace(payload, 'approve', 'deny') WHERE seq = 2"] },
  { name: "ts", sql: ["UPDATE approval_chain SET ts = ts + 1 WHERE seq = 3"] },
  { name: "ts-as-text", sql: ["UPDATE approval_chain SET ts = CAST(ts AS TEXT) || '' WHERE seq = 3"] },
  { name: "ts-as-real", sql: ["UPDATE approval_chain SET ts = ts + 0.5 WHERE seq = 3"] },
  { name: "kind", sql: ["UPDATE approval_chain SET kind = 'approval.denied' WHERE seq = 5"] },
  { name: "ref", sql: ["UPDATE approval_chain SET ref_id = 'apr_z' WHERE seq = 4"] },
  { name: "nonce", sql: ["UPDATE approval_chain SET nonce = 'n-x' WHERE seq = 1"] },
  { name: "nonce-null", sql: ["UPDATE approval_chain SET nonce = NULL WHERE seq = 2"] },
  { name: "prev-mac", sql: ["UPDATE approval_chain SET prev_mac = upper(prev_mac) WHERE seq = 6"] },
  { name: "mac-upper", sql: ["UPDATE approval_chain SET mac = upper(mac) WHERE seq = (SELECT max(seq) FROM approval_chain)"] },
  { name: "delete-middle", sql: ["DELETE FROM approval_chain WHERE seq = 3"] },
  { name: "delete-tail", sql: ["DELETE FROM approval_chain WHERE seq >= 20"] },
  { name: "delete-tail-repoint-head", sql: ["DELETE FROM approval_chain WHERE seq >= 20", "UPDATE chain_head SET seq = 19, mac = (SELECT mac FROM approval_chain WHERE seq = 19)"] },
  { name: "delete-all-keep-head", sql: ["DELETE FROM approval_chain"] },
  { name: "delete-all-and-head", sql: ["DELETE FROM approval_chain", "DELETE FROM chain_head", "DELETE FROM approval_signatures"] },
  { name: "head-deleted", sql: ["DELETE FROM chain_head"] },
  { name: "head-tag", sql: ["UPDATE chain_head SET tag = replace(tag, substr(tag, 1, 1), 'f')"] },
  { name: "head-seq-higher", sql: ["UPDATE chain_head SET seq = seq + 1"] },
  { name: "reorder", sql: ["UPDATE approval_chain SET seq = 100 WHERE seq = 2", "UPDATE approval_chain SET seq = 2 WHERE seq = 3", "UPDATE approval_chain SET seq = 3 WHERE seq = 100"] },
  { name: "replay-copy-at-end", sql: ["INSERT INTO approval_chain (seq, ts, kind, ref_id, nonce, payload, prev_mac, mac) SELECT (SELECT max(seq) FROM approval_chain) + 1, ts, kind, ref_id, nonce, payload, prev_mac, mac FROM approval_chain WHERE seq = 9"] },
  { name: "signature-byte", sql: ["UPDATE approval_signatures SET signature = 'A' || substr(signature, 2) WHERE seq = 2"] },
  { name: "signature-zero", sql: ["UPDATE approval_signatures SET signature = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==' WHERE seq = 2"] },
  { name: "signature-moved", sql: ["UPDATE approval_signatures SET seq = 3 WHERE seq = 2"] },
  { name: "signature-deleted", sql: ["DELETE FROM approval_signatures"] },
  { name: "signature-whitespace", sql: ["UPDATE approval_signatures SET signature = substr(signature, 1, 10) || ' ' || char(10) || substr(signature, 11) WHERE seq = 2"] },
  { name: "signature-url-alphabet", sql: ["UPDATE approval_signatures SET signature = replace(replace(signature, '+', '-'), '/', '_') WHERE seq = 2"] },
  { name: "signature-no-padding", sql: ["UPDATE approval_signatures SET signature = rtrim(signature, '=') WHERE seq = 2"] },
  { name: "public-key-other", sql: ["UPDATE approval_signatures SET public_key = '$OTHER_PUBLIC_KEY' WHERE seq = 2"] },
  { name: "public-key-trailing", sql: ["UPDATE approval_signatures SET public_key = public_key || 'AAAA' WHERE seq = 2"] },
  { name: "public-key-whitespace", sql: ["UPDATE approval_signatures SET public_key = ' ' || public_key || ' ' WHERE seq = 2"] },
  { name: "signature-other-key", sql: ["UPDATE approval_signatures SET public_key = '$OTHER_PUBLIC_KEY', signature = '$OTHER_SIGNATURE' WHERE seq = 2"] },
  { name: "signature-number", sql: ["UPDATE approval_signatures SET signature = 7 WHERE seq = 2"] },
  { name: "grant-person", sql: ["UPDATE grants SET person = 'mallory' WHERE id = 'grt_cap'"] },
  { name: "grant-recursive", sql: ["UPDATE grants SET match_recursive = 1 WHERE id = 'grt_task'"] },
  { name: "grant-duration", sql: ["UPDATE grants SET duration = 'always' WHERE id = 'grt_task'"] },
  { name: "grant-created-at", sql: ["UPDATE grants SET created_at = created_at + 1 WHERE id = 'grt_cap'"] },
  { name: "grant-created-at-text", sql: ["UPDATE grants SET created_at = CAST(created_at AS TEXT) || '' WHERE id = 'grt_cap'"] },
  { name: "grant-surface", sql: ["UPDATE grants SET surface = 3 WHERE id = 'grt_task'"] },
  { name: "grant-attested-cleared", sql: ["UPDATE grants SET attested_via = NULL WHERE id = 'grt_once'"] },
  { name: "grant-origin-set", sql: ["UPDATE grants SET origin = 'auto-agent-owner' WHERE id = 'grt_cap'"] },
  { name: "grant-unrevoked", sql: ["UPDATE grants SET revoked_at = NULL, end_reason = NULL WHERE id = 'grt_path'"] },
  { name: "grant-unconsumed", sql: ["UPDATE grants SET consumed_at = NULL WHERE id = 'grt_once'"] },
  { name: "grant-last-used", sql: ["UPDATE grants SET last_used_at = 1 WHERE id = 'grt_cap'"] },
  { name: "grant-row-copied", sql: ["INSERT INTO grants SELECT 'grt_copy', person, agent, capability, effect, match_kind, match_path, match_access, match_recursive, duration, created_by, created_at, expires_at, revoked_at, end_reason, last_used_at, consumed_at, action_hash, task_id, session_id, project_id, job_id, delegable, surface, acknowledged_unsandboxed, def_hash, chain_seq, attested_via, origin FROM grants WHERE id = 'grt_cap'"] },
  { name: "projection-approved", sql: ["UPDATE approvals SET status = 'approved'"] },
];

async function tampers(rows: Rows) {
  const other = await signerOf(OTHER_SIGNING);
  const otherSig = other.sign((rows.approval_chain[1] as { mac: string }).mac).signature;
  const out: unknown[] = [];
  for (const t of TAMPERS) {
    const { db, dispose } = tempDb();
    try {
      load(db, rows);
      for (const s of t.sql) db.exec(s.replaceAll("$OTHER_PUBLIC_KEY", other.publicKey).replaceAll("$OTHER_SIGNATURE", otherSig));
      const clock = { now: () => NOW + 90 * MIN };
      const signed = new ApprovalChain(db, KEY, clock, await signerOf(SIGNING));
      const unsigned = new ApprovalChain(db, KEY, clock);
      const grants = new GrantStore({ db, chain: unsigned, clock, home: HOME });
      let approvals: unknown;
      try {
        const store = await createApprovalStore({ db, keys: staticKeySource(KEY), clock });
        approvals = store.list().map((r) => [r.id, r.status]);
      } catch (e) { approvals = { error: (e as Error).name }; }
      out.push({
        name: t.name, sql: t.sql,
        verifySigned: signed.verify(), verifyUnsigned: unsigned.verify(),
        states: grants.inspect().map((v) => [v.grant.id, v.state, v.grant.revoked === true, v.grant.consumedAt ?? null, v.grant.lastUsedAt ?? null]),
        approvals,
      });
    } finally { dispose(); }
  }
  out.push(await otherKeyCase(rows));
  return out;
}

/** The finished file read with another chain key: broken at 1. */
async function otherKeyCase(rows: Rows) {
  const { db, dispose } = tempDb();
  try {
    load(db, rows);
    const chain = new ApprovalChain(db, OTHER_KEY, { now: () => NOW });
    return { name: "other-key", sql: [], otherKey: parts(OTHER_KEY.toString("hex")), verifyUnsigned: chain.verify() };
  } finally { dispose(); }
}

// ---- appends a key holder could make: the semantic rules (defence in depth) ----

const SEMANTIC: { name: string; appends: [string, string, unknown, string | null][] }[] = [
  { name: "nonce-reuse", appends: [["approval.requested", "a", JSON.parse(request("a")), "n1"], ["approval.decided", "a", JSON.parse(decided("approve")), "n1"], ["approval.requested", "b", JSON.parse(request("b")), "n2"], ["approval.decided", "b", JSON.parse(decided("approve")), "n1"]] },
  { name: "decision-null-nonce", appends: [["approval.requested", "a", JSON.parse(request("a")), "n1"], ["approval.decided", "a", JSON.parse(decided("approve")), null]] },
  { name: "decision-other-nonce", appends: [["approval.requested", "a", JSON.parse(request("a")), "n1"], ["approval.decided", "a", JSON.parse(decided("approve")), "n9"]] },
  { name: "decision-without-request", appends: [["approval.decided", "a", JSON.parse(decided("approve")), "n1"]] },
  { name: "decision-other-binding", appends: [["approval.requested", "a", JSON.parse(request("a")), "n1"], ["approval.decided", "a", { decision: "approve", person: "christian", surface: 3, delegable: false, bound: { ...BINDING, turnId: "turn2" } }, "n1"]] },
  { name: "decision-maybe", appends: [["approval.requested", "a", JSON.parse(request("a")), "n1"], ["approval.decided", "a", { decision: "maybe", bound: BINDING }, "n1"]] },
  { name: "decision-after-cancel", appends: [["approval.requested", "a", JSON.parse(request("a")), "n1"], ["approval.cancelled", "a", { by: "x", bound: BINDING }, null], ["approval.decided", "a", JSON.parse(decided("approve")), "n1"]] },
  { name: "cancel-after-decision", appends: [["approval.requested", "a", JSON.parse(request("a")), "n1"], ["approval.decided", "a", JSON.parse(decided("deny")), "n1"], ["approval.cancelled", "a", { by: "x", bound: BINDING }, null]] },
  { name: "cancel-unknown", appends: [["approval.cancelled", "a", { by: "x", bound: BINDING }, null]] },
  { name: "use-after-deny", appends: [["approval.requested", "a", JSON.parse(request("a")), "n1"], ["approval.decided", "a", JSON.parse(decided("deny")), "n1"], ["approval.used", "a", { bound: BINDING }, null]] },
  { name: "use-other-binding", appends: [["approval.requested", "a", JSON.parse(request("a")), "n1"], ["approval.decided", "a", JSON.parse(decided("approve")), "n1"], ["approval.used", "a", { bound: { ...BINDING, actionHash: "evil" } }, null]] },
  { name: "use-without-decision", appends: [["approval.requested", "a", JSON.parse(request("a")), "n1"], ["approval.used", "a", { bound: BINDING }, null]] },
  { name: "request-without-binding", appends: [["approval.requested", "a", { capability: "fs.read", expiresAt: 1 }, "n1"]] },
  { name: "request-binding-number", appends: [["approval.requested", "a", { bound: { ...BINDING, taskId: 7 } }, "n1"]] },
  { name: "request-binding-array", appends: [["approval.requested", "a", { bound: [1, 2] }, "n1"]] },
  { name: "payload-string", appends: [["approval.requested", "a", "text", "n1"]] },
  { name: "payload-null", appends: [["approval.requested", "a", null, "n1"]] },
  { name: "payload-array", appends: [["approval.requested", "a", [BINDING], "n1"]] },
  { name: "other-kinds-are-free", appends: [["grant.created", "g", "text", null], ["note", "a", null, null], ["approvalish", "a", 1, "n1"]] },
  { name: "signed-decisions", appends: [["approval.requested", "a", JSON.parse(request("a")), "n1"], ["approval.decided", "a", JSON.parse(decided("approve")), "n1"], ["approval.requested", "b", JSON.parse(request("b")), "n2"], ["approval.decided", "b", JSON.parse(decided("deny")), "n2"]] },
];

/**
 * K3-D2 (divergence): a write transaction that appends, reads the verified view and then rolls back leaves that view in
 * TypeScript's cache. The chain then reports an entry the file does not hold, and the next append leaves a gap that breaks
 * the chain for good. The Rust port caches only views of committed state; the replay expects its own answers here.
 */
function phantomAfterRollback() {
  const { db, dispose } = tempDb();
  try {
    let t = NOW;
    const chain = new ApprovalChain(db, KEY, { now: () => t++ });
    chain.append("note", "a", { i: 1 });
    let refused = false;
    try {
      transaction(db, () => { chain.append("note", "b", { i: 2 }); chain.snapshot(); throw new Error("refused after the append"); });
    } catch { refused = true; }
    const rowsAfterRollback = (db.prepare("SELECT COUNT(*) AS n FROM approval_chain").get() as { n: number }).n;
    const verifyAfterRollback = chain.verify();
    chain.append("note", "c", { i: 3 });
    const seqs = db.prepare("SELECT seq FROM approval_chain ORDER BY seq").all().map((r) => (r as { seq: number }).seq);
    return { divergence: "K3-D2", refused, rowsAfterRollback, verifyAfterRollback, seqsAfterNextAppend: seqs, verifyAfterNextAppend: new ApprovalChain(db, KEY, { now: () => 0 }).verify() };
  } finally { dispose(); }
}

async function semantic() {
  const out: unknown[] = [];
  const signer = await signerOf(SIGNING);
  for (const s of SEMANTIC) {
    const { db, dispose } = tempDb();
    try {
      let t = NOW;
      const chain = new ApprovalChain(db, KEY, { now: () => t++ }, s.name === "signed-decisions" ? signer : undefined);
      const appended: unknown[] = [];
      for (const [kind, ref, payload, nonce] of s.appends) {
        try { chain.append(kind, ref, payload, nonce); appended.push("ok"); } catch (e) { appended.push({ error: (e as Error).name }); }
      }
      out.push({ name: s.name, signed: s.name === "signed-decisions", appends: s.appends.map(([kind, ref, payload, nonce]) => ({ kind, ref, payloadJson: JSON.stringify(payload), nonce })), appended, rows: dump(db), verify: chain.verify() });
    } finally { dispose(); }
  }
  return out;
}

// ---- the grant rules: what `create` accepts and refuses ----

const base = (o: Partial<CreateGrantInput> = {}): CreateGrantInput => ({ capability: "fs.read", person: "christian", agent: "bernd", scope: "always", match: { kind: "capability" }, createdBy: "christian", surface: 3, ...o });
const path = (p: string, o: Partial<CreateGrantInput> = {}, recursive = true, access: "read" | "write" = "read"): CreateGrantInput => base({ match: { kind: "path", path: p, access, recursive }, ...o });
const long = (n: number) => "x".repeat(n);

const RULES: [string, CreateGrantInput][] = [
  ["ok", base()], ["capability-spelling", base({ capability: " FS.Read " })], ["unknown", base({ capability: "fs.readx" })],
  ["never", base({ capability: "harness.admin" })], ["no-ceiling", base({ capability: "memory.read" })], ["policy-bypass", base({ capability: "policy.bypass" })],
  ["empty-person", base({ person: "" })], ["empty-agent", base({ agent: "" })], ["empty-creator", base({ createdBy: "" })],
  ["reserved-issuer", base({ createdBy: "core:auto-agent-owner" })], ["bad-scope", base({ scope: "forever" as never })],
  ["above-ceiling", base({ capability: "fs.delete", scope: "session", sessionId: "s" })], ["at-ceiling", base({ capability: "fs.delete", scope: "task", taskId: "t" })],
  ["surface-0", base({ surface: 0 })], ["surface-1-min-2", base({ capability: "shell.exec", surface: 1 })], ["surface-2-min-3", base({ capability: "os.grant", surface: 2 })],
  ["attested-ok", base({ attestedVia: "attested:touch-id", surface: 2 })], ["attested-surface-1", base({ attestedVia: "attested:touch-id", surface: 1 })],
  ["attested-upper", base({ attestedVia: "attested:Touch-ID" })], ["attested-dash-first", base({ attestedVia: "attested:-x" })],
  ["attested-32", base({ attestedVia: `attested:${long(32)}` })], ["attested-33", base({ attestedVia: `attested:${long(33)}` })], ["attested-empty", base({ attestedVia: "attested:" })],
  ["person-256", base({ person: long(256) })], ["person-257", base({ person: long(257) })], ["person-256-units", base({ person: "\ud83d\ude00".repeat(128) })],
  ["person-257-units", base({ person: `${"\ud83d\ude00".repeat(128)}x` })], ["effect-257", base({ effect: long(257) })], ["id-257", base({ id: long(257) })],
  ["expires-past", base({ expiresAt: NOW })], ["expires-future", base({ expiresAt: NOW + 1 })], ["expires-nan", base({ expiresAt: Number.NaN })], ["expires-infinite", base({ expiresAt: Number.POSITIVE_INFINITY })],
  ["once-ok", base({ scope: "once", match: { kind: "action" }, actionHash: "h" })], ["once-no-hash", base({ scope: "once", match: { kind: "action" } })],
  ["once-empty-hash", base({ scope: "once", match: { kind: "action" }, actionHash: "" })], ["once-capability", base({ scope: "once", match: { kind: "capability" }, actionHash: "h" })],
  ["action-not-once", base({ match: { kind: "action" }, actionHash: "h" })], ["task-no-task", base({ scope: "task" })], ["task-empty-task", base({ scope: "task", taskId: "" })],
  ["session-no-session", base({ scope: "session" })], ["job-not-always", base({ scope: "task", taskId: "t", jobId: "j" })], ["job-empty", base({ jobId: "" })],
  ["memory-job-ok", base({ capability: "memory.jobs.run", jobId: "engine:dream", surface: 2 })], ["memory-job-no-job", base({ capability: "memory.jobs.run", surface: 2 })],
  ["memory-job-delegable", base({ capability: "memory.jobs.run", jobId: "j", surface: 2, delegable: true })], ["memory-job-other-creator", base({ capability: "memory.jobs.run", jobId: "j", surface: 2, createdBy: "eva" })],
  ["memory-job-task", base({ capability: "memory.jobs.run", jobId: "j", surface: 2, taskId: "t" })], ["memory-job-path", path("/work/x", { capability: "memory.jobs.run", jobId: "j", surface: 2 })],
  ["path-ok", path("/work/x")], ["path-relative", path("work/x")], ["path-root", path("/")], ["path-trailing", path("/work/x/")], ["path-double", path("/work//x")],
  ["path-dot", path("/work/./x")], ["path-dotdot", path("/work/../x")], ["path-empty", path("")], ["path-nul", path("/work/\u0000x")], ["path-bidi", path("/work/\u202ex")],
  ["path-access", base({ match: { kind: "path", path: "/work/x", access: "exec" as never, recursive: true } })],
  ["path-etc", path("/etc")], ["path-etc-sub", path("/etc/ssh", {}, false)], ["path-home", path(HOME, {}, false)], ["path-home-task-t3", path(HOME, { scope: "task", taskId: "t" }, false)],
  ["path-home-task-t2", path(HOME, { scope: "task", taskId: "t", surface: 2 }, false)], ["path-home-child", path(`${HOME}/docs`)], ["path-homes-parent", path("/home", {}, false)],
  ["path-homes-parent-recursive-task", path("/home", { scope: "task", taskId: "t" })], ["path-users", path("/Users/x/docs")], ["path-above-home", path("/home/vector-user/../x")],
  ["path-windows-spelling", path("C:\\work\\x")], ["path-unc", path("\\\\server\\share\\x")], ["path-write-system-recursive", path("/usr", { capability: "fs.write", scope: "task", taskId: "t" }, true, "write")],
  // Review B, RB-2: the inputs where a regular expression or `trim()` of JavaScript and a hand-made port could part ways
  // (line terminators, the Unicode spaces of `\s` with U+FEFF, which JavaScript counts, and U+0085 and U+180E, which it does not).
  ...(["\ufeff", "\u0085", "\u180e", "\u2028", "\u2029", "\n", "\r", "\u000b", "\u00a0", "\u1680", "\u2000", "\u200a", "\u202f", "\u205f", "\u3000", "\u200b"] as const)
    .flatMap((c, i): [string, CreateGrantInput][] => [[`capability-space-${i}`, base({ capability: `${c}fs.read${c}` })], [`attested-tail-${i}`, base({ attestedVia: `attested:touch-id${c}`, surface: 2 })],
      [`attested-head-${i}`, base({ attestedVia: `${c}attested:touch-id`, surface: 2 })], [`path-segment-${i}`, path(`/work/${c}/x`)], [`path-inside-${i}`, path(`/work/x${c}y`)]]),
  ["capability-upper", base({ capability: "FS.READ" })], ["capability-dotless-i", base({ capability: "fs.read\u0131" })], ["attested-kelvin", base({ attestedVia: "attested:\u212a", surface: 2 })],
  ["attested-dotless-i", base({ attestedVia: "attested:\u0131", surface: 2 })], ["attested-crlf", base({ attestedVia: "attested:x\r\n", surface: 2 })],
  ["path-backslash-inside", path("/work/x\\y")], ["path-backslash-trailing", path("/work/x\\")], ["path-space-segment", path("/work/ /x")], ["path-long", path(`/work/${long(4000)}`)],
];

function rules() {
  const { db, dispose } = tempDb();
  try {
    const clock = { now: () => NOW };
    const grants = new GrantStore({ db, chain: new ApprovalChain(db, KEY, clock), clock, home: HOME });
    return RULES.map(([name, input], i) => {
      let result: unknown;
      try { result = { grant: grants.create({ id: `grt_rule_${i}`, ...input }) }; } catch (e) { result = errorOf(e); }
      // JSON has no NaN or Infinity: a non-finite `expiresAt` is named beside the input.
      const nonFinite = input.expiresAt !== undefined && !Number.isFinite(input.expiresAt) ? { expiresAt: String(input.expiresAt) } : undefined;
      return { name, input, ...(nonFinite ? { nonFinite } : {}), result };
    });
  } finally { dispose(); }
}

// ---- signatures, keys, canonical text ----

async function signing() {
  const signer = await signerOf(SIGNING);
  const other = await signerOf(OTHER_SIGNING);
  const macs = ["a".repeat(64), "0".repeat(64), createHmac("sha256", KEY).update("x").digest("hex"), "abc", "", "zz".repeat(32)];
  const sign = macs.map((mac) => ({ mac, signature: signer.sign(mac).signature }));
  const good = sign[2]!;
  const pk = signer.publicKey;
  const flip = (b64: string, i: number) => { const b = Buffer.from(b64, "base64"); b[i] = b[i]! ^ 1; return b.toString("base64"); };
  // Keys of the wrong kind, from fixed seeds: a P-256 key (SEC1 without its public point; Node derives it) and an X25519 key.
  const p256 = createPrivateKey({ key: Buffer.concat([Buffer.from("30310201010420", "hex"), seed("p256"), Buffer.from("a00a06082a8648ce3d030107", "hex")]), format: "der", type: "sec1" });
  const x25519 = createPublicKey(createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), seed("x25519")]), format: "der", type: "pkcs8" }));
  const rsaSpki = createPublicKey(p256).export({ type: "spki", format: "der" }).toString("base64");
  const verify: [string, string, string, string][] = [
    ["good", good.mac, pk, good.signature], ["mac-upper", good.mac.toUpperCase(), pk, good.signature],
    ["mac-byte", (good.mac[0] === "0" ? "1" : "0") + good.mac.slice(1), pk, good.signature], ["mac-trailing-junk", `${good.mac}zz`, pk, good.signature],
    ["mac-odd", `${good.mac}a`, pk, good.signature], ["signature-byte-0", good.mac, pk, flip(good.signature, 0)], ["signature-byte-63", good.mac, pk, flip(good.signature, 63)],
    ["signature-short", good.mac, pk, Buffer.from(good.signature, "base64").subarray(0, 63).toString("base64")],
    ["signature-long", good.mac, pk, Buffer.concat([Buffer.from(good.signature, "base64"), Buffer.alloc(1)]).toString("base64")],
    ["signature-whitespace", good.mac, pk, `${good.signature.slice(0, 20)} \n\t${good.signature.slice(20)}`],
    ["signature-url", good.mac, pk, good.signature.replaceAll("+", "-").replaceAll("/", "_")], ["signature-unpadded", good.mac, pk, good.signature.replace(/=+$/, "")],
    ["signature-junk-after-pad", good.mac, pk, `${good.signature}QUJD`], ["signature-empty", good.mac, pk, ""],
    ["key-other", good.mac, other.publicKey, good.signature], ["key-byte-last", good.mac, flip(pk, 43), good.signature], ["key-byte-prefix", good.mac, flip(pk, 3), good.signature],
    ["key-trailing-bytes", good.mac, Buffer.concat([Buffer.from(pk, "base64"), Buffer.from([0, 1])]).toString("base64"), good.signature],
    ["key-truncated", good.mac, Buffer.from(pk, "base64").subarray(0, 40).toString("base64"), good.signature],
    ["key-raw-32", good.mac, Buffer.from(pk, "base64").subarray(12).toString("base64"), good.signature],
    ["key-p256", good.mac, rsaSpki, good.signature], ["key-x25519", good.mac, x25519.export({ type: "spki", format: "der" }).toString("base64"), good.signature],
    ["key-whitespace", good.mac, ` ${pk.slice(0, 10)}\n${pk.slice(10)} `, good.signature], ["key-empty", good.mac, "", good.signature],
    ["key-params-null", good.mac, Buffer.concat([Buffer.from("302c300706032b65700500032100", "hex"), Buffer.from(pk, "base64").subarray(12)]).toString("base64"), good.signature],
  ];
  const pkcs8v2 = (createPrivateKey({ key: SIGNING, format: "der", type: "pkcs8" }) as unknown as { export(o: object): Buffer });
  const keyCases: [string, string][] = [
    ["v1", SIGNING.toString("base64")],
    ["v1-other", OTHER_SIGNING.toString("base64")],
    ["v1-exported", pkcs8v2.export({ type: "pkcs8", format: "der" }).toString("base64")],
    ["short", Buffer.alloc(8).toString("base64")], ["p256", p256.export({ type: "pkcs8", format: "der" }).toString("base64")],
    ["v1-seed-short", Buffer.concat([PKCS8_V1, seed("s").subarray(0, 31)]).toString("base64")],
    ["v1-trailing", Buffer.concat([SIGNING, Buffer.from([0])]).toString("base64")],
    ["garbage-16", seed("garbage").subarray(0, 16).toString("base64")],
  ];
  const keys: unknown[] = [];
  for (const [name, text] of keyCases) {
    const value = text;
    let result: unknown;
    try {
      const bytes = Buffer.from(value, "base64");
      if (bytes.length < 16) throw Object.assign(new Error("corrupt"), { code: "corrupt" });
      result = { publicKey: (await signerOf(bytes)).publicKey };
    } catch (e) { result = { error: (e as { code?: string }).code ?? (e as Error).name }; }
    keys.push({ name, value: parts(value), result });
  }
  const chainKeys = ["", "AAAA", Buffer.alloc(31, 3).toString("base64"), Buffer.alloc(32, 3).toString("base64"), ` ${Buffer.alloc(33, 4).toString("base64")}\n`,
    Buffer.alloc(32, 250).toString("base64").replaceAll("+", "-").replaceAll("/", "_")].map((v) => {
    const b = Buffer.from(v, "base64");
    return { value: parts(v), bytes: b.length, hex: parts(b.toString("hex")), corrupt: b.length < 32 };
  });
  return {
    publicKey: pk, otherPublicKey: other.publicKey, signing: parts(SIGNING.toString("base64")),
    sign, verify: verify.map(([name, mac, publicKey, signature]) => ({ name, mac, publicKey, signature, ok: verifyDecisionSignature(mac, publicKey, signature) })),
    keys, chainKeys,
  };
}

// ---- Ed25519 at its edges (review B, RB-1): the verdict of Node's verifier for every case, which the replay must give too ----

/**
 * `verifyDecisionSignature` over keys and signature halves of small order, mixed order, non-canonical encodings and S out
 * of range (`ed25519-cases.ts`), over more spellings of the three texts, and `loadDecisionSigner` over more PKCS #8 forms.
 *
 * A case with `divergence` is one Node accepts and the Rust port refuses on purpose (`rust` holds its answer): K3-D5 for
 * BER spellings of the SubjectPublicKeyInfo that Node never writes, K3-D6 for PKCS #8 forms it never writes. The exporter
 * refuses to record a divergence in the other direction.
 */
async function ed25519() {
  const label = "p4-k k3a vectors: ed25519";
  const SPKI = Buffer.from("302a300506032b6570032100", "hex");
  const spki = (raw: Uint8Array): string => Buffer.concat([SPKI, raw]).toString("base64");
  const cases = ed25519Cases(label, (n) => createHash("sha256").update(`${label} mac ${n}`).digest());
  const verify = cases.map((c) => {
    const mac = c.message.toString("hex");
    const publicKey = spki(c.key);
    const signature = c.signature.toString("base64");
    return { group: c.group, name: c.name, equation: c.equation, mac, publicKey, signature, ok: verifyDecisionSignature(mac, publicKey, signature) };
  });

  const honest = cases[0]!;
  const mac = honest.message.toString("hex");
  const raw = honest.key;
  const pk = spki(raw);
  const sig = honest.signature.toString("base64");
  // The honest key of `ed25519Cases(label)`: its seed is that of the label's "key".
  const seedBytes = seed("ed25519: key");
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_V1, seedBytes]), format: "der", type: "pkcs8" });
  if (!Buffer.from((createPublicKey(key).export({ type: "spki", format: "der" }) as Buffer).subarray(12)).equals(raw)) throw new Error("the honest key is not the key of the cases");
  const ofEmpty = sign(null, Buffer.alloc(0), key).toString("base64");
  const der = (head: string, tail = ""): string => Buffer.concat([Buffer.from(head, "hex"), raw, Buffer.from(tail, "hex")]).toString("base64");
  const SPELLINGS: [string, string, string, string, string?][] = [
    ["plain", mac, pk, sig],
    ["signature with non-ASCII inside", mac, pk, `${sig.slice(0, 20)}\u00e9\u20ac${sig.slice(20)}`],
    ["signature twice", mac, pk, Buffer.concat([honest.signature, honest.signature]).toString("base64")],
    ["key in the URL alphabet", mac, Buffer.from(pk, "base64").toString("base64url"), sig],
    ["key with one trailing byte", mac, der("302a300506032b6570032100", "00"), sig],
    ["key with the unused-bits octet 1", mac, der("302a300506032b6570032101"), sig],
    ["key as PEM text", mac, Buffer.from(createPublicKey(key).export({ type: "spki", format: "pem" }) as string).toString("base64"), sig],
    ["key with a long-form outer length", mac, der("30812a300506032b6570032100"), sig, "K3-D5"],
    ["key with a long-form bit string length", mac, der("302b300506032b657003812100"), sig, "K3-D5"],
    ["key with an indefinite outer length", mac, der("3080300506032b6570032100", "0000"), sig, "K3-D5"],
    ["mac with junk after it", `${mac}zz00`, pk, sig],
    ["mac one byte short", mac.slice(0, 62), pk, sig],
    ["empty mac against a signature of nothing", "", pk, ofEmpty],
    ["mac starting with junk against a signature of nothing", `zz${mac}`, pk, ofEmpty],
  ];
  const spellings = SPELLINGS.map(([name, m, publicKey, signature, divergence]) => {
    const ok = verifyDecisionSignature(m, publicKey, signature);
    if (divergence !== undefined && !ok) throw new Error(`${name}: a divergence is recorded only where Node accepts and Rust refuses`);
    return { name, mac: m, publicKey, signature, ok, ...(divergence === undefined ? {} : { divergence, rust: false }) };
  });

  const other = Buffer.from((createPublicKey(createPrivateKey({ key: pkcs8("ed25519: other key"), format: "der", type: "pkcs8" })).export({ type: "spki", format: "der" }) as Buffer).subarray(12));
  const p8 = (head: string, ...rest: Uint8Array[]): Buffer => Buffer.concat([Buffer.from(head, "hex"), ...rest]);
  const KEYS: [string, Buffer, string?][] = [
    ["v1 with trailing bytes", p8("302e020100300506032b657004220420", seedBytes, Buffer.from("0000ff", "hex"))],
    ["v1 with a truncated seed", p8("302e020100300506032b657004220420", seedBytes).subarray(0, 47)],
    ["v1 with a 31-byte seed and matching lengths", p8("302d020100300506032b65700421041f", seedBytes.subarray(0, 31))],
    ["v2 with its public key", p8("3051020101300506032b657004220420", seedBytes, Buffer.from("812100", "hex"), raw)],
    ["v2 with another public key", p8("3051020101300506032b657004220420", seedBytes, Buffer.from("812100", "hex"), other), "K3-D6"],
    ["version 1 without a public key", p8("302e020101300506032b657004220420", seedBytes), "K3-D6"],
    ["long-form outer length", p8("30812e020100300506032b657004220420", seedBytes), "K3-D6"],
    ["X25519 object identifier", p8("302e020100300506032b656e04220420", seedBytes)],
    ["16 zero bytes", Buffer.alloc(16)],
    ["the bare seed", seedBytes],
    ["v1 with attributes", p8("3030020100300506032b657004220420", seedBytes, Buffer.from("a000", "hex"))],
    ["PEM text", Buffer.from(key.export({ type: "pkcs8", format: "pem" }) as string)],
  ];
  const keys: unknown[] = [];
  for (const [name, bytes, divergence] of KEYS) {
    let result: unknown;
    try { result = { publicKey: (await signerOf(bytes)).publicKey }; } catch (e) { result = { error: (e as { code?: string }).code ?? (e as Error).name }; }
    if (divergence !== undefined && !(result as { publicKey?: string }).publicKey) throw new Error(`${name}: a divergence is recorded only where Node loads and Rust refuses`);
    keys.push({ name, value: parts(bytes.toString("base64")), result, ...(divergence === undefined ? {} : { divergence, rust: { error: "corrupt" } }) });
  }
  return { smallOrder: SMALL_ORDER_ENCODINGS.map((e) => ({ name: e.name, hex: e.bytes.toString("hex") })), verify, spellings, keys };
}

function canonical() {
  const hmac = (s: string) => createHmac("sha256", KEY).update(s).digest("hex");
  const inputs: [string, number, number, string, string, string | null, string][] = [
    ["0".repeat(64), 1, NOW, "approval.requested", "apr_a", "n", "{}"], ["x", 2, 0, "k", "r", null, "\"\u2028\u2029\u0000\u001f\u007f\\\""],
    ["x", 3, -5, "k\u00e9", "r\ud83d\ude00", "\t", "[1,2]"], ["x", 2 ** 53 - 1, 1.5, "", "", "", ""], ["x", 1, 1e21, "k", "r", "n", "p"],
  ];
  const mac = inputs.map(([prev, seq, ts, kind, ref, nonce, payload]) => {
    const text = JSON.stringify([prev, seq, ts, kind, ref, nonce, payload]);
    return { prev, seq, ts, kind, ref, nonce, payload, text, mac: hmac(text) };
  });
  const tag = [[1, "a".repeat(64)], [99, ""], [0.5, "\u00e9"]].map(([seq, m]) => { const text = JSON.stringify(["head", seq, m]); return { seq, mac: m, text, tag: hmac(text) }; });
  const tuples = [
    BINDING, { ...BINDING, subject: null }, { ...BINDING, subject: "x" }, { ...BINDING, turnId: 1 }, [], null, "s", { ...BINDING, extra: 1 },
    { ...BINDING, subject: { kind: "agent", id: "\u2028" } }, { actionHash: "", principal: "", subject: { kind: "", id: "" }, turnId: "", taskId: "", sessionId: "" },
  ].map((b) => ({ inputJson: JSON.stringify(b), tuple: bindingTuple(b) }));
  const restringify = [
    "{\"b\":1,\"a\":2}", "{\"2\":1,\"10\":2,\"b\":3,\"1\":4,\"01\":5,\"4294967295\":6,\"4294967294\":7}", "[1.0,1e2,-0,0.1,1e-7,123456789012345680000]",
    "{\"a\":1,\"a\":2}", "\"\\u00e9\\ud83d\\ude00\\u2028\"", "{\"x\":{\"y\":[null,true,{\"z\":\"\\u0001\"}]}}", "1e21", "-0", "9007199254740993",
  ].map((text) => ({ text, out: JSON.stringify(JSON.parse(text)) }));
  return { key: parts(KEY.toString("hex")), mac, tag, tuples, restringify };
}

export async function buildApprovalsVectors() {
  const { cells, cellsGrants } = await cellVectors();
  return { canonical: canonical(), cells, "cells-grants": cellsGrants, chain: await mainScenario(), ed25519: await ed25519(), regex: await regexVectors(), rules: rules(), semantic: await semantic(), signing: await signing() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await exporterMain({ area: "approvals", build: buildApprovalsVectors });
}
