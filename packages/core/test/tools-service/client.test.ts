/** D120: the real tools binary is owned and reaped in standalone mode and remains optional to Core. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ToolsClient,
  toolsEnvironment,
} from "../../src/tools-service/client.ts";
import { execFileSync } from "node:child_process";
import { RPC_VERSION } from "@plur1bus/rpc-schema";
import { createSecurePath, unitAddress } from "@plur1bus/module-api";

const nativeBinary = resolve(fileURLToPath(new URL("../../../../target/debug", import.meta.url)), `plur1bus${process.platform === "win32" ? ".exe" : ""}`);

async function coreHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "p1b-tools-client-"));
  await mkdir(join(home, "state"));
  await mkdir(join(home, "run"), { mode: 0o700 });
  const secured = createSecurePath({ env: {}, runDir: join(home, "run") })(join(home, "run"), { mode: 0o700 });
  assert.equal(secured.applied, true, "fixture run directory must have private permissions");
  await writeFile(
    join(home, "run/core.pid"),
    `${process.pid} ${randomUUID()}\n`,
    { mode: 0o600 },
  );
  return home;
}

async function sequentialService(
  handle: (connection: number, request: number) => Promise<void>,
) {
  const home = await coreHome();
  const sockets = new Set<Socket>();
  let connections = 0;
  const token = randomBytes(32).toString("hex");
  await writeFile(join(home, "run/tools-core.token"), token, { mode: 0o600 });
  await writeFile(join(home, "run/tools.pid"), `${process.pid} fixture\n`, {
    mode: 0o600,
  });
  const instanceId = randomUUID();
  const server = createServer((socket) => {
    const connection = ++connections;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let pending = Promise.resolve();
    let buffer = "";
    let calls = 0;
    socket.on("data", (data) => {
      buffer += data.toString();
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const request = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        pending = pending
          .then(async () => {
            const result =
              request.method === "tools.hello"
                ? {
                    rpc: RPC_VERSION,
                    instanceId,
                    pid: process.pid,
                    capabilities: {
                      methods: {},
                      notifications: {},
                      extensionPoints: {},
                      features: [],
                    },
                  }
                : await (async () => {
                    await handle(connection, ++calls);
                    return {
                      rpc: RPC_VERSION,
                      instanceId,
                      pid: process.pid,
                      uptimeMs: 1,
                      process: { state: "ready", since: Date.now() },
                    };
                  })();
            if (!socket.destroyed)
              socket.write(
                JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) +
                  "\n",
              );
          })
          .catch(() => { socket.destroy(); });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(unitAddress(home, "tools"), resolve);
  });
  return {
    home,
    connections: () => connections,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(home, { recursive: true, force: true });
    },
  };
}

test("health has its own connection while a real request is waiting on the work connection", async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = await sequentialService(async (connection) => {
    if (connection === 1) {
      started();
      await blocked;
    }
  });
  const client = new ToolsClient({ nativeBinary, home: service.home, supervised: true });
  try {
    const work = client.call("tools.health", {}, 5000).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await ready;
    assert.equal((await client.health()).process.state, "ready");
    assert.equal(service.connections(), 2);
    release();
    assert.ok("value" in (await work));
  } finally {
    release();
    await client.close();
    await service.close();
  }
});

test("one request timeout keeps its work connection usable and ignores the late reply", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = await sequentialService(async (_connection, request) => {
    if (request === 1) await blocked;
  });
  const client = new ToolsClient({ nativeBinary, home: service.home, supervised: true });
  try {
    await assert.rejects(client.call("tools.health", {}, 25));
    release();
    assert.equal(
      (await client.call<{ process: { state: string } }>("tools.health", {}))
        .process.state,
      "ready",
    );
    assert.equal(service.connections(), 1);
  } finally {
    release();
    await client.close();
    await service.close();
  }
});

test("tools children inherit OS basics without provider credentials or loader injection", () => {
  const canary = randomBytes(24).toString("hex");
  const environment = toolsEnvironment({
    PATH: "/fixture",
    TMPDIR: "/fixture-temp",
    PROVIDER_CREDENTIAL: canary,
    DYLD_INSERT_LIBRARIES: "/foreign",
    NODE_OPTIONS: "--inspect",
  });
  assert.deepEqual(Object.keys(environment).sort(), ["PATH", "TMPDIR"]);
  assert.equal(Object.values(environment).includes(canary), false);
});

test("standalone Core spawns tools, exchanges a key, reconnects after a crash and reaps its child", async () => {
  const home = await coreHome();
  const client = new ToolsClient({ nativeBinary,
    home,
    supervised: false,
    pollIntervalMs: 50,
    binary: resolve(
      process.env.CARGO_TARGET_DIR ??
        fileURLToPath(new URL("../../../../target", import.meta.url)),
      "debug",
      `plur1bus-tools${process.platform === "win32" ? ".exe" : ""}`,
    ),
  });
  let pid: number | null = null;
  try {
    const health = await client.health();
    assert.equal(health.process.state, "ready");
    pid = health.pid;
    assert.equal(client.snapshot().ready, true);
    process.kill(pid, "SIGKILL");
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        const next = await client.health();
        if (next.pid !== pid) {
          pid = next.pid;
          break;
        }
      } catch {
        /* The child waiter and reconnect backoff must observe the crashed generation. */
      }
      assert.ok(
        Date.now() < deadline,
        "tools did not reconnect after its crash",
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    await client.close();
    await rm(home, { recursive: true, force: true });
  }
  if (pid !== null) assert.throws(() => process.kill(pid!, 0));
});

test("an unavailable supervised service gives a typed refusal and leaves the caller usable", async () => {
  const home = await mkdtemp(join(tmpdir(), "p1b-tools-down-"));
  const client = new ToolsClient({ nativeBinary,
    home,
    supervised: true,
    pollIntervalMs: 50,
  });
  try {
    await assert.rejects(client.health(), (error: unknown) => {
      return (
        error !== null &&
        typeof error === "object" &&
        "reason" in error &&
        error.reason === "tools-unavailable"
      );
    });
    assert.equal(client.snapshot().ready, false);
  } finally {
    await client.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("standalone tools startup stderr is preserved in a private log when run/ is unsafe", async () => {
  const home = await coreHome();
  const run = join(home, "run");
  if (process.platform === "win32") {
    execFileSync("icacls.exe", [run, "/grant", "*S-1-1-0:(OI)(CI)(F)"], { windowsHide: true });
  } else { await chmod(run, 0o777); }
  const client = new ToolsClient({ home, supervised: false, nativeBinary,
    binary: resolve(fileURLToPath(new URL("../../../../target/debug", import.meta.url)), `plur1bus-tools${process.platform === "win32" ? ".exe" : ""}`) });
  try {
    await assert.rejects(client.health());
    const log = join(home, "logs/tools.out.log");
    const deadline = Date.now() + 3000;
    let text = "";
    while (!text.includes("could not bind")) {
      text = await readFile(log, "utf8").catch(() => "");
      assert.ok(Date.now() < deadline, "startup refusal was not logged");
      if (!text.includes("could not bind")) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.match(text, /run|permissions|writable/i);
    assert.match(text, /tools-stderr/);
    if (process.platform !== "win32") assert.equal((await stat(log)).mode & 0o777, 0o600);
  } finally { await client.close(); await rm(home, { recursive: true, force: true }); }
});
