// Lazy catalogues: an area's texts exist only after a chunk that imports the area has called registerArea(). A page that
// reads a key of ANOTHER lazy area (approvals -> "recurring.col.action") shows an empty string when the other page was not
// opened first. This test walks the static import graph of every chunk (main.ts and each dynamic import() target) and
// requires every lazy-area key that code owned by the chunk (its entry file and the files below the entry's directory) names to
// be registered by that chunk, by the shell, or by a chunk that loads it. Files imported from elsewhere are not judged here: a
// helper imported for one constant (logs/sessions.ts -> settings/users/model.ts) does not render its texts in this chunk.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const EAGER = new Set(["surfaces", "core", "memory", "mediasearch", "models", "palette", "shared", "settings"]);
const AREA_FILES: Record<string, string> = { homeHelpLibrary: "home-help-library" };

const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const all: string[] = [];
(function walk(d: string): void {
  for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".ts")) all.push(p); }
})(SRC);

const keyArea = new Map<string, string>();
for (const f of readdirSync(join(SRC, "i18n"))) {
  if (f === "index.ts" || !f.endsWith(".ts")) continue;
  const m = await import(pathToFileURL(join(SRC, "i18n", f)).href) as { en: Record<string, string> };
  const base = f.slice(0, -3);
  const area = Object.entries(AREA_FILES).find(([, v]) => v === base)?.[0] ?? base;
  for (const k of Object.keys(m.en)) keyArea.set(k, area);
}

type Info = { stat: string[]; dyn: string[]; regs: string[]; keys: Set<string> };
const infos = new Map<string, Info>();
function resolveImport(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const p = resolve(dirname(from), spec);
  return existsSync(p) && statSync(p).isFile() ? p : null;
}
function info(f: string): Info {
  let r = infos.get(f);
  if (r) return r;
  const src = stripComments(readFileSync(f, "utf8"));
  const stat: string[] = [], dyn: string[] = [];
  for (const m of src.matchAll(/(?:^|\n)[ \t]*(import|export)(\s+type)?\s[^;'"]*?from\s*["']([^"']+)["']/g)) if (!m[2]) stat.push(m[3]!);
  for (const m of src.matchAll(/(?:^|\n)[ \t]*import\s*["']([^"']+)["']/g)) stat.push(m[1]!);
  for (const m of src.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) dyn.push(m[1]!);
  const keys = new Set<string>();
  // The generated help bundle (pages/help/docs-bundle/<lang>/*.ts, from docs/user/**) is rendered Markdown, never an
  // argument to t(): a page that names a key as inline code (`project.board.backlog` in the CLI docs) uses no text of
  // that area, so its string literals are not scanned for keys. Its imports are still followed.
  const isDocsBundlePage = /[\\/]pages[\\/]help[\\/]docs-bundle[\\/](de|en)[\\/]/.test(f);
  if (!isDocsBundlePage) for (const m of src.matchAll(/["'`]([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+)["'`]/g)) if (keyArea.has(m[1]!)) keys.add(m[1]!);
  if (!isDocsBundlePage) for (const m of src.matchAll(/\bt\(\s*`([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)*\.)\$\{/g)) for (const k of keyArea.keys()) if (k.startsWith(m[1]!)) keys.add(k);
  r = {
    stat: stat.map((s) => resolveImport(f, s)).filter((x): x is string => x !== null),
    dyn: dyn.map((s) => resolveImport(f, s)).filter((x): x is string => x !== null),
    regs: [...src.matchAll(/registerArea\(\s*["'](\w+)["']/g)].map((m) => m[1]!),
    keys,
  };
  infos.set(f, r);
  return r;
}
function closure(entry: string): Set<string> {
  const seen = new Set<string>(), todo = [entry];
  while (todo.length) { const f = todo.pop()!; if (seen.has(f)) continue; seen.add(f); todo.push(...info(f).stat); }
  return seen;
}

const main = join(SRC, "main.ts");
const entries = new Set<string>([main]);
for (const f of all) for (const d of info(f).dyn) entries.add(d);
const closures = new Map([...entries].map((e) => [e, closure(e)]));
const regsOf = (e: string): Set<string> => new Set([...closures.get(e)!].flatMap((f) => info(f).regs));
// Areas a chunk can count on: its own registrations, the shell's, and those of any chunk whose code dynamically imports it.
function available(entry: string, seen = new Set<string>()): Set<string> {
  const out = new Set([...regsOf(entry), ...regsOf(main)]);
  if (seen.has(entry)) return out;
  seen.add(entry);
  for (const [e, cl] of closures) {
    if (e === entry) continue;
    if ([...cl].some((f) => info(f).dyn.includes(entry))) for (const a of available(e, seen)) out.add(a);
  }
  return out;
}

test("lazy i18n areas: every chunk registers the lazy areas whose keys its code uses", () => {
  const problems: string[] = [];
  for (const entry of entries) {
    const avail = available(entry);
    const missing = new Map<string, string[]>();
    for (const f of closures.get(entry)!) {
      if (entry !== main && !f.startsWith(dirname(entry) + "/")) continue;
      for (const k of info(f).keys) {
        const a = keyArea.get(k)!;
        if (EAGER.has(a) || avail.has(a)) continue;
        (missing.get(a) ?? missing.set(a, []).get(a)!).push(`${relative(SRC, f)} uses ${k}`);
      }
    }
    for (const [a, l] of missing) problems.push(`chunk ${relative(SRC, entry)} never registers area "${a}": ${l.slice(0, 3).join("; ")}`);
  }
  assert.deepEqual(problems, []);
});
