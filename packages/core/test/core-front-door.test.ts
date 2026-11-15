// P4-10 seam: the TypeScript core running behind the Rust front door (core-legacy). It takes the front door's credentials
// from run/, serves on its own address, holds its own lock, never touches the front door's run files, and accepts a
// handshake only as a front-door link.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { connect, unitAddress } from "@plur1bus/module-api";
import { createCore } from "../src/core.ts";
import { acquireCoreLock } from "../src/lock.ts";
import { layout } from "../src/paths.ts";
import { flatTestInternals } from "./helpers/flat-embedder.ts";
import { tempDir } from "./helpers/temp-dir.ts";
import { until } from "./helpers/until.ts";

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

  it("stops at once when its lifeline ends before it is ready, instead of finishing its start (security review M3)", async () => {
    // The front door died while this core was starting: state/core.lock is free again, so every step of the start this
    // core still took (migrations, the journal replay, the engine) would race the next writer on the stores.
    const { home, l } = frontDoorHome();
    const lifeline = new PassThrough();
    const core = createCore({ home, testInternals: flatTestInternals(), dreams: { scheduler: false }, lifeline, behindFrontDoor: "standalone", onOrphanGraceExpired: () => {} });
    const start = core.start();
    lifeline.end();
    try {
      await assert.rejects(start, /front door is gone/, "the start is abandoned, never finished");
    } finally {
      await core.stop({ budgetMs: 5000 });
    }
    assert.equal(core.status().process.state, "stopped");
    assert.ok(!existsSync(join(l.run, "core-legacy.pid")), "it never got as far as its pid file");
    acquireCoreLock(join(l.run, "core-legacy.lock"), "next").release(); // and holds no lock: the next legacy core starts
  });

  it("an adoption over a front-door link never takes the lifeline, and the lifeline's loss expires at once (task review L8)", async () => {
    // The front door relays a supervisor's core.adopt so this core still checks the nonce and the caller's rights, but the
    // lifeline stays the front door's: closing the adopting connection must not orphan this core, and the end of the
    // front door's lifeline must stop it without a grace (nothing can adopt a core behind a front door).
    const { home, l, owner, link } = frontDoorHome();
    const nonce = hex();
    writeFileSync(l.supervisorToken, nonce, { mode: 0o600 });
    const lifeline = new PassThrough();
    let expiredAt: number | null = null;
    const core = createCore({ home, testInternals: flatTestInternals(), dreams: { scheduler: false }, lifeline, behindFrontDoor: "standalone", onOrphanGraceExpired: () => { expiredAt ??= Date.now(); } });
    await core.start();
    try {
      const c = await rawClient(core.address);
      assert.ok((await c.call("core.auth", { token: owner, frontDoor: { token: link, caller: "owner" } })).result, "a front-door link");
      const adopted = await c.call("core.adopt", { nonce });
      assert.ok(adopted.result, JSON.stringify(adopted));
      await c.close();
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(core.status().process.state, "ready", "the adopting link's end orphans nothing");
      assert.equal(expiredAt, null);
      const ended = Date.now();
      lifeline.end();
      await until(() => expiredAt !== null, "the grace expiry", { ms: 2000 });
      assert.ok(expiredAt! - ended < 500, `expired ${expiredAt! - ended} ms after the lifeline ended`);
    } finally {
      await core.stop({ budgetMs: 5000 });
    }
  });

  it("serves legacy.account.changed to the front door's control link alone: the notification to the API services and nothing else (P4-12 flip A2)", async () => {
    const { home, owner, api, link } = frontDoorHome();
    const core = createCore({ home, testInternals: flatTestInternals(), dreams: { scheduler: false }, lifeline: new PassThrough(), behindFrontDoor: "standalone", onOrphanGraceExpired: () => {} });
    await core.start();
    try {
      // The API's credential-only link watches account changes; a signed-in person's API link does not get them.
      const service = await rawClient(core.address);
      assert.ok((await service.call("core.auth", { token: owner, api: { clientId: "harness-api", token: api }, frontDoor: { token: link, caller: "api" } })).result);
      // Every request of an API link carries its delegation.
      assert.ok((await service.call("events.subscribe", { names: ["api.account.changed"] }, { api: { clientId: "harness-api", token: api } })).result);
      const person = await rawClient(core.address);
      assert.ok((await person.call("core.auth", { token: owner, api: { clientId: "harness-api", token: api, principal: { userId: "local-owner", kind: "person", role: "owner" } }, frontDoor: { token: link, caller: "api" } })).result);
      const control = await rawClient(core.address);
      assert.ok((await control.call("core.auth", { token: owner, frontDoor: { token: link, caller: "front-door" } })).result, "the control link");
      assert.deepEqual((await control.call("legacy.account.changed", { userId: "u-quiet", rights: false, learning: true })).result, {});
      assert.deepEqual((await control.call("legacy.account.changed", { userId: "u-changed", rights: true, learning: false })).result, {});
      await until(() => service.notes.length > 0, "the notification");
      await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(service.notes.map((n) => [n.method, n.params]), [["api.account.changed", { userId: "u-changed" }]], "once, for the call that asked for it");
      assert.deepEqual(person.notes, []);
      assert.deepEqual(control.notes, []);
      // An owner's own link (what the front door opens for a client) has no such method, and nothing is sent.
      const client = await rawClient(core.address);
      assert.ok((await client.call("core.auth", { token: owner, frontDoor: { token: link, caller: "owner" } })).result);
      const refused = await client.call("legacy.account.changed", { userId: "u-forged", rights: true, learning: true });
      assert.deepEqual([refused.error.code, refused.error.data.reason], [-32601, "method-not-found"]);
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(service.notes.length, 1);
      for (const c of [service, person, control, client]) await c.close();
    } finally {
      await core.stop({ budgetMs: 5000 });
    }
  });
});

/** A raw NDJSON connection: `call` sends one request and resolves with its answer. */
async function rawClient(address: string): Promise<{ call(method: string, params: Record<string, unknown>, frame?: Record<string, unknown>): Promise<any>; close(): Promise<void>; notes: any[] }> {
  const s = createConnection(address);
  await new Promise<void>((resolve, reject) => { s.once("connect", resolve); s.once("error", reject); });
  const waiting = new Map<number, (v: any) => void>();
  const notes: any[] = [];
  let buf = ""; let next = 1;
  s.on("data", (d) => {
    buf += String(d);
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const msg = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
      if (typeof msg.id === "number") waiting.get(msg.id)?.(msg); else notes.push(msg);
    }
  });
  return {
    notes,
    call: (method, params, frame = {}) => new Promise((resolve) => { const id = next++; waiting.set(id, resolve); s.write(JSON.stringify({ jsonrpc: "2.0", id, method, params, ...frame }) + "\n"); }),
    close: () => new Promise<void>((resolve) => { s.once("close", () => resolve()); s.end(); }),
  };
}

/** A home as the front door leaves it before it spawns the legacy core. */
function frontDoorHome(): { home: string; l: ReturnType<typeof layout>; owner: string; api: string; link: string } {
  const home = tempDir("p1b-front-door-");
  const l = layout(home);
  mkdirSync(l.run, { recursive: true, mode: 0o700 });
  const cfg = defaults(); cfg.agents.bernd = {};
  writeFileSync(l.configPath, JSON.stringify(cfg));
  const owner = hex(), api = hex(), link = hex();
  writeFileSync(join(l.run, "core-legacy.credentials"), JSON.stringify({ core: owner, api }), { mode: 0o600 });
  writeFileSync(join(l.run, "core-legacy.token"), link, { mode: 0o600 });
  writeFileSync(l.corePid, "4242 7a3a4b2c-0d1e-4f50-9a6b-1c2d3e4f5a6b\n", { mode: 0o600 });
  return { home, l, owner, api, link };
}
