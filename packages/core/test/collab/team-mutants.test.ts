/** Twelve review-proven surviving mutants must now lose actual behavioral cases, not only fail compilation. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { TEAM_ROOT, TEAM_TASKS, materializer, verifyFixture } from "./fixtures/team-support.ts";

function replaceOnce(source: string, pattern: string | RegExp, replacement: string): string {
  const result = source.replace(pattern, replacement);
  assert.notEqual(result, source, `mutation anchor must exist: ${pattern}`);
  return result;
}

const MUTANTS = [
  {
    task: "go-access-log",
    scope: "parse",
    rule: "field count and absolute path",
    mutate: (s: string) =>
      replaceOnce(
        s,
        'if len(fields) != 4 || !strings.HasPrefix(fields[1], "/") {',
        'if false && (len(fields) != 4 || !strings.HasPrefix(fields[1], "/")) {',
      ),
  },
  {
    task: "go-access-log",
    scope: "parse",
    rule: "method allowlist",
    mutate: (s: string) => replaceOnce(s, /default:\s*return "error"/, "default:"),
  },
  {
    task: "go-access-log",
    scope: "families",
    rule: "status range and latency",
    mutate: (s: string) =>
      replaceOnce(
        s,
        "if e1 != nil || e2 != nil || status < 100 || status > 599 || latency < 0 {",
        "if false && (e1 != nil || e2 != nil || status < 100 || status > 599 || latency < 0) {",
      ),
  },
  {
    task: "go-access-log",
    scope: "report",
    rule: "family shape and range",
    mutate: (s: string) =>
      replaceOnce(
        s,
        / \|\| len\(pair\[0\]\) != 3 \|\| pair\[0\]\[1:\] != "xx" \|\| pair\[0\]\[0\] < '1' \|\| pair\[0\]\[0\] > '5'/,
        "",
      ),
  },
  {
    task: "go-access-log",
    scope: "report",
    rule: "distinct families",
    mutate: (s: string) => replaceOnce(s, " || seen[pair[0]]", ""),
  },
  {
    task: "ts-calendar",
    scope: "choose",
    rule: "equal-length tie break",
    mutate: (s: string) => replaceOnce(s, /\s*\|\|\s*a\[0\]!\s*-\s*b\[0\]!/, ""),
  },
  {
    task: "ts-calendar",
    scope: "gaps",
    rule: "malformed interval",
    mutate: (s: string) => replaceOnce(s, /if\s*\(!m\)/, "if (false && !m)"),
  },
  {
    task: "ts-calendar",
    scope: "merge",
    rule: "malformed interval",
    mutate: (s: string) => replaceOnce(s, /if\s*\(!m\)/, "if (false && !m)"),
  },
  {
    task: "go-stock-ledger",
    scope: "decode",
    rule: "decode record shape and SKU",
    mutate: (s: string) =>
      replaceOnce(
        s,
        "if len(fields) != 3 || !valid.MatchString(fields[1]) {",
        "if false && (len(fields) != 3 || !valid.MatchString(fields[1])) {",
      ),
  },
  {
    task: "go-stock-ledger",
    scope: "apply",
    rule: "apply record shape and SKU",
    mutate: (s: string) =>
      replaceOnce(
        s,
        'if len(fields) != 3 || !valid.MatchString(fields[1]) || (fields[0] != "A" && fields[0] != "R") {',
        'if false && (len(fields) != 3 || !valid.MatchString(fields[1]) || (fields[0] != "A" && fields[0] != "R")) {',
      ),
  },
  {
    task: "go-stock-ledger",
    scope: "render",
    rule: "render record shape, SKU and uniqueness",
    mutate: (s: string) =>
      replaceOnce(
        s,
        "if len(fields) != 2 || !valid.MatchString(fields[0]) || seen[fields[0]] {",
        "if false && (len(fields) != 2 || !valid.MatchString(fields[0]) || seen[fields[0]]) {",
      ),
  },
  {
    task: "rs-range-set",
    scope: "describe",
    rule: "nonempty ASCII unsigned decimal",
    mutate: (s: string) =>
      replaceOnce(
        s,
        "if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {",
        "if false && (raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit())) {",
      ),
  },
];

test("all twelve previously surviving review mutations are killed by the expanded oracle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "p1b-team-mutants-"));
  try {
    let killed = 0;
    for (const [index, mutant] of MUTANTS.entries()) {
      const task = TEAM_TASKS.find((task) => task.id === mutant.task)!;
      const candidate = join(directory, String(index));
      await materializer.materialize(
        fileURLToPath(new URL(`${task.id}/`, TEAM_ROOT)),
        candidate,
        task.seeds[0],
        task.packages.length,
      );
      const instance = JSON.parse(await readFile(join(candidate, "instance.json"), "utf8")) as { tag: string };
      const item = task.packages.find((item) => item.id === mutant.scope)!;
      const file = join(candidate, item.entry.replaceAll("__SEED__", instance.tag));
      await writeFile(file, mutant.mutate(await readFile(file, "utf8")));
      const report = await verifyFixture(task, candidate, task.seeds[0]!, {
        runtimes: { go: { env: { GOCACHE: join(directory, "cache") } } },
      });
      if (process.platform === "win32") {
        assert.equal(report.result.reason, "unavailable");
        assert.deepEqual(report.infrastructure, ["platform-unavailable"]);
      } else {
        const check = report.checks.find((check) => check.scope === mutant.scope)!;
        assert.equal(report.result.unavailable, false, mutant.rule);
        assert.equal(check.passed, false, mutant.rule);
        assert.ok(
          check.failures.length > 0 && check.failures.length < check.cases,
          `${mutant.rule}: at least one successful case proves the mutated code compiled and ran`,
        );
      }
      killed++;
    }
    assert.equal(killed, 12);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
