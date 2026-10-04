import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { cli, home, startCore, stopCore, type RunningCore } from "./helpers.ts";

describe("model discovery through CLI and core", () => {
  it("model discovery end-to-end through CLI", async () => {
    const CANARY_SECRET_TOKEN = "CANARY-SECRET-CLI-TOKEN-999";
    const CANARY_INVALID_MODEL = "CANARY-INVALID-CLI-ENTRY-888";
    const cliOutputs: string[] = [];

    const runCli = (args: string[], opts: { json?: boolean; allowFail?: boolean } = {}) => {
      const res = cli(h, args, opts);
      if (typeof res === "string") {
        cliOutputs.push(res);
      } else {
        cliOutputs.push(JSON.stringify(res));
        if (res.stdout) cliOutputs.push(res.stdout);
        if (res.stderr) cliOutputs.push(res.stderr);
      }
      return res;
    };

    // Run the mock HTTP server in a Worker thread so that synchronous execFileSync
    // calls from the CLI do not block the event loop serving the HTTP responses.
    const workerCode = `
      import { createServer } from "node:http";
      import { parentPort } from "node:worker_threads";

      let models = [{ id: "example-chat-large" }, { id: "example-chat-small" }];
      const server = createServer((req, res) => {
        if (req.url === "/v1/models") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ data: models }));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      server.listen(0, "127.0.0.1", () => {
        parentPort.postMessage({ type: "ready", port: server.address().port });
      });

      parentPort.on("message", (msg) => {
        if (msg.type === "setModels") {
          models = msg.models;
          parentPort.postMessage({ type: "modelsSet" });
        } else if (msg.type === "close") {
          server.closeAllConnections();
          server.close(() => {
            parentPort.postMessage({ type: "closed" });
          });
        }
      });
    `;

    const worker = new Worker(workerCode, { eval: true });
    const { port } = await new Promise<{ port: number }>((resolve) => {
      worker.on("message", (msg) => {
        if (msg.type === "ready") resolve({ port: msg.port });
      });
    });

    const setModels = (models: Array<{ id: string }>) =>
      new Promise<void>((resolve) => {
        const handler = (msg: any) => {
          if (msg.type === "modelsSet") {
            worker.off("message", handler);
            resolve();
          }
        };
        worker.on("message", handler);
        worker.postMessage({ type: "setModels", models });
      });

    const stopMock = () =>
      new Promise<void>((resolve) => {
        const handler = (msg: any) => {
          if (msg.type === "closed") {
            worker.off("message", handler);
            resolve();
          }
        };
        worker.on("message", handler);
        worker.postMessage({ type: "close" });
      });

    const h = home();
    const seamPath = join(h, "discovery-profiles.json");
    writeFileSync(
      seamPath,
      JSON.stringify({
        profiles: [
          {
            id: "example-compat",
            vendor: "example-vendor",
            discovery: "openai-models",
            baseUrl: `http://127.0.0.1:${port}/v1`,
            credential: {
              headerName: "Authorization",
              headerValue: `Bearer ${CANARY_SECRET_TOKEN}`,
            },
          },
        ],
      })
    );

    let core: RunningCore | undefined;
    try {
      core = await startCore(h, {
        PLUR1BUS_ALLOW_TEST_INTERNALS: "1",
        PLUR1BUS_TEST_DISCOVERY_PROFILES: seamPath,
      });

      // 1. model scan --json carries schema model.scan/1 and finds two models
      const scan1 = runCli(["model", "scan"]);
      assert.equal(scan1.schema, "model.scan/1");
      assert.equal(scan1.providers.length, 1);
      assert.equal(scan1.providers[0].result, "ok");
      assert.equal(scan1.providers[0].new.length, 2);

      // 2. model list --json shows them with schema model.list/1; --new lists both; --new --ack then clears newCount
      const list1 = runCli(["model", "list"]);
      assert.equal(list1.schema, "model.list/1");
      assert.equal(list1.models.length, 2);
      assert.equal(list1.newCount, 2);

      const listNew = runCli(["model", "list", "--new"]);
      assert.equal(listNew.models.length, 2);

      runCli(["model", "list", "--new", "--ack"]);
      const listAfterAck = runCli(["model", "list"]);
      assert.equal(listAfterAck.newCount, 0);

      // 3. A removed model turns unavailable on the next scan and a returning one available
      await setModels([{ id: "example-chat-large" }]);
      runCli(["model", "scan"]);

      const list2 = runCli(["model", "list"]);
      const smallUnavail = list2.models.find((m: any) => m.id === "example-chat-small");
      assert.ok(smallUnavail);
      assert.equal(smallUnavail.status, "unavailable");

      await setModels([{ id: "example-chat-large" }, { id: "example-chat-small" }]);
      runCli(["model", "scan"]);

      const list3 = runCli(["model", "list"]);
      const smallAvail = list3.models.find((m: any) => m.id === "example-chat-small");
      assert.ok(smallAvail);
      assert.equal(smallAvail.status, "available");

      // 4. An override survives: model override ... --name 'My Small' then a rescan keeps it; schema model.override/1
      const ov = runCli(["model", "override", "example-compat", "example-chat-small", "--name", "My Small"]);
      assert.equal(ov.schema, "model.override/1");
      assert.equal(ov.displayName, "My Small");

      runCli(["model", "scan"]);
      const list4 = runCli(["model", "list"]);
      const smallWithOv = list4.models.find((m: any) => m.id === "example-chat-small");
      assert.ok(smallWithOv);
      assert.equal(smallWithOv.displayName, "My Small");

      // 4b. Canary test with invalid 200 model entry (Surface F9)
      await setModels([{ id: "example-chat-large" }, { id: `${CANARY_INVALID_MODEL} invalid name with \x00` }]);
      const invalidScan = runCli(["model", "scan"], { allowFail: true });
      assert.equal(invalidScan.exit, 1);
      const invalidDoc = JSON.parse(invalidScan.stdout);
      assert.equal(invalidDoc.providers[0].result, "failed:invalid");

      // Restore valid models
      await setModels([{ id: "example-chat-large" }, { id: "example-chat-small" }]);
      runCli(["model", "scan"]);

      // 5. Stopping the mock exits model scan non-zero with failed:network and the list is unchanged
      await stopMock();

      const failedScan = runCli(["model", "scan"], { allowFail: true });
      assert.equal(failedScan.exit, 1);
      const failedDoc = JSON.parse(failedScan.stdout);
      assert.equal(failedDoc.schema, "model.scan/1");
      assert.equal(failedDoc.providers[0].result, "failed:network");

      const listUnchanged = runCli(["model", "list"]);
      assert.equal(listUnchanged.models.length, 2);

      // 6. With the core stopped, model list --json reads the file read-only
      await stopCore(core);
      core = undefined;

      const staleList = runCli(["model", "list"]);
      assert.equal(staleList.schema, "model.list/1");
      assert.equal(staleList.stale, true);
      assert.equal(staleList.models.length, 2);

      // 7. Verify no canary leaked into any CLI output, logs, catalog, or state (Surface F9)
      for (const canary of [CANARY_SECRET_TOKEN, CANARY_INVALID_MODEL]) {
        for (const out of cliOutputs) {
          assert.equal(out.includes(canary), false, `Canary ${canary} leaked into CLI output: ${out}`);
        }
      }

      function checkDirForCanaries(dir: string) {
        if (!existsSync(dir)) return;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            checkDirForCanaries(full);
          } else if (entry.isFile()) {
            const content = readFileSync(full, "utf8");
            for (const canary of [CANARY_SECRET_TOKEN, CANARY_INVALID_MODEL]) {
              assert.equal(content.includes(canary), false, `Canary ${canary} leaked into file ${full}`);
            }
          }
        }
      }
      checkDirForCanaries(join(h, "logs"));
      checkDirForCanaries(join(h, "catalog"));
      checkDirForCanaries(join(h, "state"));

      // Positive controls: files actually recorded operations
      const coreLog = readFileSync(join(h, "logs", "core.log"), "utf8");
      assert.ok(coreLog.includes("model.scan.failed"), "core.log should contain scan failure events");
      const catalogJson = readFileSync(join(h, "catalog", "models.json"), "utf8");
      assert.ok(catalogJson.includes("example-chat-large"), "models.json should contain discovered models");
    } finally {
      if (core) await stopCore(core);
      await worker.terminate();
    }
  });
});
