// The reader and the verdict of the P4D-7 two-writer run (p4-11-log-writers.ts), on files written here; the run itself
// needs the built front door and is part of the nightly parity step.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "../../packages/core/test/helpers/temp-dir.ts";
import { inspectLogs, judge } from "./p4-11-log-writers.ts";

const front = (n: number) => JSON.stringify({ at: "2026-11-15T00:00:00.000Z", level: "info", role: "core", src: "front-door", connectionId: `c${n}`, msg: "adopted" });
const legacy = (n: number) => JSON.stringify({ at: "2026-11-15T00:00:00.000Z", level: "info", role: "core", connectionId: `l${n}`, state: "ready", msg: "adopted" });

function logs(files: Record<string, string>): string {
  const dir = join(tempDir("p1b-logw-test-"), "logs");
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

test("a rotated log with one line per writer and adoption passes", () => {
  const dir = logs({
    "core.log": [front(3), legacy(3), ""].join("\n"),
    "core.log.1": [JSON.stringify({ level: "info", event: "core.process.ready" }), legacy(1), front(1), front(2), legacy(2), ""].join("\n"),
    "core.log.writer-lock": "", "engine.log": "not json\n", "core.log.tmp": "not json\n",
  });
  const found = inspectLogs(dir);
  assert.deepEqual(found.files.map((f) => f.name), ["core.log", "core.log.1"]);
  assert.deepEqual([found.lines, found.frontDoor, found.legacy, found.frontDoorLines, found.frontDoorDropped, found.torn.length], [7, 3, 3, 3, 0, 0]);
  assert.deepEqual(judge(found, 3, 3), []);
});

test("a line the front door reports as dropped is accounted for; one missing without that report is lost", () => {
  const dropped = (n: number) => JSON.stringify({ at: "2026-11-15T00:00:00.000Z", level: "warn", role: "core", dropped: n, src: "front-door", msg: "front door log lines dropped" });
  const files = (extra: string[]) => ({ "core.log": [front(4), legacy(4), ...extra, ""].join("\n"), "core.log.1": [front(1), legacy(1), legacy(2), legacy(3), ""].join("\n") });
  assert.deepEqual(judge(inspectLogs(logs(files([dropped(1), dropped(1)]))), 4, 4), []);
  assert.match(judge(inspectLogs(logs(files([dropped(1)]))), 4, 4).join("; "), /the front door wrote 2 "adopted" lines and reports 1 dropped for 4 adoptions/);
  assert.match(judge(inspectLogs(logs(files([front(5)]))), 4, 4).join("; "), /the front door wrote 3 "adopted" lines and reports 0 dropped/);
  // A report alone is not a pass: most lines must have been written.
  const mostly = { "core.log": [dropped(3), legacy(1), legacy(2), ""].join("\n"), "core.log.1": [front(1), legacy(3), legacy(4), ""].join("\n") };
  assert.match(judge(inspectLogs(logs(mostly)), 4, 4).join("; "), /the front door dropped most of its lines \(1 of 4 written\)/);
});

test("a torn line, a lost line, a refused adoption, a log that did not rotate and an oversized file are each a finding", () => {
  const whole = { "core.log": [front(2), legacy(2), ""].join("\n"), "core.log.1": [front(1), legacy(1), ""].join("\n") };
  const finding = (files: Record<string, string>, adoptions = 2, accepted = 2, maxBytes?: number) => judge(inspectLogs(logs(files)), adoptions, accepted, maxBytes);
  assert.deepEqual(finding(whole), []);
  // Two writers inside one line, and a file that ends inside a line.
  const half = front(2).slice(0, 40);
  assert.match(finding({ ...whole, "core.log": `${half}${legacy(2)}\n${front(2)}\n` }).join("; "), /1 torn lines/);
  assert.match(finding({ ...whole, "core.log": `${front(2)}\n${legacy(2)}` }).join("; "), /torn lines, the first: core\.log: no newline at the end/);
  assert.match(finding({ ...whole, "core.log": "[1]\n" + whole["core.log"] }).join("; "), /1 torn lines/);
  assert.match(finding({ ...whole, "core.log": `${legacy(2)}\n` }).join("; "), /the front door wrote 1 "adopted" lines and reports 0 dropped for 2 adoptions/);
  assert.match(finding({ ...whole, "core.log": `${front(2)}\n` }).join("; "), /the TypeScript core wrote 1 "adopted" lines for 2 adoptions/);
  assert.match(finding(whole, 2, 1).join("; "), /1 of 2 adoptions were accepted/);
  assert.match(finding({ "core.log": whole["core.log"] + whole["core.log.1"] }).join("; "), /the log did not rotate \(core\.log \d+\)/);
  assert.match(finding({}, 0, 0).join("; "), /the log did not rotate \(no file\)/);
  assert.match(finding(whole, 2, 2, 100).join("; "), /a file grew to \d+ bytes with a limit of 100/);
});
