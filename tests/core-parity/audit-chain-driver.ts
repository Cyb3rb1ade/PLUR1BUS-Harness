// The TypeScript side of the audit-chain cross test (P4-K K2, plan P4-21): `crates/plur1bus-core/tests/audit_chain_cross.rs`
// writes a chain with the Rust core's sink, and this driver reads it with the product code.
//
//   verify <dir>   prints `createAuditChain({ dir }).verify()` and the records of the active file, as JSON
//   append <dir>   appends one event through the TypeScript chain (the other writer of the same file)
import { readFileSync } from "node:fs";
import path from "node:path";
import { ACTIVE_NAME, createAuditChain } from "../../packages/core/src/audit/chain.ts";

const [command, dir] = process.argv.slice(2);
if (!dir) throw new Error("usage: audit-chain-driver.ts verify|append <dir>");
const chain = createAuditChain({ dir });
if (command === "verify") {
  const result = chain.verify();
  const lines = readFileSync(path.join(dir, ACTIVE_NAME), "utf8").split("\n").filter((l) => l !== "");
  process.stdout.write(`${JSON.stringify({ result, records: lines.map((l) => JSON.parse(l).rec) })}\n`);
} else if (command === "append") {
  chain.append({ at: 3, actor: { user: "ts-core", host: "h2" }, action: "grant.created", target: "grant:g9", detail: { scope: "task" } });
  process.stdout.write("{}\n");
} else {
  throw new Error(`unknown command ${command}`);
}
