// Hygiene lint (spec criterion 6): no OpenClaw idiom anywhere in the harness's own source —
// crates, packages, tests, scripts, apps (desktop shell), and the host clients and adapters under clients/ and hosts/ (HM2) — except the few lines explicitly allow-listed below (the
// engine dependency line, a documented parity import, and the lines in this file and the
// import-hygiene test that name the very patterns being checked for).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

if (process.argv.includes("--self-test")) {
  const result = spawnSync(process.execPath, ["--test", fileURLToPath(new URL("./lint-hygiene.test.mjs", import.meta.url))], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

const ROOTS = ["packages", "crates", "tests", "scripts", "apps", "clients", "hosts"];
const SKIP_DIRS = new Set(["node_modules", "dist", "target", "generated", ".git", "__pycache__", ".venv", "venv"]);
const EXT = new Set([".ts", ".mjs", ".js", ".rs", ".json", ".md", ".toml", ".yaml", ".yml", ".py"]);
const PATTERNS = [
  { re: /openclaw/i, why: "no OpenClaw idiom in the harness (spec D9)" },
  { re: /OPENCLAW_/, why: "no host env names" },
  { re: /["'`]\/(state|forget)["'`]/, why: "no slash-command emulation" },
  { re: /adapter\/openclaw|host-services\.js|plugin-runtime/, why: "no adapter or host-services import" },
];
// The ext files the supervisor can reach (X1-R2) and the two that only the worker process runs. Every file under
// crates/plur1bus/src/ext/ must be in exactly one list, so a new file cannot slip past the rule unclassified.
const EXT_SAFE = ["mod", "paths", "state", "index", "overlays", "host", "worker", "commit", "lifecycle", "remove", "list", "record"];
const EXT_WORKER = ["inspect", "stage"];
// Path prefix (or `files`) -> patterns checked only under it.
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
  {
    // X1-R2: the supervisor never parses package bytes. `ext.inspect` and the staging half of `ext.install` run in a
    // child process (`plur1bus ext __worker`, the EXT_WORKER files below, which are not listed here); every other ext
    // file is reachable from the supervisor and must not name the parser, verifier, packer, extractor or the crates
    // they stand on. The `multi` patterns catch grouped imports (`use plur1bus_ext::{compat, verify};`), also when
    // rustfmt spreads them over several lines.
    files: EXT_SAFE.map((n) => `crates/plur1bus/src/ext/${n}.rs`),
    patterns: [
      {
        re: /\b(plur1bus_ext::(zipaudit|verify|pack|normalise)|install::archive|zip::|flate2|minisign_verify)\b/,
        why: "supervisor must not parse package bytes (X1-R2)",
      },
      // `zip::` ends in a non-word character, so `\b` after it does not match before `{` or `*`.
      { re: /\bzip::[{*]/, why: "supervisor must not parse package bytes (X1-R2)" },
      {
        multi: true,
        re: /\bplur1bus_ext::\{[^;]*?\b(zipaudit|verify|pack|normalise)\b/,
        why: "supervisor must not parse package bytes (X1-R2)",
      },
      {
        multi: true,
        re: /\binstall::\{[^;]*?\barchive\b/,
        why: "supervisor must not parse package bytes (X1-R2)",
      },
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
  // The coexistence guard (spec §A.7) must name the other host's paths.
  "crates/plur1bus/src/coexistence.rs",
  "crates/plur1bus/tests/coexistence.rs",
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
// Check all tracked paths, including documentation, independently of source exemptions.
// Read index blobs: a staged secret must fail even if the working copy was cleaned.
const tracked = spawnSync("git", ["ls-files", "--stage", "-z"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
if (tracked.status !== 0) {
  console.error("hygiene: cannot inspect tracked files");
  process.exit(1);
}
for (const entry of tracked.stdout.split("\0").filter(Boolean)) {
  const [metadata, ...parts] = entry.split("\t");
  const path = parts.join("\t");
  if (/\.(p12|p8|pfx|key|pem|keystore|oci\.tar)$/i.test(path)) {
    console.error(`${path}: forbidden tracked file`);
    bad += 1;
  }
  const [mode, hash] = metadata.split(" ");
  if (mode === "160000") continue; // A submodule has no blob in this repository.
  const blob = spawnSync("git", ["cat-file", "blob", hash], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (blob.status !== 0) {
    console.error(`${path}: cannot inspect tracked blob`);
    bad += 1;
    continue;
  }
  // The binding plan quotes this header to specify this very check. Exempt only
  // that quoted literal in that one document; an actual header there still fails.
  const text = path === "docs/superpowers/plans/2026-09-27-desktop-app-d1.md"
    ? blob.stdout.replaceAll("`untrusted comment: " + "minisign secret key`", "[documented header]")
    : blob.stdout;
  if (/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----|untrusted comment: minisign (?:encrypted )?secret key/i.test(text)) {
    console.error(`${path}: private key header`);
    bad += 1;
  }
}

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
    const patterns = [...PATTERNS, ...SCOPED.filter((s) => (s.files ? s.files.includes(rel) : rel.startsWith(s.prefix))).flatMap((s) => s.patterns)];
    const text = readFileSync(p, "utf8");
    for (const { re, why, multi } of patterns) {
      const m = multi ? re.exec(text) : null;
      if (m) {
        const at = text.slice(0, m.index).split(/\r?\n/).length;
        console.error(`${rel}:${at}: ${why}: ${m[0].replace(/\s+/g, " ").slice(0, 120)}`);
        bad += 1;
      }
    }
    text
      .split(/\r?\n/) // a Windows checkout (core.autocrlf) has CRLF; anchored allow-list regexes must still match
      .forEach((line, i) => {
        for (const { re, why, multi } of patterns) {
          if (!multi && re.test(line) && !allow.some((a) => a.test(line))) {
            console.error(`${rel}:${i + 1}: ${why}: ${line.trim().slice(0, 120)}`);
            bad += 1;
          }
        }
      });
  }
}
const EXT_DIR = "crates/plur1bus/src/ext";
try {
  for (const name of readdirSync(EXT_DIR)) {
    const stem = name.replace(/\.rs$/, "");
    if (name.endsWith(".rs") && !EXT_SAFE.includes(stem) && !EXT_WORKER.includes(stem)) {
      console.error(`${EXT_DIR}/${name}:1: ext file is in neither EXT_SAFE nor EXT_WORKER (scripts/lint-hygiene.mjs, X1-R2)`);
      bad += 1;
    }
  }
} catch {
  /* no ext directory */
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
