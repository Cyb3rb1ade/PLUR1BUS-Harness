// Worker for the race test: opens the same approvals file, waits on the gate, then tries to consume the once grant.
import { parentPort, workerData } from "node:worker_threads";
import { staticKeySource } from "../../src/approvals/keys.ts";
import { openPermissionStores } from "../../src/grants/open.ts";

const { path, key, now, gate } = workerData as { path: string; key: string; now: number; gate: SharedArrayBuffer };
const stores = await openPermissionStores({ path, keys: staticKeySource(Buffer.from(key, "hex")), clock: { now: () => now } });
const flag = new Int32Array(gate);
while (Atomics.load(flag, 0) === 0) Atomics.wait(flag, 0, 0, 1000);
const won = stores.grants.consumeOnce("once1", { person: "christian", agent: "bernd", actionHash: "h1" });
stores.close();
parentPort!.postMessage({ won });
