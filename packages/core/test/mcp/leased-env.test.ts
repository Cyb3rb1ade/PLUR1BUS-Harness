/** Packaged MCP launch leases are ephemeral, redacted, and isolated from ambient process credentials (M-A7). */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { BoundedStdioTransport } from "../../src/mcp/stdio.ts";
import { McpRegistry } from "../../src/mcp/registry.ts";
import { FakeClock } from "./helpers/fake-clock.ts";
import { caller, capturingLogger, NODE, stdioDef } from "./helpers/util.ts";

const MARKER = "fixture-A7-secret-do-not-log";

async function promptly<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("MCP cancellation waited for an unavailable backend")), 2000);
    })]);
  } finally { clearTimeout(timer); }
}

function environmentOutput(transport: BoundedStdioTransport): Promise<unknown> {
  return new Promise(resolve => {
    transport.onmessage = message => resolve("params" in message ? message.params : undefined);
    transport.onerror = resolve;
    transport.onclose = () => resolve(new Error("MCP environment fixture closed before reporting its environment"));
  });
}

describe("leased MCP launch environment", { timeout: 30_000 }, () => {
  it("rechecks host authority synchronously at spawn and releases a revoked registration's lease", async () => {
    let checked = 0;
    let released = 0;
    const transport = new BoundedStdioTransport({ type: "stdio", command: NODE,
      args: ["-e", "process.stdin.resume()"], env: {}, fromHost: [] }, 1024, 50, {}, {
      launchEnvironment: async () => ({ env: { TOKEN: MARKER }, isolated: true,
        validate() { checked++; throw Error("registration revoked"); }, release() { released++; } }),
    });
    try {
      await assert.rejects(transport.start(), /MCP child launch failed/);
      assert.equal(checked, 1);
      assert.equal(released, 1);
      assert.equal(transport.pid, null, "revocation must be checked before spawning code");
    } finally { await transport.close(); }
  });

  it("leases immediately before spawn, clears the lease, and exposes only explicit environment variables", async () => {
    const script = [
      "process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'env',params:{",
      "present:process.env.PACKAGED==='fixture-A7-secret-do-not-log',ambient:process.env.AMBIENT_TOKEN,",
      "home:process.env.HOME,path:process.env.PATH,data:process.env.P1X_DATA}})+'\\n');process.stdin.resume()",
    ].join("");
    const def = stdioDef({ transport: { type: "stdio", command: NODE, args: ["-e", script],
    env: { LEGACY: "must-not-reach-packaged-child" }, fromHost: ["AMBIENT_TOKEN"] } });
    assert.equal(def.transport.type, "stdio");
    if (def.transport.type !== "stdio") return;
    let acquired = 0;
    let released = 0;
    const values = { PACKAGED: MARKER, P1X_DATA: "/fixture/data/ext/example" };
    const redacted: string[] = [];
    const transport = new BoundedStdioTransport(def.transport, 4096, 50,
      { AMBIENT_TOKEN: "ambient-A7-token", HOME: "/ambient-home", PATH: "/ambient-path" }, {
        launchEnvironment: async () => {
          acquired++;
          return { env: values, isolated: true, release: () => { released++; } };
        },
        redact: value => redacted.push(value),
      });
    const output = environmentOutput(transport);
    assert.equal(acquired, 0);
    try {
      await transport.start();
      assert.equal(acquired, 1);
      assert.equal(released, 1, "lease must be released before protocol traffic");
      const environment = await output;
      if (environment instanceof Error) throw environment;
      assert.deepEqual(environment, { present: true, data: "/fixture/data/ext/example" });
      assert.ok(redacted.includes(MARKER));
    } finally { await transport.close(); }
    assert.equal(released, 1);
  });

  it("reports an early transport close or error before an environment notification without waiting for the suite timeout", async () => {
    for (const mode of ["close", "error"]) {
      const input = new PassThrough();
      const output = new PassThrough();
      const transport = new BoundedStdioTransport({ input, output }, 1024, 50);
      const report = environmentOutput(transport);
      try {
        await transport.start();
        if (mode === "close") await transport.close();
        else output.write("{invalid}\n");
        const error = await promptly(report);
        assert.ok(error instanceof Error);
        assert.equal(error.message, mode === "close"
          ? "MCP environment fixture closed before reporting its environment"
          : "MCP malformed JSON-RPC frame");
      } finally { await transport.close(); }
    }
  });

  it("releases a lease on spawn failure and on an abort while acquiring it", async () => {
    for (const abort of [false, true]) {
      const controller = new AbortController();
      let releases = 0;
      const transport = new BoundedStdioTransport({ type: "stdio", command: "/missing-A7-program",
        args: [], env: {}, fromHost: [] }, 1024, 50, {}, {
        signal: controller.signal,
        launchEnvironment: async () => {
          if (abort) controller.abort();
          return { env: { SECRET: MARKER }, isolated: true, release: () => { releases++; } };
        },
      });
      try {
        await assert.rejects(transport.start(), error => {
          assert.ok(error instanceof Error);
          assert.ok(!error.message.includes(MARKER));
          return true;
        });
        assert.equal(releases, 1);
      } finally { await transport.close(); }
    }
  });

  it("abort or transport close rejects a hung acquisition before its late value can launch a child", async () => {
    for (const mode of ["abort", "close"]) {
      const controller = new AbortController();
      let entered!: () => void;
      let resume!: (value: { env: Record<string, string>; isolated: true; release(): void }) => void;
      const acquiring = new Promise<void>(resolve => { entered = resolve; });
      const pending = new Promise<{ env: Record<string, string>; isolated: true; release(): void }>(resolve => { resume = resolve; });
      let releases = 0;
      const values: Record<string, string> = { SECRET: MARKER };
      const transport = new BoundedStdioTransport({ type: "stdio", command: NODE,
        args: ["-e", "process.stdin.resume()"], env: {}, fromHost: [] }, 1024, 50, {}, {
        signal: controller.signal, launchEnvironment: () => { entered(); return pending; },
      });
      const started = transport.start().then(() => undefined, error => error as Error);
      const late = { env: values, isolated: true as const, release() {
        releases++;
        for (const key of Object.keys(values)) delete values[key];
      } };
      try {
        await acquiring;
        if (mode === "abort") controller.abort();
        else await promptly(transport.close());
        const error = await promptly(started);
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes(MARKER));
        assert.equal(transport.pid, null);
        assert.equal(releases, 0);
        resume(late);
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(releases, 1);
        assert.deepEqual(Object.keys(values), []);
        assert.equal(transport.pid, null);
      } finally {
        resume(late);
        await started;
        await transport.close();
      }
    }
  });

  it("a connect deadline and registry shutdown finish while the environment port remains pending", async () => {
    for (const mode of ["deadline", "shutdown"]) {
      const clock = new FakeClock();
      let entered!: () => void;
      let resume!: () => void;
      const acquiring = new Promise<void>(resolve => { entered = resolve; });
      const pending = new Promise<void>(resolve => { resume = resolve; });
      let releases = 0;
      const registry = new McpRegistry({ clock, logger: capturingLogger(), hostEnv: {},
        policy: { allowedCommands: [NODE] }, launchEnvironment: async () => {
          entered(); await pending;
          return { env: { SECRET: MARKER }, isolated: true, release: () => { releases++; } };
        },
      });
      registry.register(stdioDef({ timeouts: { connectMs: 500, closeGraceMs: 50 } }));
      const starting = registry.listTools("fixture", caller).then(() => undefined, error => error as { code: string });
      try {
        await acquiring;
        if (mode === "deadline") await clock.advance(500);
        else await promptly(registry.shutdown());
        const error = await promptly(starting);
        assert.equal(error?.code, mode === "deadline" ? "connect-timeout" : "aborted");
        assert.equal(registry.status("fixture", caller.agentId).pid, null);
        resume();
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(releases, 1);
      } finally {
        resume();
        await starting;
        await registry.shutdown();
      }
    }
  });

  it("the registry launch port redacts every leased value without retaining it in definitions, status or events", async () => {
    const logger = capturingLogger();
    const events: unknown[] = [];
    let leases = 0;
    let releases = 0;
    const registry = new McpRegistry({ logger, hostEnv: {}, policy: { allowedCommands: [NODE] },
      onEvent: event => events.push(event),
      launchEnvironment: async server => {
        assert.equal(server.name, "fixture");
        leases++;
        return { env: { OPAQUE: MARKER }, isolated: true,
          release: () => { releases++; } };
      },
    });
    const definition = registry.register(stdioDef());
    try {
      const result = await registry.callTool("fixture", "leak_env", { name: "OPAQUE" }, caller);
      assert.equal(result.content[0]?.text, "value=[REDACTED]");
      assert.ok(leases > 0);
      assert.equal(releases, leases);
      for (const output of [definition, registry.status("fixture", caller.agentId), events, logger.lines]) {
        assert.ok(!JSON.stringify(output).includes(MARKER));
      }
    } finally { await registry.shutdown(); }
  });
});
