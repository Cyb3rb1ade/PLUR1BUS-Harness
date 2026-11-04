// Real-Core archive policy keeps API accounts opt-in and preserves destination credentials when they were omitted.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { REAL, cli, home, startCore, stopCore, type RunningCore } from "./helpers.ts";
import { defaults, validate } from "../../packages/config-schema/src/index.ts";
import { AccountStore } from "../../packages/api/src/account-store.ts";

const QUERIES = ["when is the roadmap review", "quarterly budget draft", "harbour tour"];
const FACTS = [
  "Please remember that the roadmap review is on Thursday at ten.",
  "Please remember that the quarterly budget draft is due in March.",
  "Please remember that the harbour tour starts at noon on Saturday.",
];

describe("M8 — backup and restore against a real core", () => {
  it("ordinary backups omit API accounts by default, preserve destination accounts, and restore an explicit opt-in", { timeout: 120_000 }, async () => {
    const h = home(), ordinary = join(h, "ordinary.tar.gz"), inclusive = join(h, "inclusive.tar.gz");
    const accountPath = join(h, "state", "api", "accounts.db");
    const sourceHash = randomBytes(32).toString("hex"), destinationHash = randomBytes(32).toString("hex");
    let core: RunningCore | undefined;
    const passwordHash = (): unknown => {
      const db = new DatabaseSync(accountPath, { readOnly: true });
      try { return db.prepare("SELECT password_hash FROM accounts WHERE person_id=?").get("backup-person")?.password_hash; }
      finally { db.close(); }
    };
    try {
      writeFileSync(join(h, "config.json"), JSON.stringify(defaults()));
      const accounts = new AccountStore({ path: accountPath, resolve: async () => null });
      try {
        await accounts.createPending("backup-person", "backup-person", sourceHash);
        await accounts.activate("backup-person");
      } finally { accounts.close(); }
      const publicDb = new DatabaseSync(join(h, "state", "public.sqlite"));
      try { publicDb.exec("CREATE TABLE public_control(value TEXT); INSERT INTO public_control VALUES ('public-value')"); }
      finally { publicDb.close(); }
      core = await startCore(h);
      const omitted = cli(h, ["backup", "create", "--out", ordinary]);
      assert.ok(!omitted.units.includes("state/api/accounts.db"));
      assert.ok(omitted.units.includes("state/public.sqlite"), "an unrelated database stays selected");
      const plain = gunzipSync(readFileSync(ordinary));
      assert.ok(!plain.includes(sourceHash), "the ordinary archive must omit API credential bytes");
      assert.ok(!plain.includes("data/sqlite/api/accounts.db"), "the account file must not be a tar entry");
      assert.ok(!cli(h, ["backup", "verify", ordinary]).units.includes("state/api/accounts.db"));
      const included = cli(h, ["backup", "create", "--out", inclusive, "--include-api-accounts"]);
      assert.ok(included.units.includes("state/api/accounts.db"));
      assert.ok(gunzipSync(readFileSync(inclusive)).includes(sourceHash));
      await stopCore(core); core = undefined;
      const destination = new AccountStore({ path: accountPath, resolve: async () => null });
      try { await destination.updatePasswordHash("backup-person", destinationHash); }
      finally { destination.close(); }
      const dry = cli(h, ["backup", "restore", "--dry-run", ordinary]);
      assert.ok(!dry.units.some((unit: { target: string }) => unit.target === "state/api/accounts.db"));
      assert.ok(!dry.removed.includes("state/api/accounts.db"));
      assert.equal(passwordHash(), destinationHash);
      assert.equal(cli(h, ["backup", "restore", "--yes", ordinary]).applied, true);
      assert.equal(passwordHash(), destinationHash, "omission preserves the destination account");
      assert.equal(cli(h, ["backup", "restore", "--yes", inclusive]).applied, true);
      assert.equal(passwordHash(), sourceHash, "opt-in restores the backed-up account");
    } finally {
      if (core) await stopCore(core);
      rmSync(h, { recursive: true, force: true });
    }
  });
  it("ordinary URL credential placeholders survive create → restore → TS validation", { timeout: 120_000 }, async () => {
    const h = home(), archive = join(h, "credential-snapshot.tar.gz");
    let core: RunningCore | undefined;
    const canary = randomBytes(32).toString("hex"), reference = "voice-elevenlabs-key";
    const config = defaults();
    config.voice.providers.elevenlabs.baseUrl = `https://user:${canary}@provider.example/public/path?token=${canary}#auth=${canary}`;
    config.voice.providers.elevenlabs.apiKeyRef = reference;
    writeFileSync(join(h, "config.json"), JSON.stringify(config));
    assert.ok(validate(config).ok);
    try {
      core = await startCore(h);
      const created = cli(h, ["backup", "create", "--out", archive]);
      assert.equal(created.schema, "backup.create/1");
      const raw = gunzipSync(readFileSync(archive));
      assert.ok(!raw.includes(canary), "a literal URL credential entered the archive");
      assert.ok(raw.includes(reference), "the reference name must survive byte-for-byte");
      await stopCore(core); core = undefined;
      writeFileSync(join(h, "config.json"), JSON.stringify(defaults()));
      assert.equal(cli(h, ["backup", "restore", "--yes", archive]).applied, true);
      const restored = JSON.parse(readFileSync(join(h, "config.json"), "utf8"));
      assert.equal(restored.voice.providers.elevenlabs.baseUrl,
        "https://REDACTED@provider.example/public/path?token=REDACTED#auth=REDACTED");
      assert.equal(restored.voice.providers.elevenlabs.apiKeyRef, reference);
      assert.ok(validate(restored).ok, "the real restored config must satisfy the TS URI validator");
    } finally {
      if (core) await stopCore(core);
      rmSync(h, { recursive: true, force: true });
    }
  });
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
        assert.equal(cli(h, ["backup", "verify", f], { allowFail: true }).exit, 2, f); // E_INVALID_PARAMS (docs/errors.md exit table)
        assert.equal(cli(h, ["backup", "restore", "--yes", f], { allowFail: true }).exit, 2, f);
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
      // KNOWN GAP (docs/ops/backup-restore.md): `idsBefore[0]` was forgotten after the backup and is active again in the restored
      // rows, which is what this asserts while the pinned engine has no lib/tombstone-reapply.js (the core then keeps
      // state/.restore-reapply-tombstones and warns). With an engine that has it, the start re-applies the committed
      // tombstone and the forgotten memory must stay gone: flip this assertion (and the recall one) when the pin moves; the
      // tripwire in packages/core/test/restore-reapply.test.ts turns red at that point.
      assert.ok(existsSync(join(h, "state", ".restore-reapply-tombstones")) || !ids().includes(idsBefore[0]!), "a restore leaves the re-apply marker unless the engine already settled it");
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
