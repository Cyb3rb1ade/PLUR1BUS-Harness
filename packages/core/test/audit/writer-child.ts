// Child process for the concurrent-writer test: appends `count` events to the chain in `dir`.
import { readSync, writeSync } from "node:fs";
import { createAuditChain } from "../../src/audit/chain.ts";

const [dir, tag, countArg, mode] = process.argv.slice(2);
const chain = createAuditChain({ dir: dir as string, lockTimeoutMs: 20000 });
for (let i = 0; i < Number(countArg); i++) {
  if (mode === "--stepped") {
    const advance = Buffer.alloc(1);
    if (readSync(0, advance, 0, 1, null) !== 1 || advance[0] !== 1) throw new Error("audit writer round was not released");
  }
  chain.append({ at: 1000 + i, actor: { user: String(tag), host: "test" }, action: "test.event", target: `${tag}-${i}`, detail: { i } });
  if (mode === "--stepped") writeSync(1, Buffer.from([6]));
}
