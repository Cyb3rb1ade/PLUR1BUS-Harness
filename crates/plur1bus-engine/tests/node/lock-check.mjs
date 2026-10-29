// Lock interop against engine commit 9f34008c143c5da87b2194b5a28442b407ff8ba7 (RE-02/T6).
import { createRequire } from "node:module";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Probe, hold until stdin closes, or leave a lock behind when this Node process exits. */
export async function checkLock(args) {
  const [mode, lockPath, stale = "10000"] = args;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  let engineRoot;
  try {
    engineRoot = path.dirname(createRequire(path.join(root, "packages/core/package.json")).resolve("@cyb3rb1ade/plur1bus-memory/package.json"));
  } catch {
    throw new Error("run pnpm test:prep (the engine package is not installed)");
  }
  const { tryAcquireOwnedLock, processIncarnation } = await import(pathToFileURL(path.join(engineRoot, "lib/registry-lock.js")).href);
  const handle = tryAcquireOwnedLock(lockPath, { staleMs: Number(stale) });
  const result = { acquired: handle !== null, pid: process.pid, host: hostname(), procStart: processIncarnation() };
  if (mode === "probe") {
    handle?.release();
    return result;
  }
  if (mode === "leave") return result;
  if (mode !== "hold" || !handle) throw new Error("expected a holdable Node lock");
  console.log(JSON.stringify({ ...result, ready: true }));
  try {
    for await (const _chunk of process.stdin) { /* stdin is the test lifeline */ }
  } finally {
    handle.release();
  }
  return null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkLock(process.argv.slice(2));
  if (result !== null) console.log(JSON.stringify(result));
}
