// Offline surface integration: real CLI + local RPC + existing stores + browser against mock HTTP forwarding.
// The fixture policy port grants admission; production D109 catalogue/transport bindings are separate gates.
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { setup, teardown, withApp, openRoute, browserSkip } from "./harness.ts";
import { buildCapabilities } from "../../rpc-schema/src/index.ts";
import { createRpcServer, type RpcServer } from "../../core/src/rpc/server.ts";
import { createLogger } from "../../core/src/logger.ts";
import { guardMethods, LOCAL_OWNER } from "../../core/src/rbac/guard.ts";
import { createMediaSurface } from "../../core/src/rpc/media-surface.ts";
import { buildCollabSurface } from "../../core/src/rpc/collab-surface.ts";
import { buildIdentitySurface } from "../../core/src/rpc/identity-surface.ts";
import { createCollab } from "../../core/src/collab/service.ts";
import { createIdentityService } from "../../core/src/identity/service.ts";
import { createCallBudget, PriceBook } from "../../core/src/budget/index.ts";
import { OutputStore } from "../../media/src/index.ts";
const bin =
  process.env.PLUR1BUS_BIN ??
  fileURLToPath(new URL("../../../target/debug/plur1bus", import.meta.url));
const exec = promisify(execFile);
before(setup);
after(teardown);
test(
  "CLI fake generation -> private output store -> browser gallery; project consult -> CLI/browser trace",
  {
    skip: browserSkip || (!existsSync(bin) ? "build plur1bus first" : false),
    timeout: 30000,
  },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "p1-surface-"));
    await mkdir(join(home, "run"), { mode: 0o700 });
    const token = "f".repeat(64),
      instanceId = randomUUID(),
      address = join(home, "run", "core.sock");
    await writeFile(join(home, "run", "core.token"), token, { mode: 0o600 });
    await writeFile(
      join(home, "run", "core.pid"),
      `${process.pid} ${instanceId}\n`,
      { mode: 0o600 },
    );
    const budget = createCallBudget({
      path: join(home, "budget.sqlite"),
      clock: { now: Date.now },
      prices: new PriceBook([
        { version: "fixture", effectiveFrom: 0, models: {} },
      ]),
    });
    const collab = createCollab({ path: join(home, "collab.sqlite") });
    const identity = createIdentityService({
      dbPath: join(home, "identity.sqlite"),
      clock: Date.now,
      audit: () => {},
    });
    const ac = new AbortController();
    let server: RpcServer;
    const store = new OutputStore(join(home, "media", "outputs"));
    // Valid single-pixel PNG, no provider or external network.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP00AAAAASUVORK5CYII=",
      "base64",
    );
    const media = createMediaSurface({
      home,
      store,
      budget,
      signal: ac.signal,
      policy: async () => {},
      notify: (m, p, o) => server.notify(m, p, o),
      adapters: [
        {
          id: "fixture",
          model: "fixture",
          capabilities: () => ({ generate: true, edit: false, inpaint: false }),
          async generate() {
            return {
              files: [{ bytes: png, format: "png" }],
              metadata: { adapter: "fixture", model: "fixture", durationMs: 1 },
            };
          },
          async edit() {
            throw new Error("unsupported");
          },
        },
      ],
    });
    const methods = guardMethods(
      {
        ...media.methods,
        ...buildCollabSurface(() => collab),
        ...buildIdentitySurface(() => identity),
      },
      { resolve: () => LOCAL_OWNER, now: Date.now },
    );
    const logger = createLogger({
      file: join(home, "core.log"),
      level: "error",
      role: "core",
    });
    server = createRpcServer({
      address,
      token,
      hello: () => ({
        contract: "1.12.0",
        rpc: "1.5.0",
        instanceId,
        pid: process.pid,
        capabilities: buildCapabilities([]),
      }),
      methods,
      logger,
    });
    const cli = async (...args: string[]) =>
      JSON.parse(
        (
          await exec(bin, ["--home", home, "--json", ...args], {
            timeout: 10000,
          })
        ).stdout,
      );
    try {
      await server.listen();
      const job = await cli(
        "media",
        "generate",
        "Synthetic forest",
        "--agent",
        "main",
        "--adapter",
        "fixture",
        "--wait",
        "--out",
        join(home, "download.png"),
      );
      assert.equal(job.state, "succeeded");
      assert.equal(job.schema, "media.generate/1");
      const outputs = await cli("media", "outputs");
      assert.equal(outputs.outputs[0].id, job.id);
      assert.equal(existsSync(join(home, "download.png")), true);
      const project = await cli("project", "create", "Synthetic project");
      await cli("project", "agent", "add", project.id, "a");
      await cli("project", "agent", "add", project.id, "b");
      const answer = await collab.consult({
        principal: LOCAL_OWNER,
        projectId: project.id,
        fromAgent: "a",
        toAgent: "b",
        question: "Synthetic consult",
        context: "",
      });
      const trace = await cli("trace", "show", answer.traceId);
      assert.equal(trace.spans.length, 1);
      await withApp({}, async (app) => {
        for (const method of [
          "media.output.list",
          "media.output.get",
          "project.list",
          "collab.trace.list",
        ])
          app.server.rpc.handle(
            method,
            (params) =>
              methods[method]!(params, {
                requestId: method,
                connectionId: "web-fixture",
                signal: ac.signal,
              }),
            { write: false },
          );
        await openRoute(app.page, "#/media");
        await app.page.getByText("Synthetic forest", { exact: true }).waitFor();
        const src = await app.page
          .locator(".media-grid img")
          .getAttribute("src");
        assert.ok(src?.startsWith("data:image/png;base64,"));
        await app.page.evaluate((id) => {
          location.hash = `#/projects/${id}`;
        }, project.id);
        await app.page.getByText(answer.traceId, { exact: false }).waitFor();
      });
    } finally {
      ac.abort();
      await media.close();
      await server.close();
      identity.close();
      collab.close();
      budget.close();
      logger.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
