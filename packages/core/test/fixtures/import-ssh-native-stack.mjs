/** E2/E3 integration fixture: production Core service + default Node client + real Rust worker/SSH server. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createSshImportService } from "../../src/import/ssh-service.ts";
import { createSecretStore } from "../../src/secrets/store.ts";
import { createMemoryBackend } from "../../src/secrets/memory-backend.ts";
import { createMemoryAuditSink } from "../../src/secrets/audit.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";

const [workerPath, fixturePath, root] = process.argv.slice(2);
assert.ok(workerPath && fixturePath && root, "explicit native test prerequisites are required");
const previous = { bin: process.env.PLUR1BUS_NATIVE_BIN, hash: process.env.PLUR1BUS_NATIVE_SHA256 };
process.env.PLUR1BUS_NATIVE_BIN = workerPath;
process.env.PLUR1BUS_NATIVE_SHA256 = createHash("sha256").update(await readFile(workerPath)).digest("hex");
const audit = createMemoryAuditSink();
const store = createSecretStore({ keyring: createMemoryBackend(), file: createMemoryBackend(), audit, fileFallback: () => false });
const owner = { userId: "owner", kind: "person", role: "owner" };
let admin = { userId: "admin", kind: "person", role: "admin" };
let config = {};
let egress = { allowHosts: [], allowPorts: [], allowLoopback: false };
const service = createSshImportService({ store, config: () => config,
  audit: memoryAuditSink(),
  egress: () => egress,
  setConnections: async value => { config = structuredClone(value); },
  person: id => id === owner.userId ? owner : id === admin.userId ? admin : null });
let server;
try {
  const key = await service.generateKey(owner);
  server = spawn(fixturePath, [], { stdio: ["pipe", "pipe", "ignore"] });
  const lines = createInterface({ input: server.stdout });
  server.stdin.write(`${JSON.stringify({ root, authorizedPublicKey: key.publicKey })}\n`);
  let deadline;
  const ready = await Promise.race([
    once(lines, "line").then(([line]) => JSON.parse(line)),
    new Promise((_, reject) => { deadline = setTimeout(() => reject(Error("native SSH fixture did not start")), 10_000); }),
  ]).finally(() => clearTimeout(deadline));
  egress = { allowHosts: [ready.ip], allowPorts: [ready.port], allowLoopback: false };
  await service.setConnection(owner, { id: "source", host: ready.ip, port: ready.port, user: "fixture", roots: ["/"] });
  await assert.rejects(service.probeHostKey(owner, "source"), { reason: "ssh-egress-denied" });
  await service.setConnection(owner, { id: "source", host: ready.ip, port: ready.port, user: "fixture", roots: ["/"], allowPrivate: true });
  const probe = await service.probeHostKey(owner, "source");
  assert.equal(probe.hostKeySha256, ready.hostKeySha256);
  assert.equal(audit.events.some(event => event.detail?.purpose === "ssh-import"), false, "host-key probing cannot lease private identity");
  await service.trustHostKey(owner, "source", probe.probeId, probe.hostKeySha256);
  const session = await service.open("source", "/", admin);
  assert.equal((await session.fs.readFile("config.json", 1024)).toString(), '{"model":"fixture"}\n');
  assert.equal((await session.fs.stat("config.json")).type, "file");
  assert.equal(store.activeLeases({ kind: "core" }).length, 0, "the native key ACK releases the private lease");
  admin = { ...admin, role: "viewer" };
  await assert.rejects(session.fs.readFile("config.json", 1024), { error: "E_DENIED" });
  admin = { ...admin, role: "admin" };
  const leaseCount = () => audit.events.filter(event => event.detail?.purpose === "ssh-import").length;
  const before = leaseCount();
  config.source.hostKey.sha256 = `SHA256:${"A".repeat(43)}`;
  service.configChanged();
  await assert.rejects(service.open("source", "/", owner), { reason: "ssh-host-key-mismatch" });
  assert.equal(leaseCount(), before, "a changed server key fails before private-key acquisition/authentication");
  config.source.hostKey.sha256 = ready.hostKeySha256;
  const reopened = await service.open("source", "/", owner);
  await service.rotateKey(owner);
  await assert.rejects(reopened.fs.readFile("config.json", 1024), { error: "E_DENIED" });
  await assert.rejects(service.open("source", "/", owner), { reason: "ssh-authentication-failed" });
  assert.equal(store.activeLeases({ kind: "core" }).length, 0);
  const publicViews = JSON.stringify({ key, probe, connections: await service.listConnections(owner), audit: audit.events });
  assert.ok(!publicViews.includes("BEGIN PRIVATE KEY") && !publicViews.includes('"value"'));
  process.stdout.write(JSON.stringify({ publicKey: true, probe: true, trust: true, read: true, roleRevocation: true,
    mismatchBeforeKey: true, rotation: true }));
} finally {
  await service.close();
  if (server) {
    const exited = once(server, "close"); server.stdin.end();
    const kill = setTimeout(() => server.kill("SIGKILL"), 2000);
    await exited; clearTimeout(kill);
  }
  if (previous.bin === undefined) delete process.env.PLUR1BUS_NATIVE_BIN; else process.env.PLUR1BUS_NATIVE_BIN = previous.bin;
  if (previous.hash === undefined) delete process.env.PLUR1BUS_NATIVE_SHA256; else process.env.PLUR1BUS_NATIVE_SHA256 = previous.hash;
}
