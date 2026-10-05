// Leak test: plain channel user/group ids and cron delivery targets must never reach report.json, ledger.jsonl,
// the returned report object or the rendered terminal output (docs/import.md "Report privacy").
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { importOpenclaw } from "../../src/import/importers/openclaw.ts";
import { renderOpenclaw } from "../../src/import/render.ts";
import { idFingerprint } from "../../src/import/fingerprint.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { buildM7OpenclawFixture, type M7OpenclawFixture } from "./fixtures.ts";

// Known ids from the fixture's `channels.telegram` section, plus a cron delivery target and job name.
const SECRET_IDS = ["12345678", "87654321", "-100123456789", "100123456789"];
const CRON_NAME = "user-sync";

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

describe("OpenClaw importer: no plain channel ids in reports (L1)", () => {
  let fx: M7OpenclawFixture;

  before(async () => {
    fx = await buildM7OpenclawFixture();
    const db = new DatabaseSync(join(fx.root, "state", "openclaw.sqlite"));
    db.exec("ALTER TABLE cron_jobs ADD COLUMN deliver TEXT");
    db.exec("UPDATE cron_jobs SET deliver = 'telegram:12345678' WHERE id = 'j1'");
    db.exec("UPDATE cron_jobs SET deliver = '87654321' WHERE id = 'j2'");
    db.close();
  });

  after(() => fx.close());

  it("report.json, ledger.jsonl, returned report and rendered output contain no plain ids", { timeout: 30_000 }, async () => {
    const home = tempDir("p1b-test-home-");
    const report = await importOpenclaw({ home, source: fx.root, apply: true });

    const files = filesUnder(join(home, "imports")).filter((f) => /report\.json$|ledger\.jsonl$/.test(f));
    assert.ok(files.some((f) => f.endsWith("report.json")), "report.json missing");
    assert.ok(files.some((f) => f.endsWith("ledger.jsonl")), "ledger.jsonl missing");

    const haystacks: Array<[string, string]> = [
      ...files.map((f): [string, string] => [f, readFileSync(f).toString("latin1")]),
      ["returned report", JSON.stringify(report)],
      ["rendered output", renderOpenclaw(report)],
    ];
    for (const [where, text] of haystacks) {
      for (const id of [...SECRET_IDS, CRON_NAME]) {
        assert.ok(!text.includes(id), `${where} leaks ${id}`);
      }
    }
  });

  it("reports counts, fingerprints and deliver kind instead", { timeout: 30_000 }, async () => {
    const report = await importOpenclaw({ home: tempDir("p1b-test-home-"), source: fx.root });
    const tg = report.channels[0]!;
    assert.equal(tg.allowFromCount, 2);
    assert.equal(tg.groupsCount, 1);
    assert.deepEqual(tg.allowFromFingerprints, ["12345678", "87654321"].map((i) => idFingerprint("telegram", i)).sort());
    assert.match(tg.allowFromFingerprints[0]!, /^[0-9a-f]{8}$/);
    const rendered = renderOpenclaw(report);
    assert.ok(rendered.includes(tg.allowFromFingerprints[0]!));
    assert.deepEqual(report.cron.jobs.map((j) => [j.id, j.deliverKind]), [["j1", "telegram"], ["j2", "other"]]);
  });

  it("fingerprints are stable and channel-scoped", () => {
    assert.equal(idFingerprint("telegram", "1"), idFingerprint("telegram", "1"));
    assert.notEqual(idFingerprint("telegram", "1"), idFingerprint("discord", "1"));
  });
});
