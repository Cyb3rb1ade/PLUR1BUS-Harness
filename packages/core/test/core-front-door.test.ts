// P4-10 seam: the TypeScript core running behind the Rust front door (core-legacy). It takes the front door's credentials
// from run/, serves on its own address, holds its own lock, never touches the front door's run files, and accepts a
// handshake only as a front-door link.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { connect, unitAddress } from "@plur1bus/module-api";
import { createCore } from "../src/core.ts";
import { layout } from "../src/paths.ts";
import { flatTestInternals } from "./helpers/flat-embedder.ts";
import { tempDir } from "./helpers/temp-dir.ts";

const hex = () => randomBytes(32).toString("hex");

describe("core behind the front door (P4-10 seam)", () => {
  it("uses the front door's run files, its own address, lock and pid file, and refuses a direct owner", async () => {
    const home = tempDir("p1b-front-door-");
    const l = layout(home);
    mkdirSync(l.run, { recursive: true, mode: 0o700 });
    const cfg = defaults(); cfg.agents.bernd = {};
    writeFileSync(l.configPath, JSON.stringify(cfg));
    // What the front door writes before it spawns the legacy core: its link token, the owner and API credentials in a
    // file only the legacy core reads, and its pid file. run/core.token and run/api-delegation.token come only once the
    // legacy core is ready, right before the front door listens, as the TypeScript core writes them right before it does.
    const owner = hex(), api = hex(), link = hex();
    writeFileSync(join(l.run, "core-legacy.credentials"), JSON.stringify({ core: owner, api }), { mode: 0o600 });
    writeFileSync(join(l.run, "core-legacy.token"), link, { mode: 0o600 });
    writeFileSync(l.corePid, "4242 7a3a4b2c-0d1e-4f50-9a6b-1c2d3e4f5a6b\n", { mode: 0o600 });
    const lifeline = new PassThrough();
    const core = createCore({ home, testInternals: flatTestInternals(), dreams: { scheduler: false }, lifeline, behindFrontDoor: "standalone", onOrphanGraceExpired: () => {} });
    await core.start();
    assert.ok(!existsSync(l.coreToken) && !existsSync(join(l.run, "api-delegation.token")), "the legacy core writes neither public credential file");
    writeFileSync(l.coreToken, owner, { mode: 0o600 });
    writeFileSync(join(l.run, "api-delegation.token"), api, { mode: 0o600 });
    try {
      assert.equal(core.address, unitAddress(home, "core-legacy"));
      assert.equal(core.token, owner, "the owner token is the front door's");
      assert.equal(readFileSync(l.corePid, "utf8"), "4242 7a3a4b2c-0d1e-4f50-9a6b-1c2d3e4f5a6b\n");
      assert.match(readFileSync(join(l.run, "core-legacy.pid"), "utf8"), new RegExp(`^${process.pid} [0-9a-f-]{36}\\n$`));
      const models = JSON.parse(readFileSync(join(l.run, "engine-models.json"), "utf8"));
      assert.deepEqual([models.pid, models.instanceId], [4242, "7a3a4b2c-0d1e-4f50-9a6b-1c2d3e4f5a6b"], "stamped with the front door's identity");
      // Its own lock lives in run/, not in state/: state/ is a data root that backups, restores and the import's target
      // fingerprint cover, where the TypeScript core has only state/core.lock (which they skip).
      assert.ok(existsSync(join(l.run, "core-legacy.lock")));
      assert.ok(!existsSync(join(l.state, "core-legacy.lock")) && !existsSync(join(l.state, "core-legacy.lock-journal")));
      assert.ok(!existsSync(l.coreLock), "state/core.lock is the front door's");
      // A direct client holding the owner token is refused: the legacy core answers only front-door links.
      await assert.rejects(connect({ address: core.address, token: owner, expectedServerPid: process.pid }),
        (e: any) => e.error === "E_UNAUTHORIZED" && e.reason === "front-door-link");
    } finally {
      await core.stop({ budgetMs: 5000 });
    }
    assert.equal(readFileSync(l.coreToken, "utf8"), owner, "stop leaves the front door's token");
    assert.ok(existsSync(l.corePid), "stop leaves the front door's pid file");
    assert.ok(!existsSync(join(l.run, "core-legacy.pid")), "stop removes its own pid file");
  });
});
