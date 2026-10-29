/** GUI maintenance must recover from durable metadata, without credential values or caller-chosen file paths. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, lstatSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { useTempDirs } from "./helpers.ts";

const temp = useTempDirs();
const RUN = "20261028T120000Z-12345678";
const HASH = "a".repeat(64);
const MARKER = "fixture-maintenance-secret-never-serialized";

async function factory() {
  const module = await import("../../src/import/maintenance-journal.ts").catch(() => undefined);
  assert.equal(typeof module?.openMaintenanceJournal, "function", "durable maintenance journal must exist");
  return module!;
}

describe("import maintenance journal", () => {
  it("persists each phase and reopens the same bounded, private run metadata", async () => {
    const api = await factory();
    const home = temp();
    const journal = api.openMaintenanceJournal(home, RUN);
    assert.equal(journal.read().phase, "prepared");
    journal.advance("snapshotting");
    journal.advance("snapshot-complete", { snapshotSha256: HASH });
    journal.advance("applying");
    const reopened = api.openMaintenanceJournal(home, RUN);
    assert.equal(reopened.read().phase, "applying");
    assert.equal(reopened.read().snapshotSha256, HASH);
    assert.deepEqual(reopened.read().history.map(entry => entry.phase),
      ["prepared", "snapshotting", "snapshot-complete", "applying"]);
    if (process.platform !== "win32") {
      assert.equal(lstatSync(join(home, "imports", RUN)).mode & 0o777, 0o700);
      assert.equal(lstatSync(join(home, "imports", RUN, "maintenance.json")).mode & 0o777, 0o600);
    }
  });

  it("records missing-only secret intent before creation and keeps attempt history after full restore", async () => {
    const api = await factory();
    const home = temp();
    const journal = api.openMaintenanceJournal(home, RUN);
    journal.advance("snapshotting");
    journal.advance("snapshot-complete", { snapshotSha256: HASH });
    journal.advance("applying");
    assert.throws(() => journal.secretCreated("OPENAI_API_KEY"));
    journal.secretIntent("OPENAI_API_KEY");
    assert.deepEqual(api.openMaintenanceJournal(home, RUN).read().secrets,
      [{ name: "OPENAI_API_KEY", absentBefore: true, created: false, removed: false }]);
    journal.secretCreated("OPENAI_API_KEY");
    journal.advance("rolling-back", { reason: "aborted" });
    journal.secretRemoved("OPENAI_API_KEY");
    journal.advance("restored", { reason: "aborted" });
    journal.resume();
    const value = journal.read();
    assert.equal(value.attempt, 2);
    assert.equal(value.phase, "prepared");
    assert.equal(value.snapshotSha256, HASH, "resume must keep the original cold snapshot");
    assert.equal(value.history.filter(entry => entry.phase === "restored").length, 1);
    assert.deepEqual(value.secrets, []);
  });

  it("rejects invalid transitions, unknown fields and malformed persisted metadata without rewriting it", async () => {
    const api = await factory();
    const home = temp();
    const journal = api.openMaintenanceJournal(home, RUN);
    const file = join(home, "imports", RUN, "maintenance.json");
    const before = readFileSync(file);
    assert.throws(() => journal.advance("committed"));
    assert.throws(() => journal.advance("snapshotting", { secret: MARKER } as never));
    assert.deepEqual(readFileSync(file), before);
    assert.ok(!readFileSync(file, "utf8").includes(MARKER));
    const value = JSON.parse(before.toString("utf8"));
    value.runId = "../another-run";
    writeFileSync(file, JSON.stringify(value));
    const tampered = readFileSync(file);
    assert.throws(() => api.openMaintenanceJournal(home, RUN));
    assert.deepEqual(readFileSync(file), tampered);
  });

  it("refuses traversal and linked run directories before writing any journal outside the home", async () => {
    const api = await factory();
    const home = temp();
    const outside = temp();
    assert.throws(() => api.openMaintenanceJournal(home, "../outside"));
    mkdirSync(join(home, "imports"));
    symlinkSync(outside, join(home, "imports", RUN), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => api.openMaintenanceJournal(home, RUN));
    assert.equal(lstatSync(join(outside, "maintenance.json"), { throwIfNoEntry: false }), undefined);
  });
});
