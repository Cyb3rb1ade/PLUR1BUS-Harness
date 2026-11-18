// Capability registry round trip, parity mode B (P4-K K9b, plan P4-42): the TypeScript side that
// `crates/plur1bus-core/tests/toolcall_mode_b.rs` drives.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning tests/core-parity/toolcall-b-driver.ts prepare <dir>
//   node ... tests/core-parity/toolcall-b-driver.ts verify <dir>
//
// `prepare` writes real TypeScript files into <dir>, with the product code:
//   capabilities-ts.sqlite    three entries, counters of two agents in two hourly buckets, one vector
//   capabilities-ref.sqlite   the registry opened and closed with no data: the reference for the schema text
//   manifest.json             the clock and the hashes the Rust test compares
// The Rust test continues a copy (`capabilities-rust.sqlite`) and creates a fresh file (`capabilities-fresh-rust.sqlite`);
// `verify` opens both with the product code and prints one JSON object. Test tooling only; no product code imports it.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteCapabilityRegistry } from "../../packages/core/src/toolcall/sqlite-registry.ts";
import type { CapabilityEntry } from "../../packages/core/src/toolcall/capabilities.ts";

const HOUR = 3_600_000;
const START = 480_000 * HOUR;
const entry = (id: string, over: Record<string, unknown> = {}): CapabilityEntry => ({ id, name: id, description: "Create a document report", category: "docs.create", kind: "tool", effect: "read", risk: "low", source: "ts", version: "1", ...over }) as CapabilityEntry;

function schema(path: string): string {
  const db = new DatabaseSync(path);
  try { return JSON.stringify(db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()); } finally { db.close(); }
}
function pragma(path: string, name: string): unknown {
  const db = new DatabaseSync(path);
  try { return Object.values(db.prepare(`PRAGMA ${name}`).get() as object)[0]; } finally { db.close(); }
}

function prepare(dir: string): void {
  let now = START;
  const registry = new SqliteCapabilityRegistry(join(dir, "capabilities-ts.sqlite"), () => now);
  registry.upsert(entry("ts_report", { useWhen: "The person wants a written report" }));
  registry.upsert(entry("ts_file", { description: "Read a file from disk", category: "files.read" }));
  registry.upsert(entry("ts_old", { description: "An entry Rust will replace by a new version" }));
  for (const event of ["offered", "offered", "used", "succeeded"] as const) registry.record("ts_report", "alice", event);
  registry.record("ts_report", "bob", "foundBySearch");
  registry.record("ts_old", "alice", "offered");
  now += 24 * HOUR;
  registry.record("ts_report", "alice", "offered");
  registry.putVector("ts_report", registry.hash("ts_report")!, "model-a", [0.1, -0.25, 1e-7, 3]);
  const manifest = { start: START, now, hashes: { ts_report: registry.hash("ts_report"), ts_file: registry.hash("ts_file") }, snapshot: registry.snapshot() };
  registry.close();
  new SqliteCapabilityRegistry(join(dir, "capabilities-ref.sqlite"), () => now).close();
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
}

function verify(dir: string): void {
  const ref = schema(join(dir, "capabilities-ref.sqlite"));
  const out: Record<string, unknown> = {};
  for (const name of ["capabilities-rust", "capabilities-fresh-rust"]) {
    const path = join(dir, `${name}.sqlite`);
    const before = { schema: schema(path) === ref, integrity: pragma(path, "integrity_check"), journal: pragma(path, "journal_mode"), userVersion: pragma(path, "user_version") };
    const registry = new SqliteCapabilityRegistry(path, () => START + 48 * HOUR);
    const all = new Set(registry.snapshot().map(e => e.id));
    out[name] = {
      ...before,
      snapshot: registry.snapshot(),
      hashes: Object.fromEntries([...all].map(id => [id, registry.hash(id)])),
      alice: registry.stats("ts_report", "alice"), carol: registry.stats("ts_report", "carol"), old: registry.stats("ts_old", "alice"),
      rustStats: registry.stats("rust_tool", "carol"), agents: registry.agents(),
      weighted: registry.weightedStats("ts_report", undefined, 1),
      search: registry.search("rust written report", all, 128).map(e => e.id),
      vectorA: registry.vector("ts_report", "model-a") ?? null, vectorRust: registry.vector("rust_tool", "model-r") ?? null,
      // TypeScript continues the file Rust wrote.
      again: (() => { registry.upsert(entry("ts_again")); registry.record("rust_tool", "carol", "used"); return [registry.snapshot().length, registry.stats("rust_tool", "carol")]; })(),
    };
    registry.close();
    (out[name] as any).after = { schema: schema(path) === ref, integrity: pragma(path, "integrity_check") };
  }
  process.stdout.write(JSON.stringify(out));
}

const [command, dir] = process.argv.slice(2);
if (!dir || (command !== "prepare" && command !== "verify")) { process.stderr.write("usage: toolcall-b-driver.ts prepare|verify <dir>\n"); process.exit(2); }
if (command === "prepare") prepare(dir); else verify(dir);
