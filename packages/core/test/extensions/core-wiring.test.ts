/** M-A7: the real Core mounts connection-authorized setup and transaction holds onto the live MCP composition. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { unitAddress } from "@plur1bus/module-api";
import { createCore } from "../../src/core.ts";
import type { Principal } from "../../src/rbac/types.ts";
import type { TurnProviderOptions } from "../../src/composition/provider.ts";
import type { ToolRegistry } from "../../src/tools/registry.ts";
import type { ChatRequest } from "../../src/session/provider.ts";
import { connect } from "../helpers/connect.ts";
import { flatTestInternals } from "../helpers/flat-embedder.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { FIXTURE_STDIO, waitDead } from "../mcp/helpers/util.ts";
import { httpModern } from "../mcp/helpers/dual-fixture.ts";

const SECRET = "synthetic-extension-wiring-token-dac840";
const REMOTE_SECRET = "synthetic-extension-header-token-dc8541";
const ROTATED_SECRET = "synthetic-extension-rotated-token-c732f5";
const signal = new AbortController().signal;
const request: ChatRequest = { sessionId: "extension-test", agentId: "a", principal: "local-owner",
  messages: [], summaries: [], memory: "", signal };

async function nativeLease(home: string, token: string) {
  const socket = createConnection(unitAddress(home, "e"));
  socket.on("error", () => {});
  try {
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    const response = new Promise<Buffer>((resolve, reject) => {
      let bytes = Buffer.alloc(0);
      socket.on("data", chunk => {
        bytes = Buffer.concat([bytes, chunk]);
        if (bytes.length >= 4 && bytes.length === bytes.readUInt32BE(0) + 4) resolve(bytes);
      });
      socket.once("error", reject);
      socket.once("close", () => reject(new Error("native lease channel closed before responding")));
    });
    socket.write(`${JSON.stringify({ v: 1, token, name: "reports" })}\n`);
    const bytes = await response;
    assert.equal(bytes[4], 0, "the actual Core must mount its authenticated native secret broker");
    assert.equal(bytes.readUInt16BE(5), 1);
    const keyLength = bytes.readUInt16BE(7);
    assert.equal(bytes.toString("utf8", 9, 9 + keyLength), "P1X_SECRET_TOKEN");
    const valueLength = bytes.readUInt32BE(9 + keyLength);
    assert.ok(bytes.toString("utf8", 13 + keyLength, 13 + keyLength + valueLength) === SECRET,
      "only the declared canonical slot may reach the private spawn channel");
    const closed = new Promise<void>(resolve => socket.once("close", resolve));
    socket.write(Buffer.from([0x06]));
    await closed;
    bytes.fill(0);
  } finally { socket.destroy(); }
}

async function installed(home: string) {
  const payload = join(home, "mcp", "reports", "1.0.0", "payload");
  await mkdir(payload, { recursive: true });
  await mkdir(join(home, "extensions"), { recursive: true });
  const mcpb = JSON.stringify({ server: { type: "node", entry_point: "main.mjs",
    mcp_config: { command: "node", args: ["${__dirname}/main.mjs"] } } });
  await writeFile(join(payload, "manifest.json"), mcpb);
  const entry = `import ${JSON.stringify(FIXTURE_STDIO)};`;
  await writeFile(join(payload, "main.mjs"), entry);
  const manifest = { id: "test/reports", name: "reports", version: "1.0.0", kind: "mcp-server",
    requires: { runtime: { type: "node", range: ">=24" } },
    capabilities: { network: { mode: "none" }, tools: [], secrets: [{ slot: "TOKEN", required: true }] },
    files: { "payload/manifest.json": { sha256: createHash("sha256").update(mcpb).digest("hex"),
      size: Buffer.byteLength(mcpb) }, "payload/main.mjs": {
      sha256: createHash("sha256").update(entry).digest("hex"), size: Buffer.byteLength(entry) } } };
  const bytes = JSON.stringify(manifest);
  await writeFile(join(payload, "..", "p1x.json"), bytes);
  await writeFile(join(home, "extensions", "state.json"), JSON.stringify({ schemaVersion: 1, items: { reports: {
    id: manifest.id, name: manifest.name, version: manifest.version, kind: manifest.kind,
    activeVersion: manifest.version,
    capabilities: manifest.capabilities, manifestSha256: createHash("sha256").update(bytes).digest("hex"),
  } } }));
}

async function installedHeader(home: string, url: string) {
  const root = join(home, "mcp", "headersrv", "1.0.0");
  await mkdir(root, { recursive: true });
  const manifest = { id: "test/headersrv", name: "headersrv", kind: "mcp-server", version: "1.0.0",
    requires: { runtime: { type: "none" } }, remote: { url, auth: "header" },
    capabilities: { network: { mode: "allowlist", hosts: ["127.0.0.1"] }, tools: [],
      secrets: [{ slot: "TOKEN", required: true }] } };
  const bytes = JSON.stringify(manifest);
  await writeFile(join(root, "p1x.json"), bytes);
  const path = join(home, "extensions", "state.json");
  const state = JSON.parse(await readFile(path, "utf8")) as { schemaVersion: number; items: Record<string, unknown> };
  state.items.headersrv = { id: manifest.id, name: manifest.name, kind: manifest.kind, version: manifest.version,
    activeVersion: manifest.version,
    capabilities: manifest.capabilities, manifestSha256: createHash("sha256").update(bytes).digest("hex") };
  await writeFile(path, JSON.stringify(state));
}

it("real Core setup releases declared slots, isolates leases, denies agent/PAT authority and holds running package code", {
  timeout: 60_000,
}, async () => {
  const home = tempDir("p1b-A7-core-");
  const remote = await httpModern();
  const cfg = defaults();
  cfg.agents.a = {};
  cfg.mcp.servers.reports = { enabled: true, agents: "all" };
  cfg.mcp.servers.headersrv = { enabled: true, agents: "all" };
  cfg.egress.allowHosts = ["127.0.0.1"];
  cfg.egress.allowPorts = [Number(new URL(remote.url).port)];
  cfg.egress.allowLoopback = true;
  cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false },
    merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false },
    temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false }, reranker: { enabled: false } };
  await writeFile(join(home, "config.json"), JSON.stringify(cfg));
  await installed(home);
  await installedHeader(home, `${remote.url}/json`);
  const old = { internals: process.env.PLUR1BUS_ALLOW_TEST_INTERNALS, keyring: process.env.PLUR1BUS_SECRETS_KEYRING,
    ambient: process.env.PLUR1BUS_AMBIENT_TEST_SECRET };
  process.env.PLUR1BUS_ALLOW_TEST_INTERNALS = "1";
  process.env.PLUR1BUS_SECRETS_KEYRING = "memory";
  process.env.PLUR1BUS_AMBIENT_TEST_SECRET = "synthetic-ambient-must-not-reach-child";
  let who: Principal = { userId: "local-owner", kind: "person", role: "owner" };
  let toolsForTurn: TurnProviderOptions["toolsForTurn"];
  const core = createCore({ home, testInternals: flatTestInternals(), discovery: { scheduler: false },
    rbac: { resolve: () => who }, composition: {
      providers: { profiles: { default: [{ provider: "fixture", model: "fixture", adapter: {
        async *stream() { /* the test exercises composition without a model */ },
      } }] } },
      createTurnProvider: options => {
        if (options.toolsForTurn) toolsForTurn = options.toolsForTurn;
        return { id: "fixture", telemetry: {}, async *stream() {} } as never;
      },
    } });
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  let delegated: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    await core.start();
    client = await connect({ address: core.address, token: core.token });
    const before = await client.call<{ slots: { present: boolean | null }[] }>("admin.extensions.setup.get", { name: "reports" });
    assert.equal(before.slots[0]?.present, false);
    assert.deepEqual(await client.call("admin.extensions.runtime.status", { name: "reports" }),
      { name: "reports", overlay: "needs-setup" });
    assert.ok(toolsForTurn, "production turn-provider composition must supply its MCP registry");
    assert.equal((await toolsForTurn(request)).entries().some(tool => tool.name.startsWith("mcp.reports.")), false);

    who = { userId: "admin", kind: "person", role: "admin" };
    await client.call("admin.extensions.setup.get", { name: "reports" });
    await assert.rejects(client.call("admin.extensions.runtime.hold", { name: "reports" }),
      (error: { error?: string }) => error.error === "E_DENIED");
    await assert.rejects(client.call("admin.extensions.setup.set", { name: "reports", slot: "TOKEN", value: SECRET }),
      (error: { error?: string }) => error.error === "E_DENIED");
    who = { userId: "local-owner", kind: "agent", role: "owner" };
    await assert.rejects(client.call("admin.extensions.setup.get", { name: "reports" }),
      (error: { error?: string }) => error.error === "E_DENIED");
    who = { userId: "local-owner", kind: "person", role: "owner" };
    await assert.rejects(client.call("admin.extensions.auth.start", { name: "reports" }),
      (error: { error?: string; reason?: string }) => error.error === "E_NOT_AVAILABLE" && error.reason === "auth-required");
    assert.deepEqual(await client.call("admin.extensions.setup.set", { name: "reports", slot: "TOKEN", value: SECRET }),
      { name: "reports", slot: "TOKEN", stored: true });
    await nativeLease(home, core.token);
    assert.equal(remote.requests.length, 0, "a remote header server is never contacted before its slot is present");
    await client.call("admin.extensions.setup.set", { name: "headersrv", slot: "TOKEN", value: REMOTE_SECRET });
    let registry: ToolRegistry = await toolsForTurn(request);
    assert.ok(registry.entries().some(tool => tool.name.startsWith("mcp.headersrv.")));
    assert.ok(remote.requests.length > 0);
    assert.ok(remote.requests.every(request => request.headers.authorization === `Bearer ${REMOTE_SECRET}`),
      "the real registry leases the canonical extension bearer rather than anonymous or static-header fallback");
    const run = { agentId: "a", principal: "local-owner", sessionId: request.sessionId, signal, surface: 0 as const };
    const tool = (name: string) => registry.entries().find(tool => tool.name === `mcp.reports.${name}`)!;
    const env = await tool("leak_env").execute({ name: "TOKEN" }, run);
    assert.match(JSON.stringify(env), /REDACTED/);
    assert.ok(!JSON.stringify(env).includes(SECRET));
    const ambient = await tool("leak_env").execute({ name: "PLUR1BUS_AMBIENT_TEST_SECRET" }, run);
    assert.match(JSON.stringify(ambient), /value=/);
    assert.ok(!JSON.stringify(ambient).includes("synthetic-ambient"));
    const pidResult = await tool("pid").execute({}, run) as { content: { text: string }[] };
    let pid = Number(pidResult.content[0]!.text);
    assert.ok(pid > 0);
    const oldPidTool = tool("pid");
    await client.call("secret.set", { name: "ext:reports:TOKEN", value: ROTATED_SECRET });
    assert.ok(await waitDead(pid), "rotation must stop a child that inherited the retired value");
    await assert.rejects(() => oldPidTool.execute({}, run));
    registry = await toolsForTurn(request);
    const restarted = await tool("pid").execute({}, run) as { content: { text: string }[] };
    const nextPid = Number(restarted.content[0]!.text);
    assert.notEqual(nextPid, pid);
    pid = nextPid;
    assert.deepEqual(await client.call("admin.extensions.runtime.hold", { name: "reports" }), { name: "reports", held: true });
    assert.ok(await waitDead(pid));
    assert.equal((await toolsForTurn(request)).entries().some(tool => tool.name.startsWith("mcp.reports.")), false);
    await assert.rejects(() => tool("pid").execute({}, run));
    assert.deepEqual(await client.call("admin.extensions.runtime.release", { name: "reports" }),
      { name: "reports", released: true });
    assert.equal((await toolsForTurn(request)).entries().some(tool => tool.name.startsWith("mcp.reports.")), true);

    const apiToken = (await readFile(join(home, "run", "api-delegation.token"), "utf8")).trim();
    delegated = await connect({ address: core.address, token: core.token, api: { clientId: "harness-api", token: apiToken,
      principal: { userId: "local-owner", kind: "person", role: "owner" } } });
    await assert.rejects(delegated.call("admin.extensions.runtime.hold", { name: "reports" }),
      (error: { error?: string }) => error.error === "E_DENIED");
    await delegated.close();
    delegated = await connect({ address: core.address, token: core.token, api: { clientId: "harness-api", token: apiToken,
      principal: { userId: "local-owner", kind: "agent", role: "owner", tokenScopes: ["extensions.*"] } } });
    await assert.rejects(delegated.call("admin.extensions.setup.get", { name: "reports" }),
      (error: { error?: string }) => error.error === "E_DENIED");
    await assert.rejects(delegated.call("admin.extensions.auth.start", { name: "reports" }),
      (error: { error?: string }) => error.error === "E_DENIED");
  } finally {
    await delegated?.close();
    await client?.close();
    await core.stop({ budgetMs: 5000 });
    await remote.close();
    for (const [key, value] of Object.entries({ PLUR1BUS_ALLOW_TEST_INTERNALS: old.internals,
      PLUR1BUS_SECRETS_KEYRING: old.keyring, PLUR1BUS_AMBIENT_TEST_SECRET: old.ambient })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  const files = (await readdir(join(home, "logs"))).filter(name => /\.(log|jsonl)$/.test(name));
  for (const file of files) {
    const text = await readFile(join(home, "logs", file), "utf8");
    assert.ok(!text.includes(SECRET) && !text.includes(REMOTE_SECRET) && !text.includes(ROTATED_SECRET), file);
  }
});

it("a legacy MCP registration sharing a disabled package name receives no extension secret leases", {
  timeout: 60_000,
}, async () => {
  const home = tempDir("p1b-A7-legacy-");
  const cfg = defaults();
  cfg.agents.a = {};
  cfg.mcp.servers.reports = { enabled: false, agents: "all" };
  cfg.providers.mcp = { allowedCommands: [process.execPath], servers: [{ name: "reports",
    transport: { type: "stdio", command: process.execPath, args: [FIXTURE_STDIO] } }] };
  cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false },
    merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false },
    temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false }, reranker: { enabled: false } };
  await writeFile(join(home, "config.json"), JSON.stringify(cfg));
  await installed(home);
  const old = { internals: process.env.PLUR1BUS_ALLOW_TEST_INTERNALS, keyring: process.env.PLUR1BUS_SECRETS_KEYRING };
  process.env.PLUR1BUS_ALLOW_TEST_INTERNALS = "1";
  process.env.PLUR1BUS_SECRETS_KEYRING = "memory";
  let toolsForTurn: TurnProviderOptions["toolsForTurn"];
  const core = createCore({ home, testInternals: flatTestInternals(), discovery: { scheduler: false }, composition: {
    providers: { profiles: { default: [{ provider: "fixture", model: "fixture", adapter: { async *stream() {} } }] } },
    createTurnProvider: options => {
      if (options.toolsForTurn) toolsForTurn = options.toolsForTurn;
      return { id: "fixture", telemetry: {}, async *stream() {} } as never;
    },
  } });
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    await core.start();
    client = await connect({ address: core.address, token: core.token });
    await client.call("admin.extensions.setup.set", { name: "reports", slot: "TOKEN", value: SECRET });
    assert.ok(toolsForTurn);
    const registry = await toolsForTurn(request);
    const tool = registry.entries().find(tool => tool.name === "mcp.reports.leak_env")!;
    assert.ok(tool, "legacy provider registrations remain visible independently of package enablement");
    const result = await tool.execute({ name: "TOKEN" }, { agentId: "a", principal: "local-owner",
      sessionId: request.sessionId, signal, surface: 0 });
    assert.match(JSON.stringify(result), /value=/);
    assert.ok(!JSON.stringify(result).includes(SECRET));
    assert.ok(!JSON.stringify(result).includes("REDACTED"), "the package token must never reach the legacy child");
  } finally {
    await client?.close();
    await core.stop({ budgetMs: 5000 });
    if (old.internals === undefined) delete process.env.PLUR1BUS_ALLOW_TEST_INTERNALS;
    else process.env.PLUR1BUS_ALLOW_TEST_INTERNALS = old.internals;
    if (old.keyring === undefined) delete process.env.PLUR1BUS_SECRETS_KEYRING;
    else process.env.PLUR1BUS_SECRETS_KEYRING = old.keyring;
  }
  assert.ok(!(await readFile(join(home, "logs", "audit-chain.jsonl"), "utf8")).includes("extension-spawn"));
});
