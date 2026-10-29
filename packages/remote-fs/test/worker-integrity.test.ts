/** Container images install an immutable root-owned native binary and run Core as an unprivileged user. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { test } from "node:test";
import { WorkerConnection } from "../src/worker.ts";
import { FsBudget } from "../src/budget.ts";

test("the verified system executable passes integrity checks for an unprivileged Core", async () => {
  const path = await realpath(process.platform === "win32" ? process.execPath : "/usr/bin/true");
  const sha256 = createHash("sha256").update(await readFile(path)).digest("hex");
  const worker = await WorkerConnection.open({ worker: { path, sha256, mode: "standalone" },
    endpoint: { ip: "127.0.0.1", port: 22 }, budget: new FsBudget({ timeoutMs: 1000 }) });
  await worker.close();
});
