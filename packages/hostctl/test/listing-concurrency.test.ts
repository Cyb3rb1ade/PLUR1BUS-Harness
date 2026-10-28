// Directory listings overlap bounded filesystem verification without changing policy decisions or sorted output.
import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { files } from "../src/files.ts";
import { configure } from "../src/config.ts";

afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); });

it("lists in sorted order while bounding overlapping fresh identity checks", async () => {
  const base = await fs.mkdtemp(join(tmpdir(), "i2-list-overlap-"));
  const root = await fs.realpath(await fs.mkdir(join(base, "root"), { recursive: true }).then(() => join(base, "root")));
  const home = join(base, "home");
  await fs.mkdir(home);
  const names = Array.from({ length: 40 }, (_, i) => `f${String(i).padStart(3, "0")}.txt`);
  await Promise.all([...names, ".env"].map(name => fs.writeFile(join(root, name), "fixture")));
  const first = Promise.withResolvers<void>(), second = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const original = fs.stat;
  let active = 0, peak = 0, checked = 0;
  vi.spyOn(fs, "stat").mockImplementation((async (...args: Parameters<typeof fs.stat>) => {
    const result = await original(...args);
    const target = String(args[0]);
    if (dirname(target) === root && /^f\d{3}\.txt$/.test(basename(target))) {
      active++; checked++; peak = Math.max(peak, active); first.resolve();
      if (active > 1) second.resolve();
      try { await release.promise; } finally { active--; }
    }
    return result;
  }) as typeof fs.stat);
  syncBuiltinESMExports();
  const ops = files([{ id: "fixture", path: root }], [], configure(), async () => {}, home, {});
  const listing = ops.run("list", { path: ".", limit: 100 }, new AbortController().signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let overlaps = false;
  try {
    await first.promise;
    overlaps = await Promise.race([second.promise.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 1000); })]);
  } finally {
    if (timer) clearTimeout(timer);
    release.resolve();
  }
  try {
    const result = await listing as { entries: { path: string }[]; truncated: boolean };
    expect(overlaps).toBe(true);
    expect(peak).toBeLessThanOrEqual(16);
    expect(checked).toBeGreaterThanOrEqual(names.length);
    expect(result.entries.map(entry => entry.path)).toEqual(names);
    expect(result.truncated).toBe(false);
  } finally {
    vi.restoreAllMocks(); syncBuiltinESMExports();
    await fs.rm(base, { recursive: true, force: true });
  }
});

