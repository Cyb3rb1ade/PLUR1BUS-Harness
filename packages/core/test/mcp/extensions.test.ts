/** M-A4: installed extension metadata becomes live, lazy MCP registrations without executing installation hooks. */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { McpExtensionReconciler } from "../../src/mcp/extensions.ts";
import { McpRegistry } from "../../src/mcp/registry.ts";
import { capturingLogger, caller, FIXTURE_STDIO, waitDead } from "./helpers/util.ts";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });

async function fixture(remote?: Record<string, unknown>) {
  const home = await mkdtemp(join(tmpdir(), "p1b-mcp-ext-"));
  homes.push(home);
  const payload = join(home, "extensions", "packages", "reports", "payload");
  await mkdir(payload, { recursive: true });
  const manifest = {
    name: "reports", kind: "mcp-server", id: "test/reports", version: "1.0.0",
    requires: { runtime: { type: remote ? "none" : "node", range: ">=24" } as {
      type: string; range: string; via?: string; lock?: string;
    } },
    capabilities: { network: { mode: "none" }, tools: [{ name: "echo", effect: "read" }], secrets: [] },
    files: {} as Record<string, { sha256: string; size: number }>,
    remote: remote ?? null,
  };
  const state = { schemaVersion: 1, items: { reports: { name: "reports", id: manifest.id, version: "1.0.0",
    kind: "mcp-server", removedByUser: false, requiredSecrets: [], capabilities: manifest.capabilities,
    manifestSha256: "" } } };
  const approveManifest = async () => {
    const bytes = JSON.stringify(manifest);
    state.items.reports.manifestSha256 = createHash("sha256").update(bytes).digest("hex");
    state.items.reports.version = manifest.version;
    state.items.reports.capabilities = manifest.capabilities;
    await writeFile(join(home, "extensions", "state.json"), JSON.stringify(state));
    await writeFile(join(payload, "..", "p1x.json"), bytes);
  };
  const approveMcpb = async (value: unknown) => {
    const bytes = JSON.stringify(value);
    manifest.files["payload/manifest.json"] = { sha256: createHash("sha256").update(bytes).digest("hex"),
      size: Buffer.byteLength(bytes) };
    await writeFile(join(payload, "manifest.json"), bytes);
    await approveManifest();
  };
  await approveMcpb({ server: {
    type: "node", entry_point: "server.mjs", mcp_config: { command: "node", args: ["${__dirname}/server.mjs"] },
  } });
  await writeFile(join(payload, "server.mjs"), `import ${JSON.stringify(FIXTURE_STDIO)};`);
  const config = { providers: {}, mcp: { servers: { reports: { enabled: true, agents: "all" as "all" | string[] } } } };
  const registry = new McpRegistry({ logger: capturingLogger(), hostEnv: {} });
  return { home, payload, manifest, config, registry, approveManifest, approveMcpb };
}

describe("M-A4 installed MCP composition", () => {
  it("uses the running pinned Node, an absolute entry and payload cwd, then stops the live child on disable", async () => {
    const f = await fixture();
    const reconciler = new McpExtensionReconciler({ home: f.home, config: () => f.config, registry: f.registry });
    try {
      await reconciler.refresh();
      assert.deepEqual(reconciler.servers(), ["reports"]);
      const definition = reconciler.definition("reports")!;
      assert.equal(definition.transport.type, "stdio");
      if (definition.transport.type !== "stdio") assert.fail("stdio definition expected");
      assert.equal(definition.transport.command, process.execPath);
      assert.equal(definition.transport.cwd, f.payload);
      assert.deepEqual(definition.transport.args, [join(f.payload, "server.mjs")]);
      assert.deepEqual(definition.transport.env, {});
      assert.deepEqual(definition.transport.fromHost, []);
      await f.registry.listTools("reports", caller);
      const pid = f.registry.status("reports", caller.agentId).pid!;
      assert.ok(pid);
      f.config.mcp.servers.reports.enabled = false;
      await reconciler.refresh();
      assert.deepEqual(reconciler.servers(), []);
      assert.ok(await waitDead(pid), "disable reaps the child instead of only hiding its tools");
    } finally { await reconciler.close(); await f.registry.shutdown(); }
  });

  it("keeps legacy providers.mcp definitions while registering remote extensions lazily", async () => {
    const f = await fixture({ url: "https://mcp.example.test/mcp", auth: "none" });
    const config = { ...f.config, providers: { mcp: { servers: [{ name: "legacy", transport: {
      type: "http", url: "http://127.0.0.1:1/mcp",
    } }] } } };
    const reconciler = new McpExtensionReconciler({ home: f.home, config: () => config, registry: f.registry });
    try {
      await reconciler.refresh();
      assert.deepEqual(reconciler.servers(), ["legacy", "reports"]);
      assert.equal(f.registry.status("reports", "A").starts, 0);
      assert.deepEqual(reconciler.definition("reports")!.transport,
        { type: "http", url: "https://mcp.example.test/mcp", headers: {} });
    } finally { await reconciler.close(); await f.registry.shutdown(); }
  });

  it("holds missing uv runtimes and remote auth at needs-setup without spawning or installing anything", async () => {
    for (const remote of [undefined, { url: "https://mcp.example.test/mcp", auth: "header" },
      { url: "https://mcp.example.test/mcp", auth: "oauth" }]) {
      const f = await fixture(remote);
      if (!remote) {
        f.manifest.requires.runtime = { type: "python", range: ">=3.12" };
        await f.approveManifest();
      }
      const reconciler = new McpExtensionReconciler({ home: f.home, config: () => f.config, registry: f.registry });
      try {
        await reconciler.refresh();
        assert.deepEqual(reconciler.servers(), []);
        assert.equal(reconciler.status("reports")?.overlay, "needs-setup");
      } finally { await reconciler.close(); await f.registry.shutdown(); }
    }
  });

  it("uses ext.watch/list overlays and fails closed when the supervisor feed is lost", async () => {
    const f = await fixture();
    let overlays: string[] = [];
    let failed = false;
    const feed = { async snapshot() {
      if (failed) throw Error("disconnected");
      return [{ name: "reports", kind: "mcp-server", enabled: true, agents: "all" as const, overlays }];
    } };
    const reconciler = new McpExtensionReconciler({ home: f.home, config: () => f.config, registry: f.registry, feed });
    try {
      await reconciler.refresh();
      assert.deepEqual(reconciler.servers(), ["reports"]);
      overlays = ["revoked"];
      await reconciler.refresh();
      assert.deepEqual(reconciler.servers(), []);
      overlays = [];
      await reconciler.refresh();
      failed = true;
      await reconciler.refresh();
      assert.deepEqual(reconciler.servers(), []);
    } finally { await reconciler.close(); await f.registry.shutdown(); }
  });

  it("rejects installed metadata and launch paths that escape the package payload", async () => {
    const f = await fixture();
    await writeFile(join(f.payload, "manifest.json"), JSON.stringify({ server: {
      type: "node", entry_point: "../outside.mjs",
    } }));
    const reconciler = new McpExtensionReconciler({ home: f.home, config: () => f.config, registry: f.registry });
    try {
      await reconciler.refresh();
      assert.deepEqual(reconciler.servers(), []);
      await rm(join(f.payload, "manifest.json"));
      const outside = join(f.home, "outside.json");
      await writeFile(outside, JSON.stringify({ server: { type: "node", entry_point: "server.mjs" } }));
      await symlink(outside, join(f.payload, "manifest.json"));
      await reconciler.refresh();
      assert.deepEqual(reconciler.servers(), []);
    } finally { await reconciler.close(); await f.registry.shutdown(); }
  });

  it("preserves separate legacy servers with the same name in different agent scopes", async () => {
    const f = await fixture({ url: "http://127.0.0.1:1/mcp", auth: "none" });
    const config = { ...f.config, providers: { mcp: { servers: ["A", "B"].map(agentId => ({
      name: "legacy", scope: { kind: "agent", agentId }, transport: { type: "http", url: "http://127.0.0.1:1/mcp" },
    })) } } };
    const reconciler = new McpExtensionReconciler({ home: f.home, config: () => config, registry: f.registry });
    try {
      await reconciler.refresh();
      assert.deepEqual(reconciler.servers(), ["legacy", "reports"]);
      for (const agent of ["A", "B"]) {
        assert.equal(reconciler.visible("legacy", agent), true);
        assert.equal(f.registry.status("legacy", agent).scope.kind, "agent");
      }
      assert.equal(reconciler.visible("legacy", "C"), false);
    } finally { await reconciler.close(); await f.registry.shutdown(); }
  });

  it("reacts to config events and revokes a live child before a pending supervisor refresh completes", async () => {
    const f = await fixture();
    let listener: (() => void) | undefined;
    let detach = false;
    let hold: (() => void) | undefined;
    let wait = false;
    const feed = { async snapshot() {
      if (wait) await new Promise<void>(resolve => { hold = resolve; });
      return [{ name: "reports", kind: "mcp-server", enabled: true, agents: "all" as const, overlays: [] }];
    } };
    const reconciler = new McpExtensionReconciler({ home: f.home, config: () => f.config, registry: f.registry,
      feed, onConfigChange: changed => { listener = changed; return () => { detach = true; }; } });
    try {
      await reconciler.refresh();
      await f.registry.listTools("reports", caller);
      const pid = f.registry.status("reports", caller.agentId).pid!;
      wait = true;
      const pending = reconciler.refresh();
      while (!hold) await new Promise<void>(resolve => setImmediate(resolve));
      f.config.mcp.servers.reports.enabled = false;
      listener!();
      assert.equal(reconciler.visible("reports", caller.agentId), false);
      assert.ok(await waitDead(pid), "disable must not wait behind supervisor metadata I/O");
      wait = false;
      hold();
      await pending;
      await reconciler.refresh();
      assert.deepEqual(reconciler.servers(), []);
    } finally { hold?.(); await reconciler.close(); await f.registry.shutdown(); }
    assert.equal(detach, true);
  });

  it("refuses oversized metadata and unsatisfied runtime constraints without starting the server", async () => {
    const f = await fixture();
    const reconciler = new McpExtensionReconciler({ home: f.home, config: () => f.config, registry: f.registry });
    try {
      f.manifest.requires.runtime.range = ">=99";
      await f.approveManifest();
      await reconciler.refresh();
      assert.equal(reconciler.status("reports")?.overlay, "needs-setup");
      await writeFile(join(f.payload, "..", "p1x.json"), " ".repeat(1024 * 1024 + 1));
      await reconciler.refresh();
      assert.equal(reconciler.status("reports")?.overlay, "error");
      assert.deepEqual(reconciler.servers(), []);
    } finally { await reconciler.close(); await f.registry.shutdown(); }
  });

  it("compares Python constraints with provisioned Python instead of the independently pinned uv version", async () => {
    const f = await fixture();
    f.manifest.requires.runtime = { type: "python", range: ">=3.12", via: "uv", lock: "payload/uv.lock" };
    await writeFile(join(f.payload, "uv.lock"), "version = 1\n");
    await f.approveMcpb({ server: { type: "uv", entry_point: "server.mjs" } });
    const reconciler = new McpExtensionReconciler({ home: f.home, config: () => f.config, registry: f.registry,
      runtime: { uv: { command: process.execPath, version: "0.9.3", python: process.execPath, pythonVersion: "3.12.10" } } });
    try {
      await reconciler.refresh();
      assert.deepEqual(reconciler.servers(), ["reports"]);
      const transport = reconciler.definition("reports")!.transport;
      assert.equal(transport.type, "stdio");
      if (transport.type !== "stdio") assert.fail("stdio expected");
      assert.deepEqual(transport.args.slice(0, 6),
        ["run", "--frozen", "--offline", "--no-python-downloads", "--python", process.execPath]);
      assert.equal(f.registry.status("reports", "A").starts, 0);
    } finally { await reconciler.close(); await f.registry.shutdown(); }
  });

  it("rejects changed root launch metadata before trusting its URL or tool declarations", async () => {
    const f = await fixture({ url: "https://approved.example.test/mcp", auth: "none" });
    const reconciler = new McpExtensionReconciler({ home: f.home, config: () => f.config, registry: f.registry });
    try {
      await reconciler.refresh();
      assert.deepEqual(reconciler.servers(), ["reports"]);
      f.manifest.remote = { url: "https://changed.example.test/mcp", auth: "none" };
      await writeFile(join(f.payload, "..", "p1x.json"), JSON.stringify(f.manifest));
      await reconciler.refresh();
      assert.deepEqual(reconciler.servers(), []);
      assert.equal(reconciler.status("reports")?.overlay, "error");
    } finally { await reconciler.close(); await f.registry.shutdown(); }
  });

  it("replaces an installed package generation even when its launch path and disclosed capabilities stay the same", async () => {
    const f = await fixture({ url: "https://approved.example.test/mcp", auth: "none" });
    const reconciler = new McpExtensionReconciler({ home: f.home, config: () => f.config, registry: f.registry });
    try {
      await reconciler.refresh();
      const first = reconciler.revision("reports", "A");
      f.manifest.version = "1.0.1";
      await f.approveManifest();
      await reconciler.refresh();
      assert.notEqual(reconciler.revision("reports", "A"), first,
        "an old turn cannot execute replacement code under the previous registration's policy snapshot");
    } finally { await reconciler.close(); await f.registry.shutdown(); }
  });
});
