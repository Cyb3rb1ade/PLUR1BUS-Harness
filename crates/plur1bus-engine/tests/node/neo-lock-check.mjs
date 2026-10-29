#!/usr/bin/env node
// RE-02/T6 actual Neo-writer lock protocol, engine pin 9f34008c143c5da87b2194b5a28442b407ff8ba7.
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function checkNeoLock(args){
const [mode, root] = args;
if (!["path", "probe", "hold"].includes(mode) || !root) throw new Error("usage: neo-lock-check.mjs path|probe|hold <neo root>");
process.env.PLUR1BUS_NEO_LOCK_ACQUIRE_MS = "1000";
const writeFileSync = fs.writeFileSync;
if (mode === "hold") {
  fs.writeFileSync = function (...args) {
    const result = writeFileSync(...args);
    if (String(args[0]).endsWith(`${path.sep}.neo-write.lock${path.sep}owner.json`)) {
      fs.writeSync(1, `${JSON.stringify({ ready: true, pid: process.pid, lockPath: path.dirname(String(args[0])) })}\n`);
      fs.readSync(0, Buffer.alloc(1), 0, 1, null);
    }
    return result;
  };
  syncBuiltinESMExports();
}
const harness = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
let engineRoot;
try {
  engineRoot = path.dirname(createRequire(path.join(harness, "packages/core/package.json")).resolve("@cyb3rb1ade/plur1bus-memory/package.json"));
} catch {
  throw new Error("run pnpm test:prep (the engine package is not installed)");
}
const { createNeoStore, createTurnEvent } = await import(pathToFileURL(path.join(engineRoot, "lib/neo-arch.js")).href);
const store = createNeoStore(path.resolve(root), "fixture");
const lockPath = path.join(store.paths.workspaceDir, ".neo-write.lock");
if (mode === "path") {
  fs.writeSync(1, `${JSON.stringify({ lockPath })}\n`);
} else {
  try {
    store.appendTurns(createTurnEvent({ id: "node-lock-probe", workspaceKey: "fixture", agentId: "a1", content: "Actual Node critical section.", createdAt: "2027-01-15T08:00:00.000Z" }));
    fs.writeSync(1, `${JSON.stringify({ acquired: true, lockPath })}\n`);
  } catch (error) {
    if (error?.code !== "NEO_WRITE_BACKPRESSURE") throw error;
    fs.writeSync(1, `${JSON.stringify({ acquired: false, lockPath })}\n`);
  }
}

return null;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await checkNeoLock(process.argv.slice(2));
