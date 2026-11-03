/** Data-driven validation mutations across every task/language, including all six coupled tasks. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript";
import { TEAM_ROOT, TEAM_TASKS, materializer, verifyFixture } from "./team-support.ts";
import type { TeamLanguage } from "../../../src/collab/team-eval.ts";

interface GuardMutation {
  task: string;
  scope: string;
  rule: string;
  needle: string;
  replacement: string;
}
const MUTATIONS = JSON.parse(
  await readFile(new URL("team-guard-cases.json", import.meta.url), "utf8"),
) as GuardMutation[];
assert.deepEqual([...new Set(MUTATIONS.map((item) => item.task))].sort(), TEAM_TASKS.map((task) => task.id).sort());

function functionRange(source: string, language: TeamLanguage, name: string): [number, number] {
  if (language === "typescript") {
    const ast = ts.createSourceFile("candidate.ts", source, ts.ScriptTarget.Latest, true);
    const node = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
    if (!node) throw new Error("mutation function not found");
    return [node.getStart(ast), node.end];
  }
  if (language === "python") {
    const start = source.indexOf(`def ${name}(`);
    const end = source.indexOf("\ndef ", start + 1);
    if (start < 0) throw new Error("mutation function not found");
    return [start, end < 0 ? source.length : end];
  }
  const start = source.search(new RegExp(`\\b(?:func|fn)\\s+${name}\\s*\\(`));
  if (start < 0) throw new Error("mutation function not found");
  const masked = source.replace(/"(?:\\.|[^"\\])*"|`[^`]*`|'(?:\\.|[^'\\])*'|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (value) =>
    value.replace(/[^\n]/g, " "),
  );
  const body = masked.indexOf("{", start);
  let depth = 1;
  let end = body + 1;
  while (depth && end < masked.length) {
    if (masked[end] === "{") depth++;
    if (masked[end] === "}") depth--;
    end++;
  }
  if (body < 0 || depth) throw new Error("mutation function has no complete body");
  return [start, end];
}

function mutate(source: string, language: TeamLanguage, symbol: string, mutation: GuardMutation): string {
  const original = symbol.replaceAll("__SEED__", "");
  const name = language === "go" ? `impl${original}` : `impl_${original}`;
  const [start, end] = functionRange(source, language, name);
  const body = source.slice(start, end);
  assert.equal(body.split(mutation.needle).length - 1, 1, `unique guard anchor: ${mutation.rule}`);
  const replacement = mutation.replacement.replaceAll("$MATCH", mutation.needle);
  return source.slice(0, start) + body.replace(mutation.needle, () => replacement) + source.slice(end);
}

/** Register a shardable language gate; known rule mutations must fail behavioral cases while still running valid cases. */
export function languageGuardTests(language: TeamLanguage): void {
  test(
    `guard mutations (${language}): behavioral failures or typed K2 platform refusal`,
    async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "p1b-team-guards-"));
    let checked = 0;
    const mutations = MUTATIONS.filter(
      (item) => TEAM_TASKS.find((task) => task.id === item.task)!.language === language,
    );
    assert.ok(mutations.length > 0);
    try {
      for (const [index, mutation] of mutations.entries()) {
        const task = TEAM_TASKS.find((task) => task.id === mutation.task)!;
        const candidate = join(directory, String(index));
        const item = task.packages.find((item) => item.id === mutation.scope)!;
        await materializer.materialize(
          fileURLToPath(new URL(`${task.id}/`, TEAM_ROOT)),
          candidate,
          task.seeds[0],
          task.packages.length,
        );
        const instance = JSON.parse(await readFile(join(candidate, "instance.json"), "utf8")) as { tag: string };
        const path = join(candidate, item.entry.replaceAll("__SEED__", instance.tag));
        await writeFile(path, mutate(await readFile(path, "utf8"), language, item.symbol, mutation));
        const report = await verifyFixture(task, candidate, task.seeds[0]!, {
          scope: mutation.scope,
          runtimes: { go: { env: { GOCACHE: join(directory, "cache") } } },
        });
        if (process.platform === "win32") {
          assert.equal(report.result.reason, "unavailable");
          assert.deepEqual(report.infrastructure, ["platform-unavailable"]);
        } else {
          const check = report.checks[0]!;
          assert.equal(report.result.reason, "unresolved", JSON.stringify({ mutation, report }));
          assert.ok(
            check.failures.length > 0 && check.failures.length < check.cases,
            `${mutation.task}/${mutation.rule}: valid cases must prove the mutant compiled and ran`,
          );
        }
        checked++;
      }
      assert.equal(checked, mutations.length);
      t.diagnostic(`${checked} validation mutants ${process.platform === "win32" ? "refused" : "killed"}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
