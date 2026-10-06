import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cli, home, startCore, stopCore, type RunningCore } from "./helpers.ts";

/** M3 identity v2 + pairing (ADR-007, D24) through the CLI against a real core and its `state/identity.sqlite`. */
describe("M3 — identity and pairing through the CLI", () => {
  it("pairing, manual link, unlink, no heuristic link, rate limit; the code never reaches a log or the audit file", async () => {
    const h = home();
    let core: RunningCore | undefined;
    const run = (args: string[], allowFail = false): any => {
      const out = cli(h, args, { allowFail });
      return allowFail && typeof out?.exit === "number" ? { exit: out.exit, doc: JSON.parse(out.stdout) } : out;
    };
    try {
      core = await startCore(h);

      const alex = run(["user", "add", "Alex"]);
      assert.equal(alex.schema, "user.add/1", JSON.stringify(alex));
      const bea = run(["user", "add", "Alex"]); // the same display name: a different human, never merged
      assert.notEqual(bea.id, alex.id);

      // pairing happy path
      const start = run(["user", "pair", "start", alex.id, "--channel", "telegram"]);
      assert.equal(start.schema, "user.pair.start/1");
      assert.match(start.code, /^[A-Z2-9]{8}$/);
      const claim = run(["user", "pair", "claim", start.code, "--channel", "telegram", "--account", "bot1", "--user-id", "4242", "--display-name", "Alex"]);
      assert.equal(claim.state, "awaiting-confirmation", JSON.stringify(claim));
      let list = run(["user", "ls"]);
      assert.equal(list.schema, "user.ls/1");
      assert.equal(list.humans.find((x: any) => x.id === alex.id).identities.length, 0, "a claim alone links nothing");
      assert.equal(list.pairings.length, 1);
      assert.equal(JSON.stringify(list).includes(start.code), false, "ls never shows a code");
      const done = run(["user", "pair", "confirm", claim.pairingId]);
      assert.equal(done.state, "confirmed", JSON.stringify(done));
      list = run(["user", "ls"]);
      assert.equal(list.humans.find((x: any) => x.id === alex.id).identities.length, 1);
      assert.equal(list.humans.find((x: any) => x.id === bea.id).identities.length, 0, "no heuristic link by display name");

      // a reused code is refused
      const reuse = run(["user", "pair", "claim", start.code, "--channel", "telegram", "--account", "bot1", "--user-id", "7"], true);
      assert.equal(reuse.exit, 1);
      assert.equal(reuse.doc.error, "E_DENIED");
      assert.equal(reuse.doc.reason, "invalid-code");

      // manual link, exclusivity, unlink revokes at once
      const manual = run(["user", "link", alex.id, "--channel", "discord", "--account", "g1", "--user-id", "9001"]);
      assert.equal(manual.proofMethod, "owner_manual");
      const clash = run(["user", "link", bea.id, "--channel", "discord", "--account", "g1", "--user-id", "9001"], true);
      assert.equal(clash.doc.error, "E_CONFLICT");
      const gone = run(["user", "unlink", manual.id]);
      assert.equal(typeof gone.revokedAt, "number");
      assert.equal(run(["user", "ls"]).humans.find((x: any) => x.id === alex.id).identities.length, 1);
      assert.equal(run(["user", "ls", "--all"]).humans.find((x: any) => x.id === alex.id).identities.length, 2);

      // brute force: five wrong codes, then even a fresh handle's sixth guess is only refused as a lock for that handle
      for (let i = 0; i < 5; i++) assert.equal(run(["user", "pair", "claim", "ZZZZZZZZ", "--channel", "telegram", "--account", "b", "--user-id", "brute"], true).doc.reason, "invalid-code");
      const locked = run(["user", "pair", "claim", "ZZZZZZZZ", "--channel", "telegram", "--account", "b", "--user-id", "brute"], true);
      assert.equal(locked.doc.reason, "rate-limited", JSON.stringify(locked.doc));

      // codes never logged: not in any log, not in the audit file
      const audit = readFileSync(join(h, "logs", "audit.log"), "utf8");
      assert.ok(audit.includes("identity.pair.confirm") && audit.includes("identity.unlink"));
      assert.equal(audit.includes(start.code), false);
      assert.equal(audit.includes("ZZZZZZZZ"), false);
      for (const f of ["core.log"]) { try { assert.equal(readFileSync(join(h, "logs", f), "utf8").includes(start.code), false); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } }
    } finally {
      if (core) await stopCore(core);
      rmSync(h, { recursive: true, force: true });
    }
  });
});
