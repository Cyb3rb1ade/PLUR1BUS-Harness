import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRpcServer,
  createLogger,
  coreAddress,
  supervisorAddress,
  supervisorTokenPath,
} from "@plur1bus/module-api";
import { createCoreLink } from "../src/core-link.ts";
import { createApiServer } from "../src/server.ts";
import { fakeCore } from "./helpers.ts";
import type { CoreRpc } from "../src/core-rpc.ts";

async function until(check: () => boolean) {
  const end = Date.now() + 2500;
  while (!check()) {
    if (Date.now() > end) throw new Error("supervisor extension event was not relayed");
    await new Promise((r) => setTimeout(r, 5));
  }
}
test(
  "real HTTP SSE relays the session-bound supervisor ext.watch and revokes its dedicated socket",
  { timeout: 10000 },
  async (t) => {
    const home = mkdtempSync(join(tmpdir(), "extensions-event-"));
    mkdirSync(join(home, "run"));
    const token = randomBytes(32).toString("hex"),
      apiToken = randomBytes(32).toString("hex"),
      ownerToken = randomBytes(32).toString("hex");
    writeFileSync(join(home, "run", "api-delegation.token"), apiToken, { mode: 0o600 });
    writeFileSync(supervisorTokenPath(home), token, { mode: 0o600 });
    const logger = createLogger({ file: join(home, "core.log"), role: "core", level: "error" });
    const common = {
      token,
      apiToken,
      logger,
      hello: () => ({ rpc: "1.7.0", pid: process.pid, instanceId: "extensions-events" }),
      apiPrincipalOf: (p: import("@plur1bus/module-api").ApiPrincipal) => p,
      apiPersonOfConnection: async (_id: string, p: import("@plur1bus/module-api").ApiPrincipal) => p.userId,
    };
    const core = createRpcServer({ ...common, address: coreAddress(home), methods: {} });
    let watched: Socket | undefined,
      closed = false;
    const sockets = new Set<Socket>();
    // The Rust supervisor uses its own ext.watch protocol, without events.subscribe or Core audience envelopes.
    const supervisor = createServer((socket) => {
      sockets.add(socket);
      let buffer = "";
      socket.on("close", () => {
        sockets.delete(socket);
        if (socket === watched) closed = true;
      });
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const request = JSON.parse(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          assert.equal(request.api.token, apiToken);
          assert.equal(request.api.principal.userId, "local-owner");
          if (request.method === "supervisor.auth") {
            assert.equal(request.params.token, token);
            socket.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id: request.id,
                result: { ...common.hello(), apiPrincipal: request.api.principal },
              }) + "\n",
            );
          } else {
            assert.equal(request.method, "ext.watch");
            watched = socket;
            socket.write(
              JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { subscriptionId: "extensions", items: [] } }) +
                "\n",
            );
          }
        }
      });
    });
    await core.listen();
    await new Promise<void>((resolve) => supervisor.listen(supervisorAddress(home), resolve));
    if (process.platform !== "win32") chmodSync(supervisorAddress(home), 0o600);
    const link = createCoreLink(home, { readToken: () => token, readPid: () => process.pid });
    let role: "owner" | "member" = "owner",
      version = 1;
    const api = createApiServer({
      core: link,
      ownerToken,
      resolveBootstrap: async () => ({ userId: "local-owner", kind: "person", role, disabled: false, version }),
    });
    const { url } = await api.listen();
    const controller = new AbortController();
    t.after(async () => {
      controller.abort();
      await api.close();
      await link.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => supervisor.close(() => resolve()));
      await core.close();
      await logger.close();
      rmSync(home, { recursive: true, force: true });
    });
    const logged = await fetch(url + "/api/v1/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: ownerToken }),
    });
    await logged.text();
    const cookie = logged.headers.get("set-cookie")!.split(";")[0]!;
    const stream = await fetch(url + "/events", { headers: { cookie }, signal: controller.signal });
    assert.equal(stream.status, 200);
    const frames: string[] = [];
    void (async () => {
      const reader = stream.body!.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          frames.push(new TextDecoder().decode(value));
        }
      } catch {
        /* explicit test shutdown */
      }
    })();
    await until(() => watched !== undefined);
    watched!.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "ext.changed",
        params: { name: "fixture", kind: "skill", state: "enabled", version: "1.0.0", overlays: [] },
      }) + "\n",
    );
    await until(() => frames.join("").includes("event: ext.changed"));
    assert.ok(!frames.join("").includes(apiToken));
    role = "member";
    version++;
    watched!.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "ext.changed",
        params: { name: "private-after-demotion", kind: "skill", state: "enabled", version: "2.0.0", overlays: [] },
      }) + "\n",
    );
    await until(() => closed);
    assert.ok(
      !frames.join("").includes("private-after-demotion"),
      "each event rechecks live authority before delivery",
    );
    controller.abort();
    api.rightsChanged("local-owner");
    await until(() => closed);
  },
);

test(
  "a stalled authority lookup has a bounded event queue and disconnects an overflowing publisher",
  { timeout: 5000 },
  async (t) => {
    const core = fakeCore();
    let listener: Parameters<NonNullable<CoreRpc["subscribeAs"]>>[1] | undefined;
    let stalled = false,
      waiting = false,
      disposed = false;
    core.subscribeAs = async (_principal, callback) => {
      listener = callback;
      return () => {
        disposed = true;
      };
    };
    const ownerToken = randomBytes(32).toString("hex");
    const api = createApiServer({
      core,
      ownerToken,
      resolveBootstrap: async () => {
        if (stalled) {
          waiting = true;
          return new Promise(() => {});
        }
        return { userId: "local-owner", kind: "person", role: "owner", disabled: false, version: 1 };
      },
    });
    const { url } = await api.listen();
    t.after(() => api.close());
    const login = await fetch(url + "/api/v1/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: ownerToken }),
    });
    await login.text();
    const cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!;
    const stream = await fetch(url + "/events", { headers: { cookie } });
    assert.equal(stream.status, 200);
    stalled = true;
    const emit = () =>
      listener!(
        "ext.changed",
        { name: "queued-private", kind: "skill", state: "enabled", version: "1.0.0", overlays: [] },
        { audience: [{ personId: "local-owner" }], connectionId: "test" },
      );
    emit();
    await until(() => waiting);
    for (let index = 0; index < 129; index++) emit();
    const wire = await stream.text();
    assert.ok(!wire.includes("queued-private"));
    assert.equal(disposed, true);
  },
);
