import { it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { A2aPeerClient } from "../../src/a2a/peer-client.ts";
import { A2aPeerStore } from "../../src/a2a/peer-store.ts";
import { tempDir } from "../helpers/temp-dir.ts";

it("peer management is Owner-person only and add never silently trusts a key", () => {
  const store = new A2aPeerStore({ path: join(tempDir("a2a-client-"), "peers.sqlite"), now: Date.now });
  const client = new A2aPeerClient({ store, transport: { async request() { throw new Error("must not fetch on add"); } }, enabled: () => true, signal: new AbortController().signal });
  try {
    const input = { id: "peer", kid: "key", cardUrl: "https://peer.example/card", publicKey: generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }) };
    for (const who of [{ userId: "admin", kind: "person" as const, role: "admin" as const }, { userId: "bot", kind: "agent" as const, role: "owner" as const }]) {
      assert.throws(() => client.add(who, input), { code: "denied" });
      assert.throws(() => client.list(who), { code: "denied" });
      assert.throws(() => client.remove(who, "peer"), { code: "denied" });
    }
    const owner = { userId: "owner", kind: "person" as const, role: "owner" as const };
    const added = client.add(owner, input);
    assert.equal(added.state, "pending"); assert.equal(client.hasAgent("a2a:peer"), false);
    assert.equal(client.target.accepts("a2a:peer"), true);
    assert.equal(client.target.accepts("main"), false);
    assert.equal(client.list(owner).length, 1);
  } finally { client.close(); store.close(); }
});
