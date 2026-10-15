// Keep the supervisor's real config.get/config.set envelope and revision field in the creation path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { validateParams } from "@plur1bus/rpc-schema";
import { LineDecoder, encodeLine, supervisorAddress } from "@plur1bus/module-api";
import { registerAgentConfig } from "../../src/agents/config.ts";
import { layout } from "../../src/paths.ts";
import { RpcError } from "../../src/rpc/errors.ts";

test("supervisor create uses config.get.value and config.set.ifRevision; collision/reference/conflict fail closed", async t => {
  const home = mkdtempSync(join(tmpdir(), "agent-cas-")), l = layout(home), config = defaults(), sockets = new Set<Socket>();
  const token = randomBytes(32).toString("hex"), calls: any[] = []; let refuse = false;
  mkdirSync(l.run, { mode: 0o700 }); writeFileSync(l.supervisorToken, token, { mode: 0o600 }); writeFileSync(l.supervisorPid, `${process.pid} offline-supervisor`, { mode: 0o600 });
  const server = createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {});
    const decoder = new LineDecoder(); let authed = false;
    socket.on("data", chunk => {
      for (const raw of decoder.push(chunk)) {
        const msg = raw as any;
        const reply = (result: unknown) => socket.write(encodeLine({ jsonrpc: "2.0", id: msg.id, result }));
        if (msg.method === "supervisor.auth") { authed = msg.params.token === token; assert.equal(authed, true); reply({ rpc: "1.6.0", instanceId: "offline", pid: process.pid }); continue; }
        assert.ok(authed); assert.deepEqual(validateParams(msg.method, msg.params), { ok: true }); calls.push(msg);
        if (msg.method === "config.get") reply({ value: config, revision: "revision-one" });
        else {
          assert.equal(msg.method, "config.set"); assert.equal(msg.params.ifRevision, "revision-one");
          if (refuse) socket.write(encodeLine({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "config changed", data: { error: "E_CONFLICT", reason: "revision-mismatch" } } }));
          else reply({ applied: true, revision: "revision-two" });
        }
      }
    });
  });
  await new Promise<void>(resolve => server.listen(supervisorAddress(home), resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(home, { recursive: true, force: true }); });
  await registerAgentConfig(l, "alpha", { persona: "Plain persona." });
  assert.deepEqual(calls[1].params.changes, [{ key: "agents.alpha", value: { persona: "Plain persona." } }]);
  config.agents.alpha = {};
  await assert.rejects(registerAgentConfig(l, "alpha", {}), (e: any) => e instanceof RpcError && e.error === "E_AGENT_EXISTS");
  await assert.rejects(registerAgentConfig(l, "beta", { model: "removed" }), (e: any) => e instanceof RpcError && e.error === "E_INVALID_PARAMS" && e.detail === "model");
  refuse = true;
  await assert.rejects(registerAgentConfig(l, "beta", {}), (e: any) => e instanceof RpcError && e.error === "E_CONFLICT" && e.reason === "revision-mismatch");
});
