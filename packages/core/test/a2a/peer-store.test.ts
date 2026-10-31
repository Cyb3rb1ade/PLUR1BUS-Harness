import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { statSync } from "node:fs";
import { tempDir } from "../helpers/temp-dir.ts";
import { A2aPeerStore } from "../../src/a2a/peer-store.ts";

const input = () => ({ id: "peer", cardUrl: "https://peer.example/card", kid: "peer-key", publicKey: generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }) });

describe("A2A peer pins", () => {
  it("persists a pending peer and pins only the explicitly approved fingerprint", () => {
    const path = join(tempDir("a2a-peers-"), "peers.sqlite");
    const store = new A2aPeerStore({ path, now: () => 123 });
    const peer = store.add(input());
    assert.equal(peer.state, "pending");
    assert.equal(peer.agentId, "a2a:peer");
    assert.equal(peer.origin, "a2a");
    assert.equal(peer.targetKind, "external");
    assert.equal("publicKey" in peer, false);
    assert.equal("publicKey" in store.list()[0]!, false);
    assert.throws(() => store.trust(peer.id, "sha256:wrong", peer.revision, "https://peer.example/a2a/main"), { code: "peer-untrusted" });
    assert.equal(store.get(peer.id)!.state, "pending");
    const trusted = store.trust(peer.id, peer.fingerprint, peer.revision, "https://peer.example/a2a/main");
    assert.equal(trusted.state, "trusted");
    assert.notEqual(trusted.revision, peer.revision);
    store.close();
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o077, 0);
    const reopened = new A2aPeerStore({ path, now: () => 456 });
    try {
      assert.equal(reopened.list()[0]!.state, "trusted");
      assert.equal(reopened.list()[0]!.fingerprint, peer.fingerprint);
    } finally { reopened.close(); }
  });

  it("cannot silently replace a peer or resurrect it after removal", () => {
    const store = new A2aPeerStore({ path: join(tempDir("a2a-peer-cas-"), "peers.sqlite"), now: () => 1 });
    try {
      const original = store.add(input());
      assert.throws(() => store.add(input()), { code: "peer-exists" });
      assert.equal(store.list()[0]!.fingerprint, original.fingerprint);
      assert.equal(store.remove(original.id), true);
      assert.equal(store.remove(original.id), false);
      assert.throws(() => store.trust(original.id, original.fingerprint, original.revision, "https://peer.example/a2a/main"), { code: "peer-revoked" });
      const replacement = store.add(input());
      assert.throws(() => store.trust(original.id, original.fingerprint, original.revision, "https://peer.example/a2a/main"), { code: "peer-revoked" });
      assert.equal(store.get(replacement.id)!.state, "pending");
    } finally { store.close(); }
  });

  it("bounds the registry and rejects credential-bearing URLs without echoing their values", () => {
    const store = new A2aPeerStore({ path: join(tempDir("a2a-peer-cap-"), "peers.sqlite"), now: () => 1, maxPeers: 1 });
    try {
      for (const cardUrl of ["file:///etc/passwd", "https://user:private-value@peer.example/card", "https://peer.example/card?token=private-value", "https://peer.example/card#private-value"]) {
        assert.throws(() => store.add({ ...input(), cardUrl }), { message: "A2A peer settings are invalid" });
      }
      store.add(input());
      assert.throws(() => store.add({ ...input(), id: "another" }), { code: "invalid-peer" });
      assert.equal(store.list().length, 1);
    } finally { store.close(); }
  });
});
