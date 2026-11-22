// ChatGPT-plan usage store round trip, parity mode B (P4-K K4, plan P4-23): the TypeScript side that
// `crates/plur1bus-core/tests/openai_usage_mode_b.rs` drives.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning tests/core-parity/openai-usage-b-driver.ts prepare <dir>
//   node ... tests/core-parity/openai-usage-b-driver.ts verify <dir>
//
// `prepare` writes `usage-ts.sqlite` with the product code (`PlanUsageStore`): calls of two people, one with unknown usage, one
// repeated id, and `usage-ref.sqlite`, the same store opened and closed with no data (the reference for the schema text); it
// prints the totals TypeScript reads. The Rust test reads and writes a copy (`usage-rust.sqlite`) and creates a fresh file
// (`usage-fresh-rust.sqlite`); `verify` opens both with the product code and prints the totals and the schema texts. Test
// tooling only; no product code imports it.
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PlanUsageStore } from "../../packages/core/src/openai-auth/usage.ts";

const [command, dir] = process.argv.slice(2);
if (!dir || (command !== "prepare" && command !== "verify")) throw new Error("usage: openai-usage-b-driver.ts prepare|verify <dir>");

const schemaOf = (path: string): unknown[] => {
  const db = new DatabaseSync(path);
  try { return db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all(); } finally { db.close(); }
};
const rows = (path: string): unknown[] => {
  const db = new DatabaseSync(path);
  try { return db.prepare("SELECT * FROM plan_usage ORDER BY rowid").all(); } finally { db.close(); }
};
const totals = (path: string) => {
  const s = new PlanUsageStore(path);
  try { return { alice: s.total("alice"), bob: s.total("bob"), carol: s.total("carol") }; } finally { s.close(); }
};

if (command === "prepare") {
  const path = join(dir, "usage-ts.sqlite");
  const s = new PlanUsageStore(path);
  s.record("call-1", "alice", "cred-a", "fixture-model", { inputTokens: 10, outputTokens: 20 }, 1_000);
  s.record("call-2", "alice", "cred-a", "fixture-model", {}, 1_001);
  s.record("call-3", "bob", "cred-b", "other-model", { inputTokens: 7 }, 1_002);
  s.record("call-1", "alice", "cred-a", "fixture-model", { inputTokens: 999, outputTokens: 999 }, 1_003);
  let refused = "";
  try { s.record("call-4", "alice", "cred-a", "m", { inputTokens: -1 }, 1_004); } catch (e) { refused = (e as Error).name + ": " + (e as Error).message; }
  s.close();
  new PlanUsageStore(join(dir, "usage-ref.sqlite")).close();
  console.log(JSON.stringify({ totals: totals(path), rows: rows(path), refused, schema: schemaOf(path) }));
} else {
  // Copies, so the product code's own open does not change what Rust left.
  for (const name of ["usage-rust", "usage-fresh-rust"]) copyFileSync(join(dir, `${name}.sqlite`), join(dir, `${name}-check.sqlite`));
  console.log(JSON.stringify({
    rust: { totals: totals(join(dir, "usage-rust-check.sqlite")), rows: rows(join(dir, "usage-rust.sqlite")) },
    fresh: { totals: totals(join(dir, "usage-fresh-rust-check.sqlite")), rows: rows(join(dir, "usage-fresh-rust.sqlite")) },
    schema: { ref: schemaOf(join(dir, "usage-ref.sqlite")), rust: schemaOf(join(dir, "usage-rust.sqlite")), fresh: schemaOf(join(dir, "usage-fresh-rust.sqlite")) },
  }));
}
