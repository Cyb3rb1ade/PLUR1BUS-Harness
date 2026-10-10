import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { generateKeyPairSync, createHash, sign } from "node:crypto";
import { defaults } from "@plur1bus/config-schema";
import { createCore } from "../../src/core.ts";
import { layout } from "../../src/paths.ts";
import { platformCapabilities } from "../../src/platform.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import { DeviceStore } from "../../../remote-access/src/device-store.ts";
import { PairCodeStore } from "../../../remote-access/src/pair-code.ts";
import { connect } from "../helpers/connect.ts";
import { flatTestInternals } from "../helpers/flat-embedder.ts";
import { tempDir } from "../helpers/temp-dir.ts";

test("core registers device RPC, validates params, audits mutations and preserves revocation after restart", async () => {
  const home = tempDir("p1b-device-core-");
  const cfg = defaults();
  cfg.agents.bernd = {};
  cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false }, reranker: { enabled: false } };
  writeFileSync(layout(home).configPath, JSON.stringify(cfg));
  const audit = memoryAuditSink();
  const options = { file: `${layout(home).state}/devices.json`, clock: () => 1000, audit, securePath: platformCapabilities.securePath };
  const enrolled = new DeviceStore(options);
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const codes = new PairCodeStore({ derive: s => createHash("sha256").update(s).digest() });
  const code = codes.issue(1000);
  const device = enrolled.pair(codes, code.code, { name: "Phone", platform: "ios", publicKey, pairedBy: "local-owner", scope: [] }, "offline");
  for (const first of [true, false]) {
    const core = createCore({ home, testInternals: flatTestInternals(), rbac: { audit } });
    await core.start();
    const client = await connect({ address: core.address, token: core.token });
    try {
      const result = await client.call<any>("device.list", {});
      assert.equal(result.devices.length, 1);
      assert.equal(result.devices[0].id, device.id);
      assert.equal(result.devices[0].revoked, !first);
      if (first) {
        await assert.rejects(client.call("device.revoke", { id: device.id, pairedBy: "local-owner" }), (e: any) => e.error === "E_INVALID_PARAMS");
        const renamed = await client.call<any>("device.rename", { id: device.id, name: "Tablet" });
        assert.equal(renamed.name, "Tablet");
        const revoked = await client.call<any>("device.revoke", { id: device.id });
        assert.equal(revoked.revoked, true);
      } else {
        assert.equal(result.devices[0].name, "Tablet");
        const restored = new DeviceStore(options);
        const challenge = restored.challenge();
        assert.throws(() => restored.connect({ publicKey, challenge, signature: sign(null, challenge, keys.privateKey), close: () => {} }));
      }
    } finally { await client.close(); await core.stop({ budgetMs: 5000 }); }
  }
  assert.deepEqual(audit.events.filter(e => e.action.startsWith("device.")).map(e => e.action), ["device.paired", "device.renamed", "device.revoked"]);
});
