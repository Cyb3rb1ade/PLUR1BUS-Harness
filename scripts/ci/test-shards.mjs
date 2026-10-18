// Deterministic test-file sharding for the CI `web-browser` shards (docs/ci.md, "M3 web browser checks").
//
// A package's test files (the same sorted `test/**/*.test.ts` list `scripts/test-package.mjs` runs) are dealt
// round-robin over N shards: file k of the sorted list goes to shard (k mod N) + 1. The result does not depend on the
// filesystem's glob order, and every file lands in exactly one shard. Each sharded run writes a manifest
// ({ shard, total, files }); the `web-browser` gate job runs `verify` over all manifests, which fails unless every
// shard 1..N reported exactly once, the shards are disjoint, none is empty, and their union is the package's full
// test list. A shard that never ran, a changed N on one side only or a file outside the list therefore fails the gate.
//
//   node scripts/ci/test-shards.mjs verify --cwd=packages/web --dir=<directory with *.json manifests>
import { globSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The package's test files, relative to `cwd`, sorted (identical to what test-package.mjs runs unsharded). */
export function listTestFiles(cwd = process.cwd()) {
  return globSync("test/**/*.test.ts", { cwd }).map(f => f.split("\\").join("/")).sort();
}

/** "i/N" with 1 <= i <= N, no leading zeros or spaces; anything else throws (a typo must never run every file). */
export function parseShard(spec) {
  const m = /^([1-9]\d*)\/([1-9]\d*)$/.exec(String(spec));
  if (!m) throw new Error(`invalid shard "${spec}": expected i/N with 1 <= i <= N`);
  const index = Number(m[1]), total = Number(m[2]);
  if (index > total) throw new Error(`invalid shard "${spec}": index above the shard count`);
  return { index, total };
}

/** The files of shard `index` of `total`: round-robin over the sorted list. */
export function selectShard(files, { index, total }) {
  return [...files].sort().filter((_, k) => k % total === index - 1);
}

export function writeManifest(path, { index, total }, files) {
  writeFileSync(path, JSON.stringify({ shard: index, total, files }, null, 2) + "\n");
}

/** Returns a list of problems; empty means the manifests form an exact partition of `allFiles`. */
export function verifyManifests(manifests, allFiles) {
  const errors = [];
  if (manifests.length === 0) return ["no shard manifests found"];
  const totals = new Set(manifests.map(m => m.total));
  if (totals.size !== 1) return [`manifests disagree on the shard count: ${[...totals].join(", ")}`];
  const [total] = totals;
  const byShard = new Map();
  for (const m of manifests) {
    if (byShard.has(m.shard)) errors.push(`shard ${m.shard}/${total} reported twice`);
    byShard.set(m.shard, m);
  }
  for (let i = 1; i <= total; i++) {
    const m = byShard.get(i);
    if (!m) errors.push(`shard ${i}/${total} missing`);
    else if (!Array.isArray(m.files) || m.files.length === 0) errors.push(`shard ${i}/${total} ran no test file`);
  }
  for (const s of byShard.keys()) if (!(Number.isInteger(s) && s >= 1 && s <= total)) errors.push(`unexpected shard ${s}/${total}`);
  const all = new Set(allFiles), count = new Map();
  for (const m of manifests) for (const f of m.files ?? []) count.set(f, (count.get(f) ?? 0) + 1);
  for (const [f, n] of count) {
    if (!all.has(f)) errors.push(`not in the test list: ${f}`);
    if (n > 1) errors.push(`run by more than one shard: ${f}`);
  }
  for (const f of allFiles) if (!count.has(f)) errors.push(`not run by any shard: ${f}`);
  return errors;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const opt = Object.fromEntries(rest.map(a => /^--([^=]+)=(.*)$/.exec(a)).filter(Boolean).map(m => [m[1], m[2]]));
  if (cmd !== "verify" || !opt.cwd || !opt.dir) {
    console.error("usage: test-shards.mjs verify --cwd=<package dir> --dir=<manifest dir>");
    return 2;
  }
  const manifests = readdirSync(opt.dir, { recursive: true }).map(String).filter(f => f.endsWith(".json")).sort()
    .map(f => JSON.parse(readFileSync(join(opt.dir, f), "utf8")));
  const all = listTestFiles(opt.cwd);
  const errors = verifyManifests(manifests, all);
  if (errors.length) {
    for (const e of errors) console.error(`shard check: ${e}`);
    return 1;
  }
  const sizes = [...manifests].sort((a, b) => a.shard - b.shard).map(m => m.files.length).join("/");
  console.log(`shard check ok: ${all.length} test files, ${manifests.length} shards, each file exactly once (sizes ${sizes})`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
