import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const repo = process.env.PLUR1BUS_ENGINE_GIT;
assert(repo && process.version === "v24.21.0");
const pin = "c3cf52fda7ad281dca1277ce00bc981f3fa344e1";
const file = "lib/dreaming/dream-diary.js";
const source = execFileSync("git", ["-C", repo, "show", pin + ":" + file], { encoding: "utf8" });
const sha = text => createHash("sha256").update(text).digest("hex");
const body = source.replace(/^import \{ loadHostSdk \} from .+;$/m, "");
const diary = await import("data:text/javascript," + encodeURIComponent(body));
const narrative = "The quiet garden was silver under the full moon.";
const alternate = "A lantern lit the path around the sleeping garden.";
const initial = "A note left by the reader.\r\n";
const now = 1_768_305_600_000;
const run = "logical-rem-window";
function record() {
  const dates = ["UTC", "Europe/Berlin", "Asia/Kolkata", "America/New_York"].map(timezone => ({
    timezone, text: diary.formatDiaryDate(now, timezone),
  }));
  const entry = diary.buildDiaryEntry({ narrative, mode: "rem", dateText: dates[0].text, idempotencyKey: run });
  const first = diary.insertDiaryEntry(initial, entry, { narrative, mode: "rem", idempotencyKey: run });
  const retryEntry = diary.buildDiaryEntry({ narrative: alternate, mode: "rem", dateText: dates[0].text, idempotencyKey: run });
  const retry = diary.insertDiaryEntry(first.content, retryEntry, { narrative: alternate, mode: "rem", idempotencyKey: run });
  assert.equal(first.changed, true);
  assert.equal(retry.reason, "already_present");
  return JSON.stringify({
    pin, file, sourceSha256: sha(source), now, narrative, alternate, initial, run, dates,
    fingerprint: diary.narrativeFingerprint(narrative), firstBodySha256: sha(first.content),
  }, null, 2) + "\n";
}
const output = record();
assert.equal(record(), output);
writeFileSync(new URL("./dream-diary.json", import.meta.url), output);
console.log(`Recorded two runs from ${pin}. SHA-256 ${sha(output)}`);
