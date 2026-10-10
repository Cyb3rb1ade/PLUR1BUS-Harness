import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { DeviceStore } from "../src/device-store.ts";
import { PairCodeStore } from "../src/pair-code.ts";

const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const device = { name: "Phone", platform: "ios", publicKey, pairedBy: "alice", scope: ["memory.recall"] };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "device-store-"));
  const file = join(dir, "devices.json");
  let now = 1000;
  const events: any[] = [];
  const options = { file, clock: () => now, audit: { append: (e: any) => events.push(e) }, securePath: () => {} };
  return { file, events, options, store: new DeviceStore(options), advance: (n: number) => { now += n; }, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

test("successful pairing persists metadata, fingerprint and audit; invalid codes add nothing", () => {
  const f = fixture();
  try {
    const codes = new PairCodeStore({ derive: (s) => createHash("sha256").update(s).digest() });
    assert.throws(() => f.store.pair(codes, "bad", device, "test"));
    assert.deepEqual(f.store.list(), []);
    const issued = codes.issue(1000);
    const d = f.store.pair(codes, issued.code, device, "test");
    assert.equal(d.name, "Phone"); assert.equal(d.pairedAt, 1000); assert.equal(d.lastSeenAt, 1000);
    assert.equal(d.revoked, false); assert.equal(d.pairedBy, "alice");
    assert.match(d.fingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(new DeviceStore(f.options).list(), [d]);
    assert.equal(f.events[0].action, "device.paired");
    assert.throws(() => f.store.pair(codes, issued.code, device, "test"));
    if (process.platform !== "win32") assert.equal(statSync(f.file).mode & 0o777, 0o600);
  } finally { f.clean(); }
});

test("authenticated handshake throttles lastSeen writes; revoke closes all connections and persists denial", () => {
  const f = fixture();
  try {
    const d = f.store.recordPairing(device);
    let closed = 0;
    let challenge = f.store.challenge();
    let signature = sign(null, challenge, keys.privateKey);
    assert.throws(() => f.store.connect({ publicKey, challenge, signature: Buffer.alloc(64), close: () => {} }));
    challenge = f.store.challenge(); signature = sign(null, challenge, keys.privateKey);
    f.advance(1);
    const disconnect = f.store.connect({ publicKey, challenge, signature, close: () => { closed++; } });
    assert.equal(f.store.list()[0]!.lastSeenAt, 1000);
    f.advance(60_000);
    challenge = f.store.challenge(); signature = sign(null, challenge, keys.privateKey);
    f.store.connect({ publicKey, challenge, signature, close: () => { closed++; } });
    assert.equal(f.store.list()[0]!.lastSeenAt, 61_001);
    f.store.revoke(d.id, "alice");
    assert.equal(closed, 2); disconnect();
    f.store.revoke(d.id, "alice"); assert.equal(closed, 2);
    const restarted = new DeviceStore(f.options);
    assert.equal(restarted.list()[0]!.revoked, true);
    challenge = restarted.challenge(); signature = sign(null, challenge, keys.privateKey);
    assert.throws(() => restarted.connect({ publicKey, challenge, signature, close: () => {} }));
    assert.throws(() => restarted.recordPairing(device));
    assert.equal(f.events.filter(e => e.action === "device.revoked").length, 1);
  } finally { f.clean(); }
});

test("rename audits, copies cannot mutate trust, malformed state fails closed", () => {
  const f = fixture();
  try {
    const d = f.store.recordPairing(device);
    f.store.rename(d.id, "Tablet", "alice");
    const copy = f.store.list()[0]!; copy.scope.push("admin.*"); copy.name = "oops";
    assert.equal(f.store.list()[0]!.name, "Tablet");
    assert.deepEqual(f.store.list()[0]!.scope, ["memory.recall"]);
    assert.equal(f.events.at(-1).action, "device.renamed");
    assert.throws(() => f.store.rename(d.id, "\u001b", "alice"));
    writeFileSync(f.file, '{"version":1,"devices":[{"id":"bad"}]}');
    assert.throws(() => new DeviceStore(f.options));
  } finally { f.clean(); }
});

test("failed private write does not publish pairing or erase revocation", () => {
  const f = fixture();
  try {
    const d = f.store.recordPairing(device);
    const before = readFileSync(f.file, "utf8");
    let fail = false;
    const s = new DeviceStore({ ...f.options, securePath: () => { if (fail) throw new Error("ACL refused"); } });
    let closed = false;
    const challenge = s.challenge();
    s.connect({ publicKey, challenge, signature: sign(null, challenge, keys.privateKey), close: () => { closed = true; } });
    fail = true;
    assert.throws(() => s.revoke(d.id, "alice"));
    assert.equal(readFileSync(f.file, "utf8"), before);
    assert.equal(s.get(d.id).revoked, true);
    assert.equal(closed, true);
    fail = false; s.revoke(d.id, "alice");
    assert.equal(new DeviceStore(f.options).get(d.id).revoked, true);
  } finally { f.clean(); }
});


test("unknown keys, expired challenges and replayed proofs cannot connect", () => {
  const f = fixture();
  try {
    f.store.recordPairing(device);
    const challenge = f.store.challenge();
    const signature = sign(null, challenge, keys.privateKey);
    const cleanup = f.store.connect({ publicKey, challenge, signature, close: () => {} });
    assert.throws(() => f.store.connect({ publicKey, challenge, signature, close: () => {} }));
    cleanup();
    const expired = f.store.challenge(); f.advance(30_000);
    assert.throws(() => f.store.connect({ publicKey, challenge: expired, signature: sign(null, expired, keys.privateKey), close: () => {} }));
    const stranger = generateKeyPairSync("ed25519");
    const nonce = f.store.challenge();
    assert.throws(() => f.store.connect({ publicKey: stranger.publicKey.export({ format: "der", type: "spki" }).toString("base64"), challenge: nonce, signature: sign(null, nonce, stranger.privateKey), close: () => {} }));
  } finally { f.clean(); }
});

test("audit failure refuses pairing, rename and revocation before state changes", () => {
  const f = fixture();
  try {
    const d = f.store.recordPairing(device);
    const s = new DeviceStore({ ...f.options, audit: { append: () => { throw new Error("audit failed"); } } });
    assert.throws(() => s.rename(d.id, "Tablet", "alice"));
    assert.throws(() => s.revoke(d.id, "alice"));
    const key = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
    assert.throws(() => s.recordPairing({ ...device, publicKey: key }));
    assert.deepEqual(s.list(), [d]);
    assert.deepEqual(new DeviceStore(f.options).list(), [d]);
  } finally { f.clean(); }
});
