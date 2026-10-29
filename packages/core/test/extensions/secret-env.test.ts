/** Declared extension slots use the existing Secret Store without widening human or agent authority (M-A7). */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecretStore } from "../../src/secrets/store.ts";
import { createMemoryBackend } from "../../src/secrets/memory-backend.ts";
import { createMemoryAuditSink } from "../../src/secrets/audit.ts";

const MARKER = "A7-fixture-secret-never-output";
const owner = { kind: "owner" as const, id: "person", surface: 3 as const };
const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
const metadata = { name: "example", slots: [{ slot: "TOKEN", required: true }, { slot: "OPTIONAL", required: false }],
  env: { OPAQUE: "Bearer ${user_config.api-key}", ORDINARY: "safe-${__dirname}" },
  userConfigSlots: { "api-key": "TOKEN" }, variables: { __dirname: "/verified/payload" } };

async function factory() {
  const module = await import("../../src/extensions/secret-env.ts").catch(() => undefined);
  assert.equal(typeof module?.createExtensionSecrets, "function", "extension secret service must be implemented");
  return module!;
}

async function rig() {
  const api = await factory();
  const home = await mkdtemp(join(tmpdir(), "p1b-A7-secrets-"));
  homes.push(home);
  const backend = createMemoryBackend();
  const store = createSecretStore({ keyring: backend, file: createMemoryBackend({ available: false }),
    fileFallback: () => false, audit: createMemoryAuditSink(), clock: () => 1_000 });
  const service = api.createExtensionSecrets({ home, store,
    definition: async name => name === "example" ? metadata : undefined });
  return { api, backend, store, service, home };
}

async function promptly<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("secret acquisition ignored cancellation")), 2000);
    })]);
  } finally { clearTimeout(timer); }
}

describe("extension secret setup", () => {
  it("canonical names validate both components and permit the full bounded extension-slot namespace", async () => {
    const api = await factory();
    const name = "a".repeat(64);
    const slot = "K".repeat(64);
    assert.equal(api.extensionSecretName(name, slot), `ext:${name}:${slot}`);
    for (const bad of [undefined, null, true, 1, "../outside", "a".repeat(65)]) {
      assert.throws(() => api.extensionSecretName(bad as never, "TOKEN"));
    }
  });

  it("gets metadata for Owner/Admin and permits only the Owner to set a declared canonical slot", async () => {
    const { store, service } = await rig();
    assert.deepEqual(await service.getSetup("example", { kind: "admin" }), {
      name: "example", available: true, slots: [
        { slot: "TOKEN", secret: "ext:example:TOKEN", required: true, present: false },
        { slot: "OPTIONAL", secret: "ext:example:OPTIONAL", required: false, present: false },
      ],
    });
    for (const principal of [{ kind: "admin" }, { kind: "agent" }, { kind: "core" }]) {
      await assert.rejects(service.setSecret("example", "TOKEN", MARKER, principal as never),
        error => (error as { error?: string }).error === "E_DENIED");
    }
    await assert.rejects(service.setSecret("example", "NOT_DECLARED", MARKER, owner),
      error => (error as { error?: string }).error === "E_INVALID_PARAMS");
    assert.deepEqual(await service.setSecret("example", "TOKEN", MARKER, owner),
      { name: "example", slot: "TOKEN", stored: true });
    assert.equal((await store.reveal(owner, "ext:example:TOKEN")).value, MARKER);
    const result = await service.getSetup("example", owner);
    assert.equal(result.slots[0]?.present, true);
    assert.ok(!JSON.stringify(result).includes(MARKER));
  });

  it("reports unavailable metadata as unknown presence and never substitutes a missing required slot", async () => {
    const { backend, service } = await rig();
    backend.available = false;
    const result = await service.getSetup("example", owner);
    assert.equal(result.available, false);
    assert.equal(result.slots[0]?.present, null);
    await assert.rejects(service.launchEnvironment({ name: "example", transport: { type: "stdio", args: [] } } as never),
      error => !String(error).includes(MARKER));
  });

  it("an optional slot does not require an available backend to start without credentials", async () => {
    const { api, backend, store, home } = await rig();
    backend.available = false;
    const service = api.createExtensionSecrets({ home, store, definition: async () => ({
      name: "example", slots: [{ slot: "OPTIONAL", required: false }],
    }) });
    const launch = await service.launchEnvironment({ name: "example",
      transport: { type: "stdio", args: [] } } as never);
    assert.ok(launch);
    try {
      assert.equal(launch.env.OPTIONAL, undefined);
      assert.equal(launch.env.P1X_DATA, join(home, "data", "ext", "example"));
    } finally { launch.release(); }
  });

  it("the RPC adapter derives authority from its injected connection principal", async () => {
    const { api, service } = await rig();
    const methods = api.buildExtensionSetupMethods({ service, principalOf: () => ({ kind: "agent" }) });
    await assert.rejects(methods["admin.extensions.setup.set"]({ name: "example", slot: "TOKEN", value: MARKER,
      principal: owner }, { requestId: "setup", connectionId: "agent", signal: new AbortController().signal }),
    error => (error as { error?: string }).error === "E_DENIED");
  });
});

describe("extension launch leases", () => {
  it("cancellation releases earlier slots while a later backend is pending and revokes its late lease", async () => {
    const { api, store, home } = await rig();
    await store.set(owner, "ext:example:FIRST", MARKER);
    await store.set(owner, "ext:example:SECOND", "second-fixture-value");
    let entered!: () => void;
    let resume!: () => void;
    const acquiring = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { resume = resolve; });
    const controller = new AbortController();
    const service = api.createExtensionSecrets({ home, definition: async () => ({ name: "example", slots: [
      { slot: "FIRST", required: true }, { slot: "SECOND", required: true },
    ] }), store: { ...store, lease: async (...args) => {
      if (args[1].endsWith(":SECOND")) { entered(); await pending; }
      return store.lease(...args);
    } } });
    const result = service.leaseSlots("example", controller.signal).then(() => undefined, error => error);
    try {
      await acquiring;
      assert.equal((await store.status(owner)).activeLeases, 1);
      controller.abort();
      const error = await promptly(result);
      assert.ok(error instanceof Error);
      assert.ok(!String(error).includes(MARKER));
      assert.equal((await store.status(owner)).activeLeases, 0);
      resume();
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal((await store.status(owner)).activeLeases, 0);
    } finally {
      resume();
      await result;
    }
  });

  it("the private native broker can lease declared slots without creating a child environment", async () => {
    const { service, store } = await rig();
    await service.setSecret("example", "TOKEN", MARKER, owner);
    assert.equal(typeof service.leaseSlots, "function");
    const lease = await service.leaseSlots("example");
    assert.deepEqual(Object.keys(lease.env), ["TOKEN"]);
    assert.equal(lease.env.TOKEN, MARKER);
    assert.ok(!JSON.stringify(lease).includes(MARKER));
    lease.release();
    assert.equal((await store.status(owner)).activeLeases, 0);
  });

  it("maps sensitive MCPB aliases into environment only and clears a non-printing lease wrapper", async () => {
    const { service, store, home } = await rig();
    await service.setSecret("example", "TOKEN", MARKER, owner);
    const lease = await service.launchEnvironment({ name: "example", transport: { type: "stdio", args: [] } } as never);
    assert.ok(lease);
    assert.equal(lease.env.OPAQUE, `Bearer ${MARKER}`);
    assert.equal(lease.env.ORDINARY, "safe-/verified/payload");
    assert.equal(lease.env.P1X_DATA, join(home, "data", "ext", "example"));
    assert.equal(lease.env.OPTIONAL, undefined);
    assert.equal((await store.status(owner)).activeLeases, 1);
    assert.ok(!JSON.stringify(lease).includes(MARKER));
    assert.ok(!inspect(lease).includes(MARKER));
    lease.release();
    lease.release();
    assert.deepEqual(Object.keys(lease.env), []);
    assert.equal((await store.status(owner)).activeLeases, 0);
  });

  it("rejects secret substitution into argv before acquiring any lease", async () => {
    const { service, store } = await rig();
    await service.setSecret("example", "TOKEN", MARKER, owner);
    await assert.rejects(service.launchEnvironment({ name: "example", transport: {
      type: "stdio", command: "node", args: ["--token=${user_config.api-key}"] } } as never));
    assert.equal((await store.status(owner)).activeLeases, 0);
  });

  it("MCPB slot names never become implicit interpreter environment variables", async () => {
    const { api, store, home } = await rig();
    await store.set(owner, "ext:example:LD_PRELOAD", MARKER);
    const service = api.createExtensionSecrets({ home, store, definition: async () => ({
      name: "example", slots: [{ slot: "LD_PRELOAD", required: true }],
      userConfigSlots: { key: "LD_PRELOAD" }, env: { OPAQUE: "${user_config.key}" },
    }) });
    const lease = await service.launchEnvironment({ name: "example",
      transport: { type: "stdio", args: [] } } as never);
    assert.ok(lease);
    try {
      assert.equal(lease.env.OPAQUE, MARKER);
      assert.equal(lease.env.LD_PRELOAD, undefined);
    } finally { lease.release(); }
  });

  it("revokes already acquired slots when a later required slot is missing or the operation aborts", async () => {
    const { api, store, home } = await rig();
    await store.set(owner, "ext:example:FIRST", MARKER);
    const service = api.createExtensionSecrets({ home, store, definition: async () => ({
      name: "example", slots: [{ slot: "FIRST", required: true }, { slot: "MISSING", required: true }],
    }) });
    await assert.rejects(service.launchEnvironment({ name: "example", transport: { type: "stdio", args: [] } } as never));
    assert.equal((await store.status(owner)).activeLeases, 0);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(service.launchEnvironment({ name: "example", transport: { type: "stdio", args: [] } } as never,
      controller.signal));
    assert.equal((await store.status(owner)).activeLeases, 0);
  });

  it("refuses a replaced extension data directory before leasing or spawning a server", async () => {
    const { api, store } = await rig();
    const home = await mkdtemp(join(tmpdir(), "p1b-A7-data-"));
    const outside = await mkdtemp(join(tmpdir(), "p1b-A7-outside-"));
    try {
      await store.set(owner, "ext:example:TOKEN", MARKER);
      await mkdir(join(home, "data", "ext"), { recursive: true });
      await writeFile(join(outside, "kept"), "private data");
      await symlink(outside, join(home, "data", "ext", "example"), "junction");
      const service = api.createExtensionSecrets({ home, store, definition: async () => metadata });
      await assert.rejects(service.launchEnvironment({ name: "example",
        transport: { type: "stdio", args: [] } } as never));
      assert.equal((await store.status(owner)).activeLeases, 0);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
