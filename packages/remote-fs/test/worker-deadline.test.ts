/** The connection's deadline timer and the operation's own deadline timer race; the deadline must win either way. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { setImmediate as turn } from "node:timers/promises";
import { test } from "node:test";
import { WorkerConnection } from "../src/worker.ts";
import { FsBudget } from "../src/budget.ts";

/** A shell (or Node) without arguments reads its stdin as a script and writes nothing to stdout, so a request stays pending. */
async function silentWorker(timeoutMs: number): Promise<WorkerConnection> {
  const path = await realpath(process.platform === "win32" ? process.execPath : "/bin/sh");
  const sha256 = createHash("sha256").update(await readFile(path)).digest("hex");
  return WorkerConnection.open({ worker: { path, sha256, mode: "standalone" },
    endpoint: { ip: "127.0.0.1", port: 22 }, budget: new FsBudget({ timeoutMs }) });
}

test("a request cut off by the connection's deadline timer reports timeout, not the lost pipe", async () => {
  const connection = await silentWorker(60_000);
  try {
    const pending = assert.rejects(connection.request("stat", { path: "/" }), { reason: "timeout" });
    await turn();
    // What the connection's deadline timer does; it can fire before the operation's timer, and the worker's
    // end of stdout then arrives while the operation still waits for its reply.
    connection.destroy("timeout");
    await pending;
    await assert.rejects(connection.request("stat", { path: "/" }), { reason: "timeout" });
  } finally { await connection.close(); }
});

test("an explicit close still reports the worker as unavailable", async () => {
  const connection = await silentWorker(60_000);
  const pending = assert.rejects(connection.request("stat", { path: "/" }), { reason: "unavailable" });
  await turn();
  await connection.close();
  await pending;
});
