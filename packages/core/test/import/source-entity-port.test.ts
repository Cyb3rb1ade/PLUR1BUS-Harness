/** Offline entity reads share the injected source port; the target remains a separate local authority. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLocalFs } from "@plur1bus/remote-fs";
import { importOpenclaw } from "../../src/import/importers/openclaw.ts";
import { importHermes } from "../../src/import/importers/hermes.ts";

for (const family of ["openclaw", "hermes"] as const) test(`${family}: offline entity bodies use the selected source read port`, async () => {
  const base = await mkdtemp(join(tmpdir(), "p1-entity-port-"));
  const source = join(base, "source"), home = join(base, "target");
  try {
    await mkdir(source); await mkdir(home);
    const workspace = family === "hermes" ? source : join(source, "workspace");
    if (workspace !== source) await mkdir(workspace);
    await writeFile(join(workspace, "SOUL.md"), "Public source persona\n");
    await writeFile(join(source, family === "hermes" ? "config.yaml" : "openclaw.json"), family === "hermes"
      ? "_config_version: 45\n" : JSON.stringify({ meta: { lastTouchedVersion: "2026.9.5" } }));
    const real = await createLocalFs({ root: source });
    const reads: string[] = [];
    const reader = { root: source, fs: { ...real, async readFile(path: string, cap: number) {
      reads.push(path); return real.readFile(path, cap);
    } } };
    if (family === "hermes") await importHermes({ home, source, env: {}, reader } as Parameters<typeof importHermes>[0]);
    else await importOpenclaw({ home, source, env: {}, reader } as Parameters<typeof importOpenclaw>[0]);
    assert.ok(reads.includes(join(workspace, "SOUL.md")), "entity source contents must cross the same read-only port");
  } finally { await rm(base, { recursive: true, force: true }); }
});
