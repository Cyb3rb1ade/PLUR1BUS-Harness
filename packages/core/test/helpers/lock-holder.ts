import { acquireCoreLock } from "../../src/lock.ts";
// Keep the handle reachable: an unreferenced DatabaseSync can be garbage-collected and closed, which frees the lock.
(globalThis as { heldLock?: unknown }).heldLock = acquireCoreLock(process.argv[2]!, "holder");
process.stdout.write("locked\n");
setInterval(() => {}, 1000);
