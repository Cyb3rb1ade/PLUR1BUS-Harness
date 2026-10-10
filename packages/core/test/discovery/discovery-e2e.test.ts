// End-to-end tests through RPC and discovery service, D109 spies, canaries (plan Task 11).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { type CoreClient } from "@plur1bus/module-api";
import { connect } from "../helpers/connect.ts";
import { defaults } from "@plur1bus/config-schema";
import { createCore, type Core } from "../../src/core.ts";
import { layout } from "../../src/paths.ts";
import { flatTestInternals } from "../helpers/flat-embedder.ts";
import { startFakeEndpoint, type FakeEndpoint } from "../helpers/fake-endpoint.ts";
import { InMemoryProfileSource, StaticCredentialResolver } from "../../src/discovery/testing.ts";
import type { CredentialResolver } from "../../src/discovery/ports.ts";
import { createLoggerEvents } from "../../src/discovery/events-logger.ts";

function newHome(endpointPort: number, extraConfig?: (cfg: any) => void): string {
  const home = mkdtempSync(join(tmpdir(), "p1b-e2e-"));
  const cfg = defaults();
  cfg.agents.bernd = {};
  cfg.engine = {
    neo: { enabled: false },
    gc: { enabled: false },
    obsidianBridge: { enabled: false },
    merging: { enabled: false },
    dreaming: { enabled: false },
    skillMiner: { enabled: false },
    temporalContext: { enabled: false },
    conversationReactivationRecall: { enabled: false },
    reranker: { enabled: false },
    runtime: { recallTimeoutMs: 10_000 },
  };
  cfg.engine.duplicateThreshold = 1.01;
  cfg.egress = { allowHosts: ["127.0.0.1"], allowPorts: [endpointPort], allowLoopback: true };
  if (extraConfig) extraConfig(cfg);
  writeFileSync(layout(home).configPath, JSON.stringify(cfg));
  return home;
}

describe("model discovery end-to-end", () => {
  it("openai-style mock: scan finds two models, list shows them, removal turns unavailable, return turns available, override survives", async () => {
    let models = [{ id: "example-chat-large" }, { id: "example-chat-small" }];
    const endpoint = await startFakeEndpoint((req) => {
      if (req.url === "/v1/models") {
        return { status: 200, json: { data: models } };
      }
      return { status: 404 };
    });

    const home = newHome(endpoint.port);
    const profiles = new InMemoryProfileSource([
      { id: "example-compat", vendor: "example-vendor", discovery: "openai-models", baseUrl: `${endpoint.origin}/v1` },
    ]);
    const credentials = new StaticCredentialResolver({
      "example-compat": { origin: endpoint.origin, headerName: "Authorization", headerValue: "Bearer token" },
    });

    const core = createCore({
      home,
      testInternals: flatTestInternals(),
      discovery: { profiles, credentials, scheduler: false },
    });

    let client: CoreClient | undefined;
    try {
      await core.start();
      client = await connect({ address: core.address, token: core.token });

      // 1. Initial scan
      const scan1 = await client.call<any>("models.scan");
      assert.equal(scan1.providers[0].result, "ok");
      assert.equal(scan1.providers[0].new.length, 2);

      // 2. List shows them
      const list1 = await client.call<any>("models.list");
      assert.equal(list1.models.length, 2);
      const small1 = list1.models.find((m: any) => m.id === "example-chat-small");
      assert.ok(small1);
      assert.equal(small1.kind, "chat");
      assert.equal(small1.contextWindow, 128000);
      assert.equal(small1.status, "available");
      const small1LastSeen = small1.lastSeen;

      // 3. Set displayName override "My Small"
      const ov = await client.call<any>("models.setOverride", {
        provider: "example-compat",
        id: "example-chat-small",
        set: { displayName: "My Small" },
      });
      assert.equal(ov.displayName, "My Small");

      const listAfterOv = await client.call<any>("models.list");
      assert.equal(listAfterOv.models.find((m: any) => m.id === "example-chat-small").displayName, "My Small");

      // 4. Removal turns unavailable, lastSeen unchanged, override survives
      models = [{ id: "example-chat-large" }];
      await client.call("models.scan");

      const list2 = await client.call<any>("models.list");
      const small2 = list2.models.find((m: any) => m.id === "example-chat-small");
      assert.ok(small2);
      assert.equal(small2.status, "unavailable");
      assert.equal(small2.lastSeen, small1LastSeen);
      assert.equal(small2.displayName, "My Small");

      // 5. Return turns available, override still survives
      models = [{ id: "example-chat-large" }, { id: "example-chat-small" }];
      await client.call("models.scan");

      const list3 = await client.call<any>("models.list");
      const small3 = list3.models.find((m: any) => m.id === "example-chat-small");
      assert.ok(small3);
      assert.equal(small3.status, "available");
      assert.equal(small3.displayName, "My Small");
    } finally {
      if (client) await client.close();
      await core.stop();
      await endpoint.close();
    }
  });

  it("ollama-style mock", async () => {
    let models = [
      { name: "example-llama:latest", modified_at: "2026-10-01T00:00:00Z" },
      { name: "example-llama:8b", modified_at: "2026-10-01T00:00:00Z" },
    ];
    const endpoint = await startFakeEndpoint((req) => {
      if (req.url === "/api/tags") {
        return { status: 200, json: { models } };
      }
      return { status: 404 };
    });

    const home = newHome(endpoint.port);
    const profiles = new InMemoryProfileSource([
      { id: "ollama-local", discovery: "ollama-tags", baseUrl: endpoint.origin },
    ]);
    const credentials = new StaticCredentialResolver({});

    const core = createCore({
      home,
      testInternals: flatTestInternals(),
      discovery: { profiles, credentials, scheduler: false },
    });

    let client: CoreClient | undefined;
    try {
      await core.start();
      client = await connect({ address: core.address, token: core.token });

      // Scan finds two models
      await client.call("models.scan");
      const list1 = await client.call<any>("models.list");
      assert.equal(list1.models.length, 2);
      const llama8b1 = list1.models.find((m: any) => m.id === "example-llama:8b");
      assert.ok(llama8b1);
      assert.equal(llama8b1.status, "available");
      const lastSeen1 = llama8b1.lastSeen;

      // Set override
      await client.call("models.setOverride", {
        provider: "ollama-local",
        id: "example-llama:8b",
        set: { displayName: "My Llama 8B" },
      });

      // Remove model
      models = [{ name: "example-llama:latest", modified_at: "2026-10-01T00:00:00Z" }];
      await client.call("models.scan");

      const list2 = await client.call<any>("models.list");
      const llama8b2 = list2.models.find((m: any) => m.id === "example-llama:8b");
      assert.ok(llama8b2);
      assert.equal(llama8b2.status, "unavailable");
      assert.equal(llama8b2.lastSeen, lastSeen1);
      assert.equal(llama8b2.displayName, "My Llama 8B");

      // Restore model
      models = [
        { name: "example-llama:latest", modified_at: "2026-10-01T00:00:00Z" },
        { name: "example-llama:8b", modified_at: "2026-10-01T00:00:00Z" },
      ];
      await client.call("models.scan");

      const list3 = await client.call<any>("models.list");
      const llama8b3 = list3.models.find((m: any) => m.id === "example-llama:8b");
      assert.ok(llama8b3);
      assert.equal(llama8b3.status, "available");
      assert.equal(llama8b3.displayName, "My Llama 8B");
    } finally {
      if (client) await client.close();
      await core.stop();
      await endpoint.close();
    }
  });

  it("models.list, models.scan and jobs.run('models.scan') agree", async () => {
    const endpoint = await startFakeEndpoint((req) => {
      if (req.url === "/v1/models") {
        return { status: 200, json: { data: [{ id: "example-chat-large" }, { id: "example-chat-small" }] } };
      }
      return { status: 404 };
    });

    const home = newHome(endpoint.port);
    const profiles = new InMemoryProfileSource([
      { id: "example-compat", vendor: "example-vendor", discovery: "openai-models", baseUrl: `${endpoint.origin}/v1` },
    ]);
    const credentials = new StaticCredentialResolver({
      "example-compat": { origin: endpoint.origin, headerName: "Authorization", headerValue: "Bearer token" },
    });

    const core = createCore({
      home,
      testInternals: flatTestInternals(),
      discovery: { profiles, credentials, scheduler: false },
    });

    let client: CoreClient | undefined;
    try {
      await core.start();
      client = await connect({ address: core.address, token: core.token });

      // Run models.scan
      const scan = await client.call<any>("models.scan");
      const scanIds = scan.providers[0].new;

      // Run models.list
      const list = await client.call<any>("models.list");
      const listIds = list.models.map((m: any) => m.id).sort();
      assert.deepEqual(listIds, [...scanIds].sort());

      // Run jobs.run({ job: "models.scan" })
      const jobRun = await client.call<any>("jobs.run", { job: "models.scan" });
      assert.equal(jobRun.job, "models.scan");
      assert.equal(jobRun.trigger, "manual");

      // Verify ledger has completed records, both with trigger "manual"
      const ledgerPath = join(layout(home).systemJobs, "ledger.jsonl");
      const ledgerLines = readFileSync(ledgerPath, "utf8").trim().split("\n").filter(Boolean);
      const completedRows = ledgerLines.map((l) => JSON.parse(l)).filter((r) => r.phase === "finished");
      assert.equal(completedRows.length, 2);
      for (const row of completedRows) {
        assert.equal(row.job, "models.scan");
        assert.equal(row.trigger, "manual");
      }
    } finally {
      if (client) await client.close();
      await core.stop();
      await endpoint.close();
    }
  });

  it("models.changed and the three D111-shaped events arrive with the specified levels", async () => {
    let models = [{ id: "example-chat-large" }, { id: "example-chat-small" }];
    let shouldFail = false;

    const endpoint = await startFakeEndpoint((req) => {
      if (shouldFail) return { status: 500 };
      if (req.url === "/v1/models") {
        return { status: 200, json: { data: models } };
      }
      return { status: 404 };
    });

    // Configure modelRoles.chat pointing to example-compat/example-chat-small
    const home = newHome(endpoint.port, (cfg) => {
      cfg.modelRoles = { chat: "example-compat/example-chat-small" };
    });
    const profiles = new InMemoryProfileSource([
      { id: "example-compat", vendor: "example-vendor", discovery: "openai-models", baseUrl: `${endpoint.origin}/v1` },
    ]);
    const credentials = new StaticCredentialResolver({
      "example-compat": { origin: endpoint.origin, headerName: "Authorization", headerValue: "Bearer token" },
    });

    const logCalls: { level: string; msg: string; fields?: any }[] = [];
    const loggerSpy = {
      debug(msg: string, fields?: object) { logCalls.push({ level: "debug", msg, fields }); },
      info(msg: string, fields?: object) { logCalls.push({ level: "info", msg, fields }); },
      warn(msg: string, fields?: object) { logCalls.push({ level: "warn", msg, fields }); },
      error(msg: string, fields?: object) { logCalls.push({ level: "error", msg, fields }); },
    };
    const events = createLoggerEvents(loggerSpy);

    const core = createCore({
      home,
      testInternals: flatTestInternals(),
      discovery: { profiles, credentials, events, scheduler: false },
    });

    let client: CoreClient | undefined;
    try {
      await core.start();
      client = await connect({ address: core.address, token: core.token });

      const changedEvents: any[] = [];
      client.onNotification((method, params) => {
        if (method === "models.changed") changedEvents.push(params);
      });
      await client.call("events.subscribe", {});

      // 1. Initial scan: model.discovered logged at info level
      await client.call("models.scan");
      await new Promise((r) => setTimeout(r, 50));
      assert.ok(changedEvents.length >= 1);
      const discLog = logCalls.find((c) => c.msg === "model.discovered");
      assert.ok(discLog);
      assert.equal(discLog.level, "info");

      // 2. Removal of example-chat-large (not in modelRoles): model.unavailable logged at info
      models = [{ id: "example-chat-small" }];
      await client.call("models.scan");
      const unavailInfo = logCalls.find((c) => c.msg === "model.unavailable" && c.level === "info");
      assert.ok(unavailInfo);

      // 3. Removal of example-chat-small (named by modelRoles.chat): model.unavailable logged at warn
      models = [{ id: "example-chat-large" }];
      await client.call("models.scan");
      const unavailWarn = logCalls.find((c) => c.msg === "model.unavailable" && c.level === "warn");
      assert.ok(unavailWarn, "warn logged when modelRoles.chat names removed model");
      assert.deepEqual(unavailWarn.fields?.roles, ["chat"]);

      // 4. Failing scan (network/server): scan.failed logged at warn
      shouldFail = true;
      await client.call("models.scan");
      const failWarn = logCalls.find((c) => c.msg === "model.scan.failed");
      assert.ok(failWarn);
      assert.equal(failWarn.level, "warn");
    } finally {
      if (client) await client.close();
      await core.stop();
      await endpoint.close();
    }
  });

  it("stopping the mock gives failed:network and leaves the catalog unchanged", async () => {
    const endpoint = await startFakeEndpoint((req) => {
      if (req.url === "/v1/models") {
        return { status: 200, json: { data: [{ id: "example-chat-large" }, { id: "example-chat-small" }] } };
      }
      return { status: 404 };
    });

    const home = newHome(endpoint.port);
    const profiles = new InMemoryProfileSource([
      { id: "example-compat", vendor: "example-vendor", discovery: "openai-models", baseUrl: `${endpoint.origin}/v1` },
    ]);
    const credentials = new StaticCredentialResolver({
      "example-compat": { origin: endpoint.origin, headerName: "Authorization", headerValue: "Bearer token" },
    });

    const core = createCore({
      home,
      testInternals: flatTestInternals(),
      discovery: { profiles, credentials, scheduler: false },
    });

    let client: CoreClient | undefined;
    try {
      await core.start();
      client = await connect({ address: core.address, token: core.token });

      // Scan initial models
      await client.call("models.scan");
      const listBefore = await client.call<any>("models.list");
      assert.equal(listBefore.models.length, 2);

      // Stop mock
      await endpoint.close();

      // Scan again -> failed:network
      const scanAfter = await client.call<any>("models.scan");
      assert.equal(scanAfter.providers[0].result, "failed:network");

      // List is unchanged
      const listAfter = await client.call<any>("models.list");
      assert.deepEqual(listAfter.models, listBefore.models);
    } finally {
      if (client) await client.close();
      await core.stop();
    }
  });

  it("a role at a vanished model keeps modelRoles byte-identical", async () => {
    let models = [{ id: "example-chat-large" }, { id: "example-chat-small" }];
    const endpoint = await startFakeEndpoint((req) => {
      if (req.url === "/v1/models") {
        return { status: 200, json: { data: models } };
      }
      return { status: 404 };
    });

    const home = newHome(endpoint.port);
    const cfgPath = layout(home).configPath;
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    cfg.modelRoles = { chat: "example-compat/example-chat-small" };
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
    const configBytesBefore = readFileSync(cfgPath);

    const profiles = new InMemoryProfileSource([
      { id: "example-compat", vendor: "example-vendor", discovery: "openai-models", baseUrl: `${endpoint.origin}/v1` },
    ]);
    const credentials = new StaticCredentialResolver({
      "example-compat": { origin: endpoint.origin, headerName: "Authorization", headerValue: "Bearer token" },
    });

    const core = createCore({
      home,
      testInternals: flatTestInternals(),
      discovery: { profiles, credentials, scheduler: false },
    });

    let client: CoreClient | undefined;
    try {
      await core.start();
      client = await connect({ address: core.address, token: core.token });

      // Initial scan with both models present
      await client.call("models.scan");

      // Vanish model and scan again
      models = [{ id: "example-chat-large" }];
      await client.call("models.scan");

      const list = await client.call<any>("models.list");
      assert.ok(list.warnings.length > 0);

      // Verify config.json bytes are identical
      const configBytesAfter = readFileSync(cfgPath);
      assert.deepEqual(configBytesAfter, configBytesBefore);
    } finally {
      if (client) await client.close();
      await core.stop();
      await endpoint.close();
    }
  });

  it("filesystem spy: nothing outside the harness home is opened", async () => {
    const endpoint = await startFakeEndpoint((req) => {
      if (req.url === "/v1/models") {
        return { status: 200, json: { data: [{ id: "example-chat-large" }, { id: "example-chat-small" }] } };
      }
      return { status: 404 };
    });

    const home = newHome(endpoint.port);
    const realHome = realpathSync(home);
    const profiles = new InMemoryProfileSource([
      { id: "example-compat", vendor: "example-vendor", discovery: "openai-models", baseUrl: `${endpoint.origin}/v1` },
    ]);
    const credentials = new StaticCredentialResolver({
      "example-compat": { origin: endpoint.origin, headerName: "Authorization", headerValue: "Bearer token" },
    });

    const core = createCore({
      home,
      testInternals: flatTestInternals(),
      discovery: { profiles, credentials, scheduler: false },
    });

    let client: CoreClient | undefined;
    try {
      await core.start();
      client = await connect({ address: core.address, token: core.token });

      // Surface F2: wait for quiescence (engine.ready and warm-up done) before arming spies (with 10s deadline)
      const waitDeadline = Date.now() + 10_000;
      while (true) {
        if (Date.now() > waitDeadline) {
          throw new Error("timed out waiting for engine.ready and process.state ready");
        }
        const st = (await client.call("core.status", {})) as any;
        if (st.engine?.ready && st.process?.state === "ready") break;
        await new Promise((r) => setTimeout(r, 20));
      }

      function isSubpath(parent: string, child: string): boolean {
        const rel = relative(parent, child);
        return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
      }

      // Assert sibling paths such as <home>-other are rejected
      assert.equal(isSubpath(home, `${home}-other`), false);
      assert.equal(isSubpath(realHome, `${realHome}-other`), false);
      assert.equal(isSubpath(home, join(home, "child")), true);

      const projectRoot = realpathSync(resolve(fileURLToPath(import.meta.url), "../../../../.."));

      // Spy setup: wrap sync fs functions
      const targets = [
        "openSync", "readFileSync", "writeFileSync", "appendFileSync",
        "mkdirSync", "renameSync", "copyFileSync", "readdirSync",
        "statSync", "existsSync", "rmSync"
      ] as const;

      const originals: Partial<Record<keyof typeof fs, any>> = {};
      const outsidePaths: string[] = [];
      let inHomeCalls = 0;
      let spyActive = false;

      const check = (rawP: unknown) => {
        if (!spyActive) return;
        if (typeof rawP !== "string") return;
        let p = rawP;
        // Windows securePath (ruling S11) dumps the DACL it just set with `icacls /save` into a scratch dir under the OS
        // temp dir (module-api secure-path.ts) and removes it again; it holds an ACL listing, never user data.
        if (process.platform === "win32" && /[\\/]p1b-acl-[^\\/]+(?:[\\/]|$)/.test(p)) return;
        if (p.startsWith("/proc/self/fd/")) {
          try {
            p = fs.readlinkSync(p);
          } catch {}
        }
        if (isSubpath(realHome, p) || isSubpath(home, p)) {
          inHomeCalls++;
        } else if (isSubpath(projectRoot, p)) {
          // Internal repository source/package files loaded during execution
          return;
        } else {
          outsidePaths.push(rawP);
        }
      };

      for (const fn of targets) {
        originals[fn] = (fs as any)[fn];
        (fs as any)[fn] = (...args: any[]) => {
          check(args[0]);
          if (fn === "renameSync" || fn === "copyFileSync") check(args[1]);
          return originals[fn](...args);
        };
      }
      syncBuiltinESMExports();

      try {
        spyActive = true;
        // Run full scenario
        await client.call("models.scan");
        await client.call("models.list");
        await client.call("models.setOverride", {
          provider: "example-compat",
          id: "example-chat-small",
          set: { displayName: "Overridden" },
        });
        await client.call("models.list");
      } finally {
        spyActive = false;
        for (const fn of targets) {
          (fs as any)[fn] = originals[fn];
        }
        syncBuiltinESMExports();
      }

      assert.ok(inHomeCalls > 0, `spy must observe at least one in-home filesystem access (got ${inHomeCalls})`);
      assert.deepEqual(outsidePaths, [], `Paths outside home were opened: ${outsidePaths.join(", ")}`);
    } finally {
      if (client) await client.close();
      await core.stop();
      await endpoint.close();
    }
  });

  it("network spy: requests go only to configured base URLs, no process is spawned", async () => {
    const endpoint = await startFakeEndpoint((req) => {
      if (req.url === "/v1/models") {
        return { status: 200, json: { data: [{ id: "example-chat-large" }, { id: "example-chat-small" }] } };
      }
      return { status: 404 };
    });

    const home = newHome(endpoint.port);
    const realHome = realpathSync(home);
    const profiles = new InMemoryProfileSource([
      { id: "example-compat", vendor: "example-vendor", discovery: "openai-models", baseUrl: `${endpoint.origin}/v1` },
    ]);
    const credentials = new StaticCredentialResolver({
      "example-compat": { origin: endpoint.origin, headerName: "Authorization", headerValue: "Bearer token" },
    });

    const core = createCore({
      home,
      testInternals: flatTestInternals(),
      discovery: { profiles, credentials, scheduler: false },
    });

    let client: CoreClient | undefined;
    try {
      await core.start();
      client = await connect({ address: core.address, token: core.token });

      const targets = new Set<string>();
      let spawnCount = 0;

      const origHttpRequest = http.request;
      const origHttpsRequest = https.request;
      const origConnect = net.Socket.prototype.connect;
      const origSpawn = childProcess.spawn;
      const origExec = childProcess.exec;
      const origExecFile = childProcess.execFile;
      const origFork = childProcess.fork;

      (http as any).request = function (...args: any[]) {
        const opt = typeof args[0] === "string" ? new URL(args[0]) : args[0];
        const host = opt.host ?? `${opt.hostname}:${opt.port}`;
        targets.add(host);
        return origHttpRequest.apply(this, args as any);
      };
      (https as any).request = function (...args: any[]) {
        const opt = typeof args[0] === "string" ? new URL(args[0]) : args[0];
        const host = opt.host ?? `${opt.hostname}:${opt.port}`;
        targets.add(host);
        return origHttpsRequest.apply(this, args as any);
      };
      net.Socket.prototype.connect = function (...args: any[]) {
        const opt = args[0];
        if (typeof opt === "string") targets.add(opt);
        else if (typeof opt === "object" && opt !== null) {
          if (opt.path) targets.add(opt.path);
          else if (opt.port) targets.add(`${opt.host ?? "localhost"}:${opt.port}`);
        }
        return origConnect.apply(this, args as any);
      };
      (childProcess as any).spawn = function (...args: any[]) { spawnCount++; return origSpawn.apply(this, args as any); };
      (childProcess as any).exec = function (...args: any[]) { spawnCount++; return origExec.apply(this, args as any); };
      (childProcess as any).execFile = function (...args: any[]) { spawnCount++; return origExecFile.apply(this, args as any); };
      (childProcess as any).fork = function (...args: any[]) { spawnCount++; return origFork.apply(this, args as any); };
      syncBuiltinESMExports();

      try {
        await client.call("models.scan");
        await client.call("models.list");
      } finally {
        http.request = origHttpRequest;
        https.request = origHttpsRequest;
        net.Socket.prototype.connect = origConnect;
        childProcess.spawn = origSpawn;
        childProcess.exec = origExec;
        childProcess.execFile = origExecFile;
        childProcess.fork = origFork;
        syncBuiltinESMExports();
      }

      assert.equal(spawnCount, 0, "No child processes should be spawned during model discovery");
      assert.ok(targets.size > 0, "network spy must observe at least one network target");
      for (const t of targets) {
        assert.ok(
          t === `127.0.0.1:${endpoint.port}` || t.startsWith(home) || t.startsWith(realHome),
          `Unexpected network target: ${t}`
        );
      }
    } finally {
      if (client) await client.close();
      await core.stop();
      await endpoint.close();
    }
  });

  it("canaries (ADR-005 action 8, extended)", async () => {
    const CANARY_KEY = "CANARY-KEY-1";
    const CANARY_TOKEN = "Bearer CANARY-TOKEN-2";
    const CANARY_URL = "https://auth.example.invalid/authorize?code=CANARY-URL-3";
    const CANARY_SUCCESS_TOKEN = "CANARY-SUCCESS-TOKEN-4";
    const CANARY_INVALID_ID = "CANARY-INVALID-ID-5";
    const CANARY_RESOLVER_SECRET = "CANARY-RESOLVER-SECRET-6";
    const CANARY_RPC_PARAM = "CANARY-RPC-PARAM-7";

    const endpoint = await startFakeEndpoint((req) => {
      if (req.url === "/v1/canary-401/models") {
        return {
          status: 401,
          headers: { "WWW-Authenticate": `Bearer error="invalid_token", error_description="${CANARY_URL}"` },
          json: { error: "unauthorized", canary_url: CANARY_URL },
        };
      }
      if (req.url === "/v1/canary-success/models") {
        return {
          status: 200,
          json: { data: [{ id: "example-chat-valid" }] },
        };
      }
      if (req.url === "/v1/canary-invalid/models") {
        return {
          status: 200,
          json: { data: [{ id: `${CANARY_INVALID_ID} with spaces and \x00 control` }] },
        };
      }
      return { status: 404 };
    });

    const home = newHome(endpoint.port);
    const profiles = new InMemoryProfileSource([
      { id: "canary-prof", vendor: "example-vendor", discovery: "openai-models", baseUrl: `${endpoint.origin}/v1/canary-401` },
      { id: "canary-success", vendor: "example-vendor", discovery: "openai-models", baseUrl: `${endpoint.origin}/v1/canary-success` },
      { id: "canary-invalid", vendor: "example-vendor", discovery: "openai-models", baseUrl: `${endpoint.origin}/v1/canary-invalid` },
      { id: "canary-throw", vendor: "example-vendor", discovery: "openai-models", baseUrl: `${endpoint.origin}/v1/canary-success` },
    ]);
    const staticCreds = new StaticCredentialResolver({
      "canary-prof": { origin: endpoint.origin, headerName: CANARY_KEY, headerValue: CANARY_TOKEN },
      "canary-success": { origin: endpoint.origin, headerName: "Authorization", headerValue: `Bearer ${CANARY_SUCCESS_TOKEN}` },
      "canary-invalid": { origin: endpoint.origin, headerName: "Authorization", headerValue: "Bearer token" },
    });
    const credentials: CredentialResolver = {
      resolve: async (p, origin) => {
        if (p === "canary-throw") {
          throw new Error(`Credential resolver failure containing ${CANARY_RESOLVER_SECRET}`);
        }
        return staticCreds.resolve(p, origin);
      },
    };

    const core = createCore({
      home,
      testInternals: flatTestInternals(),
      discovery: { profiles, credentials, scheduler: false },
    });

    let client: CoreClient | undefined;
    try {
      await core.start();
      client = await connect({ address: core.address, token: core.token });

      const replies: string[] = [];
      const scan = await client.call("models.scan");
      replies.push(JSON.stringify(scan));

      const list = await client.call("models.list");
      replies.push(JSON.stringify(list));

      const jobRun = await client.call("jobs.run", { job: "models.scan" });
      replies.push(JSON.stringify(jobRun));

      let threwRpcError = false;
      try {
        await client.call("models.setOverride", {
          provider: "canary-prof",
          id: "example-chat-valid",
          set: { displayName: CANARY_RPC_PARAM },
          clear: ["invalid_key_causes_rpc_error" as any],
        });
      } catch (err) {
        threwRpcError = true;
        replies.push(JSON.stringify(err));
      }
      assert.ok(threwRpcError, "expected models.setOverride to throw an RPC error");

      const filesToCheck = [
        join(home, "logs", "core.log"),
        join(home, "catalog", "models.json"),
        join(home, "catalog", "models.json.prev"),
        join(layout(home).systemJobs, "ledger.jsonl"),
      ];

      const allCanaries = [
        CANARY_KEY,
        "CANARY-TOKEN-2",
        "CANARY-URL-3",
        CANARY_SUCCESS_TOKEN,
        CANARY_INVALID_ID,
        CANARY_RESOLVER_SECRET,
        CANARY_RPC_PARAM,
      ];

      for (const canary of allCanaries) {
        for (const reply of replies) {
          assert.equal(reply.includes(canary), false, `Canary ${canary} leaked into RPC reply: ${reply}`);
        }
        for (const f of filesToCheck) {
          if (fs.existsSync(f)) {
            const content = readFileSync(f, "utf8");
            assert.equal(content.includes(canary), false, `Canary ${canary} leaked into ${f}`);
          }
        }
      }

      // Positive controls: verify files actually contain recorded activity
      const logContent = readFileSync(join(home, "logs", "core.log"), "utf8");
      assert.ok(logContent.includes("model.scan.failed"), "core.log should contain scan failure events");
      const catContent = readFileSync(join(home, "catalog", "models.json"), "utf8");
      assert.ok(catContent.includes("example-chat-valid"), "models.json should contain successful scan model");
    } finally {
      if (client) await client.close();
      await core.stop();
      await endpoint.close();
    }
  });
});
