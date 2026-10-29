/** Browser interaction tests use real HTTP, session CSRF and canonical source metadata; native maintenance is tested separately. */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { SOURCE_CATALOG } from "../../core/src/import/types.ts";
import { openRoute, setup, teardown, withApp, type App } from "./harness.ts";
import { expectAxeClean } from "./axe.ts";
import type { MockHarnessServer } from "./mock-server.ts";
import type { ImportRun } from "../../rpc-schema/generated/types.ts";
import type { ImportSourcesResult } from "../../api/src/import-routes.ts";
import { MODEL_CHOICES } from "../src/pages/setup/licences.ts";

before(setup);
after(teardown);
const sourceId = "12345678-1234-4123-8123-123456789011",
  planId = "12345678-1234-4123-8123-123456789012",
  runId = "12345678-1234-4123-8123-123456789013",
  ticket = "12345678-1234-4123-8123-123456789014";
/** Discovery starts at a configured, trusted remote root; choosing a result is a separate normal inspect call. */
async function findRemoteSources(app: App): Promise<void> {
  app.server.rpc.handle(
    "admin.import.ssh.connections.list",
    () => ({
      connections: [
        {
          id: "known-source",
          host: "source.example",
          port: 22,
          user: "reader",
          roots: ["/"],
          allowPrivate: false,
          hostKey: { sha256: `SHA256:${"A".repeat(43)}` },
        },
      ],
    }),
    { write: false },
  );
  await openRoute(app.page, "#/import");
  await app.page.getByLabel("Source format").selectOption(SOURCE_CATALOG[0]!.id);
  await app.page.getByLabel("Source location").selectOption("ssh");
  await app.page.getByLabel("Source folder", { exact: true }).fill("/");
  await app.page.getByLabel("Configured SSH connection", { exact: true }).selectOption("known-source");
  await app.page.getByRole("button", { name: "Find installations", exact: true }).click();
}
function seed(
  server: MockHarnessServer,
  catalog: ImportSourcesResult = { sources: SOURCE_CATALOG, hostPathsAllowed: true },
): ImportRun {
  server.extensions.push((_req, res, path) => {
    if (path !== "/api/v1/import/sources") return false;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(catalog));
    return true;
  });
  const counts = { agents: 2, skills: 2, memories: 3, stores: 1, channels: 0, extensions: 1, secrets: 0 };
  const run: ImportRun = {
    runId,
    planId,
    sourceType: SOURCE_CATALOG[0]!.id,
    state: "applying",
    attempt: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    restored: false,
    resumable: false,
    rollbackAvailable: false,
    progress: { runId, phase: "apply", completed: 1, total: 3 },
  };
  server.rpc.handle("admin.import.detect", (params) => {
    assert.deepEqual(params, { source: { kind: "auto", family: SOURCE_CATALOG[0]!.id } });
    return {
      sourceId,
      sourceType: run.sourceType,
      sourceSha256: "a".repeat(64),
      expiresAt: "2099-01-01T00:00:00Z",
      counts,
      agents: [
        {
          id: "one",
          displayName: "Agent One",
          hasPersona: true,
          files: 3,
          skills: 2,
          plugins: 0,
          mcpServers: 1,
          stores: 1,
          channels: 0,
        },
        {
          id: "two",
          displayName: "Agent Two",
          hasPersona: false,
          files: 1,
          skills: 0,
          plugins: 0,
          mcpServers: 0,
          stores: 0,
          channels: 0,
        },
      ],
      plugins: [{ id: "plugin", name: "Source plugin", classification: "nonportable", reason: "runtime-api" }],
      mcpServers: [{ id: "mcp", name: "Source MCP", transport: "http", enabled: false, needsSetup: true }],
      unsupported: ["cron", "sessions"],
      warnings: [],
    };
  });
  server.rpc.handle("admin.import.plan", (params) => {
    const value = params as { sourceId: string; options: { agentIds: string[]; migrateSecrets: boolean } };
    assert.equal(value.sourceId, sourceId);
    assert.deepEqual(value.options.agentIds, ["one"]);
    assert.equal(value.options.migrateSecrets, false);
    return {
      planId,
      runId,
      sourceType: run.sourceType,
      sourceSha256: "a".repeat(64),
      planSha256: "b".repeat(64),
      expiresAt: "2099-01-01T00:00:00Z",
      counts,
      conflicts: [],
      warnings: [],
      requiresSecretOwner: false,
    };
  });
  server.rpc.handle("admin.import.preflight", () => ({
    planId,
    runId,
    ok: true,
    preflightId: ticket,
    expiresAt: "2099-01-01T00:00:00Z",
    issues: [],
    estimatedDowntimeMs: 500,
    requiredBytes: 100,
    availableBytes: 1000,
    automaticRollback: true,
  }));
  server.rpc.handle("admin.import.apply", (params) => {
    assert.deepEqual(params, { planId, preflightId: ticket });
    return { runId, state: "queued" };
  });
  server.rpc.handle("admin.import.status", () => ({ run }), { write: false });
  server.rpc.handle("admin.import.runs", () => ({ runs: [run] }), { write: false });
  server.rpc.handle("admin.import.abort", () => {
    run.state = "aborted";
    run.restored = true;
    return { runId, accepted: true, state: "rolling-back" };
  });
  return run;
}

test("source summary, selected agents and immutable preview precede explicit downtime consent; cancellation waits for restoration", async () => {
  await withApp({}, async (app) => {
    seed(app.server);
    await openRoute(app.page, "#/import");
    await app.page.getByLabel("Source format").selectOption(SOURCE_CATALOG[0]!.id);
    await app.page.getByRole("button", { name: "Inspect source", exact: true }).click();
    await app.page.getByRole("heading", { name: "Source summary", exact: true }).waitFor();
    await app.page.getByLabel(/^Agent Two/).uncheck();
    await app.page.getByRole("button", { name: "Create preview", exact: true }).click();
    await app.page.getByRole("heading", { name: "Immutable import preview", exact: true }).waitFor();
    assert.equal(app.server.rpc.calls.filter((call) => call.method === "admin.import.apply").length, 0);
    await app.page.getByRole("button", { name: "Run preflight", exact: true }).click();
    await app.page.getByText(/^Preflight passed\./).waitFor();
    assert.equal(await app.page.getByRole("button", { name: "Apply import", exact: true }).isDisabled(), true);
    await app.page.getByLabel(/^I accept stopping the Core/).check();
    await app.page.getByRole("button", { name: "Apply import", exact: true }).click();
    await app.page.getByText("Applying import", { exact: true }).waitFor();
    await app.page.getByRole("button", { name: "Cancel and restore snapshot", exact: true }).click();
    await app.page.getByText("Cancelled and restored", { exact: true }).waitFor();
    await app.page.getByText("The target snapshot was restored.", { exact: true }).waitFor();
    assert.equal(app.server.rpc.calls.filter((call) => call.method === "admin.import.apply").length, 1);
    await expectAxeClean(app.page, "import restored after explicit cancellation");
    assert.deepEqual(app.problems, []);
  });
});

test("Member invokes no import metadata/RPC; remote Admin cannot choose a free host path", async () => {
  await withApp({ server: { role: "member" } }, async (app) => {
    seed(app.server);
    await openRoute(app.page, "#/import");
    await app.page.locator('[data-state="forbidden"]').waitFor();
    assert.equal(app.server.requests.filter((value) => value.url === "/api/v1/import/sources").length, 0);
    assert.equal(app.server.rpc.calls.filter((value) => value.method.startsWith("admin.import.")).length, 0);
  });
  await withApp({ server: { role: "admin" } }, async (app) => {
    seed(app.server, { sources: SOURCE_CATALOG, hostPathsAllowed: false });
    await openRoute(app.page, "#/import");
    await app.page.getByLabel("Source location").waitFor();
    assert.equal(await app.page.locator('#import-mode option[value="path"]').isDisabled(), true);
    assert.equal(await app.page.locator('#import-mode option[value="wsl"]').isDisabled(), true);
    await expectAxeClean(app.page, "remote Admin import source picker");
  });
});

test("discovery is a source choice and cannot be mistaken for an inspected source or import plan", async () => {
  await withApp({}, async (app) => {
    const run = seed(app.server),
      source = { kind: "snapshot", family: run.sourceType, snapshotId: "S".repeat(43) };
    app.server.rpc.handle("admin.import.detect", (params) => {
      if ((params as { discover?: boolean }).discover === true)
        return {
          discovery: true,
          candidates: [{ id: "choice", source, displayName: "Detected source" }],
          warnings: [],
        };
      assert.deepEqual(params, { source });
      return {
        sourceId,
        sourceType: run.sourceType,
        sourceSha256: "a".repeat(64),
        expiresAt: "2099-01-01T00:00:00Z",
        counts: { agents: 0, skills: 0, memories: 0, stores: 0, channels: 0, extensions: 0, secrets: 0 },
        agents: [],
        plugins: [],
        mcpServers: [],
        unsupported: [],
        warnings: [],
      };
    });
    await findRemoteSources(app);
    const discoveryCall = app.server.rpc.calls.find((call) => call.method === "admin.import.detect");
    assert.deepEqual(discoveryCall?.params, {
      discover: true,
      source: { kind: "ssh", family: SOURCE_CATALOG[0]!.id, connectionId: "known-source", path: "/" },
    });
    await app.page.getByRole("heading", { name: "Detected installations", exact: true }).waitFor();
    assert.equal(await app.page.getByRole("button", { name: "Create preview", exact: true }).count(), 0);
    await app.page.getByRole("button", { name: "Detected source", exact: true }).click();
    await app.page.getByRole("heading", { name: "Source summary", exact: true }).waitFor();
    assert.equal(app.server.rpc.calls.filter((call) => call.method === "admin.import.plan").length, 0);
  });
});

test("an authorized apply survives reload when its first status request is interrupted", async () => {
  await withApp({}, async (app) => {
    const run = seed(app.server);
    let unavailable = true;
    app.server.rpc.handle(
      "admin.import.status",
      () => {
        if (unavailable) throw { error: "E_NOT_AVAILABLE", message: "Core restarting" };
        return { run };
      },
      { write: false },
    );
    await openRoute(app.page, "#/import");
    await app.page.getByLabel("Source format").selectOption(SOURCE_CATALOG[0]!.id);
    await app.page.getByRole("button", { name: "Inspect source", exact: true }).click();
    await app.page.getByLabel(/^Agent Two/).uncheck();
    await app.page.getByRole("button", { name: "Create preview", exact: true }).click();
    await app.page.getByRole("button", { name: "Run preflight", exact: true }).click();
    await app.page.getByLabel(/^I accept stopping the Core/).check();
    await app.page.getByRole("button", { name: "Apply import", exact: true }).click();
    await app.page.waitForFunction(
      (id) =>
        Object.keys(sessionStorage).some(
          (key) => key.startsWith("p1x.import.") && JSON.parse(sessionStorage.getItem(key) ?? "null")?.runId === id,
        ),
      runId,
    );
    unavailable = false;
    await app.page.reload();
    await app.page.getByText("Applying import", { exact: true }).waitFor();
    assert.equal(app.server.rpc.calls.filter((call) => call.method === "admin.import.apply").length, 1);
    assert.ok(app.server.rpc.calls.filter((call) => call.method === "admin.import.status").length >= 2);
  });
});

for (const lang of ["en", "de"] as const)
  for (const state of ["loading", "empty", "error", "forbidden", "unavailable"] as const) {
    test(`import axe: ${state}, ${lang}`, async () => {
      await withApp({ locale: lang === "de" ? "de-DE" : "en-US" }, async (app) => {
        let release: (() => void) | undefined;
        app.server.extensions.push((_req, res, path) => {
          if (path !== "/api/v1/import/sources") return false;
          if (state === "loading")
            return new Promise<boolean>((resolve) => {
              release = () => {
                res
                  .writeHead(200, { "content-type": "application/json" })
                  .end(JSON.stringify({ sources: SOURCE_CATALOG, hostPathsAllowed: true }));
                resolve(true);
              };
            });
          const status = state === "empty" ? 200 : state === "forbidden" ? 403 : state === "unavailable" ? 503 : 500;
          res.writeHead(status, { "content-type": "application/json" }).end(
            JSON.stringify(
              status === 200
                ? { sources: [], hostPathsAllowed: true }
                : {
                    schema: "error/1",
                    error: status === 403 ? "E_DENIED" : "E_NOT_AVAILABLE",
                    message: "fixture failure",
                  },
            ),
          );
          return true;
        });
        try {
          await openRoute(app.page, "#/import", lang);
          await app.page.locator(`[data-state="${state}"]`).first().waitFor();
          await expectAxeClean(app.page, `import ${state} ${lang}`);
        } finally {
          release?.();
        }
      });
    });
  }

test("Owner SSH setup requires exact endpoint policy consent and independent host-key verification; Admin invokes no Owner setup methods", async () => {
  await withApp({}, async (app) => {
    seed(app.server);
    const connection = {
      id: "source",
      host: "source.example",
      port: 2222,
      user: "reader",
      roots: ["/source"],
      allowPrivate: false,
    };
    let connections: (typeof connection)[] = [];
    let policy = {
      revision: "r1",
      value: { allowHosts: ["provider.example"], allowPorts: [443], allowLoopback: false },
    };
    const instructions = 'restrict,command="/usr/lib/openssh/sftp-server -R" ssh-ed25519 PUBLIC-FIXTURE';
    app.server.rpc.handle("admin.import.ssh.connections.list", () => ({ connections }), { write: false });
    app.server.rpc.handle(
      "admin.import.ssh.key.status",
      () => ({
        configured: true,
        publicKey: "ssh-ed25519 PUBLIC-FIXTURE",
        fingerprint: `SHA256:${"K".repeat(43)}`,
        instructions,
      }),
      { write: false },
    );
    app.server.rpc.handle(
      "config.get",
      (params) => {
        assert.deepEqual(params, { key: "egress" });
        return policy;
      },
      { write: false },
    );
    app.server.rpc.handle("config.set", (params) => {
      assert.deepEqual(params, {
        ifRevision: "r1",
        changes: [
          { key: "egress.allowHosts", value: ["provider.example", "source.example"] },
          { key: "egress.allowPorts", value: [443, 2222] },
        ],
      });
      policy = {
        revision: "r2",
        value: { ...policy.value, allowHosts: ["provider.example", "source.example"], allowPorts: [443, 2222] },
      };
      return {
        applied: true,
        dryRun: false,
        revision: "r2",
        changed: ["egress.allowHosts", "egress.allowPorts"],
        restart: { live: ["egress.allowHosts", "egress.allowPorts"], core: false, modules: [] },
        restarted: [],
        durationMs: 1,
      };
    });
    app.server.rpc.handle("admin.import.ssh.connections.set", (params) => {
      assert.deepEqual(params, { connection });
      connections = [connection];
      return { connection };
    });
    const probe = {
      connectionId: "source",
      probeId: "P".repeat(43),
      hostKeySha256: `SHA256:${"A".repeat(43)}`,
      hostKeyAlgorithm: "ssh-ed25519",
      changed: false,
    };
    app.server.rpc.handle("admin.import.ssh.hostKey.probe", (params) => {
      assert.deepEqual(params, { id: "source" });
      return probe;
    });
    app.server.rpc.handle("admin.import.ssh.hostKey.trust", (params) => {
      assert.deepEqual(params, { connectionId: "source", probeId: "P".repeat(43), hostKeySha256: probe.hostKeySha256 });
      return {
        connection: { ...connection, hostKey: { sha256: probe.hostKeySha256, algorithm: probe.hostKeyAlgorithm } },
      };
    });
    await openRoute(app.page, "#/import");
    await app.page.getByLabel("Source location").selectOption("ssh");
    await app.page.getByRole("button", { name: "Configure SSH access", exact: true }).waitFor();
    assert.equal(
      app.server.rpc.calls.some(
        (call) => call.method === "admin.import.ssh.key.status" || call.method === "config.get",
      ),
      false,
    );
    await app.page.getByRole("button", { name: "Configure SSH access", exact: true }).click();
    await app.page.getByLabel("Connection ID", { exact: true }).fill(connection.id);
    await app.page.getByLabel("Exact SSH hostname or IP address", { exact: true }).fill(connection.host);
    await app.page.getByLabel("SSH port", { exact: true }).fill(String(connection.port));
    await app.page.getByLabel("SSH account", { exact: true }).fill(connection.user);
    await app.page.getByLabel("Permitted remote roots (one absolute path per line)", { exact: true }).fill("/source");
    assert.equal(await app.page.locator('[data-ssh="readonly-instructions"]').textContent(), instructions);
    const save = app.page.getByRole("button", { name: "Save policy and connection", exact: true });
    assert.equal(await save.isDisabled(), true);
    await app.page
      .getByLabel("I approve adding the displayed exact host and port to the central egress policy.", { exact: true })
      .check();
    await app.page.getByLabel("SSH port", { exact: true }).fill("22");
    assert.equal(await save.isDisabled(), true);
    await app.page.getByLabel("SSH port", { exact: true }).fill("2222");
    await app.page
      .getByLabel("I approve adding the displayed exact host and port to the central egress policy.", { exact: true })
      .check();
    await save.click();
    await app.page.getByRole("button", { name: "Inspect host key", exact: true }).click();
    await app.page.getByText(probe.hostKeySha256, { exact: true }).waitFor();
    const trust = app.page.getByRole("button", { name: "Trust this host key", exact: true });
    assert.equal(await trust.isDisabled(), true);
    await app.page.getByLabel("I independently verified this exact host-key fingerprint.", { exact: true }).check();
    await trust.click();
    await app.page.getByText("Verify host key for source.example:2222", { exact: true }).waitFor({ state: "hidden" });
    assert.equal(app.server.rpc.calls.filter((call) => call.method === "admin.import.ssh.hostKey.trust").length, 1);
    await expectAxeClean(app.page, "Owner SSH setup after explicit endpoint and host-key approval");
    assert.deepEqual(app.problems, []);
  });
  await withApp({ server: { role: "admin" } }, async (app) => {
    seed(app.server);
    app.server.rpc.handle("admin.import.ssh.connections.list", () => ({ connections: [] }), { write: false });
    await openRoute(app.page, "#/import");
    await app.page.getByLabel("Source location").selectOption("ssh");
    await app.page.getByLabel("Configured SSH connection", { exact: true }).waitFor();
    assert.equal(await app.page.getByRole("button", { name: "Configure SSH access", exact: true }).count(), 0);
    assert.equal(
      app.server.rpc.calls.some(
        (call) =>
          call.method.startsWith("admin.import.ssh.key.") ||
          call.method === "config.get" ||
          call.method === "config.set",
      ),
      false,
    );
  });
});

test("standalone discovered store requires a source and an explicit original-path assignment, including remote Admin", async () => {
  await withApp({ server: { role: "admin" } }, async (app) => {
    const run = seed(app.server, { sources: SOURCE_CATALOG, hostPathsAllowed: false });
    const candidateId = "12345678-1234-4123-8123-123456789021";
    const storeId = "12345678-1234-4123-8123-123456789022";
    const source = { kind: "snapshot", family: run.sourceType, snapshotId: "S".repeat(43) };
    const counts = { agents: 1, skills: 0, memories: 0, stores: 0, channels: 0, extensions: 0, secrets: 0 };
    app.server.rpc.handle("admin.import.detect", (params) => {
      if ((params as { discover?: boolean }).discover === true)
        return {
          discovery: true,
          candidates: [{ id: candidateId, source, displayName: "Detected source" }],
          stores: [{ id: storeId, displayName: "Separate memory store", path: "/remote/memory-store" }],
          warnings: [],
        };
      assert.deepEqual(params, { source });
      return {
        sourceId,
        sourceType: run.sourceType,
        sourceSha256: "a".repeat(64),
        expiresAt: "2099-01-01T00:00:00Z",
        counts,
        agents: [
          {
            id: "one",
            displayName: "Agent One",
            hasPersona: false,
            files: 1,
            skills: 0,
            plugins: 0,
            mcpServers: 0,
            stores: 0,
            channels: 0,
          },
        ],
        plugins: [],
        mcpServers: [],
        stores: [{ id: "source-memory", displayName: "Source memory", kind: "shared", rows: 12 }],
        portability: { unmapped: [{ path: "/old/source-memory", kind: "store", reason: "outside-source-root" }] },
        unsupported: [],
        warnings: [],
      };
    });
    app.server.rpc.handle("admin.import.plan", (params) => {
      assert.deepEqual((params as { options: { maps: unknown } }).options.maps, [
        { from: "/old/source-memory", to: `store:${storeId}` },
      ]);
      assert.equal((params as { options: { adoptStoreId: string } }).options.adoptStoreId, "source-memory");
      return {
        planId,
        runId,
        sourceType: run.sourceType,
        sourceSha256: "a".repeat(64),
        planSha256: "b".repeat(64),
        expiresAt: "2099-01-01T00:00:00Z",
        counts,
        conflicts: [],
        warnings: [],
        requiresSecretOwner: false,
      };
    });
    await findRemoteSources(app);
    const discoveryCall = app.server.rpc.calls.find((call) => call.method === "admin.import.detect");
    assert.deepEqual(discoveryCall?.params, {
      discover: true,
      source: { kind: "ssh", family: SOURCE_CATALOG[0]!.id, connectionId: "known-source", path: "/" },
    });
    await app.page.getByText("Agent and path assignment required.", { exact: true }).waitFor();
    assert.equal(await app.page.getByRole("button", { name: "Separate memory store", exact: true }).count(), 0);
    assert.equal(
      app.server.rpc.calls.some((call) => call.method === "admin.import.plan"),
      false,
    );
    await app.page.getByRole("button", { name: "Detected source", exact: true }).click();
    await app.page.getByRole("button", { name: "Add path mapping", exact: true }).click();
    const create = app.page.getByRole("button", { name: "Create preview", exact: true });
    assert.equal(await create.isDisabled(), true);
    await app.page
      .getByLabel("External paths reported by the source", { exact: true })
      .selectOption("/old/source-memory");
    assert.equal(
      await app.page.getByLabel("Original external path declared by the source", { exact: true }).inputValue(),
      "/old/source-memory",
    );
    await app.page.getByLabel("Source store to adopt (optional)", { exact: true }).selectOption("source-memory");
    await app.page.getByLabel("Replacement read location", { exact: true }).selectOption(`store:${storeId}`);
    assert.equal(
      await app.page.getByLabel("Replacement source path accessible on the harness host", { exact: true }).count(),
      0,
    );
    await create.click();
    await app.page.getByRole("heading", { name: "Immutable import preview", exact: true }).waitFor();
    assert.equal(app.server.rpc.calls.filter((call) => call.method === "admin.import.plan").length, 1);
    await expectAxeClean(app.page, "remote Admin explicit discovered store mapping");
    assert.deepEqual(app.problems, []);
  });
});

test("a changed saved SSH endpoint cannot be mislabeled by an older connection card", async () => {
  await withApp({}, async (app) => {
    seed(app.server);
    const saved = {
      id: "source",
      host: "original.example",
      port: 22,
      user: "reader",
      roots: ["/source"],
      allowPrivate: false,
    };
    let changed = false;
    app.server.rpc.handle(
      "admin.import.ssh.connections.list",
      () => ({ connections: [{ ...saved, host: changed ? "changed.example" : saved.host }] }),
      { write: false },
    );
    app.server.rpc.handle("admin.import.ssh.key.status", () => ({ configured: false }), { write: false });
    app.server.rpc.handle(
      "config.get",
      () => ({ revision: "r1", value: { allowHosts: ["original.example", "changed.example"], allowPorts: [22] } }),
      { write: false },
    );
    app.server.rpc.handle("admin.import.ssh.hostKey.probe", () => {
      changed = true;
      return {
        connectionId: saved.id,
        probeId: "P".repeat(43),
        hostKeySha256: `SHA256:${"B".repeat(43)}`,
        changed: false,
      };
    });
    await openRoute(app.page, "#/import");
    await app.page.getByLabel("Source location").selectOption("ssh");
    await app.page.getByRole("button", { name: "Configure SSH access", exact: true }).click();
    await app.page.getByRole("button", { name: "Inspect host key", exact: true }).click();
    await app.page
      .getByRole("alert")
      .getByText(
        "The connection changed while the host key was inspected. Review the refreshed endpoint and inspect it again.",
        { exact: true },
      )
      .waitFor();
    assert.equal(await app.page.getByRole("button", { name: "Trust this host key", exact: true }).count(), 0);
    assert.equal(
      app.server.rpc.calls.some((call) => call.method === "admin.import.ssh.hostKey.trust"),
      false,
    );
    await app.page.getByText("source · reader@changed.example:22", { exact: true }).waitFor();
    assert.deepEqual(app.problems, []);
  });
});

test("container host metadata proposes a Docker endpoint without approving egress, private access or a connection", async () => {
  for (const container of [false, true])
    await withApp({}, async (app) => {
      seed(app.server, {
        sources: SOURCE_CATALOG,
        hostPathsAllowed: true,
        ...(container
          ? { sshHostSuggestion: { host: "host.docker.internal" as const, reason: "container-host" as const } }
          : {}),
      });
      app.server.rpc.handle("admin.import.ssh.connections.list", () => ({ connections: [] }), { write: false });
      app.server.rpc.handle("admin.import.ssh.key.status", () => ({ configured: false }), { write: false });
      app.server.rpc.handle(
        "config.get",
        () => ({ revision: "r1", value: { allowHosts: [], allowPorts: [], allowLoopback: false } }),
        { write: false },
      );
      await openRoute(app.page, "#/import");
      await app.page.getByLabel("Source location").selectOption("ssh");
      await app.page.getByRole("button", { name: "Configure SSH access", exact: true }).click();
      assert.equal(
        await app.page.getByLabel("Exact SSH hostname or IP address", { exact: true }).inputValue(),
        container ? "host.docker.internal" : "",
      );
      assert.equal(
        await app.page.getByRole("button", { name: "Use Docker host proposal", exact: true }).count(),
        container ? 1 : 0,
      );
      assert.equal(
        await app.page
          .getByLabel(
            "Permit private destination addresses for this connection. Central host and port policy still applies.",
            { exact: true },
          )
          .isChecked(),
        false,
      );
      assert.equal(
        await app.page
          .getByLabel("I approve adding the displayed exact host and port to the central egress policy.", {
            exact: true,
          })
          .isChecked(),
        false,
      );
      assert.equal(
        await app.page.getByRole("button", { name: "Save policy and connection", exact: true }).isDisabled(),
        true,
      );
      assert.equal(
        app.server.rpc.calls.some((c) => c.method === "config.set" || c.method === "admin.import.ssh.connections.set"),
        false,
      );
      assert.deepEqual(app.problems, []);
    });
});

test("source and actual target NC models require separate canonical ledger confirmations and preserve the separate settings decision", async () => {
  await withApp({}, async (app) => {
    const run = seed(app.server);
    const models = MODEL_CHOICES.filter((c) => c.kind === "embedding" && c.nc),
      source = models[0]!,
      target = models[1]!;
    const original = app.server.rpc;
    original.handle("admin.import.detect", () => ({
      sourceId,
      sourceType: run.sourceType,
      sourceSha256: "a".repeat(64),
      expiresAt: "2099-01-01T00:00:00Z",
      counts: { agents: 1, skills: 0, memories: 1, stores: 1, channels: 0, extensions: 0, secrets: 0 },
      agents: [
        {
          id: "one",
          displayName: "Agent One",
          hasPersona: false,
          files: 1,
          skills: 0,
          plugins: 0,
          mcpServers: 0,
          stores: 1,
          channels: 0,
        },
      ],
      stores: [
        {
          id: "source-memory",
          displayName: "Source memory",
          kind: "shared",
          sourceModelCandidate: {
            model: source.model,
            dimensions: source.dimensions,
            revision: source.revision,
            licence: "CC-BY-NC-4.0",
            nonCommercial: true,
          },
        },
      ],
      plugins: [],
      mcpServers: [],
      unsupported: [],
      warnings: [],
    }));
    original.handle(
      "config.get",
      (params) => ({
        value: (params as { key: string }).key === "embedding.useClass" ? "research" : false,
        revision: "r1",
      }),
      { write: false },
    );
    original.handle(
      "model.memory.status",
      () => ({
        embedding: {
          provider: "local-transformers",
          model: target.model,
          dimensions: target.dimensions,
          configured: true,
        },
      }),
      { write: false },
    );
    original.handle("model.licence.confirm", (params) => {
      const model = MODEL_CHOICES.find((c) => c.model === (params as { model: string }).model)!;
      assert.deepEqual(params, { model: model.model, accepted: true });
      return {
        acceptance: {
          who: "local-owner",
          at: new Date().toISOString(),
          licence: model.licence,
          model: model.model,
          revision: model.revision,
          source: "memory",
        },
      };
    });
    await openRoute(app.page, "#/import");
    await app.page.getByRole("button", { name: "Inspect source", exact: true }).click();
    await app.page.getByLabel("Source store to adopt (optional)", { exact: true }).selectOption("source-memory");
    await app.page.getByLabel("Store strategy", { exact: true }).selectOption("re-embed");
    await app.page.getByRole("heading", { name: "Target embedding model", exact: true }).waitFor();
    await app.page.getByText("Non-commercial model licence", { exact: true }).waitFor();
    const fields = app.page
      .locator("fieldset")
      .filter({ has: app.page.getByText("Licence terms: CC BY-NC 4.0; non-commercial use only.", { exact: true }) });
    assert.equal(await fields.count(), 2);
    assert.equal(
      original.calls.some((c) => c.method === "model.licence.confirm"),
      false,
    );
    for (const field of await fields.all()) {
      await field
        .getByLabel("I have read and accept these non-commercial licence terms for this model revision.", {
          exact: true,
        })
        .check();
      await field.getByRole("button", { name: "Record licence acceptance", exact: true }).click();
      await field
        .getByText(
          "Licence acceptance recorded for this model and revision. Preflight still verifies model availability and the host’s non-commercial policy.",
          { exact: true },
        )
        .waitFor();
    }
    assert.deepEqual(
      original.calls
        .filter((c) => c.method === "model.licence.confirm")
        .map((c) => (c.params as { model: string }).model)
        .sort(),
      [source.model, target.model].sort(),
    );
    assert.equal(
      original.calls.some((c) => c.method === "config.set"),
      false,
    );
    assert.equal(await app.page.locator('a[href="#/settings/memory?focus=embedding.acceptedNcLicence"]').count(), 2);
    await expectAxeClean(app.page, "source and actual target model consent review");
    assert.deepEqual(app.problems, []);
  });
});

test("a declined cancellation refreshes actual status without displaying a pending cancellation", async () => {
  await withApp({}, async (app) => {
    seed(app.server);
    app.server.rpc.handle("admin.import.abort", () => ({ runId, accepted: false, state: "restarting-core" }));
    await openRoute(app.page, "#/import");
    await app.page.getByRole("button", { name: "Inspect source", exact: true }).click();
    await app.page.getByLabel(/^Agent Two/).uncheck();
    await app.page.getByRole("button", { name: "Create preview", exact: true }).click();
    await app.page.getByRole("button", { name: "Run preflight", exact: true }).click();
    await app.page.getByLabel(/^I accept stopping the Core/).check();
    await app.page.getByRole("button", { name: "Apply import", exact: true }).click();
    await app.page.getByText("Applying import", { exact: true }).waitFor();
    const previous = app.server.rpc.calls.filter((c) => c.method === "admin.import.status").length;
    const abort = app.page.getByRole("button", { name: "Cancel and restore snapshot", exact: true });
    await abort.click();
    await app.page.waitForFunction(() => !(document.querySelector(".btn-err") as HTMLButtonElement | null)?.disabled);
    assert.ok(app.server.rpc.calls.filter((c) => c.method === "admin.import.status").length > previous);
    assert.equal(
      await app.page.getByText("Cancellation requested. Waiting for restoration and restart.", { exact: true }).count(),
      0,
    );
    assert.equal(await abort.isDisabled(), false);
    assert.equal(app.server.rpc.calls.filter((c) => c.method === "admin.import.abort").length, 1);
    assert.deepEqual(app.problems, []);
  });
});
