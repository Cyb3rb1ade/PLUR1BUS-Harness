/** AF2 end to end: real Core + Unix fake, including policy filtering, R6 and status redaction. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { startFakeFmServe } from "../../../providers/test/fixtures/fake-fm-serve.ts";
import { createCore } from "../../src/core.ts";
import { layout } from "../../src/paths.ts";
import { connect } from "../helpers/connect.ts";
import { flatTestInternals } from "../helpers/flat-embedder.ts";

type Scan = { providers: { result: string; warnings: { code: string; count?: number }[] }[] };
test("Core synthesizes the keyless system provider and never reconciles filtered models", {
  timeout: 30_000, skip: process.platform === "win32" && "native Unix sockets require POSIX",
}, async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "af2-core-")));
  const paths = layout(home);
  await mkdir(paths.appleFmDir, { recursive: true, mode: 0o700 });
  const config = defaults(); config.appleFm.enabled = true; config.privacy.localOnly = true;
  config.agents.fixture = {};
  await writeFile(paths.configPath, JSON.stringify(config));
  const envelope = { data: [{ id: "system", context_length: 1_000_000 }, { id: "pcc" }, { id: "unknown" }] };
  const fm = await startFakeFmServe({ directory: paths.appleFmDir, models: envelope });
  let state = "ready", tcp = 0, genericFetch = 0;
  const core = createCore({ home, testInternals: flatTestInternals(), composition: {
    appleFm: { platform: "darwin", slot: () => ({ state }) }, definitions: {},
    fetch: async () => { genericFetch++; throw Error("generic fetch forbidden"); },
  }, discovery: { request: () => { tcp++; throw Error("TCP forbidden"); } } });
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    await core.start();
    client = await connect({ address: core.address, token: core.token });
    const scan = await client.call<Scan>("models.scan", { provider: "apple-fm" });
    assert.equal(scan.providers[0]?.result, "ok");
    assert.deepEqual(scan.providers[0]?.warnings, [{ code: "filtered_by_policy", provider: "apple-fm", count: 2 }]);
    const list = await client.call<{ models: { id: string; contextWindow: number; locked?: "local-only" }[] }>("models.list", {});
    assert.deepEqual(list.models.map(model => model.id), ["system"]);
    assert.equal(list.models[0]?.contextWindow, 4096);
    assert.equal(list.models[0]?.locked, undefined);
    const caller = { channel: "cli", accountId: "host", userId: "alice" };
    const { session } = await client.call<{ session: { id: string } }>("session.create", { caller, agentId: "fixture" });
    const beforeSelection = fm.requests.length;
    await assert.rejects(client.call("session.model.set", { caller, sessionId: session.id, profile: "apple-fm/system" }), /4096.*16384/);
    assert.equal(fm.requests.length, beforeSelection);
    await assert.rejects(client.call("models.setOverride", { provider: "apple-fm", id: "system", set: { contextWindow: 65536 } }));
    await assert.rejects(client.call("models.setOverride", { provider: "apple-fm", id: "pcc", create: true, set: {} }));
    envelope.data = [{ id: "pcc" }];
    const missing = await client.call<Scan>("models.scan", { provider: "apple-fm" });
    assert.equal(missing.providers[0]?.result, "failed:empty");
    assert.equal(missing.providers[0]?.warnings[0]?.count, 1);
    envelope.data = [];
    assert.equal((await client.call<Scan>("models.scan", { provider: "apple-fm" })).providers[0]?.result, "failed:empty");
    assert.deepEqual((await client.call<typeof list>("models.list", {})).models.map(model => model.id), ["system"]);
    state = "crashed";
    const before = fm.requests.length;
    await client.call("models.scan", { provider: "apple-fm" });
    assert.equal(fm.requests.length, before, "unready slot cannot reach the socket");
    const status = await client.call<ReturnType<typeof core.status>>("core.status");
    const metrics = status.providers?.["apple-fm"]?.transport.unix;
    assert.ok(metrics && metrics.ok >= 3 && metrics.refused.unavailable >= 1);
    assert.doesNotMatch(JSON.stringify(status.providers), /af2-core-|fm\.sock|Bearer|1_000_000/);
    assert.equal(tcp, 0); assert.equal(genericFetch, 0);
  } finally {
    client?.close(); await core.stop(); await fm.close(); await rm(home, { recursive: true, force: true });
  }
});
