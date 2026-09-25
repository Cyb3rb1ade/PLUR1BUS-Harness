import { acquireCoreLock } from "../../src/lock.ts";
acquireCoreLock(process.argv[2]!, "holder");
process.stdout.write("locked\n");
setInterval(() => {}, 1000);
