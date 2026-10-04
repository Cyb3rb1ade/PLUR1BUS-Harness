import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { connect, type CoreClient, RpcCallError } from "@plur1bus/module-api";
import { createPlatformCapabilities } from "../src/platform.ts";
import { createCatalogStore } from "../src/discovery/catalog-store.ts";
import { loadMetadataTable } from "../src/discovery/metadata.ts";
import { createDiscoveryService } from "../src/discovery/service.ts";
import { createModelsScanJob } from "../src/discovery/job.ts";
import { createSystemJobs } from "../src/system-jobs/index.ts";
import { createRpcServer, type RpcServer } from "../src/rpc/server.ts";
import { buildMethods } from "../src/rpc/methods.ts";
import { FakeClock, InMemoryProfileSource, RecordingEvents } from "../src/discovery/testing.ts";
import { startFakeEndpoint, type FakeEndpoint } from "./helpers/fake-endpoint.ts";
import { tempDir } from "./helpers/temp-dir.ts";
import { createLogger } from "../src/logger.ts";
import { ActivityTracker } from "../src/activity.ts";

describe("models RPC", () => {
  const platform = createPlatformCapabilities({ platform: process.platform });
  const TOKEN = "m".repeat(64);

  let dir: string;
  let endpoint: FakeEndpoint;
  let clock: FakeClock;
  let server: RpcServer;
  let client: CoreClient;
  let systemJobs: ReturnType<typeof createSystemJobs>;
  let discovery: ReturnType<typeof createDiscoveryService>;
  const serverNotifications: { name: string; payload: unknown }[] = [];
  let modelItems = [{ id: "example-chat-large" }, { id: "example-chat-small" }];

  before(async () => {
    dir = tempDir("p1b-models-rpc-");
    const address = process.platform === "win32" ? `\\\\.\\pipe\\plur1bus-models-rpc-${process.pid}` : join(dir, "core.sock");
    const log = createLogger({ file: join(dir, "core.log"), level: "debug", role: "core" });

    endpoint = await startFakeEndpoint((req) => {
      if (req.url === "/v1/models") {
        return {
          status: 200,
          json: {
            data: modelItems,
          },
        };
      }
      return { status: 404 };
    });

    clock = new FakeClock(1_700_000_000_000);
    const table = loadMetadataTable();
    const catalogPath = join(dir, "models.json");
    const ledgerPath = join(dir, "system-jobs.jsonl");

    const store = createCatalogStore({
      path: catalogPath,
      securePath: platform.securePath,
      clock,
      tableRevision: table.revision,
      logger: { info: () => {}, warn: () => {} },
    });
    await store.load();

    const profiles = new InMemoryProfileSource([
      { id: "example-compat", vendor: "example-vendor", discovery: "openai-models", baseUrl: `${endpoint.origin}/v1` },
    ]);
    const credentials = {
      resolve: async (_id: string, origin: string) => ({ origin, headerName: "Authorization", headerValue: "Bearer token" }),
    };
    const events = new RecordingEvents();

    discovery = createDiscoveryService({
      store,
      profiles,
      credentials,
      events,
      clock,
      rng: () => 0.5,
      table,
      roles: () => ({}),
      settings: () => ({ enabled: true, intervalHours: 24 }),
      logger: { debug: () => {}, info: () => {}, warn: () => {} },
    });

    systemJobs = createSystemJobs({
      ledgerPath,
      clock,
      logger: { warn: () => {} },
      securePath: platform.securePath,
      engineHasJob: () => false,
    });
    systemJobs.register(createModelsScanJob(discovery, () => ({ enabled: true, intervalHours: 24 })));

    const fakeEngine = {
      contract: "1.0.0",
      jobs: { list: () => [], run: async () => {}, history: async () => [] },
      models: { warm: async () => ({ embedder: { state: "ready" }, reranker: { state: "disabled" } }) },
      status: async () => ({ storeSchema: { current: null, expected: "1.0" }, jobs: { ledger: "ok", agents: [] } }),
    };

    const activity = new ActivityTracker(() => clock.now());
    const agents = { list: () => [], workspaceOf: () => null } as any;

    const methods = buildMethods({
      engine: fakeEngine as any,
      config: () => ({}) as any,
      agents,
      activity,
      logger: log,
      status: () => ({} as any),
      shutdown: () => {},
      journalBacklog: () => 0,
      clock: () => clock.now(),
      captureSignal: new AbortController().signal,
      isStopping: () => false,
      adopt: () => ({} as any),
      onMigrated: () => {},
      systemJobs,
      discovery,
    });

    server = createRpcServer({
      address,
      token: TOKEN,
      hello: () => ({ contract: "1.0.0", rpc: "1.5.0", instanceId: "inst", pid: process.pid }),
      methods,
      logger: log,
    });

    // Wire notifications to spy
    const origNotify = server.notify.bind(server);
    server.notify = (name: string, payload: object, opts?: any) => {
      serverNotifications.push({ name, payload });
      return origNotify(name, payload, opts);
    };

    discovery.onChanged((e) => {
      server.notify("models.changed", e);
    });

    await server.listen();
    client = await connect({ address, token: TOKEN });
  });

  after(async () => {
    await client?.close();
    await server?.close();
    await endpoint?.close();
  });

  it("models.list after a scan", async () => {
    // Before scan: empty
    const before = await client.call<any>("models.list", {});
    assert.equal(before.models.length, 0);

    // Run scan
    const scanRes = await client.call<any>("models.scan", {});
    assert.equal(scanRes.providers.length, 1);
    assert.equal(scanRes.providers[0].result, "ok");

    // List after scan
    const after = await client.call<any>("models.list", {});
    assert.equal(after.models.length, 2);
    assert.equal(after.providers[0].lastResult, "ok");
    assert.equal(after.newCount, 2);
    assert.deepEqual(after.warnings, []);
  });

  it("models.scan result matches the schema", async () => {
    const scanRes = await client.call<any>("models.scan", { provider: "example-compat" });
    assert.equal(scanRes.providers.length, 1);
    const p = scanRes.providers[0];
    assert.equal(p.provider, "example-compat");
    assert.equal(p.result, "ok");
    assert.deepEqual(p.reappeared, []);
    assert.deepEqual(p.unavailable, []);
    assert.ok(scanRes.startedAt <= scanRes.finishedAt);
  });

  it("models.setOverride returns the entry, create makes a manual one", async () => {
    // Override existing scanned model
    const overridden = await client.call<any>("models.setOverride", {
      provider: "example-compat",
      id: "example-chat-large",
      set: { displayName: "Custom Large" },
    });
    assert.equal(overridden.displayName, "Custom Large");
    assert.equal(overridden.overrides.displayName, "Custom Large");

    // Create a manual model
    const manual = await client.call<any>("models.setOverride", {
      provider: "example-compat",
      id: "my-manual-model",
      create: true,
      set: { displayName: "My Manual Model", kind: "chat" },
    });
    assert.equal(manual.id, "my-manual-model");
    assert.equal(manual.status, "manual");
  });

  it("models.removeManual refuses a non-manual entry", async () => {
    await assert.rejects(
      async () => {
        await client.call("models.removeManual", {
          provider: "example-compat",
          id: "example-chat-large",
        });
      },
      (err: any) => {
        assert.ok(err instanceof RpcCallError);
        assert.equal(err.error, "E_INVALID_PARAMS");
        assert.equal(err.reason, "not-manual");
        return true;
      },
    );

    // Remove the manual entry created above
    const rem = await client.call<any>("models.removeManual", {
      provider: "example-compat",
      id: "my-manual-model",
    });
    assert.equal(rem.removed, true);
  });

  it("models.acknowledge clears the badge", async () => {
    const ack = await client.call<any>("models.acknowledge", {});
    assert.ok(typeof ack.acknowledgedAt === "string");

    const list = await client.call<any>("models.list", {});
    assert.equal(list.newCount, 0);
  });

  it("unknown provider and unknown params are refused", async () => {
    await assert.rejects(
      async () => {
        await client.call("models.scan", { provider: "nope" });
      },
      (err: any) => {
        assert.ok(err instanceof RpcCallError);
        assert.equal(err.error, "E_INVALID_PARAMS");
        assert.equal(err.reason, "unknown-provider");
        return true;
      },
    );

    await assert.rejects(
      async () => {
        await client.call("models.list", { extra: 1 });
      },
      (err: any) => {
        assert.ok(err instanceof RpcCallError);
        assert.equal(err.error, "E_INVALID_PARAMS");
        return true;
      },
    );
  });

  it("models.changed is delivered after a change and not after an unchanged scan", async () => {
    // Clear notifications spy
    serverNotifications.length = 0;

    // Scan with no changes
    await client.call("models.scan", { provider: "example-compat" });
    const changedNotifications = serverNotifications.filter((n) => n.name === "models.changed");
    assert.equal(changedNotifications.length, 0, "no notification for unchanged scan");

    // Add a new model to fake endpoint response
    modelItems.push({ id: "example-chat-new" });

    // Scan again, which will detect the new model and emit models.changed
    await client.call("models.scan", { provider: "example-compat" });
    const changedAfterScan = serverNotifications.filter((n) => n.name === "models.changed");
    assert.equal(changedAfterScan.length, 1);
    const payload = changedAfterScan[0]!.payload as any;
    assert.equal(payload.provider, "example-compat");
    assert.deepEqual(payload.discovered, ["example-chat-new"]);
    assert.ok(typeof payload.at === "string");
  });

  it("models.scan writes one ledger row and no job.run", async () => {
    serverNotifications.length = 0;
    const historyBefore = systemJobs.history({ job: "models.scan" }).length;

    await client.call("models.scan", { provider: "example-compat" });

    const historyAfter = systemJobs.history({ job: "models.scan" }).length;
    assert.equal(historyAfter - historyBefore, 1, "exactly one ledger row written");
    assert.equal(serverNotifications.filter((n) => n.name === "job.run").length, 0, "no job.run notification emitted");
  });

  it("setOverride validation errors carry the field", async () => {
    await assert.rejects(
      async () => {
        await client.call("models.setOverride", {
          provider: "example-compat",
          id: "example-chat-large",
          set: { contextWindow: 0 },
        });
      },
      (err: any) => {
        assert.ok(err instanceof RpcCallError);
        assert.equal(err.error, "E_INVALID_PARAMS");
        assert.ok(err.detail?.includes("contextWindow"));
        return true;
      },
    );

    // Alias collision with another model id
    await assert.rejects(
      async () => {
        await client.call("models.setOverride", {
          provider: "example-compat",
          id: "example-chat-large",
          set: { aliases: ["example-chat-small"] },
        });
      },
      (err: any) => {
        assert.ok(err instanceof RpcCallError);
        assert.equal(err.error, "E_CONFLICT");
        return true;
      },
    );

    // Duplicate create is also E_CONFLICT
    await assert.rejects(
      async () => {
        await client.call("models.setOverride", {
          provider: "example-compat",
          id: "example-chat-large",
          create: true,
        });
      },
      (err: any) => {
        assert.ok(err instanceof RpcCallError);
        assert.equal(err.error, "E_CONFLICT");
        return true;
      },
    );
  });
});
