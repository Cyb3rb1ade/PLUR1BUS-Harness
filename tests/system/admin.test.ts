import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { REAL, cli, home, startCore, stopCore, type RunningCore } from "./helpers.ts";

/** The engine's store schema marker (`{baseDbPath}/_schema.json`; the core's baseDbPath is `<home>/state/lancedb`). */
const marker = (h: string): string => readFileSync(join(h, "state", "lancedb", "_schema.json"), "utf8");

describe("2a-H3b — admin ops through the CLI (B15)", () => {
  it("admin embedding probe --json carries schema admin.embedding.probe/1", { skip: REAL && "flat embedder only" }, async (t) => {
    const h = home();
    let core: RunningCore | undefined;
    try {
      cli(h, ["agent", "create", "bernd"]);
      core = await startCore(h);
      t.diagnostic(`core ready ${core.readyMs.toFixed(0)} ms [flat embedder]`);
      const probe = cli(h, ["admin", "embedding", "probe"]);
      assert.equal(probe.schema, "admin.embedding.probe/1");
      assert.equal(probe.ok, true, JSON.stringify(probe));
      assert.equal(probe.identity.dimensions, 384);
      const again = cli(h, ["admin", "embedding", "probe", "--refresh"]);
      assert.equal(again.cached, false, JSON.stringify(again));
      const stopped = cli(h, ["admin", "embedding", "serve", "--stop"]);
      assert.equal(stopped.schema, "admin.embedding.serve/1");
      assert.deepEqual({ ...stopped, schema: undefined }, { schema: undefined, address: null, tokenPath: null, identity: null });
    } finally {
      if (core) await stopCore(core);
      rmSync(h, { recursive: true, force: true });
    }
  });

  it("admin migrate without --yes refuses before connecting: with no core it is exit 2, never E_CORE_UNAVAILABLE", () => {
    const h = home();
    try {
      const refused = cli(h, ["admin", "migrate", "--from", "1", "--to", "1"], { allowFail: true });
      assert.equal(refused.exit, 2, JSON.stringify(refused));
      const doc = JSON.parse(refused.stdout);
      assert.equal(doc.error, "E_INVALID_PARAMS", JSON.stringify(doc));
      assert.equal(doc.applied, false, JSON.stringify(doc));
      // The same call with --yes does try the core, and there is none.
      const unavailable = cli(h, ["admin", "migrate", "--from", "1", "--to", "1", "--yes"], { allowFail: true });
      assert.equal(unavailable.exit, 1, JSON.stringify(unavailable));
      assert.equal(JSON.parse(unavailable.stdout).error, "E_CORE_UNAVAILABLE");
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  it("admin migrate without --yes in a non-interactive shell exits 2 and changes nothing",{ skip: REAL && "flat embedder only" }, async () => {
    const h = home();
    let core: RunningCore | undefined;
    try {
      core = await startCore(h);
      const before = marker(h);
      const refused = cli(h, ["admin", "migrate", "--from", "1", "--to", "1"], { allowFail: true });
      assert.equal(refused.exit, 2, JSON.stringify(refused));
      const doc = JSON.parse(refused.stdout);
      assert.equal(doc.schema, "error/1"); assert.equal(doc.applied, false, JSON.stringify(doc));
      assert.equal(marker(h), before);
      // With --yes the same call reaches the core: the store is at 1, so nothing is applied either.
      const applied = cli(h, ["admin", "migrate", "--from", "1", "--to", "1", "--yes"]);
      assert.equal(applied.schema, "admin.migrate/1");
      assert.equal(applied.applied, false, JSON.stringify(applied));
      assert.equal(marker(h), before);
      const conflict = cli(h, ["admin", "migrate", "--from", "0", "--to", "1", "--yes"], { allowFail: true });
      assert.equal(conflict.exit, 1, JSON.stringify(conflict));
      assert.equal(JSON.parse(conflict.stdout).error, "E_CONFLICT");
    } finally {
      if (core) await stopCore(core);
      rmSync(h, { recursive: true, force: true });
    }
  });
});
