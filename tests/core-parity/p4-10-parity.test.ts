import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { beyondFloor, compareFixtureRuns, diffPath, diffPlace, G1_ENDS_SESSION, G1_EXPECTED, G1_EXPECTED_AT, G1_UNSTABLE_AT, sendFixtures, withoutExpected, withoutUnstable } from "./p4-10-parity.ts";

describe("the noise floor of P4-10's comparison", () => {
  it("names where a difference is, without its values", () => {
    assert.equal(diffPath('conn 0, response to #3 memory.recall: $.result.blocks[2].text: expected "a", got "b"'), "conn 0, response to #3 memory.recall: $.result.blocks[2].text");
    assert.equal(diffPath("conn 1, response to #2 x.y: $.result.z: missing, expected 1"), "conn 1, response to #2 x.y: $.result.z");
    assert.equal(diffPath('conn 0, notification a.b: $.params.q: unexpected, got "x\ny"'), "conn 0, notification a.b: $.params.q");
  });

  it("keeps only the front door's differences at a place where two stock cores agree", () => {
    const control = ['conn 0, response to #3 memory.recall: $.result.text: expected "a", got "b"'];
    const frontDoor = ['conn 0, response to #3 memory.recall: $.result.text: expected "c", got "d"', "conn 0, response to #4 core.status: $.result.process: expected 1, got 2"];
    assert.deepEqual(beyondFloor(frontDoor, control), ["conn 0, response to #4 core.status: $.result.process: expected 1, got 2"]);
    assert.deepEqual(beyondFloor([], control), []);
  });

  it("sets aside only the methods G1 expects to differ, each with its reason", () => {
    assert.ok(G1_EXPECTED["bridge.hello"]?.includes("bridge"));
    const diffs = ["conn 0, response to #bridge.hello#93 bridge.hello: $.error.code: expected -32601, got -32000", "conn 0, response to #core.status#94 core.status: $.result.rpc: expected 1, got 2"];
    assert.deepEqual(withoutExpected(diffs), ["conn 0, response to #core.status#94 core.status: $.result.rpc: expected 1, got 2"]);
  });

  it("names method and path of a difference in a response, and nothing for any other difference", () => {
    assert.deepEqual(diffPlace("conn 0, response to #logs.query#296 logs.query: $.result.scanned.bytes: expected 67944, got 67970"), { method: "logs.query", path: "$.result.scanned.bytes" });
    assert.equal(diffPlace('conn 0, notification a.b: $.params.q: unexpected, got "x"'), undefined);
  });

  it("sets aside a place that differs by design, and only that place of its method", () => {
    assert.ok(G1_EXPECTED_AT.every((p) => p.why.length > 40), "every place carries its reason");
    const size = "conn 0, response to #logs.query#296 logs.query: $.result.scanned.bytes: expected 67944, got 67970";
    const files = "conn 0, response to #logs.query#296 logs.query: $.result.scanned.files: expected 2, got 3";
    const other = "conn 0, response to #x.y#3 x.y: $.result.scanned.bytes: expected 1, got 2";
    assert.deepEqual(withoutExpected([size, files, other]), [files, other]);
  });

  it("sets aside the byte counts that move between two runs of one core, and nothing next to them", () => {
    assert.ok(G1_UNSTABLE_AT.every((p) => p.why.length > 40), "every place carries its reason");
    const manifest = "conn 0, response to #admin.backup.snapshot#14 admin.backup.snapshot: $.result.files[28].bytes: expected 6513, got 6512";
    const plan = ["sourceBytes", "targetBytes", "requiredFreeBytes", "freeBytes"].map((k) => `conn 0, response to #admin.reembed.plan#57 admin.reembed.plan: $.result.plan.${k}: expected 33940, got 33937`);
    const kept = [
      'conn 0, response to #admin.backup.snapshot#14 admin.backup.snapshot: $.result.files[28].path: expected "a", got "b"',
      "conn 0, response to #admin.backup.snapshot#14 admin.backup.snapshot: $.result.files: expected 30 items, got 31",
      "conn 0, response to #admin.reembed.plan#57 admin.reembed.plan: $.result.plan.rows: expected 15, got 16",
      "conn 0, response to #admin.backup.verify#15 admin.backup.verify: $.result.files[28].bytes: expected 1, got 2",
    ];
    assert.deepEqual(withoutUnstable([manifest, ...plan, ...kept]), kept);
  });
});

describe("G1's bookkeeping of fixtures without a response (task review L7)", () => {
  /** A fake connection: `core.auth` and every fixture are answered, except those named in `lost`, whose wait rejects
   *  (a timeout or a dropped connection: the raw client rejects either way). */
  function fakeConnect(lost: readonly string[]) {
    let connections = 0;
    const connect = async () => {
      connections++;
      return {
        send: () => {},
        waitFor: async (_pick: (f: any) => boolean, what: string) => {
          if (lost.includes(what)) throw new Error(`timed out after 10 ms waiting for ${what}`);
          return { jsonrpc: "2.0", id: what === "core.auth" ? 0 : what, result: { ok: true } };
        },
        close: async () => {},
      };
    };
    return { connect, connections: () => connections };
  }
  const fixtures: Array<[string, string, unknown]> = [["a.x", "a.x", {}], ["b.y", "b.y", {}], ["c.z", "c.z", {}]];

  it("records a fixture whose wait rejects as unanswered, reconnects, and goes on", async () => {
    const fake = fakeConnect(["b.y#2"]);
    const run = await sendFixtures(fixtures, fake.connect, "token-placeholder", 10);
    assert.deepEqual(run.unanswered, ["b.y#2"]);
    assert.equal(fake.connections(), 2, "a fresh, authenticated connection after the lost one");
    assert.equal(run.lines.filter((l) => l.dir === "in").length, 3, "every fixture is sent");
    assert.equal(run.lines.filter((l) => l.dir === "out").length, 3, "every request keeps a line, so the legs stay aligned");
  });

  it("starts a new session after a fixture that ends it by contract, so the next fixture is answered", async () => {
    assert.ok(G1_ENDS_SESSION["core.auth"]?.includes("closes the connection"));
    // The server closes the connection after its reply to the core.auth fixture: on that connection nothing answers any more.
    let connections = 0;
    const connect = async () => {
      const mine = ++connections;
      let closedByServer = false;
      return {
        send: () => {},
        waitFor: async (_pick: (f: any) => boolean, what: string) => {
          if (closedByServer) throw new Error(`connection ${mine} closed while waiting for ${what}`);
          if (what.startsWith("core.auth#")) { closedByServer = true; return { jsonrpc: "2.0", id: what, error: { code: -32000, message: "client not approved" } }; }
          return { jsonrpc: "2.0", id: what === "core.auth" ? 0 : what, result: { ok: true } };
        },
        close: async () => {},
      };
    };
    const run = await sendFixtures([["a.x", "a.x", {}], ["core.auth", "core.auth", { token: "fixture" }], ["core.status", "core.status", {}]], connect, "token-placeholder", 10);
    assert.deepEqual(run.unanswered, []);
    assert.equal(connections, 2);
    assert.deepEqual(run.lines.filter((l) => l.dir === "out").map((l) => (l.msg as any).result ?? "refused"), [{ ok: true }, "refused", { ok: true }]);
  });

  it("never counts fixtures both legs left unanswered as parity: they fail G1 and are counted", async () => {
    const ts = await sendFixtures(fixtures, fakeConnect(["b.y#2"]).connect, "token-placeholder", 10);
    const rust = await sendFixtures(fixtures, fakeConnect(["b.y#2", "c.z#3"]).connect, "token-placeholder", 10);
    const g = compareFixtureRuns(ts, rust, ["ts", "rust"]);
    assert.deepEqual(g.unanswered, ["ts: b.y#2", "rust: b.y#2", "rust: c.z#3"]);
    assert.equal(g.sent, 3);
    assert.ok(!g.passed, "unanswered fixtures fail G1 even where the transcripts compare equal");
    const clean = compareFixtureRuns(
      await sendFixtures(fixtures, fakeConnect([]).connect, "token-placeholder", 10),
      await sendFixtures(fixtures, fakeConnect([]).connect, "token-placeholder", 10),
      ["ts", "rust"],
    );
    assert.deepEqual(clean.unanswered, []);
    assert.deepEqual(clean.diffs, []);
    assert.ok(clean.passed);
  });
});
