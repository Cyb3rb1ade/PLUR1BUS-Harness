// Audit b11: regressions found while reading metrics/** (registry names, endpoint resilience, token file).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { chmodSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRegistry } from "../../src/metrics/registry.ts";
import { createMetricsServer } from "../../src/metrics/http.ts";
import { loadOrCreateMetricsToken } from "../../src/metrics/token.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const TOKEN = "t".repeat(48);
const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return log; } } as any;
function get(port: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/metrics", headers: { authorization: `Bearer ${TOKEN}` }, timeout: 5000 }, (res) => {
      let body = ""; res.setEncoding("utf8"); res.on("data", (c) => (body += c)); res.on("end", () => resolve({ status: res.statusCode!, body }));
    });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("timeout"))); req.end();
  });
}

describe("b11 metrics registry: histogram series names", () => {
  for (const suffix of ["_bucket", "_sum", "_count"]) {
    it(`a metric named like the histogram's own ${suffix} series is refused`, () => {
      const r = createRegistry();
      r.histogram("job_seconds", "h", {}, [1, 2]);
      assert.throws(() => r.counter(`job_seconds${suffix}`, "c", {}), /already|collid|conflict/i);
    });
    it(`a histogram whose ${suffix} series is an existing metric is refused`, () => {
      const r = createRegistry();
      r.counter(`job_seconds${suffix}`, "c", {});
      assert.throws(() => r.histogram("job_seconds", "h", {}, [1, 2]), /already|collid|conflict/i);
    });
  }
});

describe("b11 metrics endpoint", () => {
  it("an access port that throws answers 500 and does not take the process down", async () => {
    const access = { authorize(): never { throw new Error("backend down"); } };
    const s = createMetricsServer({ token: TOKEN, port: 0, render: () => "x 1\n", logger: log, access });
    const { port } = await s.listen();
    try {
      const a = await get(port);
      assert.equal(a.status, 500);
      const b = await get(port); // still serving
      assert.equal(b.status, 500);
    } finally { await s.close(); }
  });
  it("listen() twice is refused instead of leaking the first server", async () => {
    const s = createMetricsServer({ token: TOKEN, port: 0, render: () => "x 1\n", logger: log });
    const { port } = await s.listen();
    try {
      await assert.rejects(s.listen(), /already listening/);
      assert.equal((await get(port)).status, 200);
    } finally { await s.close(); }
  });
  it("can listen again after the port was taken", async () => {
    const a = createMetricsServer({ token: TOKEN, port: 0, render: () => "a\n", logger: log });
    const { port } = await a.listen();
    const b = createMetricsServer({ token: TOKEN, port, render: () => "b\n", logger: log });
    try {
      await assert.rejects(b.listen(), /EADDRINUSE/);
      await a.close();
      await b.listen();
      assert.equal((await get(port)).body, "b\n");
    } finally { await a.close(); await b.close(); }
  });
});

describe("b11 metrics token file", { skip: process.platform === "win32" }, () => {
  it("tightens a too-open mode on an existing valid token", () => {
    const file = join(tempDir("p1b-mtok-"), "metrics.token");
    const t = "ab".repeat(32);
    writeFileSync(file, `${t}\n`, { mode: 0o644 }); chmodSync(file, 0o644);
    assert.equal(loadOrCreateMetricsToken(file), t);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });
});
