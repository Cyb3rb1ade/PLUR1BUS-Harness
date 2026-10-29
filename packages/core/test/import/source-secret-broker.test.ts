/** Native maintenance fetches source values through a separate authenticated purpose, never ordinary RPC. */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createConnection, type Socket } from "node:net";
import { unitAddress } from "@plur1bus/module-api";
import { createImportSourceSecrets } from "../../src/import/source-secrets.ts";
import { useTempDirs } from "./helpers.ts";

const temp = useTempDirs();
const TOKEN = "source-import-core-token-fixture";
const MARKER = "fixture-private-import-source-token-never-public";
const binding = { ownerId: "owner", planId: "1158b21f-29ba-4992-bfa9-e89b71816c79", planSha256: "a".repeat(64),
  preflightId: "90408488-6fc1-49d9-b82a-76bb370440e5" };
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const module = await import("../../src/import/source-secret-broker.ts").catch(() => undefined);
  assert.equal(typeof module?.startImportSourceSecretBroker, "function", "native import needs a purpose-bound broker");
  const home = temp();
  const secrets = createImportSourceSecrets();
  secrets.prepare({ ...binding, expiresAt: Date.now() + 60_000,
    entries: new Map([["OPENAI_API_KEY", Buffer.from(MARKER)]]) });
  cleanup.push(() => secrets.close());
  let lookups = 0;
  const broker = await module!.startImportSourceSecretBroker({ home, token: TOKEN, secrets,
    binding: async (planId, preflightId) => {
      lookups++;
      return planId === binding.planId && preflightId === binding.preflightId ? binding : undefined;
    } });
  cleanup.push(() => broker.close());
  return { home, broker, secrets, lookups: () => lookups };
}

async function connect(address: string) {
  const socket = createConnection(address);
  socket.on("error", () => {});
  cleanup.push(() => { socket.destroy(); });
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  return socket;
}

async function response(socket: Socket, request: object) {
  return new Promise<Buffer>((resolve, reject) => {
    let bytes: Buffer = Buffer.alloc(0);
    const data = (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length >= 4 && bytes.length >= bytes.readUInt32BE(0) + 4) {
        socket.off("data", data);
        resolve(bytes);
      }
    };
    socket.on("data", data);
    socket.once("close", () => { if (!bytes.length) reject(new Error("closed before frame")); });
    socket.write(JSON.stringify(request) + "\n");
  });
}

function request(token = TOKEN) {
  return { v: 1, token, planId: binding.planId, preflightId: binding.preflightId };
}

async function closed(socket: Socket) {
  if (socket.destroyed) return;
  await new Promise<void>(resolve => socket.once("close", resolve));
}

describe("private import source-secret broker", () => {
  it("uses distinct role-i binary framing and revokes the one-use transfer after ACK", async () => {
    const { home, broker, secrets } = await fixture();
    assert.equal(broker.address, unitAddress(home, "i"));
    const socket = await connect(broker.address);
    const frame = await response(socket, request());
    assert.equal(frame.readUInt32BE(0), frame.length - 4);
    assert.equal(frame[4], 0);
    assert.equal(frame.readUInt16BE(5), 1);
    const nameLength = frame.readUInt16BE(7);
    assert.equal(frame.toString("utf8", 9, 9 + nameLength), "OPENAI_API_KEY");
    assert.equal(frame.readUInt32BE(9 + nameLength), Buffer.byteLength(MARKER));
    assert.equal(frame.subarray(13 + nameLength).toString(), MARKER);
    assert.equal(JSON.stringify(broker).includes(MARKER), false);
    socket.write(Buffer.from([6]));
    await closed(socket);
    assert.throws(() => secrets.take(binding));
  });

  it("rejects an unauthenticated request before ticket lookup and leaves the Owner's lease usable", async () => {
    const { broker, secrets, lookups } = await fixture();
    const socket = await connect(broker.address);
    const frame = await response(socket, request(TOKEN + "-wrong"));
    assert.equal(frame[4], 1);
    assert.equal(frame.includes(Buffer.from(MARKER)), false);
    assert.equal(lookups(), 0);
    const lease = secrets.take(binding);
    assert.equal([...lease.entries()][0]![1].toString(), MARKER);
    lease.release();
  });

  it("refuses extension-purpose fields and mismatched tickets without returning source values", async () => {
    const { broker } = await fixture();
    for (const invalid of [{ v: 1, token: TOKEN, name: "example" },
      { ...request(), preflightId: "e".repeat(36) }]) {
      const socket = await connect(broker.address);
      const frame = await response(socket, invalid);
      assert.notEqual(frame[4], 0);
      assert.equal(frame.length, 7);
      assert.equal(frame.includes(Buffer.from(MARKER)), false);
    }
  });
});
