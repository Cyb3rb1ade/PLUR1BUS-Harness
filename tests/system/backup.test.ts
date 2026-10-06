import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { REAL, cli, home, startCore, stopCore, type RunningCore } from "./helpers.ts";

const QUERIES = ["when is the roadmap review", "quarterly budget draft", "harbour tour"];
const FACTS = [
  "Please remember that the roadmap review is on Thursday at ten.",
  "Please remember that the quarterly budget draft is due in March.",
  "Please remember that the harbour tour starts at noon on Saturday.",
];

describe("M8 — backup and restore against a real core", () => {
  it("create → restore round trip gives identical recall; corrupt archives and failed restores change nothing", { skip: REAL && "flat embedder only", timeout: 300_000 }, async (t) => {
    const h = home();
    let core: RunningCore | undefined;
    const testEnv = (extra: NodeJS.ProcessEnv = {}) => ({ ...process.env, PLUR1BUS_ALLOW_TEST_INTERNALS: "1", ...extra });
    // The recalled memory records, in order: id and quoted text. The other blocks (temporal context, mood) depend on the
    // clock and on per-session recall state, not on what the store holds.
    const recallAll = () => QUERIES.map((q) => {
      const r = cli(h, ["memory", "recall", "--agent", "bernd", q]);
      assert.equal(r.degraded, null, JSON.stringify(r));
      const text = r.blocks.map((b: any) => b.text as string).join("\n");
      return [...text.matchAll(/<memory-record [^>]*\bid="([^"]+)"[^>]*><quoted-evidence>([^<]*)<\/quoted-evidence>/g)].map((m) => ({ id: m[1], text: m[2] }));
    });
    const ids = () => cli(h, ["memory", "list", "--agent", "bernd"]).items.map((i: any) => i.id as string).sort();
    const archive = join(h, "snap.tar.gz");
    try {
      cli(h, ["agent", "create", "bernd"]);
      cli(h, ["config", "set", "engine.duplicateThreshold", "1.01", "--yes"]);
      core = await startCore(h);
      for (const f of FACTS) assert.equal(cli(h, ["memory", "add", "--agent", "bernd", "--session", "s1", f]).stored, 1);
      const recallBefore = recallAll();
      const idsBefore = ids();
      assert.equal(idsBefore.length, 3);
      assert.ok(recallBefore.every((records) => records.length > 0), `every query recalls memories: ${JSON.stringify(recallBefore)}`);

      // ── create (core running)
      const created = cli(h, ["backup", "create", "--out", archive]);
      assert.equal(created.schema, "backup.create/1");
      assert.equal(created.path, archive);
      assert.ok(created.files > 0 && created.units.includes("state/lancedb") && created.units.includes("config.json"), JSON.stringify(created));
      assert.equal(created.secrets.included, false);
      if (process.platform !== "win32") assert.equal(statSync(archive).mode & 0o077, 0, "the archive is private");
      assert.deepEqual(readdirOrEmpty(join(h, "state", "backup-staging")), [], "staging is removed");
      // No secret in the archive: the core's token (run/core.token) is nowhere in the decompressed bytes, and no run/ entry.
      const token = readFileSync(join(h, "run", "core.token"), "utf8").trim();
      const raw = gunzipSync(readFileSync(archive));
      assert.ok(token.length >= 16 && !raw.includes(token), "the token must not be archived");
      assert.ok(!raw.includes("run/core.token"), "no run/ entry");
      const verified = cli(h, ["backup", "verify", archive]);
      assert.equal(verified.schema, "backup.verify/1");
      assert.equal(verified.ok, true);

      // ── mutate: more memories, a forgotten one, another agent
      cli(h, ["memory", "add", "--agent", "bernd", "--session", "s1", "Please remember that the offsite is in June."]);
      cli(h, ["memory", "forget", "--agent", "bernd", "--yes", idsBefore[0]!]);
      cli(h, ["agent", "create", "anna"]);
      assert.notDeepEqual(ids(), idsBefore);

      // ── a running core refuses the restore and nothing changes
      const refused = cli(h, ["backup", "restore", "--yes", archive], { allowFail: true });
      assert.equal(refused.exit, 3, JSON.stringify(refused));
      assert.equal(JSON.parse(refused.stdout).reason, "core-running");
      await stopCore(core); core = undefined;

      // ── corrupt archives: verify and restore refuse, the state stays
      const flipped = join(h, "flipped.tar.gz"); const cut = join(h, "cut.tar.gz");
      const bytes = readFileSync(archive);
      const bad = Buffer.from(bytes); bad[Math.floor(bad.length / 2)]! ^= 0xff;
      writeFileSync(flipped, bad); writeFileSync(cut, bytes.subarray(0, bytes.length - 100));
      for (const f of [flipped, cut]) {
        assert.equal(cli(h, ["backup", "verify", f], { allowFail: true }).exit, 1, f);
        assert.equal(cli(h, ["backup", "restore", "--yes", f], { allowFail: true }).exit, 1, f);
      }

      // ── a failed restore leaves the current (mutated) state: start a core and see the mutation, then stop it again
      const failed = cli(h, ["backup", "restore", "--yes", archive], { allowFail: true, env: testEnv({ PLUR1BUS_TEST_BACKUP_FAIL_AT: "swap-after:1" }) });
      assert.equal(failed.exit, 1, JSON.stringify(failed));
      assert.equal(JSON.parse(failed.stdout).reason, "restore-failed");
      core = await startCore(h);
      assert.equal(ids().length, 3, "the failed restore left the mutated store (3 = 3 + 1 added − 1 forgotten)");
      assert.ok(JSON.stringify(cli(h, ["agent", "list"])).includes("anna"), "anna still exists");
      await stopCore(core); core = undefined;

      // ── the restore
      const dry = cli(h, ["backup", "restore", "--dry-run", archive]);
      assert.equal(dry.dryRun, true);
      const restored = cli(h, ["backup", "restore", "--yes", archive]);
      assert.equal(restored.applied, true, JSON.stringify(restored));
      assert.ok(existsSync(restored.preRestore), "the replaced state is kept");
      core = await startCore(h);
      assert.deepEqual(ids(), idsBefore, "the same memories");
      assert.deepEqual(recallAll(), recallBefore, "identical recall results");
      assert.ok(!JSON.stringify(cli(h, ["agent", "list"])).includes("anna"), "the agent created after the backup is gone");
      t.diagnostic(`restored ${created.files} files; recall identical for ${QUERIES.length} queries`);
    } finally {
      if (core) await stopCore(core);
      rmSync(h, { recursive: true, force: true });
    }
  });
});

function readdirOrEmpty(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}
