// Approvals store round trip, parity mode B (P4-K K3a, plan P4-22): the TypeScript side that
// `crates/plur1bus-core/tests/approvals_mode_b.rs` drives.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning tests/core-parity/approvals-b-driver.ts prepare <dir>
//   node ... tests/core-parity/approvals-b-driver.ts verify <dir>
//
// `prepare` writes real TypeScript files into <dir>:
//   approvals-v1.sqlite .. approvals-v3.sqlite  the store at schema versions 1 to 3 (through the store's own
//                          `migrateApprovalsSteps`), holding the rows the product code wrote into a seed file (approvals
//                          requested, approved, used, denied; grants created, used, revoked; one chain over all of them)
//   approvals-v4.sqlite    version 4 written by the product code with a signer: the same history plus a signed decision,
//                          a pending request for Rust to decide, a once grant for Rust to consume, an attested grant
//   approvals-ref-v4.sqlite  version 4 with no data, the reference for the schema text
//   manifest.json          the test key material (made here, test-only), the ids and nonces Rust needs
// The Rust test reads and writes copies and leaves `*-rust.sqlite` files and `rust-results.json`; `verify` opens those with
// the product code (on copies), checks chain and signatures with TypeScript's own verifier, decides and consumes what Rust
// left pending, verifies again, and prints one JSON object. Test tooling only; no product code imports it.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StoreCopy, createStoreAtVersion } from "./store-roundtrip.ts";
import { APPROVALS_MIGRATIONS, migrateApprovalsSteps, openApprovalsDb } from "../../packages/core/src/approvals/db.ts";
import { staticKeySource } from "../../packages/core/src/approvals/keys.ts";
import { loadDecisionSigner, verifyDecisionSignature } from "../../packages/core/src/approvals/signing.ts";
import { openPermissionStores, type PermissionStores } from "../../packages/core/src/grants/open.ts";

const NOW = Date.UTC(2026, 10, 18, 9, 0, 0);
const KEY = createHash("sha256").update("p4-k k3a mode b: chain key").digest();
const SIGNING = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), createHash("sha256").update("p4-k k3a mode b: signing key").digest()]);
const BINDING = { actionHash: "h1", principal: "christian", subject: { kind: "agent" as const, id: "bernd" }, turnId: "turn1", taskId: "t1", sessionId: "s1" };

class Clock { t = NOW; now(): number { return this.t; } }

async function stores(path: string, clock: Clock, signed: boolean): Promise<PermissionStores> {
  const signer = signed ? await loadDecisionSigner({ load: async () => Uint8Array.from(SIGNING) }) : undefined;
  return openPermissionStores({ path, keys: staticKeySource(KEY), clock, ...(signer ? { signer } : {}) });
}

/** The history every file holds: written by the product code. */
function history(s: PermissionStores, clock: Clock): Record<string, string> {
  const a = s.approvals.request({ ...BINDING, capability: "fs.write", detail: { tool: "fs.write", risk: "low" } });
  clock.t += 1; s.approvals.decide({ requestId: a.id, nonce: a.nonce, decision: "approve", person: "christian", surface: 3, delegable: true });
  clock.t += 1; s.approvals.consume({ ...BINDING, requestId: a.id });
  const b = s.approvals.request({ ...BINDING, actionHash: "h2", capability: "shell.exec" });
  clock.t += 1; s.approvals.decide({ requestId: b.id, nonce: b.nonce, decision: "deny", person: "christian", surface: 2 });
  const cap = s.grants.create({ capability: "fs.read", person: "christian", agent: "bernd", scope: "always", match: { kind: "capability" }, createdBy: "christian", surface: 3 });
  const path = s.grants.create({ capability: "fs.write", person: "christian", agent: "bernd", scope: "session", sessionId: "s1", match: { kind: "path", path: "/work/proj", access: "write", recursive: true }, createdBy: "christian", surface: 2 });
  clock.t += 1; s.grants.markUsed(cap.id);
  clock.t += 1; s.grants.revoke(path.id, "christian");
  return { approved: a.id, denied: b.id, cap: cap.id, revoked: path.id };
}

const COPIED = ["approval_chain", "chain_head", "approvals"];

function copyInto(seed: string, target: string, version: number): void {
  const db = new DatabaseSync(target);
  try {
    db.exec(`ATTACH DATABASE '${seed.replaceAll("'", "''")}' AS seed`);
    for (const t of COPIED) db.exec(`INSERT INTO main.${t} SELECT * FROM seed.${t}`);
    const cols = ["id", "person", "agent", "capability", "effect", "match_kind", "match_path", "match_access", "match_recursive", "duration", "created_by",
      "created_at", "expires_at", "revoked_at", "end_reason", "last_used_at", "consumed_at", "action_hash", "task_id", "session_id", "project_id", "job_id",
      "delegable", "surface", "acknowledged_unsandboxed", "def_hash", "chain_seq", ...(version >= 2 ? ["attested_via"] : [])].join(", ");
    db.exec(`INSERT INTO main.grants (${cols}) SELECT ${cols} FROM seed.grants`);
    db.exec("DETACH DATABASE seed");
  } finally { db.close(); }
}

async function prepare(dir: string): Promise<void> {
  const seedPath = join(dir, "seed.sqlite");
  const clock = new Clock();
  const seed = await stores(seedPath, clock, false);
  const ids = history(seed, clock);
  seed.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  seed.close();
  for (const v of [1, 2, 3]) {
    const path = join(dir, `approvals-v${v}.sqlite`);
    createStoreAtVersion({ path, migrations: APPROVALS_MIGRATIONS, version: v, migrate: migrateApprovalsSteps });
    copyInto(seedPath, path, v);
  }
  // Version 4, signed, with work left for Rust.
  const c4 = new Clock();
  const s4 = await stores(join(dir, "approvals-v4.sqlite"), c4, true);
  const ids4 = history(s4, c4);
  const pending = s4.approvals.request({ ...BINDING, actionHash: "h3", capability: "fs.write" });
  const once = s4.grants.create({ capability: "fs.write", person: "christian", agent: "bernd", scope: "once", match: { kind: "action" }, actionHash: "h-once", createdBy: "christian", surface: 3 });
  const attested = s4.grants.create({ capability: "fs.read", person: "christian", agent: "bernd", scope: "always", match: { kind: "path", path: "/work/docs", access: "read", recursive: false }, createdBy: "christian", surface: 2, attestedVia: "attested:touch-id" });
  s4.close();
  openApprovalsDb({ path: join(dir, "approvals-ref-v4.sqlite") }).close();
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    version: APPROVALS_MIGRATIONS.length, now: NOW, key: KEY.toString("hex"), signing: SIGNING.toString("base64"),
    ids, v4: { ...ids4, pending: pending.id, pendingNonce: pending.nonce, once: once.id, attested: attested.id }, clockAfterHistory: clock.t,
  }));
}

/** `sqlite_master` without the rows SQLite generates itself, in a stable order: what the code that made the file produced. */
function schemaOf(copy: StoreCopy): string {
  return JSON.stringify(copy.read("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"));
}

async function verify(dir: string): Promise<Record<string, unknown>> {
  const rust = JSON.parse(readFileSync(join(dir, "rust-results.json"), "utf8"));
  const ref = StoreCopy.open(join(dir, "approvals-ref-v4.sqlite"));
  const out: Record<string, unknown> = {};
  try {
    for (const name of ["v1", "v2", "v3", "v4", "fresh"]) {
      const copy = StoreCopy.open(join(dir, `approvals-${name}-rust.sqlite`));
      try {
        const clock = new Clock();
        clock.t = rust.now;
        const signed = name === "v4";
        const s = await stores(copy.path, clock, signed);
        const sigRows = s.db.prepare("SELECT s.seq, s.public_key, s.signature, c.mac FROM approval_signatures s JOIN approval_chain c ON c.seq = s.seq").all() as { public_key: string; signature: string; mac: string }[];
        const entry: Record<string, unknown> = {
          userVersion: copy.userVersion(), sameSchema: schemaOf(copy) === schemaOf(ref), check: copy.check(),
          verify: s.approvals.verify(),
          signaturesByTypeScript: sigRows.map((r) => verifyDecisionSignature(r.mac, r.public_key, r.signature)),
          approvals: s.approvals.list().map((r) => [r.id, r.status, r.delegable]),
          grants: s.grants.inspect().map((v) => [v.grant.id, v.state, v.grant.scope, v.grant.attestedVia ?? null, v.grant.lastUsedAt ?? null]),
        };
        // TypeScript writes after Rust: it decides and uses what Rust left pending, then the chain still verifies.
        const left = rust.files[name] as { pending?: string; pendingNonce?: string } | undefined;
        if (left?.pending) {
          clock.t += 1;
          const d = s.approvals.decide({ requestId: left.pending, nonce: left.pendingNonce!, decision: "approve", person: "christian", surface: 3 });
          const used = s.approvals.consume({ ...BINDING, actionHash: "h-rust", requestId: left.pending });
          entry.typescriptAfterRust = { decided: d.ok, used: used.ok, verify: s.approvals.verify() };
        }
        s.close();
        out[name] = entry;
      } finally { copy.dispose(); }
    }
  } finally { ref.dispose(); }
  return out;
}

const [command, dir] = process.argv.slice(2);
if (!dir || (command !== "prepare" && command !== "verify")) {
  console.error("usage: approvals-b-driver.ts prepare|verify <dir>");
  process.exit(2);
}
if (command === "prepare") await prepare(dir);
else console.log(JSON.stringify(await verify(dir)));
