import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { open } from "./helpers.ts";

const worker = fileURLToPath(new URL("./worker.ts", import.meta.url));

function run(path: string, agent: string, n: number, mode: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings=ExperimentalWarning", worker, path, agent, String(n), mode], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    c.stderr.on("data", (d) => { err += d; });
    const timer = setTimeout(() => { c.kill("SIGKILL"); reject(new Error("worker timed out")); }, 60_000);
    c.on("exit", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`worker exited ${code}: ${err}`)); });
  });
}

describe("concurrent recordUsage", () => {
  it("many processes writing the same store lose no update", { timeout: 120_000 }, async () => {
    const { svc, path } = open();
    const W = 6, N = 150;
    await Promise.all(Array.from({ length: W }, (_, i) => run(path, `agent-${i % 2}`, N, "plain")));
    const t = svc.status().periods[0]!;
    assert.equal(t.total.events, W * N);
    assert.equal(t.total.inputTokens, W * N);
    assert.equal(t.total.outputTokens, 2 * W * N);
    assert.equal(t.total.costMicros, 11 * W * N); // 1 + 2*5 micro-USD per event, exact integers
    assert.deepEqual(t.agents.map((a) => [a.agentId, a.total.events]), [["agent-0", 3 * N], ["agent-1", 3 * N]]);
    svc.close();
  });

  it("the same request ids recorded from several processes count once", { timeout: 120_000 }, async () => {
    const { svc, path } = open();
    const N = 100;
    await Promise.all(Array.from({ length: 4 }, () => run(path, "agent-x", N, "dup")));
    assert.equal(svc.status().periods[0]!.total.events, N);
    svc.close();
  });

  it("interleaved in-process calls from many async tasks lose nothing", async () => {
    const { svc } = open();
    await Promise.all(Array.from({ length: 500 }, (_, i) => Promise.resolve().then(() => svc.recordUsage({ agent: "a1", model: "m-small", inputTokens: 1, outputTokens: 1, requestId: `r${i}` }))));
    assert.equal(svc.status().periods[0]!.total.events, 500);
    svc.close();
  });
});
