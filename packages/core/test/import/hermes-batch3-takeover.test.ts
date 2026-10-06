// hermes-batch3-takeover.test.ts — PR #100 review findings B1–B6 and M1 as assertions (probes P1–P10 of
// review-pr100.md, rewritten as tests). Every test runs in temp dirs with a stub embedder; no real home, no network.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { layout } from "../../src/paths.ts";
import { importHermes } from "../../src/import/importers/hermes.ts";
import { readHermesSourceFileSafe } from "../../src/import/importers/hermes-fs-safe.ts";
import { idFingerprint } from "../../src/import/fingerprint.ts";
import { rollbackImport } from "../../src/import/rollback.ts";
import { renderHermes } from "../../src/import/render.ts";
import { ImportError } from "../../src/import/types.ts";
import { buildM7HermesFixture, lanceStore } from "./fixtures.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import type { Engine } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";

const MiB = 1024 * 1024;

/** A deterministic stub embedder: every text maps to the unit vector at `hot`. Two values of `hot` are two
 *  different "models" with the same dimension, which is exactly what the adopt cosine probe must catch. */
function embedder(hot = 0, dim = 384) {
  const vector = () => Array.from({ length: dim }, (_, i) => (i === hot ? 1 : 0));
  const one = async () => vector();
  return { embed: one, embedQuery: one, embedPassage: one, embedBatch: async (t: string[]) => t.map(vector), shutdown: async () => {} };
}

/** Relative path -> sha256 for every entry of a tree (dirs as "dir", links refused as "link"). */
function treeMap(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  const walk = (d: string) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, ent.name);
      const rel = relative(dir, full).replaceAll("\\", "/");
      if (ent.isDirectory()) {
        out.set(rel, "dir");
        walk(full);
      } else if (ent.isFile()) {
        out.set(rel, createHash("sha256").update(readFileSync(full)).digest("hex"));
      } else {
        out.set(rel, "other");
      }
    }
  };
  walk(dir);
  return out;
}

function treeDigest(dir: string): string {
  return JSON.stringify([...treeMap(dir).entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function treeText(dir: string): string {
  let text = "";
  for (const [rel, kind] of treeMap(dir)) {
    if (kind !== "dir" && kind !== "other") text += readFileSync(join(dir, rel), "latin1");
  }
  return text;
}

/** A legacy (manifest-less) 384-d store written by the "model" embedder(0): row 0 is the unit vector at 0. */
async function legacyStore(rows = 1): Promise<string> {
  const store = join(tempDir("p1b-pr100-src-store-"), "store");
  mkdirSync(store, { recursive: true, mode: 0o700 });
  writeFileSync(join(store, "_schema.json"), JSON.stringify({ schemaVersion: "1" }));
  await lanceStore(join(store, "default"), 384, rows);
  return store;
}

/** A target home that already went through one plain Hermes import (config, agents, store, core.lock exist). */
async function populatedHome(prefix: string): Promise<string> {
  const fx = await buildM7HermesFixture();
  const home = tempDir(prefix);
  await importHermes({ home, source: fx.root, apply: true, testInternals: { embeddings: embedder(0) } });
  return home;
}

async function rejectsWith(p: Promise<unknown>, reason: string): Promise<void> {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof ImportError, `expected ImportError, got ${String(e)}`);
    assert.equal((e as ImportError).reason, reason);
    return true;
  });
}

const timeout = 60_000;

describe("PR #100 B1/B2: --adopt-store runs before the target engine, never merges, aborts cleanly", () => {
  it("B1/P10: fresh home + default --conflict skip adopts the store byte-identically (not preview-ok)", { timeout }, async () => {
    const fx = await buildM7HermesFixture();
    const home = tempDir("p1b-pr100-b1-fresh-");
    const l = layout(home);
    const src = await legacyStore();
    const srcTree = treeMap(src);

    // engine stub: the real target engine would add rows; here the store must be exactly the source copy.
    const stub = { memory: { import: async (r: any) => ({ created: r.cards.length, matchedExisting: 0, rejected: 0, cards: r.cards.map((c: any) => ({ idempotencyKey: c.idempotencyKey, outcome: "created" })) }) }, close: async () => {} } as unknown as Engine;
    const report = await importHermes({ home, source: fx.root, adoptStore: src, apply: true, engine: stub, testInternals: { embeddings: embedder(0) } });

    assert.equal(report.storeAdopt?.verdict, "ok");
    assert.equal(report.storeAdopt?.action, "taken-over");
    assert.equal(report.storeAdopt?.identitySource, "probe");
    assert.equal(treeDigest(l.lancedb), treeDigest(src), "target store must be an exact copy of the source store");
    assert.deepEqual(readdirSync(l.state).filter((n) => n.startsWith("lancedb.adopt-")), [], "no staging dir left behind");
    assert.ok(srcTree.size > 0);
    const ledger = readFileSync(report.ledgerPath!, "utf8");
    assert.ok(ledger.includes('"entity":"store"') && ledger.includes('"action":"adopted"'));
  });

  it("B1: fresh home with the REAL target engine adopts first; the engine then writes into the adopted store", { timeout }, async () => {
    const fx = await buildM7HermesFixture();
    const home = tempDir("p1b-pr100-b1-real-");
    const l = layout(home);
    const src = await legacyStore();
    const srcTree = treeMap(src);

    const report = await importHermes({ home, source: fx.root, adoptStore: src, apply: true, testInternals: { embeddings: embedder(0) } });
    assert.equal(report.storeAdopt?.action, "taken-over");
    assert.ok(report.counts.memoryCardsImported > 0);
    // Every source file is still there byte-identically (LanceDB data files are immutable; the engine only adds).
    const target = treeMap(l.lancedb);
    for (const [rel, sha] of srcTree) assert.equal(target.get(rel), sha, `adopted store lost or changed ${rel}`);
  });

  it("B1: an existing target store with --conflict skip is left untouched and reported store-exists-skipped", { timeout }, async () => {
    const fx = await buildM7HermesFixture();
    const home = await populatedHome("p1b-pr100-b1-skip-");
    const l = layout(home);
    const before = treeDigest(l.lancedb);
    const src = await legacyStore();

    const stub = { memory: { import: async (r: any) => ({ created: 0, matchedExisting: r.cards.length, rejected: 0, cards: r.cards.map((c: any) => ({ idempotencyKey: c.idempotencyKey, outcome: "matched-existing" })) }) }, close: async () => {} } as unknown as Engine;
    const report = await importHermes({ home, source: fx.root, adoptStore: src, apply: true, engine: stub, testInternals: { embeddings: embedder(0) } });

    assert.equal(report.storeAdopt?.action, "skipped");
    assert.equal(report.storeAdopt?.reason, "store-exists-skipped");
    assert.equal(treeDigest(l.lancedb), before, "skip must not merge anything into the existing store");
    assert.ok(!readFileSync(report.ledgerPath!, "utf8").includes('"entity":"store"'));
  });

  it("B1/P5b: an existing target store with --conflict replace is replaced as a whole (no merge) and rollback restores it", { timeout }, async () => {
    const fx = await buildM7HermesFixture();
    const home = await populatedHome("p1b-pr100-b1-replace-");
    const l = layout(home);
    const before = treeDigest(l.lancedb);
    const src = await legacyStore();

    const stub = { memory: { import: async (r: any) => ({ created: r.cards.length, matchedExisting: 0, rejected: 0, cards: r.cards.map((c: any) => ({ idempotencyKey: c.idempotencyKey, outcome: "created" })) }) }, close: async () => {} } as unknown as Engine;
    const report = await importHermes({ home, source: fx.root, adoptStore: src, onConflict: "replace", apply: true, engine: stub, testInternals: { embeddings: embedder(0) } });
    assert.equal(report.storeAdopt?.action, "taken-over");
    assert.equal(treeDigest(l.lancedb), treeDigest(src), "replace = exact source copy, nothing of the old store merged in");

    const rb = await rollbackImport({ home, reportPath: report.reportPath!, apply: true, sourceType: "hermes" });
    assert.equal(rb.storeUndoStatus, "restored");
    assert.equal(treeDigest(l.lancedb), before, "rollback restores the pre-import store byte-identically (P5c)");
  });

  it("B1/P5b: --conflict rename with an existing store is refused before anything is written", { timeout }, async () => {
    const fx = await buildM7HermesFixture();
    const home = await populatedHome("p1b-pr100-b1-rename-");
    const before = treeDigest(home);
    const src = await legacyStore();
    await rejectsWith(importHermes({ home, source: fx.root, adoptStore: src, onConflict: "rename", apply: true, testInternals: { embeddings: embedder(0) } }), "store-rename-unsupported");
    assert.equal(treeDigest(home), before);
  });

  it("B2/P5a: a REAL identity mismatch (same 384-d, different model) aborts and leaves a populated target byte-identical", { timeout }, async () => {
    const fx = await buildM7HermesFixture();
    const home = await populatedHome("p1b-pr100-b2-mismatch-");
    const before = treeDigest(home);
    const src = await legacyStore();

    // embedder(7) is "another model": the probe re-embeds the stored text and gets cosine 0 against the stored vector.
    await rejectsWith(
      importHermes({ home, source: fx.root, adoptStore: src, onConflict: "replace", apply: true, testInternals: { embeddings: embedder(7) } }),
      "identity-mismatch",
    );
    assert.equal(treeDigest(home), before, "abort after the staging copy must leave the whole target tree byte-identical");
  });

  it("B2: identity mismatch on a fresh home leaves nothing but the lock file, no store, no run dir", { timeout }, async () => {
    const fx = await buildM7HermesFixture();
    const home = tempDir("p1b-pr100-b2-fresh-");
    const src = await legacyStore();
    await rejectsWith(
      importHermes({ home, source: fx.root, adoptStore: src, apply: true, testInternals: { embeddings: embedder(7) } }),
      "identity-mismatch",
    );
    // withTargetLock itself creates state/core.lock (the OS lock); nothing else may exist.
    assert.deepEqual([...treeMap(home).keys()].sort(), ["state", "state/core.lock"]);
  });
});

describe("PR #100 B3–B6", () => {
  it("B3/P1/P2: delivery targets and pairing ids never appear; fingerprints are #104's idFingerprint format", { timeout }, async () => {
    const fx = await buildM7HermesFixture();
    const home = tempDir("p1b-pr100-b3-");
    const cronPath = join(fx.root, "cron", "jobs.json");
    const cron = JSON.parse(readFileSync(cronPath, "utf8"));
    cron.jobs.push({ id: "c-target", schedule: "0 7 * * *", deliver: "telegram:5551234567", prompt: "x" });
    cron.jobs.push({ id: "c-discord", schedule: "0 8 * * *", deliver: "discord:7778889990", prompt: "y" });
    writeFileSync(cronPath, JSON.stringify(cron));

    const report = await importHermes({ home, source: fx.root, apply: true, testInternals: { embeddings: embedder(0) } });
    const surfaces = [JSON.stringify(report), readFileSync(report.reportPath!, "utf8"), readFileSync(report.ledgerPath!, "utf8"), renderHermes(report)];
    for (const text of surfaces) {
      for (const id of ["5551234567", "7778889990", "12345", "67890", "99999", "123456"]) {
        assert.ok(!text.includes(id), `plain id ${id} leaked`);
      }
    }
    const tg = report.channels.find((c) => c.platform === "telegram")!;
    assert.deepEqual(tg.allowFromFingerprints, [idFingerprint("telegram", "12345"), idFingerprint("telegram", "67890")].sort());
    assert.equal(tg.allowFromCount, 2);
    assert.equal(report.cron.jobs.find((j) => j.id === "c-target")?.deliverKind, "telegram");
    assert.equal(report.cron.jobs.find((j) => j.id === "c-discord")?.deliverKind, "discord");
    for (const j of report.cron.jobs) assert.deepEqual(Object.keys(j).sort(), ["deliverKind", "id", "schedule", "sourceProfile", "status"]);
  });

  it("B4/P4: dry run writes nothing — fresh home, populated home, and with --adopt-store", { timeout }, async () => {
    const fx = await buildM7HermesFixture();

    const fresh = tempDir("p1b-pr100-b4-fresh-");
    await importHermes({ home: fresh, source: fx.root, apply: false });
    assert.deepEqual([...treeMap(fresh).keys()], [], "fresh home stays empty");

    const freshAdopt = tempDir("p1b-pr100-b4-adopt-");
    const src = await legacyStore();
    const srcBefore = treeDigest(src);
    const r = await importHermes({ home: freshAdopt, source: fx.root, adoptStore: src, apply: false, testInternals: { embeddings: embedder(0) } });
    assert.equal(r.storeAdopt?.action, "preview-ok");
    assert.deepEqual([...treeMap(freshAdopt).keys()], [], "adopt preview writes nothing to the target");
    assert.equal(treeDigest(src), srcBefore, "adopt preview does not modify the source store");

    const populated = await populatedHome("p1b-pr100-b4-pop-");
    const before = treeDigest(populated);
    const r2 = await importHermes({ home: populated, source: fx.root, apply: false });
    assert.equal(r2.mode, "dry-run");
    assert.equal(treeDigest(populated), before, "populated home is byte-identical after a dry run");
  });

  it("B5/P3: without a user binding, no USER.md content (memories/USER.md or profile-root USER.md) lands anywhere", { timeout }, async () => {
    const fx = await buildM7HermesFixture();
    const home = tempDir("p1b-pr100-b5-");
    const l = layout(home);
    writeFileSync(join(fx.root, "USER.md"), "ROOT-USER-MD-MARKER persona of the human\n");

    const report = await importHermes({ home, source: fx.root, apply: true, testInternals: { embeddings: embedder(0) } });
    assert.ok(report.counts.unresolvedUserScope >= 2);
    const all = treeText(home);
    assert.ok(!all.includes("Hermes user pref"), "memories/USER.md cards must not be mirrored or copied");
    assert.ok(!all.includes("ROOT-USER-MD-MARKER"), "profile-root USER.md must not be copied without a binding");
    assert.ok(!existsSync(join(l.workspaceDir("default"), "USER.md")));
    const def = report.profilesOrAgents.find((p) => p.harnessAgentId === "default")!;
    const userFile = def.files.find((f) => f.targetFile === "USER.md");
    assert.equal(userFile?.action, "skipped");
    assert.equal(userFile?.reason, "unresolved-user-scope");
    assert.ok(!report.errors.some((e) => e.reason === "unresolved-user-scope"), "unresolved scope is reported, not an error");
  });

  it("B6/P8: the memories.md mirror follows --conflict (skip keeps the user file; replace backs it up)", { timeout }, async () => {
    for (const strategy of ["skip", "replace", "rename"] as const) {
      const fx = await buildM7HermesFixture();
      const home = tempDir(`p1b-pr100-b6-${strategy}-`);
      const l = layout(home);
      mkdirSync(l.workspaceDir("default"), { recursive: true });
      writeFileSync(join(l.workspaceDir("default"), "memories.md"), "MINE\n");
      const report = await importHermes({ home, source: fx.root, onConflict: strategy, apply: true, testInternals: { embeddings: embedder(0) } });
      const now = readFileSync(join(l.workspaceDir("default"), "memories.md"), "utf8");
      if (strategy === "replace") {
        assert.notEqual(now, "MINE\n");
        assert.equal(readFileSync(join(home, "imports", report.runId, "replaced", "agents", "default", "workspace", "memories.md"), "utf8"), "MINE\n");
      } else {
        assert.equal(now, "MINE\n", `${strategy} must not overwrite the user's memories.md`);
      }
      if (strategy === "rename") assert.ok(existsSync(join(l.workspaceDir("default"), "memories.imported.md")));
    }
  });

  it("B6/P7: memory-import failure is an error with a reason code, cards count as rejected, and no mirror is written", { timeout }, async () => {
    const fx = await buildM7HermesFixture();
    const home = tempDir("p1b-pr100-b6-fail-");
    const l = layout(home);
    const failing = { memory: { import: async () => { const e: any = new Error("Hermes memory 1 text must not leak"); e.code = "storage"; throw e; } }, close: async () => {} } as unknown as Engine;
    const report = await importHermes({ home, source: fx.root, apply: true, engine: failing });
    assert.ok(report.errors.some((e) => e.reason === "memory-import-failed:storage"));
    assert.ok(report.counts.memoryCardsRejected > 0);
    assert.equal(report.counts.memoryCardsImported, 0);
    assert.ok(!existsSync(join(l.workspaceDir("default"), "memories.md")));
    assert.ok(!JSON.stringify(report.errors).includes("must not leak"), "error message text is never reported");
  });
});

describe("PR #100 M1: every Hermes source read is no-follow, regular-file-only and bounded", () => {
  it("helper: symlink, FIFO, oversized and growth are refused; a regular file reads byte-exact", { timeout }, () => {
    const dir = tempDir("p1b-pr100-m1-unit-");
    const big = join(dir, "big.md");
    writeFileSync(big, Buffer.alloc(16 * MiB + 1, 0x61));
    assert.deepEqual(readHermesSourceFileSafe(big, 16 * MiB), { ok: false, error: "file-too-large" });
    const link = join(dir, "link.md");
    symlinkSync(big, link);
    assert.deepEqual(readHermesSourceFileSafe(link, 32 * MiB), { ok: false, error: "symlink-refused" });
    const bin = join(dir, "bin.md");
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x41]);
    writeFileSync(bin, bytes);
    const ok = readHermesSourceFileSafe(bin, 16);
    assert.ok(ok.ok && ok.buffer.equals(bytes), "non-UTF-8 bytes survive unchanged");
    assert.deepEqual(readHermesSourceFileSafe(join(dir, "nope"), 16), { ok: false, error: "not-found" });
    if (process.platform !== "win32") {
      const fifo = join(dir, "fifo.md");
      assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
      assert.deepEqual(readHermesSourceFileSafe(fifo, 16), { ok: false, error: "not-a-regular-file" });
    }
  });

  it("P6: an in-root symlinked SOUL.md to a 16 MiB + 1 file is refused, reported in errors[], and not copied", { timeout }, async () => {
    const fx = await buildM7HermesFixture();
    const home = tempDir("p1b-pr100-m1-p6-");
    const l = layout(home);
    const big = join(fx.root, "big-in-root.md");
    writeFileSync(big, Buffer.alloc(16 * MiB + 1, 0x62));
    rmSync(join(fx.root, "SOUL.md"));
    symlinkSync(big, join(fx.root, "SOUL.md"));

    const report = await importHermes({ home, source: fx.root, apply: true, testInternals: { embeddings: embedder(0) } });
    const def = report.profilesOrAgents.find((p) => p.harnessAgentId === "default")!;
    const soul = def.files.find((f) => f.targetFile === "SOUL.md");
    assert.equal(soul?.action, "skipped");
    assert.equal(soul?.reason, "symlink-refused");
    assert.ok(report.errors.some((e) => e.sourceRef === "default:SOUL.md" && e.reason === "symlink-refused"));
    const ws = join(l.workspaceDir("default"), "SOUL.md");
    assert.ok(!existsSync(ws) || readFileSync(ws).length < MiB, "the 16 MiB target must never be copied");
  });

  it("oversized regular SOUL.md, FIFO MEMORY.md, symlinked pairing and oversized cron files are all refused and reported", { timeout }, async () => {
    const fx = await buildM7HermesFixture();
    const home = tempDir("p1b-pr100-m1-all-");
    writeFileSync(join(fx.root, "SOUL.md"), Buffer.alloc(16 * MiB + 1, 0x63));
    const pairing = join(fx.root, "platforms", "pairing", "telegram-approved.json");
    const outside = join(tempDir("p1b-pr100-m1-out-"), "approved.json");
    writeFileSync(outside, JSON.stringify({ "424242": {} }));
    rmSync(pairing);
    symlinkSync(outside, pairing);
    writeFileSync(join(fx.root, "cron", "jobs.json"), Buffer.alloc(MiB + 1, 0x20));
    if (process.platform !== "win32") {
      rmSync(join(fx.root, "memories", "MEMORY.md"));
      assert.equal(spawnSync("mkfifo", [join(fx.root, "memories", "MEMORY.md")]).status, 0);
    }

    const report = await importHermes({ home, source: fx.root, apply: true, testInternals: { embeddings: embedder(0) } });
    const reasons = report.errors.map((e) => `${e.sourceRef}=${e.reason}`);
    assert.ok(reasons.includes("default:SOUL.md=file-too-large"), reasons.join(" "));
    assert.ok(reasons.includes("platforms/pairing/telegram-approved.json=symlink-refused"), reasons.join(" "));
    assert.ok(reasons.includes("default:cron/jobs.json=file-too-large"), reasons.join(" "));
    if (process.platform !== "win32") assert.ok(reasons.includes("default:memories/MEMORY.md=not-a-regular-file"), reasons.join(" "));
    assert.ok(!JSON.stringify(report).includes("424242"));
  });
});

describe("PR #100 B6: a failed run is resumable without re-adopting the store", () => {
  it("--resume after memory-import-failed keeps the adopted store (no second copy, even with replace)", { timeout }, async () => {
    const fx = await buildM7HermesFixture();
    const home = await populatedHome("p1b-pr100-resume-");
    const l = layout(home);
    const src = await legacyStore();
    const failing = { memory: { import: async () => { const e: any = new Error("down"); e.code = "storage"; throw e; } }, close: async () => {} } as unknown as Engine;
    const first = await importHermes({ home, source: fx.root, adoptStore: src, onConflict: "replace", apply: true, engine: failing, testInternals: { embeddings: embedder(0) } });
    assert.equal(first.storeAdopt?.action, "taken-over");
    assert.ok(first.errors.some((e) => e.reason === "memory-import-failed:storage"));
    writeFileSync(join(l.lancedb, "written-after-adopt.marker"), "x");
    const afterFirst = treeDigest(l.lancedb);

    const stub = { memory: { import: async (r: any) => ({ created: r.cards.length, matchedExisting: 0, rejected: 0, cards: r.cards.map((c: any) => ({ idempotencyKey: c.idempotencyKey, outcome: "created" })) }) }, close: async () => {} } as unknown as Engine;
    const resumed = await importHermes({ home, source: fx.root, adoptStore: src, onConflict: "replace", apply: true, resume: first.runId, engine: stub, testInternals: { embeddings: embedder(0) } });
    assert.equal(resumed.storeAdopt?.action, "skipped");
    assert.equal(resumed.storeAdopt?.reason, "already-adopted-in-run");
    assert.equal(treeDigest(l.lancedb), afterFirst, "the resumed run must not replace the store a second time");
    assert.equal(resumed.errors.length, 0);
    assert.ok(resumed.counts.memoryCardsImported > 0);
  });
});
