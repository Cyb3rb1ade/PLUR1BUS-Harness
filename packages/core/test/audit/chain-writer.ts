// Child process for the concurrent-writer test: appends `count` events to the chain in `dir`.
import { createAuditChain } from "../../src/audit/index.ts";

const [dir, id, count] = process.argv.slice(2);
if (!dir || !id || !count) { process.stderr.write("usage: chain-writer <dir> <id> <count>\n"); process.exit(2); }
const chain = createAuditChain({ dir, maxBytes: 4000 });
for (let i = 0; i < Number(count); i++) {
  chain.append({ at: Date.now(), actor: { user: `w${id}`, host: "h" }, action: "test.event", target: `w${id}-${i}`, detail: { i } });
}
