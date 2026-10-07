// Child process for the concurrent-writer test: appends `count` events to the chain in `dir`.
import { createAuditChain } from "../../src/audit/chain.ts";

const [dir, tag, countArg] = process.argv.slice(2);
const chain = createAuditChain({ dir: dir as string, lockTimeoutMs: 20000 });
for (let i = 0; i < Number(countArg); i++) {
  chain.append({ at: 1000 + i, actor: { user: String(tag), host: "test" }, action: "test.event", target: `${tag}-${i}`, detail: { i } });
}
