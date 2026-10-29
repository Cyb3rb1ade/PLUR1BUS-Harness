/** Actual HTTP Owner setup -> real SSH/SFTP discovery/seal -> native maintenance -> restarted Core and real recall. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, lstat, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { createApiServer } from "../../src/server.ts";
import { createCoreLink } from "../../src/core-link.ts";
import { createImportRecords } from "../../../core/src/import/maintenance-records.ts";
import { verifySourceSnapshot } from "../../../core/src/import/snapshot-source.ts";
import { createSshSources } from "./import-ssh-source-tree.ts";

const [home, remoteRoot, mode, serverPath] = process.argv.slice(2);
if (
  !home ||
  !remoteRoot ||
  !["source-a", "source-b"].includes(mode) ||
  !serverPath ||
  !isAbsolute(serverPath) ||
  process.env.PLUR1BUS_ALLOW_TEST_INTERNALS !== "1"
)
  throw new Error("SSH maintenance fixture arguments and gate required");
const deadline = Date.now() + 105_000;
const fixture = await createSshSources(remoteRoot);
const selected = fixture.sources[mode === "source-a" ? 0 : 1];
const unselected = fixture.sources[mode === "source-a" ? 1 : 0];
const link = createCoreLink(home),
  ownerToken = randomBytes(32).toString("hex");
const api = createApiServer({
  home,
  core: link,
  ownerToken,
  resolveBootstrap: async () => (await link.serviceCall("admin.api.person.resolve", { userId: "local-owner" })).person,
});
const { url } = await api.listen();
const responses = [];
let server;
let sequence = 0;
const request = (path, options = {}) =>
  fetch(url + path, {
    ...options,
    headers: { connection: "close", ...options.headers },
    signal: AbortSignal.timeout(Math.max(1, Math.min(30_000, deadline - Date.now()))),
  });
const record = async (response) => {
  const raw = await response.text();
  assert.ok(Buffer.byteLength(raw) <= 2 * 1024 * 1024, "bounded HTTP response body");
  responses.push(raw);
  assert.ok(
    responses.reduce((size, body) => size + Buffer.byteLength(body), 0) <= 8 * 1024 * 1024,
    "bounded accumulated HTTP evidence",
  );
  return JSON.parse(raw);
};
const exists = async (path) => {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};
async function startServer(publicKey) {
  const child = spawn(serverPath, [], { stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  const completion = new Promise((resolve) => child.once("close", resolve));
  let diagnostic = "";
  child.stderr.on("data", (chunk) => {
    diagnostic = (diagnostic + chunk.toString()).slice(-4096);
  });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("SFTP fixture readiness timeout"));
    }, 10_000);
    lines.once("line", (line) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(line));
      } catch {
        reject(new Error("invalid SFTP readiness metadata"));
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", () => {
      clearTimeout(timer);
      reject(new Error("SFTP fixture closed before readiness"));
    });
    child.stdin.write(JSON.stringify({ root: remoteRoot, authorizedPublicKey: publicKey }) + "\n");
  });
  assert.equal(ready.ip, "127.0.0.1");
  assert.ok(Number.isInteger(ready.port) && ready.port > 0 && ready.port <= 65535);
  assert.match(ready.hostKeySha256, /^SHA256:[A-Za-z0-9+/]{43}$/);
  let closed = false;
  return {
    ready,
    diagnostic: () => diagnostic,
    async close() {
      if (closed) return;
      closed = true;
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
      const code = await completion;
      clearTimeout(timer);
      lines.close();
      assert.equal(code, 0, "the real read-only SFTP source closes cleanly before maintenance");
    },
  };
}
async function csrf(cookie) {
  const response = await request("/api/v1/csrf", { headers: { cookie } });
  const value = await record(response);
  if (response.status === 503 && value.error === "E_CORE_UNAVAILABLE") throw { transientCore: true };
  assert.equal(response.status, 200, "real session CSRF authority");
  return value.token;
}
async function rpc(cookie, method, params = {}) {
  const response = await request("/rpc", {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "x-csrf-token": await csrf(cookie) },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
  });
  const reply = await record(response);
  if (response.status === 503 && reply.error === "E_CORE_UNAVAILABLE") throw { transientCore: true };
  assert.equal(response.status, 200, `actual HTTP ${method} transport`);
  assert.ok(
    !reply.error && reply.result !== undefined,
    `actual ${method} succeeds (${reply.error?.data?.error ?? "none"}/${reply.error?.data?.reason ?? "none"})`,
  );
  return reply.result;
}
async function scanFiles(root, check, maxBytes = 16 * 1024 * 1024) {
  let bytes = 0;
  const visit = async (path) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) {
        const info = await lstat(file);
        bytes += info.size;
        assert.ok(bytes <= maxBytes, "bounded source/log leak scan");
        check((await readFile(file)).toString("utf8"));
      }
    }
  };
  await visit(root);
}
const noPrivateMaterial = (text) => {
  assert.ok(!text.includes(fixture.canary), "source credential canary never crosses a metadata or log boundary");
  assert.ok(!text.includes(ownerToken), "API credential never appears in output");
  assert.ok(!/BEGIN (?:OPENSSH )?PRIVATE KEY/.test(text), "private SSH key is never printable or persisted");
};
try {
  const login = await request("/api/v1/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: ownerToken }),
  });
  assert.equal(login.status, 200);
  await record(login);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  const before = await rpc(cookie, "core.status");
  assert.deepEqual(await rpc(cookie, "admin.import.ssh.key.status"), { configured: false });
  const key = await rpc(cookie, "admin.import.ssh.key.generate");
  assert.equal(key.configured, true);
  assert.match(key.publicKey, /^ssh-ed25519 [A-Za-z0-9+/]+=*$/);
  assert.ok(key.instructions.includes("-R"), "the Owner receives read-only SFTP setup instructions");
  server = await startServer(key.publicKey);
  const endpoint = server.ready;
  const policy = await rpc(cookie, "config.get", { key: "egress" });
  const allowed = await rpc(cookie, "config.set", {
    ifRevision: policy.revision,
    changes: [
      { key: "egress.allowHosts", value: [...new Set([...policy.value.allowHosts, endpoint.ip])] },
      { key: "egress.allowPorts", value: [...new Set([...policy.value.allowPorts, endpoint.port])] },
    ],
  });
  assert.equal(allowed.applied, true, "explicit Owner exact host and port consent updates actual central policy");
  await rpc(cookie, "admin.import.ssh.connections.set", {
    connection: {
      id: "actual-source",
      host: endpoint.ip,
      port: endpoint.port,
      user: "fixture-user",
      roots: ["/"],
      allowPrivate: true,
    },
  });
  const probe = await rpc(cookie, "admin.import.ssh.hostKey.probe", { id: "actual-source" });
  assert.equal(probe.hostKeySha256, endpoint.hostKeySha256, "Owner verifies the actual server fingerprint out of band");
  const trusted = await rpc(cookie, "admin.import.ssh.hostKey.trust", {
    connectionId: "actual-source",
    probeId: probe.probeId,
    hostKeySha256: probe.hostKeySha256,
  });
  assert.equal(trusted.connection.hostKey.sha256, endpoint.hostKeySha256);
  const discovered = await rpc(cookie, "admin.import.detect", {
    discover: true,
    source: { kind: "ssh", family: selected.family, connectionId: "actual-source", path: "/" },
  });
  assert.equal(discovered.discovery, true, "broad remote root uses bounded known-home discovery");
  for (const source of fixture.sources)
    assert.equal(
      discovered.candidates.some(
        (candidate) =>
          candidate.source.kind === "ssh" &&
          candidate.source.family === source.family &&
          candidate.source.path === source.remotePath,
      ),
      true,
      "both canonical source families are discoverable through the real SSH transport",
    );
  const chosen = discovered.candidates.find(
    (candidate) => candidate.source.family === selected.family && candidate.source.path === selected.remotePath,
  );
  assert.ok(chosen);
  const detected = await rpc(cookie, "admin.import.detect", { source: chosen.source });
  assert.equal(detected.sourceType, selected.family);
  assert.equal(detected.counts.skills, 1);
  assert.equal(detected.counts.memories, 1);
  assert.equal(detected.agents.length, 1);
  assert.equal(detected.plugins.length, 1);
  assert.equal(detected.plugins[0].classification, "unknown");
  assert.equal(detected.mcpServers.length, 1);
  assert.equal(detected.mcpServers[0].enabled, false);
  assert.equal(detected.mcpServers[0].needsSetup, true);
  const plan = await rpc(cookie, "admin.import.plan", {
    sourceId: detected.sourceId,
    options: { onConflict: "skip", migrateSecrets: false, agentIds: detected.agents.map((agent) => agent.id) },
  });
  const { record: sealed } = await createImportRecords(home).readPlan(plan.planId, "local-owner", plan.planSha256);
  const snapshotRoot = join(home, "import", sealed.snapshotId, "snapshot");
  assert.ok(verifySourceSnapshot(snapshotRoot, home), "actual remote bytes are sealed before stopping Core");
  await scanFiles(snapshotRoot, noPrivateMaterial);
  await server.close(); // Neither SSH server nor Core's memory-only private key is required during cold application.
  const preflight = await rpc(cookie, "admin.import.preflight", { planId: plan.planId, operation: "apply" });
  assert.equal(preflight.ok, true, "actual preflight accepts the sealed source with SSH already unavailable");
  const started = await rpc(cookie, "admin.import.apply", { planId: plan.planId, preflightId: preflight.preflightId });
  let offlineStatus = false,
    run;
  while (Date.now() < deadline) {
    const absent = !(await exists(join(home, "run", "api-delegation.token")));
    let result;
    try {
      result = await rpc(cookie, "admin.import.status", { runId: started.runId });
    } catch (error) {
      if (error.transientCore !== true) throw error;
      await delay(500);
      continue;
    }
    run = result.run;
    if (absent && !(await exists(join(home, "run", "api-delegation.token")))) offlineStatus = true;
    if (["completed", "failed", "aborted"].includes(run.state)) break;
    await delay(500);
  }
  assert.equal(run?.state, "completed", "real SSH snapshot reaches completed native maintenance");
  assert.equal(offlineStatus, true, "fresh HTTP status succeeds while the Core credential file is absent");
  const after = await rpc(cookie, "core.status");
  assert.ok(Number.isInteger(before.pid) && Number.isInteger(after.pid) && before.pid !== after.pid);
  const shown = await rpc(cookie, "ext.show", { name: selected.skill });
  assert.equal(shown.item.enabled, false);
  assert.equal(await exists(join(home, "skills", unselected.skill)), false);
  const recalled = await link.call("memory.recall", {
    caller: { channel: "cli", accountId: "ssh-fixture", userId: "owner" },
    agentId: selected.agentId,
    query: selected.knowledge,
    joined: true,
    budget: { softMs: 15_000, hardMs: 20_000, capChars: 12_000 },
  });
  assert.equal(recalled.degraded, null);
  if (!recalled.blocks.some((block) => block.text.includes(selected.knowledge))) {
    const report = JSON.parse(await readFile(join(home, "imports", started.runId, "report.json"), "utf8"));
    const mirror = join(home, "agents", selected.agentId, "workspace", "memory", "KNOWLEDGE.md");
    const knowledge = (await exists(mirror)) ? await readFile(mirror) : undefined;
    process.stderr.write(
      JSON.stringify({
        diagnostic: "ssh-import-card-recall",
        agentId: selected.agentId,
        counts: report.counts,
        agents: (report.profilesOrAgents ?? report.agents ?? []).map((agent) => ({
          harnessAgentId: agent.harnessAgentId,
          memory: agent.memory
            ? Object.fromEntries(
                [
                  "importedCount",
                  "skippedDuplicateCount",
                  "rejectedCount",
                  "totalCards",
                  "linkedCount",
                  "pendingReembedCount",
                  "deferredCount",
                ].map((key) => [key, agent.memory[key]]),
              )
            : undefined,
          outcomes: (agent.memory?.cardResults ?? []).map((card) => ({ outcome: card.outcome, reason: card.reason })),
        })),
        errors: (report.errors ?? []).map((error) => ({ reason: error.reason })),
        mirror: {
          exists: !!knowledge,
          marker: knowledge?.toString("utf8").includes(selected.knowledge) ?? false,
          sha256: knowledge ? createHash("sha256").update(knowledge).digest("hex") : undefined,
        },
        recalled: {
          blocks: recalled.blocks.length,
          hashes: recalled.blocks.map((block) => createHash("sha256").update(block.text).digest("hex")),
        },
      }) + "\n",
    );
  }
  assert.ok(recalled.blocks.some((block) => block.text.includes(selected.knowledge)));
  const mcp = await rpc(cookie, "ext.show", { name: detected.mcpServers[0].name });
  assert.equal(mcp.item.kind, "mcp-server");
  assert.equal(mcp.item.enabled, false);
  await rpc(cookie, "logs.query", { stream: "diagnostic", limit: 200 });
  await rpc(cookie, "logs.query", { stream: "audit", limit: 200 });
  for (const response of responses) noPrivateMaterial(response);
  const inspectionMetadata = JSON.stringify({ discovered, detected, plan, preflight });
  assert.ok(
    !inspectionMetadata.includes(home) && !inspectionMetadata.includes(remoteRoot),
    "inspection metadata never exposes private local source staging paths",
  );
  await scanFiles(join(home, "logs"), noPrivateMaterial);
  noPrivateMaterial(server.diagnostic());
  process.stdout.write(
    JSON.stringify({
      ssh: true,
      bothFamiliesDiscovered: true,
      sourceSelected: true,
      snapshotSealed: true,
      pluginsClassified: true,
      mcpDisabled: true,
      importedCards: true,
      disabledSkill: true,
      coreRestarted: true,
      offlineStatus: true,
      noLeaks: true,
    }) + "\n",
  );
} finally {
  await server?.close();
  await api.close();
  await link.close();
}
