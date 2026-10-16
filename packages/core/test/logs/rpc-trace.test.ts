import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../../src/logger.ts";
import { createRpcServer, type RpcServer } from "../../src/rpc/server.ts";
import { createWriter } from "../../src/logs/writer.ts";
import { connect } from "../helpers/connect.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { logsDir } from "./helpers.ts";
import { loadFixtures } from "@plur1bus/rpc-schema";

const TOKEN = "c".repeat(64);
const fx = (method: string): { params: any; result: any } => (loadFixtures().methods as any)[method];
const records = (dir: string) =>
  readFileSync(join(dir, "core.log"), "utf8").trim().split("\n").filter(Boolean).map((s) => JSON.parse(s) as { event: string; trace_id: string; attrs: { pid?: number; link_trace_id?: string } });

describe("rpc _meta.traceparent", () => {
  const dir = tempDir("p1b-rpc-trace-");
  const address = process.platform === "win32" ? `\\\\.\\pipe\\plur1bus-test-trace-${process.pid}` : join(dir, "core.sock");
  const log = createLogger({ file: join(dir, "server.log"), level: "debug", role: "core" });
  const logs = logsDir();
  const writer = createWriter({ dir: logs, role: "core", source: { kind: "harness", id: "core", version: "0.1.0" }, timers: false });
  let server: RpcServer;
  let pid = 1;

  before(async () => {
    server = createRpcServer({
      address, token: TOKEN, hello: () => ({ contract: "1.4.1", rpc: "1.6.0", instanceId: "inst-trace", pid: process.pid }),
      logger: log,
      methods: {
        "core.status": async () => {
          writer.write("core.process.started", { pid: pid++ });
          writer.flush();
          return { ...fx("core.status").result, pid: process.pid, instanceId: "inst-trace" };
        },
      },
    });
    await server.listen();
  });
  after(async () => { writer.close(); await server.close(); await log.close(); });

  it("trace-id from RPC to log record", async () => {
    const trace_id = "4bf92f3577b34da6a3ce929d0e0e4736";
    const span_id = "00f067aa0ba902b7";
    const c = await connect({ address, token: TOKEN });
    await c.call("core.status", { _meta: { traceparent: `00-${trace_id}-${span_id}-01` } });
    await c.close();
    assert.ok(records(logs).some((r) => r.event === "core.process.started" && r.trace_id === trace_id), JSON.stringify(records(logs)));
  });

  it("invalid trace-id is replaced, not adopted", async () => {
    const zero = "0".repeat(32);
    const c = await connect({ address, token: TOKEN });
    await c.call("core.status", { _meta: { traceparent: `00-${zero}-${"1".repeat(16)}-01` } });
    await c.call("core.status", { _meta: { traceparent: "not-a-traceparent" } });
    await c.close();
    const written = records(logs).filter((r) => r.event === "core.process.started");
    assert.ok(written.length >= 2, JSON.stringify(written));
    assert.ok(written.every((r) => r.trace_id !== zero), JSON.stringify(written));
    assert.ok(written.every((r) => /^[0-9a-f]{32}$/.test(r.trace_id) && !/^0+$/.test(r.trace_id)));
  });
});
