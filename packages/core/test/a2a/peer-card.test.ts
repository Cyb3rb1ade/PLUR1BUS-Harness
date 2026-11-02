import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { AgentCard, generateAgentCardSignature } from "@a2a-js/sdk";
import { peerKeyFingerprint, verifyPeerCard } from "../../src/a2a/peer-card.ts";

const cardUrl = "https://peer.example/.well-known/agent-card.json";
async function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const key = publicKey.export({ format: "jwk" });
  const card = AgentCard.fromJSON({
    name: "Foreign Agent", description: "public card", version: "1",
    supportedInterfaces: [{ protocolBinding: "JSONRPC", protocolVersion: "1.0", url: "https://peer.example/a2a/main" }],
    capabilities: { streaming: false }, defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain"],
    skills: [{ id: "chat", name: "Chat", description: "Chat", tags: [] }],
  });
  const signed = await generateAgentCardSignature(privateKey, { alg: "EdDSA", typ: "JWT", kid: "peer-key" })(card);
  return { signed, key, privateKey };
}

describe("foreign A2A card verification", () => {
  it("verifies Ed25519 and returns only endpoint and public-key identity", async () => {
    const { signed, key } = await fixture();
    const result = verifyPeerCard(signed, { key, kid: "peer-key", cardUrl });
    assert.deepEqual(result, { endpoint: "https://peer.example/a2a/main", fingerprint: peerKeyFingerprint(key), kid: "peer-key" });
    assert.match(result.fingerprint, /^sha256:[A-Za-z0-9_-]{43}$/);
  });

  it("rejects tampered cards, a changed key, unsigned cards and wrong key ids without logging peer data", async t => {
    const { signed, key } = await fixture();
    const other = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" });
    const debug = t.mock.method(console, "debug", () => {});
    const marker = "UNTRUSTED-CARD-CONTENT-12345";
    for (const [card, chosen, kid] of [
      [{ ...signed, description: marker }, key, "peer-key"],
      [signed, other, "peer-key"],
      [{ ...signed, signatures: [] }, key, "peer-key"],
      [signed, key, "other-key"],
    ] as const) {
      assert.throws(() => verifyPeerCard(card, { key: chosen, kid, cardUrl }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "A2A peer card verification failed");
        return true;
      });
    }
    assert.equal(debug.mock.callCount(), 0);
  });

  it("rejects private/malformed keys and unsupported protected headers", async () => {
    const { signed, key } = await fixture();
    for (const bad of [{ ...key, d: "not-public" }, { ...key, crv: "X25519" }, { ...key, x: "AA" }]) {
      assert.throws(() => peerKeyFingerprint(bad), /A2A public key is invalid/);
    }
    for (const header of [
      { alg: "HS256", kid: "peer-key", typ: "JWT" },
      { alg: "EdDSA", kid: "peer-key", typ: "JWT", crit: ["unknown"], unknown: true },
      { alg: "EdDSA", kid: "peer-key", typ: "JWT", b64: false },
    ]) {
      const card = { ...signed, signatures: [{ ...signed.signatures![0], protected: Buffer.from(JSON.stringify(header)).toString("base64url") }] };
      assert.throws(() => verifyPeerCard(card, { key, kid: "peer-key", cardUrl }), /A2A peer card verification failed/);
    }
  });

  it("rejects unsigned prototype keys and an endpoint outside the card origin", async () => {
    const { signed, key } = await fixture();
    const proto = JSON.parse(JSON.stringify(signed));
    Object.defineProperty(proto, "__proto__", { value: { injected: true }, enumerable: true });
    assert.throws(() => verifyPeerCard(proto, { key, kid: "peer-key", cardUrl }), /A2A peer card verification failed/);
    assert.throws(() => verifyPeerCard(signed, { key, kid: "peer-key", cardUrl: "https://other.example/card" }), /A2A peer card verification failed/);
  });

  it("rejects correctly signed cards with ambiguous or credential-bearing JSON-RPC endpoints", async () => {
    const { signed, key, privateKey } = await fixture();
    for (const endpoints of [["https://peer.example/a2a/main", "https://peer.example/other"], ["https://user:password@peer.example/a2a"], ["https://peer.example/a2a?token=secret"]]) {
      const card = await generateAgentCardSignature(privateKey, { alg: "EdDSA", typ: "JWT", kid: "peer-key" })({ ...signed, supportedInterfaces: endpoints.map(url => ({ url, protocolBinding: "JSONRPC", protocolVersion: "1.0", tenant: "" })) });
      assert.throws(() => verifyPeerCard(card, { key, kid: "peer-key", cardUrl }), { code: "card-signature" });
    }
  });
});
