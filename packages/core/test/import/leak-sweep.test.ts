// leak-sweep.test.ts — M7 acceptance 7 (docs/milestones.md): "Fixtures are hand-authored and synthetic; a grep for known fixture
// tokens finds nothing in any report." This sweeps EVERYTHING a fixture run leaves or prints, not only report.json: the
// whole imports/ tree (report, ledger, snapshot, markers), every log file, the returned report objects, every rendering and
// whatever the run printed to stdout, stderr or the console. FAKE_TOKEN must not appear anywhere in the target home at all.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { layout } from "../../src/paths.ts";
import { importHermes } from "../../src/import/importers/hermes.ts";
import { importOpenclaw } from "../../src/import/importers/openclaw.ts";
import { importSkills } from "../../src/import/skills-import.ts";
import { rollbackImport } from "../../src/import/rollback.ts";
import { renderHermes, renderOpenclaw, renderRollback, renderSkills } from "../../src/import/render.ts";
import { DEFAULT_MAX_SKILL_BYTES } from "../../src/import/skills-scan.ts";
import { buildM7HermesFixture, buildM7OpenclawFixture, CONTENT_MARKER, FAKE_TOKEN } from "./fixtures.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { flatTestInternals } from "../helpers/flat-embedder.ts";

const timeout = 120_000;
// Strings that exist only in the fixtures: secret values, card and message content, cron prompts, pairing names.
const HERMES_TOKENS = [FAKE_TOKEN, CONTENT_MARKER, "morning check", "evening wrap", "alice", "bob", "Hermes memory 1", "Hermes user pref"];
const OPENCLAW_TOKENS = [FAKE_TOKEN, CONTENT_MARKER, "12345678", "87654321", "user-sync"];

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else if (statSync(p).isFile()) out.push(p);
  }
  return out;
}

/** Everything the run printed, via console and the process streams. */
async function captured<T>(fn: () => Promise<T>): Promise<{ value: T; output: string }> {
  const chunks: string[] = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  const take = (c: unknown) => { chunks.push(typeof c === "string" ? c : Buffer.from(c as Uint8Array).toString("latin1")); };
  (process.stdout as any).write = (c: unknown, ...rest: unknown[]) => { take(c); return (out as any)(c, ...rest); };
  (process.stderr as any).write = (c: unknown, ...rest: unknown[]) => { take(c); return (err as any)(c, ...rest); };
  try { return { value: await fn(), output: chunks.join("") }; } finally { process.stdout.write = out as any; process.stderr.write = err as any; }
}

/** `snapshot/` and `replaced/` hold verbatim copies of the user's own target files taken before a write (rollback needs them). They are
 *  the user's data, not a report; the manifest, report and ledger next to them are scanned like everything else. */
const verbatimCopy = (f: string) => /[\\/](snapshot|replaced)[\\/]/.test(f) && !/manifest\.json$/.test(f);

function sweep(home: string, extra: Array<[string, string]>, tokens: string[], opts: { allowInTree: string[] }): void {
  const haystacks: Array<[string, string]> = [...extra];
  for (const f of filesUnder(join(home, "imports")).filter((x) => !verbatimCopy(x))) haystacks.push([f, readFileSync(f).toString("latin1")]);
  for (const f of filesUnder(home).filter((x) => /\.(log|jsonl?)$/.test(x) && !x.includes(`${join(home, "imports")}`))) haystacks.push([f, readFileSync(f).toString("latin1")]);
  assert.ok(haystacks.some(([w]) => w.endsWith("report.json")) && haystacks.some(([w]) => w.endsWith("ledger.jsonl")), "report.json and ledger.jsonl must have been scanned");
  for (const [where, text] of haystacks) {
    for (const t of tokens) assert.ok(!text.includes(t), `${where} contains the fixture token "${t}"`);
  }
  // The secret value may not be anywhere in the home, not even in the copied workspace files or the snapshot copies.
  for (const f of filesUnder(home)) {
    if (opts.allowInTree.some((a) => f.includes(a))) continue;
    assert.ok(!readFileSync(f).toString("latin1").includes(FAKE_TOKEN), `${f} contains the fake secret`);
  }
}

describe("M7 acceptance 7: no fixture token in any report, ledger, log or rendering", () => {
  it("the sweep itself catches a planted token in a report, a ledger, a log and a rendering", () => {
    for (const planted of ["imports/r1/report.json", "imports/r1/ledger.jsonl", "logs/core.log", "extra"]) {
      const home = tempDir("p2-sweep-self-");
      mkdirSync(join(home, "imports", "r1"), { recursive: true });
      mkdirSync(join(home, "logs"), { recursive: true });
      writeFileSync(join(home, "imports", "r1", "report.json"), "{}");
      writeFileSync(join(home, "imports", "r1", "ledger.jsonl"), "{}\n");
      const extra: Array<[string, string]> = [["rendering", "ok"]];
      if (planted === "extra") extra[0] = ["rendering", `x ${CONTENT_MARKER} y`];
      else writeFileSync(join(home, planted), `x ${CONTENT_MARKER} y`);
      assert.throws(() => sweep(home, extra, [CONTENT_MARKER], { allowInTree: [] }), /fixture token/, planted);
    }
  });

  it("Hermes: apply with a proved user, skills, a second run and a rollback", { timeout }, async () => {
    const fx = await buildM7HermesFixture();
    const home = tempDir("p2-sweep-hermes-");
    const user = { agentId: "default", channel: "telegram", accountId: "default", chat: { id: "c1", kind: "direct" }, trust: "proved", user: `user:v1:${"b".repeat(64)}` };
    const run = () => importHermes({ home, source: fx.root, apply: true, testInternals: flatTestInternals() as any, userPrincipal: user });
    const { value: r, output } = await captured(async () => {
      const first = await run();
      const second = await run();
      return { first, second };
    }).then((x) => ({ value: x.value.first, output: x.output + JSON.stringify(x.value.second) + renderHermes(x.value.second) }));
    const skills = await importSkills({ sourceType: "hermes", source: fx.root, home, env: {}, homedir: "/nonexistent-home", apply: true, enable: false, onConflict: "skip", maxBytes: DEFAULT_MAX_SKILL_BYTES }, renderSkills);
    const dry = await importHermes({ home: tempDir("p2-sweep-hermes-dry-"), source: fx.root, testInternals: flatTestInternals() as any });
    const rb = await rollbackImport({ home, reportPath: r.reportPath!, apply: false, sourceType: "hermes" });
    sweep(home, [
      ["returned report", JSON.stringify(r)], ["rendered report", renderHermes(r)], ["dry-run report", JSON.stringify(dry)], ["dry-run rendering", renderHermes(dry)],
      ["skills report", JSON.stringify(skills)], ["skills rendering", renderSkills(skills)], ["rollback report", JSON.stringify(rb)], ["rollback rendering", renderRollback(rb)],
      ["captured stdout/stderr", output],
    ], HERMES_TOKENS, { allowInTree: [] });
  });

  it("OpenClaw: dry run, apply with store take-over, second run and rollback", { timeout }, async () => {
    const fx = await buildM7OpenclawFixture();
    try {
      const home = tempDir("p2-sweep-openclaw-");
      const dry = await importOpenclaw({ home: tempDir("p2-sweep-openclaw-dry-"), source: fx.root, testInternals: flatTestInternals() as any });
      const { value: r, output } = await captured(() => importOpenclaw({ home, source: fx.root, apply: true, testInternals: flatTestInternals() as any }));
      const again = await importOpenclaw({ home, source: fx.root, apply: true, testInternals: flatTestInternals() as any });
      const rb = await rollbackImport({ home, reportPath: r.reportPath!, apply: false, sourceType: "openclaw" });
      // The OpenClaw workspace files are copied on purpose (copy-never-move), so their marker content lives in the workspaces.
      sweep(home, [
        ["returned report", JSON.stringify(r)], ["rendered report", renderOpenclaw(r)], ["second run", JSON.stringify(again)], ["second rendering", renderOpenclaw(again)],
        ["dry-run report", JSON.stringify(dry)], ["dry-run rendering", renderOpenclaw(dry)], ["rollback report", JSON.stringify(rb)], ["rollback rendering", renderRollback(rb)],
        ["captured stdout/stderr", output],
      ], OPENCLAW_TOKENS.filter((t) => t !== CONTENT_MARKER), { allowInTree: [] });
      // The content marker is allowed in copied user files, never in a report, ledger or rendering.
      for (const f of filesUnder(join(home, "imports")).filter((x) => !verbatimCopy(x))) assert.ok(!readFileSync(f).toString("latin1").includes(CONTENT_MARKER), `${f} contains the content marker`);
      for (const text of [JSON.stringify(r), renderOpenclaw(r), JSON.stringify(rb), renderRollback(rb), output]) assert.ok(!text.includes(CONTENT_MARKER));
      assert.ok(layout(home).home.length > 0);
    } finally { fx.close(); }
  });
});
