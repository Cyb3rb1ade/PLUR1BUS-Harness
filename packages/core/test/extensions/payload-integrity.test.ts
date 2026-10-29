/** Installed code is authenticated again at every real lazy launch and reconnect, rather than trusted from ext.list. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { composeExtensions } from "../../src/composition/extensions.ts";
import { createSecretStore } from "../../src/secrets/store.ts";
import { createMemoryBackend } from "../../src/secrets/memory-backend.ts";
import { createMemoryAuditSink } from "../../src/secrets/audit.ts";
import { createEgress } from "../../src/egress/index.ts";
import { createWriter } from "../../src/logs/writer.ts";
import { caller, capturingLogger, FIXTURE_STDIO, waitDead } from "../mcp/helpers/util.ts";

async function rig(withSecret = false) {
  const home = await mkdtemp(join(tmpdir(), "p1b-mcp-integrity-"));
  const payload = join(home, "mcp", "reports", "1.0.0", "payload");
  await mkdir(join(payload, "lib"), { recursive: true });
  await mkdir(join(home, "extensions"));
  const files: Record<string, { sha256: string; size: number; exec: boolean }> = {};
  for (const [path, content] of Object.entries({
    "manifest.json": JSON.stringify({ server: { type: "node", entry_point: "main.mjs" } }),
    "main.mjs": `await import(${JSON.stringify(FIXTURE_STDIO)});`,
    "lib/data.txt": "approved supporting payload".repeat(8000),
  })) {
    await writeFile(join(payload, path), content, { mode: 0o600 });
    files[`payload/${path}`] = { sha256: createHash("sha256").update(content).digest("hex"),
      size: Buffer.byteLength(content), exec: false };
  }
  const manifest = { id: "test/reports", name: "reports", version: "1.0.0", kind: "mcp-server",
    requires: { runtime: { type: "node", range: ">=24" } },
    capabilities: { network: { mode: "none" }, tools: [],
      secrets: withSecret ? [{ slot: "TOKEN", required: true }] : [] }, files };
  const bytes = JSON.stringify(manifest);
  await writeFile(join(payload, "..", "p1x.json"), bytes, { mode: 0o600 });
  await writeFile(join(home, "extensions", "state.json"), JSON.stringify({ schemaVersion: 1, items: { reports: {
    id: manifest.id, name: manifest.name, version: manifest.version, activeVersion: manifest.version,
    kind: manifest.kind, manifestSha256: createHash("sha256").update(bytes).digest("hex"),
    capabilities: manifest.capabilities,
  } } }), { mode: 0o600 });
  const cfg = defaults();
  cfg.agents[caller.agentId] = {};
  cfg.mcp.servers.reports = { enabled: true, agents: "all" };
  const logger = capturingLogger();
  const backend = createMemoryBackend();
  let onRead: (() => Promise<void> | void) | undefined;
  const get = backend.get;
  backend.get = async name => { const value = await get(name); await onRead?.(); return value; };
  const store = createSecretStore({ keyring: backend, file: createMemoryBackend(),
    fileFallback: () => false, audit: createMemoryAuditSink() });
  if (withSecret) await store.set({ kind: "owner" }, "ext:reports:TOKEN", "synthetic-launch-integrity-secret");
  const output = createWriter({ dir: join(home, "logs"), role: "core.out", timers: false,
    source: { kind: "harness", id: "mcp", version: "0.1.0" } });
  const composition = await composeExtensions({ home, config: () => cfg, secrets: store,
    egress: createEgress({ config: () => cfg.egress }), logger: logger as never, output, clock: Date.now });
  const marker = join(home, "unapproved-code-started");
  const tamper = () => writeFile(join(payload, "main.mjs"),
    `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'executed');await import(${JSON.stringify(FIXTURE_STDIO)});`);
  return { home, payload, composition, logger, marker, tamper, store,
    onSecretRead(callback: () => Promise<void> | void) { onRead = callback; }, async close() {
    await composition.close(); output.close(); await rm(home, { recursive: true, force: true });
  } };
}

it("a lazy launch refuses an entry modified after registration and revokes the current tool authority", async () => {
  const r = await rig();
  try {
    assert.equal(r.composition.registry.status("reports", caller.agentId).starts, 0);
    await r.tamper();
    await assert.rejects(r.composition.registry.listTools("reports", caller));
    assert.equal(r.composition.registry.status("reports", caller.agentId).pid, null);
    assert.equal(r.composition.controller.visible("reports", caller.agentId), false);
    assert.equal(r.composition.controller.status("reports")?.overlay, "error");
    assert.equal(r.composition.controller.status("reports")?.reason, undefined);
    await assert.rejects(readFile(r.marker), { code: "ENOENT" });
    assert.ok(!r.logger.text().includes(r.home), "integrity failures expose no private path");
  } finally { await r.close(); }
});

it("a payload changed while acquiring a real secret lease is refused and the lease is revoked", async () => {
  const r = await rig(true);
  try {
    r.onSecretRead(r.tamper);
    await assert.rejects(r.composition.registry.listTools("reports", caller));
    assert.equal((await r.store.status({ kind: "core" })).activeLeases, 0);
    assert.equal(r.composition.registry.status("reports", caller.agentId).starts, 0);
    assert.equal(r.composition.controller.status("reports")?.overlay, "error");
    await assert.rejects(readFile(r.marker), { code: "ENOENT" });
  } finally { await r.close(); }
});

it("a transaction hold during acquisition revokes the exact registration before any process can launch", async () => {
  const r = await rig(true);
  let held: Promise<unknown> | undefined;
  try {
    r.onSecretRead(() => { held = r.composition.controller.hold("reports"); });
    await assert.rejects(r.composition.registry.listTools("reports", caller));
    await held;
    assert.equal((await r.store.status({ kind: "core" })).activeLeases, 0);
    assert.deepEqual(r.composition.registry.list(caller.agentId), []);
    assert.equal(r.composition.controller.visible("reports", caller.agentId), false);
  } finally { await r.close(); }
});

it("a reconnect authenticates payload bytes again before launching the replacement child", async () => {
  const r = await rig();
  try {
    await r.composition.registry.listTools("reports", caller);
    const pid = r.composition.registry.status("reports", caller.agentId).pid!;
    assert.ok(pid > 0);
    await r.tamper();
    await assert.rejects(r.composition.registry.callTool("reports", "crash", {}, caller));
    assert.ok(await waitDead(pid));
    await assert.rejects(r.composition.registry.callTool("reports", "echo", { text: "again" }, caller));
    await assert.rejects(readFile(r.marker), { code: "ENOENT" });
    assert.equal(r.composition.registry.status("reports", caller.agentId).starts, 1);
    assert.equal(r.composition.controller.visible("reports", caller.agentId), false);
  } finally { await r.close(); }
});

for (const change of ["supporting-file", "file-symlink", "directory-symlink"] as const) {
  it(`a lazy launch checks every approved payload file and rejects ${change}`, async () => {
    const r = await rig();
    try {
      const file = join(r.payload, "lib", "data.txt");
      if (change === "supporting-file") await writeFile(file, "unapproved supporting payload");
      else if (change === "file-symlink") {
        const target = join(r.payload, "copy.txt");
        await writeFile(target, await readFile(file));
        await rm(file); await symlink(target, file);
      } else {
        const target = join(r.payload, "copy");
        await mkdir(target); await writeFile(join(target, "data.txt"), await readFile(file));
        await rm(join(r.payload, "lib"), { recursive: true });
        await symlink(target, join(r.payload, "lib"), process.platform === "win32" ? "junction" : "dir");
      }
      await assert.rejects(r.composition.registry.listTools("reports", caller));
      assert.equal(r.composition.registry.status("reports", caller.agentId).starts, 0);
      assert.equal(r.composition.controller.status("reports")?.overlay, "error");
    } finally { await r.close(); }
  });
}
