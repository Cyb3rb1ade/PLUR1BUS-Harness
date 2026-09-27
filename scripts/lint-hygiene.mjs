// Hygiene lint (spec criterion 6): no OpenClaw idiom anywhere in the harness's own source —
// crates, packages, tests, scripts — except the few lines explicitly allow-listed below (the
// engine dependency line, a documented parity import, and the lines in this file and the
// import-hygiene test that name the very patterns being checked for).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOTS = ["packages", "crates", "tests", "scripts"];
const SKIP_DIRS = new Set(["node_modules", "dist", "target", "generated", ".git"]);
const EXT = new Set([".ts", ".mjs", ".js", ".rs", ".json", ".md", ".toml", ".yaml", ".yml"]);
const PATTERNS = [
  { re: /openclaw/i, why: "no OpenClaw idiom in the harness (spec D9)" },
  { re: /OPENCLAW_/, why: "no host env names" },
  { re: /["'`]\/(state|forget)["'`]/, why: "no slash-command emulation" },
  { re: /adapter\/openclaw|host-services\.js|plugin-runtime/, why: "no adapter or host-services import" },
];
// Path prefix -> patterns checked only under it.
const SCOPED = [
  {
    // Spec §4: the supervisor's dependency budget. Downloads, archives and signatures belong to the installer
    // (`crate::install::{fetch,archive}`, reached from setup/update/repair), never to the supervisor.
    prefix: "crates/plur1bus/src/supervisor/",
    patterns: [
      { re: /\b(ureq|flate2|tar::|zip::|minisign_verify|install::fetch|install::archive)\b/, why: "supervisor dependency budget (spec §4)" },
      { re: /\b(tar|zip)::[{*]/, why: "supervisor dependency budget (spec §4)" },
    ],
  },
];
// Path -> the whole file is exempt (never scanned).
const ALLOW_FILES = new Set([
  "scripts/lint-hygiene.mjs",
  // The importer (docs/import.md §8, §9) exists to read an OpenClaw installation, so naming OpenClaw's paths, env
  // variables and plugin id is its job, not an idiom leaking into the harness. It is a separate entry (dist/import.js)
  // the core process never loads (packages/core/test/import-hygiene.test.ts checks dist/core.js carries none of it).
  "packages/core/src/import-bin.ts",
  "crates/plur1bus/src/commands/import.rs",
  "crates/plur1bus/tests/import.rs",
]);
// Directory prefixes exempt as a whole, for the same reason as the importer files above.
const ALLOW_DIRS = ["packages/core/src/import/", "packages/core/test/import/"];
// Path -> regexes; a matching line is allowed only if it also matches one of these.
const ALLOW = new Map([
  ["packages/core/test/principal.test.ts", [/lib\/memory-request-context\.js/]],
  [
    "packages/core/package.json",
    [/git\+https:\/\/github\.com\/Cyb3rb1ade\/openclaw-plur1bus-memory\.git#[0-9a-f]{40}/],
  ],
  // The one line in the import-gate test that names the forbidden path fragments themselves.
  ["packages/core/test/import-hygiene.test.ts", [/const offenders = urls\.filter/]],
  // scripts/gen-engine-keys.mjs (Task 16, written concurrently) names openclaw.plugin.json —
  // allow by path + regex even though the file does not exist yet at lint time.
  ["scripts/gen-engine-keys.mjs", [/openclaw\.plugin\.json/]],
  ["pnpm-lock.yaml", [/.*/]],
  // `plur1bus import <openclaw|hermes>` (docs/import.md): the importer's clap definitions — its help text, the source
  // enum and the documented source-root defaults — a capability the harness itself offers, not an OpenClaw idiom.
  ["crates/plur1bus/src/cli.rs", [/OpenClaw\/Hermes/, /^\s*Openclaw,$/, /\$OPENCLAW_STATE_DIR \/ \$OPENCLAW_PROFILE \/ ~\/\.openclaw/]],
]);

let bad = 0;
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      walk(p);
      continue;
    }
    if (![...EXT].some((e) => name.endsWith(e))) continue;
    const rel = relative(process.cwd(), p).replaceAll("\\", "/");
    if (ALLOW_FILES.has(rel) || ALLOW_DIRS.some((d) => rel.startsWith(d))) continue;
    const allow = ALLOW.get(rel) ?? [];
    const patterns = [...PATTERNS, ...SCOPED.filter((s) => rel.startsWith(s.prefix)).flatMap((s) => s.patterns)];
    readFileSync(p, "utf8")
      .split("\n")
      .forEach((line, i) => {
        for (const { re, why } of patterns) {
          if (re.test(line) && !allow.some((a) => a.test(line))) {
            console.error(`${rel}:${i + 1}: ${why}: ${line.trim().slice(0, 120)}`);
            bad += 1;
          }
        }
      });
  }
}
for (const r of ROOTS) {
  try {
    walk(r);
  } catch {
    /* root absent */
  }
}
if (bad) {
  console.error(`hygiene: ${bad} violation(s)`);
  process.exit(1);
}
console.log("hygiene ok");
