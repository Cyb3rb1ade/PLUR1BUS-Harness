// Budget store round trip, parity mode B (P4-K K1, plan P4-24): the TypeScript side that
// `crates/plur1bus-core/tests/budget_mode_b.rs` drives.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning tests/core-parity/budget-b-driver.ts prepare <dir>
//   node ... tests/core-parity/budget-b-driver.ts verify <dir>
//
// `prepare` writes real TypeScript files into <dir>:
//   budget-v1.sqlite        the budget store at schema version 1 (through the store's own `migrateBudgetSteps`) with one usage row
//   budget-v2.sqlite        version 2 written by the product code: a limit and a usage event (the service), a call limit and a
//                           pending reservation (the call port, which creates its tables outside `user_version`), a peer
//                           reservation (the A2A budget, likewise)
//   budget-ref-v2.sqlite    version 2 with no data, the reference for the schema text of a migration
//   budget-ref-full.sqlite  version 2 plus the call and peer tables with no data, the reference for a fresh Rust file
//   licences.sqlite         one confirmed licence
//   licences-ref.sqlite     the licence ledger with no data
//   manifest.json           what the Rust test must find, and the ids it needs
// The Rust test reads and writes copies of them and leaves `*-rust.sqlite` files; `verify` opens those with the product code
// (on copies) and prints one JSON object. Test tooling only; no product code imports it.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StoreCopy, createStoreAtVersion } from "./store-roundtrip.ts";
import { BUDGET_MIGRATIONS, migrateBudgetSteps } from "../../packages/core/src/budget/store.ts";
import { createBudgetService } from "../../packages/core/src/budget/service.ts";
import { createCallBudget } from "../../packages/core/src/budget/calls.ts";
import { PeerCallBudget } from "../../packages/core/src/budget/peer.ts";
import { LicenceLedger } from "../../packages/core/src/licences/ledger.ts";
import { memoryModel } from "../../packages/core/src/licences/memory.ts";
import { memoryAuditSink } from "../../packages/core/src/rbac/audit.ts";

const NOW = Date.UTC(2026, 9, 6, 12);
const clock = { now: () => NOW };
const IDENTITY = { person: "person", agent: "main", session: "session", turn: "turn", peer: "peer" };
const PEER_LIMITS = { peerCalls: 2, turnCalls: 3, peerTokens: 100, turnTokens: 150 };
const MODEL = "jinaai/jina-embeddings-v3";

function budgetFile(path: string, data: boolean): { reservationId?: string } {
  mkdirSync(join(path, ".."), { recursive: true });
  const svc = createBudgetService({ path, clock });
  const out: { reservationId?: string } = {};
  if (data) {
    svc.setLimit({ scope: "global", period: "day", metric: "tokens", hard: 100_000 });
    svc.recordUsage({ agent: "ts-agent", model: "m", inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500, requestId: "ts-1" });
  }
  svc.close();
  const gate = createCallBudget({ path, clock });
  if (data) {
    gate.setLimit({ scope: "user", id: "u1", period: "day", metric: "tokens", hard: 100 });
    const d = gate.checkBeforeCall({ principal: "u1", agent: "a1", project: "p1", model: "m", estimatedInputTokens: 50, maxOutputTokens: 0 });
    if (d.kind !== "allow") throw new Error("setup: the reservation was refused");
    out.reservationId = d.reservationId;
  }
  gate.close();
  const peer = new PeerCallBudget({ path, now: () => NOW });
  if (data && peer.reserve(IDENTITY, 60, PEER_LIMITS).kind !== "allow") throw new Error("setup: the peer reservation was refused");
  peer.close();
  return out;
}

function prepare(dir: string): void {
  createStoreAtVersion({ path: join(dir, "budget-v1.sqlite"), migrations: BUDGET_MIGRATIONS, version: 1, migrate: migrateBudgetSteps });
  const v1 = new DatabaseSync(join(dir, "budget-v1.sqlite"));
  v1.prepare("INSERT INTO usage_event (ts, agent, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_micros, price_version, request_id) VALUES (?, 'v1-agent', '', 'm', 40, 2, 0, 0, NULL, 'v0', NULL)").run(NOW);
  v1.close();
  createStoreAtVersion({ path: join(dir, "budget-ref-v2.sqlite"), migrations: BUDGET_MIGRATIONS, version: BUDGET_MIGRATIONS.length, migrate: migrateBudgetSteps });
  const { reservationId } = budgetFile(join(dir, "budget-v2.sqlite"), true);
  budgetFile(join(dir, "budget-ref-full.sqlite"), false);
  const m = memoryModel(MODEL);
  const ledger = new LicenceLedger(join(dir, "licences.sqlite"), memoryAuditSink(), () => 12345);
  const acceptance = ledger.confirm("owner", m.model, m.licence, m.revision, "memory");
  ledger.close();
  new LicenceLedger(join(dir, "licences-ref.sqlite"), memoryAuditSink(), () => 1).close();
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ version: BUDGET_MIGRATIONS.length, now: NOW, reservationId, acceptance, model: m }));
}

/** `sqlite_master` without the rows SQLite generates itself, in a stable order: what the code that made the file produced. */
function schemaOf(copy: StoreCopy): string {
  return JSON.stringify(copy.read("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"));
}

function verify(dir: string): Record<string, unknown> {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const rust = JSON.parse(readFileSync(join(dir, "rust-results.json"), "utf8"));
  const migrated = StoreCopy.open(join(dir, "budget-migrated-rust.sqlite"));
  const refV2 = StoreCopy.open(join(dir, "budget-ref-v2.sqlite"));
  const full = StoreCopy.open(join(dir, "budget-fresh-rust.sqlite"));
  const refFull = StoreCopy.open(join(dir, "budget-ref-full.sqlite"));
  const lic = StoreCopy.open(join(dir, "licences-fresh-rust.sqlite"));
  const licRef = StoreCopy.open(join(dir, "licences-ref.sqlite"));
  const written = StoreCopy.open(join(dir, "budget-v2-rust.sqlite"));
  const licences = StoreCopy.open(join(dir, "licences-rust.sqlite"));
  try {
    const out: Record<string, unknown> = {
      migrated: { userVersion: migrated.userVersion(), sameSchema: schemaOf(migrated) === schemaOf(refV2), check: migrated.check() },
      fresh: { sameSchema: schemaOf(full) === schemaOf(refFull), userVersion: full.userVersion() },
      licencesFresh: { sameSchema: schemaOf(lic) === schemaOf(licRef) },
    };
    // The product code reads what Rust wrote: the service, the call port and the peer budget, each on its own copy of the file.
    const svc = createBudgetService({ path: written.path, clock });
    const day = svc.status().periods[0]!;
    const limits = svc.limits().map((l) => [l.scope, l.period, l.metric, l.hard]);
    svc.close();
    const mig = createBudgetService({ path: migrated.path, clock });
    const migratedDay = mig.status().periods[0]!;
    mig.close();
    const gate = createCallBudget({ path: written.path, clock });
    const tsReservation = gate.reservation(manifest.reservationId);
    const rustReservation = gate.reservation(rust.reservationId);
    const over = gate.checkBeforeCall({ principal: "u1", agent: "a1", project: "p1", model: "m", estimatedInputTokens: 30, maxOutputTokens: 0 }).kind;
    const exact = gate.checkBeforeCall({ principal: "u1", agent: "a1", project: "p1", model: "m", estimatedInputTokens: 20, maxOutputTokens: 0 }).kind;
    gate.close();
    const peer = new PeerCallBudget({ path: written.path, now: () => NOW });
    const peerAfter = [peer.reserve(IDENTITY, 1, PEER_LIMITS).kind];
    peer.close();
    const ledger = new LicenceLedger(licences.path, memoryAuditSink(), () => 1);
    const list = ledger.list();
    ledger.close();
    out.service = { events: day.total.events, inputTokens: day.total.inputTokens, limits, migratedEvents: migratedDay.total.events, migratedInput: migratedDay.total.inputTokens };
    out.calls = {
      tsReservation: tsReservation && { state: tsReservation.state, tokens: tsReservation.tokens },
      rustReservation: rustReservation && { state: rustReservation.state, tokens: rustReservation.tokens },
      over, exact,
    };
    out.peer = peerAfter;
    out.licences = list;
    return out;
  } finally {
    for (const c of [migrated, refV2, full, refFull, lic, licRef, written, licences]) c.dispose();
  }
}

const [command, dir] = process.argv.slice(2);
if (!dir || (command !== "prepare" && command !== "verify")) {
  console.error("usage: budget-b-driver.ts prepare|verify <dir>");
  process.exit(2);
}
if (command === "prepare") prepare(dir);
else console.log(JSON.stringify(verify(dir)));
