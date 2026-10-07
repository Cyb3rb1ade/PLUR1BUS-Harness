import { createCoreLog } from "../../src/logs/bootstrap.ts";
const log = createCoreLog({ dir: process.argv[2]!, role: "core", source: { kind: "harness", id: "core", version: null }, timers: false });
log.info("buffered crash fixture", { password: "fixture-crash-canary" });
throw new Error("deliberate fixture crash");
