/** E2/E3: real Secret Store key material, authenticated ownership and host-bound trust before private leases. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { createSecretStore } from "../../src/secrets/store.ts";
import { createMemoryBackend } from "../../src/secrets/memory-backend.ts";
import { createMemoryAuditSink } from "../../src/secrets/audit.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import type { AuditEvent } from "../../src/rbac/audit.ts";
import type { Principal } from "../../src/rbac/types.ts";
import type { SshConnectionConfig } from "../../src/import/ssh-service.ts";
import { resolveSshEndpoint } from "../../src/import/ssh-egress.ts";
import { resolveGuarded, makeAddressPolicy } from "../../src/tools/web/guard.ts";
import { nativeSshWorker } from "../../src/import/ssh-service.ts";
import type { EgressConfig } from "../../src/egress/policy.ts";
import { RemoteFsError } from "@plur1bus/remote-fs";
import { SourceReader } from "../../src/import/source-reader.ts";

const owner: Principal = { userId: "owner", kind: "person", role: "owner" };
const admin: Principal = { userId: "admin", kind: "person", role: "admin" };
const fingerprint = `SHA256:${"A".repeat(43)}`;

it("accepts only the launcher's complete pinned native descriptor and never discovers a helper through PATH", () => {
  assert.equal(nativeSshWorker({ PATH: "/untrusted" }), undefined);
  assert.equal(nativeSshWorker({ PLUR1BUS_NATIVE_BIN: "/trusted/native" }), undefined);
  assert.equal(nativeSshWorker({ PLUR1BUS_NATIVE_BIN: "native", PLUR1BUS_NATIVE_SHA256: "a".repeat(64) }), undefined);
  assert.deepEqual(nativeSshWorker({ PLUR1BUS_NATIVE_BIN: "/trusted/native", PLUR1BUS_NATIVE_SHA256: "a".repeat(64) }),
    { path: "/trusted/native", sha256: "a".repeat(64), mode: "harness" });
});

async function rig(readError?: RemoteFsError) {
  const module = await import("../../src/import/ssh-service.ts").catch(() => null);
  assert.equal(typeof module?.createSshImportService, "function", "the actual Core SSH service must be composed");
  let now = 1000, configs: Record<string, SshConnectionConfig> = {};
  const audit = createMemoryAuditSink();
  const store = createSecretStore({ keyring: createMemoryBackend(), file: createMemoryBackend(), fileFallback: () => false, audit });
  const lifecycleAudit = memoryAuditSink();
  let failAudit: ((event: AuditEvent) => boolean) | undefined;
  const calls: unknown[] = [], privateKeys: Buffer[] = [];
  let closed = 0;
  let egress: EgressConfig = { allowHosts: ["source.example", "changed.example", "changed-again.example"],
    allowPorts: [22], allowLoopback: false };
  let dns = 0;
  const service = module!.createSshImportService({ store,
    audit: { append(event: AuditEvent) {
      if (failAudit?.(event)) throw Error("synthetic-private-audit-failure");
      lifecycleAudit.append(event);
    } },
    config: () => configs,
    egress: () => egress,
    setConnections: async next => { configs = structuredClone(next); }, clock: () => now,
    worker: () => ({ path: "/trusted/fixture", sha256: "a".repeat(64), mode: "harness" }),
    resolver: async () => { dns++; return [{ address: "93.184.216.34", family: 4 }]; },
    probe: async options => { calls.push(options); return { hostKeySha256: fingerprint, hostKeyAlgorithm: "ssh-ed25519" }; },
    connect: async options => {
      calls.push({ endpoint: options.endpoint, root: options.root });
      const lease = await options.leaseKey(new AbortController().signal);
      privateKeys.push(Buffer.from(lease.key));
      await lease.release();
      assert.ok(lease.key.every(byte => byte === 0));
      return { fs: { async stat() { if (readError) throw readError; return { type: "file" as const, size: 1 }; } } as never,
        async close() { closed++; } };
    },
  });
  return { service, store, audit, lifecycleAudit,
    auditFailure: (fail?: (event: AuditEvent) => boolean) => { failAudit = fail; },
    calls, privateKeys, get closed() { return closed; },
    get dns() { return dns; }, egress: (next: EgressConfig) => { egress = next; service.configChanged(); },
    advance: () => { now += 300_001; }, configs: () => configs };
}

it("checks central host and TCP port policy before DNS and revokes reads when that policy is removed", async () => {
  const r = await rig();
  try {
    await r.service.setConnection(owner, { id: "source", host: "source.example", user: "reader", roots: ["/source"], allowPrivate: true });
    r.egress({ allowHosts: ["source.example"], allowPorts: [443], allowLoopback: false });
    await assert.rejects(r.service.probeHostKey(owner, "source"), { error: "E_DENIED", reason: "ssh-egress-denied" });
    assert.equal(r.dns, 0);
    r.egress({ allowHosts: [], allowPorts: [22], allowLoopback: false });
    await assert.rejects(r.service.probeHostKey(owner, "source"), { error: "E_DENIED", reason: "ssh-egress-denied" });
    assert.equal(r.dns, 0);
    r.egress({ allowHosts: ["source.example"], allowPorts: [22], allowLoopback: false });
    const probe = await r.service.probeHostKey(owner, "source");
    await r.service.trustHostKey(owner, probe.connectionId, probe.probeId, probe.hostKeySha256);
    await r.service.generateKey(owner);
    const session = await r.service.open("source", "/source", admin);
    assert.equal((await session.fs.stat("/source/file")).type, "file");
    const before = r.dns;
    r.egress({ allowHosts: [], allowPorts: [22], allowLoopback: false });
    await assert.rejects(session.fs.stat("/source/file"));
    await assert.rejects(r.service.open("source", "/source", admin), { error: "E_DENIED", reason: "ssh-egress-denied" });
    assert.equal(r.dns, before);
    assert.equal(r.closed, 1);
  } finally { await r.service.close(); }
});

it("stores only a private Ed25519 key, returns a valid SSH public key, and denies non-Owner key access", async () => {
  const r = await rig();
  try {
    assert.deepEqual(await r.service.keyStatus(owner), { configured: false });
    const status = await r.service.generateKey(owner);
    assert.equal(status.configured, true);
    assert.match(status.publicKey!, /^ssh-ed25519 [A-Za-z0-9+/]+=*$/);
    const wire = Buffer.from(status.publicKey!.split(" ")[1]!, "base64");
    assert.equal(wire.readUInt32BE(0), 11);
    assert.equal(wire.subarray(4, 15).toString(), "ssh-ed25519");
    assert.equal(wire.readUInt32BE(15), 32);
    assert.equal(status.fingerprint, `SHA256:${createHash("sha256").update(wire).digest("base64").replace(/=+$/, "")}`);
    assert.match(status.instructions!, /authorized_keys/);
    const saved = await r.store.reveal({ kind: "owner" }, "import.ssh.key");
    const key = createPrivateKey(saved.value);
    assert.equal(key.asymmetricKeyType, "ed25519");
    assert.equal(createPublicKey(key).export({ format: "jwk" }).x, wire.subarray(19).toString("base64url"));
    assert.equal(verify(null, Buffer.from("test"), createPublicKey(key), sign(null, Buffer.from("test"), key)), true);
    for (const principal of [admin, { ...owner, kind: "agent" as const }, { ...owner, tokenScopes: ["imports.read"] }]) {
      await assert.rejects(r.service.generateKey(principal), { error: "E_DENIED" });
    }
    await assert.rejects(r.service.keyStatus(admin), { error: "E_DENIED" });
    await assert.rejects(r.service.generateKey(owner), { error: "E_CONFLICT", reason: "ssh-key-exists" });
    const rotated = await r.service.rotateKey(owner);
    assert.notEqual(rotated.publicKey, status.publicKey);
    assert.equal(r.store.activeLeases({ kind: "core" }).length, 0);
    assert.ok(!JSON.stringify({ status, rotated, audit: r.audit.events }).includes(saved.value));
    assert.deepEqual(await r.service.deleteKey(owner), { deleted: true });
    assert.deepEqual(await r.service.deleteKey(owner), { deleted: false });
    await assert.rejects(r.service.rotateKey(owner), { reason: "ssh-key-required" });
    const scoped = await r.service.generateKey({ ...owner, tokenScopes: ["imports.manage"] });
    assert.equal(scoped.configured, true, "a manage-only scope can complete its write without borrowing read authority");
  } finally { await r.service.close(); }
});

it("returns complete OS-specific read-only authorized_keys lines without changing the public key", async () => {
  const r = await rig();
  try {
    const status = await r.service.generateKey(owner);
    const instructions = status.instructions!;
    const paths = [
      "/usr/lib/openssh/sftp-server", "/usr/libexec/openssh/sftp-server", "/usr/lib/ssh/sftp-server",
      "/usr/libexec/sftp-server", "C:/Windows/System32/OpenSSH/sftp-server.exe",
    ];
    for (const path of paths) {
      assert.ok(instructions.split("\n").includes(`restrict,command="${path} -R" ${status.publicKey} plur1bus-import`));
    }
    for (const os of ["Debian/Ubuntu", "Fedora/RHEL", "Arch", "macOS", "Windows OpenSSH"]) {
      assert.ok(instructions.includes(os), os);
    }
    assert.match(instructions, /Remote Login/);
    assert.match(instructions, /administrators_authorized_keys/);
    assert.match(instructions, /Administrators and SYSTEM/);
    assert.match(instructions, /verify.*path/i);
    assert.ok(instructions.length <= 8192);
    assert.match(status.publicKey!, /^ssh-ed25519 [A-Za-z0-9+/]+=*$/);
    assert.equal((await r.service.keyStatus(owner)).instructions, instructions);
  } finally { await r.service.close(); }
});

it("binds host trust to the probing Owner and current connection, and revokes active reads when keys or config change", async () => {
  const r = await rig();
  try {
    await r.service.setConnection(owner, { id: "source", host: "source.example", user: "reader", roots: ["/source"] });
    await assert.rejects(r.service.setConnection(admin, { id: "other", host: "source.example", user: "reader", roots: ["/source"] }), { error: "E_DENIED" });
    assert.equal((await r.service.listConnections(admin)).connections.length, 1);
    await assert.rejects(r.service.open("source", "/source", admin), { reason: "ssh-host-key-required" });
    const probe = await r.service.probeHostKey(owner, "source");
    assert.equal(r.store.activeLeases({ kind: "core" }).length, 0, "a probe never reads the private key");
    await assert.rejects(r.service.trustHostKey({ ...owner, userId: "other-owner" }, probe.connectionId, probe.probeId, probe.hostKeySha256), { error: "E_NOT_FOUND" });
    await r.service.trustHostKey(owner, probe.connectionId, probe.probeId, probe.hostKeySha256);
    await r.service.generateKey(owner);
    await assert.rejects(r.service.open("source", "/other", admin), { error: "E_DENIED" });
    const session = await r.service.open("source", "/source", admin);
    assert.equal((await session.fs.stat("file")).size, 1);
    assert.equal(r.privateKeys.length, 1);
    assert.equal(createPrivateKey(r.privateKeys[0]!).asymmetricKeyType, "ed25519");
    assert.deepEqual((r.calls.at(-1) as { endpoint: unknown }).endpoint,
      { ip: "93.184.216.34", port: 22, username: "reader", hostKeySha256: fingerprint });
    await r.service.rotateKey(owner);
    assert.equal(r.closed, 1);
    await assert.rejects(session.fs.stat("file"), { error: "E_DENIED" });
    const another = await r.service.open("source", "/source", owner);
    await r.service.setConnection(owner, { id: "source", host: "changed.example", user: "reader", roots: ["/source"] });
    assert.equal(r.closed, 2);
    await assert.rejects(another.fs.stat("file"), { error: "E_DENIED" });
    assert.equal(r.configs().source!.hostKey, undefined);
    const old = await r.service.probeHostKey(owner, "source"); r.advance();
    await assert.rejects(r.service.trustHostKey(owner, "source", old.probeId, old.hostKeySha256), { error: "E_NOT_FOUND" });
    const stale = await r.service.probeHostKey(owner, "source");
    await r.service.setConnection(owner, { id: "source", host: "changed-again.example", user: "reader", roots: ["/source"] });
    await assert.rejects(r.service.trustHostKey(owner, "source", stale.probeId, stale.hostKeySha256), { error: "E_NOT_FOUND" });
    for (const key of r.privateKeys) key.fill(0);
  } finally { await r.service.close(); }
});

it("keeps private SSH allowances scoped to an Owner-configured connection and refuses unsafe or mixed DNS answers", async () => {
  const r = await rig();
  try {
    for (const host of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "0.0.0.0", "224.0.0.1"]) {
      await r.service.setConnection(owner, { id: "source", host, user: "reader", roots: ["/source"] });
      await assert.rejects(r.service.probeHostKey(owner, "source"), { error: "E_DENIED", reason: "ssh-egress-denied" });
    }
    await r.service.setConnection(owner, { id: "source", host: "127.0.0.1", user: "reader", roots: ["/source"], allowPrivate: true });
    r.egress({ allowHosts: ["127.0.0.1", "169.254.169.254"], allowPorts: [22], allowLoopback: false });
    await r.service.probeHostKey(owner, "source");
    assert.equal((r.calls.at(-1) as { endpoint: { ip: string } }).endpoint.ip, "127.0.0.1");
    await r.service.setConnection(owner, { id: "source", host: "169.254.169.254", user: "reader", roots: ["/source"], allowPrivate: true });
    await assert.rejects(r.service.probeHostKey(owner, "source"), { reason: "ssh-egress-denied" });
    await assert.rejects(resolveSshEndpoint("mixed.example", 22, false, async () => [
      { address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 },
    ]), { reason: "ssh-egress-denied" });
    await assert.rejects(resolveSshEndpoint("mixed.example", 22, true, async () => [
      { address: "10.1.2.3", family: 4 }, { address: "169.254.169.254", family: 4 },
    ]), { reason: "ssh-egress-denied" });
    await assert.rejects(resolveGuarded("127.0.0.1", async () => [], makeAddressPolicy([])),
      { code: "private-address" }, "SSH private allowance must not alter the existing web guard");
    for (const roots of [["relative"], ["/source/../escape"], ["/source\\other"]]) {
      await assert.rejects(r.service.setConnection(owner, { id: "source", host: "public.example", user: "reader", roots }), { error: "E_INVALID_PARAMS" });
    }
  } finally { await r.service.close(); }
});


it("records actor-bound SSH lifecycle metadata and denies unaudited network or key writes", async () => {
  const r = await rig();
  try {
    await r.service.setConnection(owner, { id: "source", host: "source.example", user: "reader", roots: ["/source"] });
    r.auditFailure(() => true);
    await assert.rejects(r.service.probeHostKey(owner, "source"), { error: "E_STORAGE", reason: "ssh-audit-unavailable" });
    await assert.rejects(r.service.generateKey(owner), { error: "E_STORAGE", reason: "ssh-audit-unavailable" });
    assert.equal(r.dns, 0);
    assert.equal(r.calls.length, 0);
    r.auditFailure();
    assert.equal((await r.service.keyStatus(owner)).configured, false);
    const publicKey = await r.service.generateKey(owner);
    const probe = await r.service.probeHostKey(owner, "source");
    await r.service.trustHostKey(owner, "source", probe.probeId, probe.hostKeySha256);
    const session = await r.service.open("source", "/source", admin);
    await session.close();
    await assert.rejects(r.service.keyStatus(admin), { error: "E_DENIED" });
    const events = r.lifecycleAudit.events;
    for (const action of ["connections.set", "key.generate", "hostKey.probe", "hostKey.trust", "open", "close"]) {
      assert.ok(events.some(event => event.action === `import.ssh.${action}` && event.detail.outcome === "intent"), action);
      assert.ok(events.some(event => event.action === `import.ssh.${action}` && event.detail.outcome === "completed"), action);
    }
    assert.ok(events.some(event => event.actor.user === "admin" && event.detail.outcome === "denied"));
    const encoded = JSON.stringify(events);
    for (const value of ["source.example", "/source", "PRIVATE KEY", publicKey.publicKey!]) {
      assert.ok(!encoded.includes(value));
    }
  } finally { await r.service.close(); }
});

it("a failed completion audit never exposes a newly opened SSH session and cleanup still closes during audit failure", async () => {
  const r = await rig();
  try {
    await r.service.setConnection(owner, { id: "source", host: "source.example", user: "reader", roots: ["/source"] });
    await r.service.generateKey(owner);
    const probe = await r.service.probeHostKey(owner, "source");
    await r.service.trustHostKey(owner, "source", probe.probeId, probe.hostKeySha256);
    r.auditFailure(event => event.action === "import.ssh.open" && event.detail.outcome === "completed");
    await assert.rejects(r.service.open("source", "/source", admin), { error: "E_STORAGE", reason: "ssh-audit-unavailable" });
    assert.equal(r.closed, 1);
    assert.equal(r.store.activeLeases({ kind: "core" }).length, 0);
    r.auditFailure();
    const session = await r.service.open("source", "/source", owner);
    r.auditFailure(() => true);
    await assert.rejects(session.close(), { error: "E_STORAGE", reason: "ssh-audit-unavailable" });
    assert.equal(r.closed, 2, "audit unavailability must never leave a revoked session alive");
    r.auditFailure();
  } finally { await r.service.close(); }
});


it("retains typed private filesystem absence and budget errors without bypassing revocation or audit failure", async () => {
  for (const reason of ["not-found", "permission-denied", "file-limit", "timeout"] as const) {
    const original = new RemoteFsError(reason);
    const r = await rig(original);
    try {
      await r.service.setConnection(owner, { id: "source", host: "source.example", user: "reader", roots: ["/source"] });
      await r.service.generateKey(owner);
      const probe = await r.service.probeHostKey(owner, "source");
      await r.service.trustHostKey(owner, "source", probe.probeId, probe.hostKeySha256);
      const session = await r.service.open("source", "/source", owner);
      await assert.rejects(session.fs.stat("/source/optional"), error => error === original);
      if (reason === "not-found") {
        const reader = new SourceReader({ fs: session.fs, root: "/source", remote: true });
        assert.equal(await reader.stat("/source/optional"), null, "optional known-home probes can continue");
      } else assert.throws(() => SourceReader.refuseFatal(original), error => error === original);
      r.auditFailure(() => true);
      await assert.rejects(session.fs.stat("/source/optional"), { error: "E_STORAGE", reason: "ssh-audit-unavailable" });
      assert.equal(r.closed, 1, "the private error type cannot override failed audit cleanup");
      r.auditFailure();
      r.egress({ allowHosts: [], allowPorts: [22], allowLoopback: false });
      await assert.rejects(session.fs.stat("/source/optional"), { error: "E_DENIED" });
      assert.equal(r.store.activeLeases({ kind: "core" }).length, 0);
    } finally { r.auditFailure(); await r.service.close(); }
  }
});
