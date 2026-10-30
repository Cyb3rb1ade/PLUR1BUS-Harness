/** The maintenance control channel is private: stdout contains bounded metadata, while config arrives only on stdin. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

const RUN = "470655c8-99da-445a-ad09-3179c16611cc";
const PLAN = "918852b6-77b4-41be-bbf8-44c3c0a6a064";
const MARKER = "fixture-private-target-legacy-inline-credential";
const job = { v: 1, runId: RUN, mode: "apply", home: "/trusted/home", plan: { id: PLAN, sha256: "a".repeat(64) },
  ownerId: "trusted-owner", attempt: 1 };

async function fixture(preflightId?: string) {
  const module = await import("../../src/import/worker-port.ts").catch(() => undefined);
  assert.equal(typeof module?.openImportWorkerPort, "function", "supervised maintenance requires bounded private controls");
  const input = new PassThrough();
  const output = new PassThrough();
  const writes: Buffer[] = [];
  output.on("data", chunk => writes.push(Buffer.from(chunk)));
  const opening = module!.openImportWorkerPort({ input, output });
  input.write(JSON.stringify({ ...job, ...(preflightId ? { preflightId } : {}) }) + "\n");
  const port = await opening;
  return { input, output, writes, port };
}

function last(writes: Buffer[]) {
  const lines = Buffer.concat(writes).toString("utf8").trim().split("\n");
  return JSON.parse(lines.at(-1)!);
}

async function tick() {
  await new Promise<void>(resolve => setImmediate(resolve));
}

describe("private import worker controls", () => {
  it("allows automatic undo only on the private rollback job", async () => {
    const { openImportWorkerPort } = await import("../../src/import/worker-port.ts");
    for (const mode of ["apply", "recover", "rollback"]) {
      const input = new PassThrough();
      const output = new PassThrough();
      const opening = openImportWorkerPort({ input, output });
      input.write(JSON.stringify({ ...job, mode, automaticRollback: true }) + "\n");
      if (mode === "rollback") {
        const port = await opening;
        assert.equal(port.job.automaticRollback, true);
        port.close();
      } else await assert.rejects(opening);
      input.destroy();
      output.destroy();
    }
  });
  it("matches config controls by id and keeps the private config response out of stdout and progress", async () => {
    const { input, writes, port } = await fixture();
    try {
      assert.equal(port.job.runId, RUN);
      const pending = port.request("config.get", {});
      await tick();
      const request = last(writes);
      assert.deepEqual(request, { v: 1, type: "request", runId: RUN, id: 1, method: "config.get", params: {} });
      input.write(JSON.stringify({ v: 1, type: "response", runId: RUN, id: request.id, ok: true,
        result: { config: { token: MARKER }, revision: "rev-1" } }) + "\n");
      assert.deepEqual(await pending, { config: { token: MARKER }, revision: "rev-1" });
      await port.progress({ runId: RUN, phase: "apply", completed: 1, entity: "agent" });
      await port.result({ ok: true, status: "completed", restored: false, resumable: false });
      assert.ok(!Buffer.concat(writes).includes(Buffer.from(MARKER)));
      assert.equal(last(writes).type, "result");
    } finally {
      port.close();
      input.destroy();
    }
  });

  it("accepts a bounded config larger than stdout's cap only through the private stdin response", async () => {
    const { input, writes, port } = await fixture();
    try {
      const pending = port.request("config.get", {});
      await tick();
      input.write(JSON.stringify({ v: 1, type: "response", runId: RUN, id: last(writes).id, ok: true,
        result: { config: { legacy: MARKER.repeat(3000) }, revision: "rev-2" } }) + "\n");
      const result = await pending as { config: { legacy: string } };
      assert.equal(result.config.legacy.length, MARKER.length * 3000);
      assert.ok(Buffer.concat(writes).length < 65_536);
    } finally {
      port.close();
      input.destroy();
    }
  });

  it("aborts and rejects outstanding controls on a wrong-run response or disconnect with fixed diagnostics", async () => {
    for (const disconnect of [false, true]) {
      const { input, port } = await fixture();
      try {
        const pending = port.request("config.get", {});
        const failure = assert.rejects(pending, (error: Error) => {
          assert.equal(error.message, "Import worker control is unavailable");
          assert.ok(!error.message.includes(MARKER));
          return true;
        });
        if (disconnect) input.end();
        else input.write(JSON.stringify({ v: 1, type: "response", runId: MARKER, id: 1, ok: true,
          result: {} }) + "\n");
        await failure;
        assert.equal(port.signal.aborted, true);
        await assert.rejects(Promise.race([
          port.request("config.restore", { sha256: null }),
          new Promise(resolve => setTimeout(() => resolve("host control still waiting after disconnect"), 50)),
        ]));
      } finally {
        port.close();
        input.destroy();
      }
    }
  });

  it("rejects unknown controls, content-bearing progress and oversized stdout before writing them", async () => {
    const { input, writes, port } = await fixture();
    try {
      await assert.rejects(port.request("shell.exec" as never, { command: MARKER }));
      await assert.rejects(port.request("config.set", { changes: { huge: MARKER.repeat(3000) }, dryRun: false }));
      await assert.rejects(port.progress({ runId: RUN, phase: "apply", completed: 1, content: MARKER } as never));
      assert.equal(writes.length, 0);
      input.write(JSON.stringify({ v: 1, type: "abort", runId: RUN }) + "\n");
      await tick();
      assert.equal(port.signal.aborted, true);
    } finally {
      port.close();
      input.destroy();
    }
  });

  it("sends the existing Supervisor changes array without a full target config", async () => {
    const { input, writes, port } = await fixture();
    try {
      const request = port.request("config.set", { changes: [{ key: "agents.alpha", value: { createdAt: "now" } }],
        dryRun: true, ifRevision: "rev" });
      await tick();
      const sent = last(writes);
      assert.equal(sent.params.changes[0].key, "agents.alpha");
      input.write(JSON.stringify({ v: 1, type: "response", runId: RUN, id: sent.id, ok: true,
        result: { revision: "rev" } }) + "\n");
      await request;
      await assert.rejects(port.result({ ok: true, status: "completed", restored: false, resumable: false,
        report: { content: MARKER } } as never));
      assert.ok(!Buffer.concat(writes).includes(Buffer.from(MARKER)));
    } finally {
      port.close();
      input.destroy();
    }
  });

  it("consumes a matching private source-secret envelope once and never emits its values", async () => {
    const preflightId = "7a1ae57f-293b-4f04-beb7-4ae76a0dc664";
    const { input, writes, port } = await fixture(preflightId);
    try {
      input.write(JSON.stringify({ v: 1, type: "secret-source", runId: RUN, planId: PLAN, preflightId,
        entries: { OPENAI_API_KEY: MARKER } }) + "\n");
      const lease = await port.takeSourceSecrets();
      const values = [...lease.entries()];
      assert.equal(values[0]![1].toString(), MARKER);
      assert.equal(JSON.stringify(lease), "{}");
      await assert.rejects(port.takeSourceSecrets());
      lease.release();
      assert.equal(values[0]![1].every(value => value === 0), true);
      assert.ok(!Buffer.concat(writes).includes(Buffer.from(MARKER)));
    } finally {
      port.close();
      input.destroy();
    }
  });
});
