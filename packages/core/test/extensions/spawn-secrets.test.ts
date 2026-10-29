/** Native child credentials use a private, authenticated binary channel, never ordinary RPC (M-A7). */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createConnection, type Socket } from "node:net";
import { mkdtemp, mkdir, rm, symlink, lstat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unitAddress } from "@plur1bus/module-api";
import { createMemoryBackend } from "../../src/secrets/memory-backend.ts";
import { createMemoryAuditSink } from "../../src/secrets/audit.ts";
import { createSecretStore } from "../../src/secrets/store.ts";

const TOKEN = "private-core-fixture-token";
const MARKER = "A7-native-fixture-secret-never-output";
const owner = { kind: "owner" as const, surface: 3 as const };
const vectors = JSON.parse(await readFile(new URL("../fixtures/extension-spawn-secrets.json", import.meta.url), "utf8")) as {
  ack: number; valid: { name: string; hex: string; status: number; env: Record<string, string> }[];
};
const resources: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of resources.splice(0).reverse()) await close(); });

async function factory() {
  const module = await import("../../src/extensions/spawn-secrets.ts").catch(() => undefined);
  assert.equal(typeof module?.startExtensionSpawnSecrets, "function", "private spawn broker must be implemented");
  return module!;
}

async function rig(slots = [{ slot: "apiKey", required: true }, { slot: "OPTIONAL", required: false }]) {
  const api = await factory();
  const home = await mkdtemp(join(tmpdir(), "p1b-spawn-"));
  resources.push(() => rm(home, { recursive: true, force: true }));
  const audit = createMemoryAuditSink();
  const store = createSecretStore({ keyring: createMemoryBackend(), file: createMemoryBackend({ available: false }),
    fileFallback: () => false, audit, clock: () => Date.now() });
  let lookups = 0;
  const options = { home, token: TOKEN, store, definition: async (name: string) => {
    lookups++;
    return name === "example" ? { name, slots } : undefined;
  } };
  const broker = await api.startExtensionSpawnSecrets(options);
  resources.push(() => broker.close());
  return { ...broker, api, options, home, store, audit, lookups: () => lookups };
}

async function connect(address: string, allowHalfOpen = false): Promise<Socket> {
  const socket = createConnection({ path: address, allowHalfOpen });
  socket.on("error", () => {});
  resources.push(async () => { socket.destroy(); });
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  return socket;
}

async function frame(socket: Socket, request: unknown = { v: 1, token: TOKEN, name: "example" }) {
  const chunks: Buffer[] = [];
  let length = 0;
  return new Promise<Buffer>((resolve, reject) => {
    const data = (chunk: Buffer) => {
      chunks.push(chunk); length += chunk.length;
      const bytes = Buffer.concat(chunks);
      if (length >= 4 && length >= bytes.readUInt32BE(0) + 4) {
        socket.off("data", data); socket.off("close", closed);
        resolve(bytes);
      }
    };
    const closed = () => reject(new Error("spawn broker closed before its bounded frame"));
    socket.on("data", data); socket.once("close", closed);
    socket.write(typeof request === "string" ? request : `${JSON.stringify(request)}\n`);
  });
}

function decode(bytes: Buffer): { status: number; env: Record<string, string> } {
  assert.equal(bytes.readUInt32BE(0), bytes.length - 4);
  const status = bytes[4]!;
  const count = bytes.readUInt16BE(5);
  const env: Record<string, string> = {};
  let offset = 7;
  for (let i = 0; i < count; i++) {
    const keyLength = bytes.readUInt16BE(offset); offset += 2;
    const key = bytes.toString("utf8", offset, offset + keyLength); offset += keyLength;
    const valueLength = bytes.readUInt32BE(offset); offset += 4;
    env[key] = bytes.toString("utf8", offset, offset + valueLength); offset += valueLength;
  }
  assert.equal(offset, bytes.length);
  return { status, env };
}

async function closed(socket: Socket) {
  if (socket.destroyed) return;
  await new Promise<void>(resolve => socket.once("close", resolve));
}

async function promptly<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("broker shutdown waited for an unavailable backend")), 2000);
    })]);
  } finally { clearTimeout(timer); }
}

describe("private native spawn-secret broker", () => {
  it("emits the shared native/TypeScript wire vector without protocol drift", async () => {
    const broker = await rig();
    const vector = vectors.valid.find(item => item.name === "one-case-preserving-slot")!;
    await broker.store.set(owner, "ext:example:apiKey", vector.env.P1X_SECRET_apiKey!);
    const socket = await connect(broker.address);
    assert.equal((await frame(socket)).toString("hex"), vector.hex);
    socket.write(Buffer.from([vectors.ack]));
    await closed(socket);
  });

  it("uses the canonical role address and transfers declared credentials only until synchronous-spawn ACK", async () => {
    const broker = await rig();
    await broker.store.set(owner, "ext:example:apiKey", MARKER);
    await broker.store.set(owner, "unrelated", "unrelated-secret");
    assert.equal(broker.address, unitAddress(broker.home, "e"));
    if (process.platform !== "win32") assert.equal((await lstat(broker.address)).mode & 0o777, 0o600);
    const socket = await connect(broker.address);
    const reply = decode(await frame(socket));
    assert.deepEqual(reply, { status: 0, env: { P1X_SECRET_apiKey: MARKER } });
    assert.equal((await broker.store.status(owner)).activeLeases, 1);
    assert.ok(!JSON.stringify(broker).includes(MARKER));
    assert.ok(!JSON.stringify(broker.audit).includes(MARKER));
    socket.write(Buffer.from([0x06]));
    await closed(socket);
    assert.equal((await broker.store.status(owner)).activeLeases, 0);
    await broker.close();
    if (process.platform !== "win32") await assert.rejects(lstat(broker.address), { code: "ENOENT" });
  });

  it("authenticates before looking up a declaration and returns fixed errors without secret material", async () => {
    const broker = await rig();
    await broker.store.set(owner, "ext:example:apiKey", MARKER);
    const socket = await connect(broker.address);
    const bytes = await frame(socket, { v: 1, token: `${TOKEN}-wrong`, name: "example" });
    assert.equal(bytes.toString("hex"), vectors.valid.find(item => item.name === "denied")!.hex);
    assert.deepEqual(decode(bytes), { status: 1, env: {} });
    assert.equal(broker.lookups(), 0);
    assert.equal((await broker.store.status(owner)).activeLeases, 0);
    assert.ok(!bytes.includes(Buffer.from(MARKER)));
  });

  it("refuses malformed, oversized, extra-field and pipelined requests before leasing", async () => {
    const broker = await rig();
    for (const request of ["{broken}\n", "x".repeat(4097), { v: 2, token: TOKEN, name: "example" },
      { v: 1, token: TOKEN, name: "example", reveal: true },
      `${JSON.stringify({ v: 1, token: TOKEN, name: "example" })}\n{}\n`]) {
      const socket = await connect(broker.address);
      assert.deepEqual(decode(await frame(socket, request)), { status: 3, env: {} });
      await closed(socket);
    }
    assert.equal(broker.lookups(), 0);
  });

  it("revokes partial leases when a later required slot is missing", async () => {
    const broker = await rig([{ slot: "apiKey", required: true }, { slot: "MISSING", required: true }]);
    await broker.store.set(owner, "ext:example:apiKey", MARKER);
    const socket = await connect(broker.address);
    assert.deepEqual(decode(await frame(socket)), { status: 2, env: {} });
    assert.equal((await broker.store.status(owner)).activeLeases, 0);
  });

  it("revokes a backend lease that completes after its native peer disconnected", async () => {
    const broker = await rig();
    await broker.store.set(owner, "ext:example:apiKey", MARKER);
    await broker.close();
    let entered!: () => void;
    let resume!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const resumed = new Promise<void>(resolve => { resume = resolve; });
    const lease = broker.store.lease.bind(broker.store);
    const delayed = await broker.api.startExtensionSpawnSecrets({ ...broker.options,
      store: { ...broker.store, lease: async (...args) => {
        entered(); await resumed; return lease(...args);
      } },
    });
    resources.push(() => delayed.close());
    const socket = await connect(delayed.address);
    socket.write(`${JSON.stringify({ v: 1, token: TOKEN, name: "example" })}\n`);
    await waiting;
    socket.destroy();
    await closed(socket);
    const stopped = delayed.close();
    try {
      await promptly(stopped);
      assert.equal((await broker.store.status(owner)).activeLeases, 0);
    } finally {
      resume();
      await stopped;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.equal((await broker.store.status(owner)).activeLeases, 0);
  });

  it("shutdown closes failed-request peers even when they keep their write side open", async () => {
    const broker = await rig();
    const socket = await connect(broker.address, true);
    assert.equal(decode(await frame(socket, { v: 1, token: "bad", name: "example" })).status, 1);
    await broker.close();
    socket.end();
    await closed(socket);
  });

  it("revokes transferred leases on disconnect, invalid ACK and Core shutdown", async () => {
    const broker = await rig();
    await broker.store.set(owner, "ext:example:apiKey", MARKER);
    for (const mode of ["disconnect", "invalid-ack", "shutdown"]) {
      const socket = await connect(broker.address);
      assert.equal(decode(await frame(socket)).status, 0);
      if (mode === "disconnect") socket.end();
      else if (mode === "invalid-ack") socket.write(Buffer.from([0x07]));
      else await broker.close();
      await closed(socket);
      assert.equal((await broker.store.status(owner)).activeLeases, 0);
    }
  });

  it("expires a transfer that never acknowledges spawn within the fixed ten-second deadline", async () => {
    const broker = await rig();
    await broker.store.set(owner, "ext:example:apiKey", MARKER);
    const socket = await connect(broker.address);
    assert.equal(decode(await frame(socket)).status, 0);
    await closed(socket);
    assert.equal((await broker.store.status(owner)).activeLeases, 0);
  });

  it("refuses an aggregate over one MiB without transmitting any credential bytes", async () => {
    const slots = Array.from({ length: 17 }, (_, i) => ({ slot: `S${i}`, required: true }));
    const broker = await rig(slots);
    for (const item of slots) await broker.store.set(owner, `ext:example:${item.slot}`, "V".repeat(64 * 1024));
    const socket = await connect(broker.address);
    assert.deepEqual(decode(await frame(socket)), { status: 4, env: {} });
    assert.equal((await broker.store.status(owner)).activeLeases, 0);
  });

  it("bounds unauthenticated connections without looking up any extension", async () => {
    const broker = await rig();
    for (let i = 0; i < 32; i++) await connect(broker.address);
    const extra = await connect(broker.address);
    await closed(extra);
    assert.equal(broker.lookups(), 0);
    await broker.close();
  });

  it("preserves distinct slot case and refuses environment-name collisions on Windows", async () => {
    const broker = await rig([{ slot: "apiKey", required: true }, { slot: "APIKEY", required: true }]);
    await broker.store.set(owner, "ext:example:apiKey", MARKER);
    await broker.store.set(owner, "ext:example:APIKEY", "another-fixture-value");
    const socket = await connect(broker.address);
    const reply = decode(await frame(socket));
    if (process.platform === "win32") {
      assert.deepEqual(reply, { status: 4, env: {} });
    } else {
      assert.deepEqual(reply, { status: 0, env: {
        P1X_SECRET_apiKey: MARKER, P1X_SECRET_APIKEY: "another-fixture-value",
      } });
      socket.write(Buffer.from([vectors.ack]));
      await closed(socket);
    }
    assert.equal((await broker.store.status(owner)).activeLeases, 0);
  });

  it("preserves a live endpoint and refuses symlinked run directories", async () => {
    const broker = await rig();
    await assert.rejects(broker.api.startExtensionSpawnSecrets(broker.options));
    const socket = await connect(broker.address);
    assert.equal(decode(await frame(socket, { v: 1, token: "bad", name: "example" })).status, 1);
    await broker.close();
    await rm(join(broker.home, "run"), { recursive: true });
    const outside = join(broker.home, "outside");
    await mkdir(outside);
    await symlink(outside, join(broker.home, "run"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(broker.api.startExtensionSpawnSecrets(broker.options));
  });
});
