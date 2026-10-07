// Dependency and licence audit (docs/dependency-policy.md). Node stdlib only, no network needed for the licence mode.
//
//   node scripts/audit-deps.mjs                 licence check of pnpm, cargo (root + apps/desktop) and python deps
//   node scripts/audit-deps.mjs --advisories    vulnerability check (pnpm audit, cargo audit); skips cleanly without tool/network
//
// The allow-list is read from docs/dependency-policy.md, approved exceptions from docs/dependency-exceptions.json;
// neither is hard-coded here. Exit codes: 0 clean, 1 policy violation or advisory found, 2 usage/config error,
// 3 an ecosystem could not be collected (use --allow-incomplete to downgrade that to a warning).
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------------------------------------------------
// Policy and exceptions

const ALLOW_BEGIN = "<!-- audit-deps:allowed -->";
const ALLOW_END = "<!-- /audit-deps:allowed -->";

/** The allow-list: every `- <SPDX-id>` line between the two marker comments of the policy document. */
export function parsePolicy(markdown) {
  const start = markdown.indexOf(ALLOW_BEGIN);
  const end = markdown.indexOf(ALLOW_END);
  if (start < 0 || end < start) throw new Error(`policy: missing ${ALLOW_BEGIN} ... ${ALLOW_END} block`);
  const allowed = new Set();
  for (const line of markdown.slice(start + ALLOW_BEGIN.length, end).split(/\r?\n/)) {
    const m = /^\s*[-*]\s+`?([A-Za-z0-9.+-]+)`?(?:\s.*)?$/.exec(line);
    if (m) allowed.add(m[1].toLowerCase());
  }
  if (allowed.size === 0) throw new Error("policy: the allow-list block is empty");
  return { allowed };
}

const ECOSYSTEMS = ["pnpm", "cargo", "cargo-desktop", "python"];

/** Validates docs/dependency-exceptions.json; throws with a precise message on a malformed entry. */
export function parseExceptions(text) {
  let doc;
  try { doc = JSON.parse(text); } catch (e) { throw new Error(`exceptions: not valid JSON (${e.message})`); }
  if (!doc || !Array.isArray(doc.exceptions)) throw new Error('exceptions: expected {"exceptions": [...]}');
  doc.exceptions.forEach((x, i) => {
    const at = `exceptions[${i}]`;
    if (!x || typeof x !== "object") throw new Error(`${at}: not an object`);
    if (!ECOSYSTEMS.includes(x.ecosystem)) throw new Error(`${at}: ecosystem must be one of ${ECOSYSTEMS.join(", ")}`);
    for (const k of ["name", "license", "reason"]) {
      if (typeof x[k] !== "string" || x[k].trim() === "") throw new Error(`${at}: "${k}" must be a non-empty string`);
    }
    if (x.version !== undefined && (typeof x.version !== "string" || x.version === "")) throw new Error(`${at}: "version" must be a non-empty string`);
  });
  return doc.exceptions;
}

// ---------------------------------------------------------------------------------------------------------------------
// SPDX expression evaluation

const STRONG_COPYLEFT = /^(a?gpl|sspl|eupl|osl|cpal|busl)/i;

function tokenize(expr) {
  const out = [];
  const re = /\s*(\(|\)|\/|[A-Za-z0-9.+:-]+)/gy;
  let pos = 0;
  while (pos < expr.length) {
    re.lastIndex = pos;
    const m = re.exec(expr);
    if (!m) { if (expr.slice(pos).trim() === "") break; throw new Error(`unexpected character at ${pos}`); }
    out.push(m[1]);
    pos = re.lastIndex;
  }
  return out;
}

/**
 * Evaluates an SPDX licence expression against the allow-list. `OR` (and cargo's legacy `/`) needs one allowed
 * alternative, `AND` needs all, `WITH <exception>` is judged by its licence part. Returns
 * { verdict: "ok" | "forbidden" | "not-listed" | "unknown", used: [ids], ids: [all ids seen] }.
 */
export function evaluateLicense(raw, allowed) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text === "" || /^(unknown|unlicensed|none|n\/a)$/i.test(text) || /^see licen[cs]e/i.test(text)) return { verdict: "unknown", used: [], ids: [] };
  let tokens;
  try { tokens = tokenize(text); } catch { return { verdict: "unknown", used: [], ids: [] }; }
  let i = 0;
  const ids = [];
  const isOp = (t, op) => t !== undefined && t.toUpperCase() === op;
  const fail = () => { throw new Error("syntax"); };
  // Each node evaluates to { ok, used }.
  function parseOr() {
    const alts = [parseAnd()];
    while (isOp(tokens[i], "OR") || tokens[i] === "/") { i++; alts.push(parseAnd()); }
    const good = alts.filter((a) => a.ok);
    if (good.length === 0) return { ok: false, used: [] };
    // Prefer an alternative that does not rely on MPL-2.0's "unmodified only" condition.
    good.sort((a, b) => a.used.filter((u) => u === "mpl-2.0").length - b.used.filter((u) => u === "mpl-2.0").length);
    return good[0];
  }
  function parseAnd() {
    const parts = [parsePrimary()];
    while (isOp(tokens[i], "AND")) { i++; parts.push(parsePrimary()); }
    return { ok: parts.every((p) => p.ok), used: parts.flatMap((p) => p.used) };
  }
  function parsePrimary() {
    const t = tokens[i];
    if (t === undefined || t === ")" || t === "/" || isOp(t, "AND") || isOp(t, "OR") || isOp(t, "WITH")) fail();
    if (t === "(") {
      i++;
      const inner = parseOr();
      if (tokens[i] !== ")") fail();
      i++;
      return inner;
    }
    i++;
    const id = t.replace(/\+$/, "").toLowerCase();
    ids.push(id);
    if (isOp(tokens[i], "WITH")) { i++; if (tokens[i] === undefined || tokens[i] === "(" || tokens[i] === ")") fail(); i++; }
    return allowed.has(id) ? { ok: true, used: [id] } : { ok: false, used: [] };
  }
  try {
    const r = parseOr();
    if (i !== tokens.length) fail();
    if (r.ok) return { verdict: "ok", used: r.used, ids };
  } catch { return { verdict: "unknown", used: [], ids }; }
  if (ids.some((id) => id.startsWith("licenseref-"))) return { verdict: "unknown", used: [], ids };
  return { verdict: ids.some((id) => STRONG_COPYLEFT.test(id)) ? "forbidden" : "not-listed", used: [], ids };
}

/** Judges every entry: adds `verdict`, `note` and (when an exception applies) `exception`. Also returns stale exceptions. */
export function judge(entries, policy, exceptions = []) {
  const usedEx = new Set();
  const rows = entries.map((e) => {
    const ev = evaluateLicense(e.license, policy.allowed);
    let verdict = ev.verdict;
    let note = "";
    let exception = null;
    if (verdict === "ok" && ev.used.includes("mpl-2.0")) note = "MPL-2.0: only unmodified";
    if (verdict !== "ok") {
      const idx = exceptions.findIndex((x) => x.ecosystem === e.ecosystem && x.name === e.name &&
        (x.version === undefined || x.version === "*" || x.version === e.version));
      if (idx >= 0) {
        const x = exceptions[idx];
        usedEx.add(idx);
        if (x.license.trim() === (e.license ?? "").trim()) { verdict = "exception"; exception = x; note = x.reason; }
        else note = `exception for "${x.license}" does not cover "${e.license ?? ""}"`;
      }
    }
    return { ...e, verdict, note, exception };
  });
  const stale = exceptions.filter((_, i) => !usedEx.has(i));
  return { rows, stale };
}

export const FAILING = new Set(["forbidden", "not-listed", "unknown"]);

// ---------------------------------------------------------------------------------------------------------------------
// Collectors (parsers are pure; collection shells out through an injectable `run`)

export function defaultRun(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd, encoding: "utf8", timeout: opts.timeoutMs ?? 180_000, maxBuffer: 1024 * 1024 * 1024,
    shell: process.platform === "win32" && cmd === "pnpm", env: { ...process.env, ...(opts.env ?? {}) },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error ? String(r.error.message ?? r.error) : null };
}

/** `pnpm licenses list --json`: { "<licence>": [ { name, versions: [...] } ] }. */
export function parsePnpmLicenses(doc, directNames = new Set()) {
  const out = [];
  for (const [license, pkgs] of Object.entries(doc ?? {})) {
    if (!Array.isArray(pkgs)) continue;
    for (const p of pkgs) {
      for (const version of p.versions?.length ? p.versions : [p.version ?? "?"]) {
        out.push({ ecosystem: "pnpm", name: p.name, version, license: p.license ?? license, direct: directNames.has(p.name) });
      }
    }
  }
  return out;
}

/** Names the workspace's package.json files depend on directly (the "direct" column). */
export function pnpmDirectNames(root) {
  const dirs = [root];
  try {
    const ws = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
    const block = /^packages:\s*\r?\n((?:[ \t]*-[^\n]*\n?)+)/m.exec(ws)?.[1] ?? "";
    for (const line of block.split(/\r?\n/)) {
      const pat = /^\s*-\s*["']?([^"'#\s]+)/.exec(line)?.[1];
      if (!pat) continue;
      if (pat.endsWith("/*")) {
        const base = join(root, pat.slice(0, -2));
        if (existsSync(base)) for (const d of readdirSync(base)) if (statSync(join(base, d)).isDirectory()) dirs.push(join(base, d));
      } else dirs.push(join(root, pat));
    }
  } catch { /* no workspace file: root only */ }
  const names = new Set();
  for (const d of dirs) {
    try {
      const pj = JSON.parse(readFileSync(join(d, "package.json"), "utf8"));
      for (const k of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) for (const n of Object.keys(pj[k] ?? {})) names.add(n);
    } catch { /* directory without package.json */ }
  }
  return names;
}

/** `cargo metadata --format-version 1`: every package with a registry/git source; workspace members are skipped. */
export function parseCargoMetadata(doc, ecosystem = "cargo") {
  const members = new Set(doc.workspace_members ?? []);
  const isLocal = (p) => members.has(p.id) || p.source == null;
  const direct = new Set((doc.packages ?? []).filter(isLocal).flatMap((p) => (p.dependencies ?? []).map((d) => d.name)));
  const out = [];
  for (const p of doc.packages ?? []) {
    if (isLocal(p)) continue;
    const license = p.license ?? (p.license_file ? `unknown (license-file ${p.license_file})` : null);
    out.push({ ecosystem, name: p.name, version: p.version, license, direct: direct.has(p.name) });
  }
  return out;
}

function stripTomlComment(s) {
  let q = null;
  let out = "";
  for (const ch of s) {
    if (q) { if (ch === q) q = null; } else if (ch === '"' || ch === "'") q = ch; else if (ch === "#") break;
    out += ch;
  }
  return out;
}

/** Minimal reader for the `[project]` table of a pyproject.toml: string and string-array values only. */
export function parsePyproject(text) {
  const proj = {};
  let inProject = false;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const sec = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(lines[i]);
    if (sec) { inProject = sec[1].trim() === "project"; continue; }
    if (!inProject) continue;
    const kv = /^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let value = kv[2];
    if (value.trimStart().startsWith("[")) {
      while (!value.split("\n").map(stripTomlComment).join("\n").includes("]") && i + 1 < lines.length) value += "\n" + lines[++i];
    }
    value = value.split("\n").map(stripTomlComment).join("\n").trim();
    if (value.startsWith("[")) proj[kv[1]] = [...value.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);
    else if (/^["']/.test(value)) proj[kv[1]] = /^"((?:[^"\\]|\\.)*)"|^'([^']*)'/.exec(value)?.slice(1).find((v) => v !== undefined) ?? "";
    else proj[kv[1]] = value;
  }
  return proj;
}

/** The distribution name of a PEP 508 requirement; null for requirements only needed with an extra. */
export function requirementName(req) {
  if (/extra\s*==/.test(req)) return null;
  return /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(req)?.[1] ?? null;
}

const CLASSIFIER_SPDX = new Map([
  ["License :: OSI Approved :: MIT License", "MIT"],
  ["License :: OSI Approved :: Apache Software License", "Apache-2.0"],
  ["License :: OSI Approved :: ISC License (ISCL)", "ISC"],
  ["License :: OSI Approved :: Mozilla Public License 2.0 (MPL 2.0)", "MPL-2.0"],
  ["License :: CC0 1.0 Universal (CC0 1.0) Public Domain Dedication", "CC0-1.0"],
]);

/** Licence of an installed Python distribution as reported by importlib.metadata (see PY_SNIPPET). */
export function pythonLicense(d) {
  if (d.licenseExpression) return d.licenseExpression;
  const fromClass = (d.classifiers ?? []).map((c) => CLASSIFIER_SPDX.get(c)).filter(Boolean);
  if (fromClass.length) return fromClass.join(" OR ");
  if (d.license && d.license.length < 100 && !d.license.includes("\n")) return d.license;
  return null;
}

// Runs under `python3 -I`: resolves requirement names (and, recursively, their Requires-Dist) from installed metadata.
const PY_SNIPPET = `
import json, sys, re
from importlib import metadata
seen, out, queue = set(), [], json.loads(sys.argv[1])
def norm(n): return re.sub(r"[-_.]+", "-", n).lower()
while queue:
    n = queue.pop()
    if norm(n) in seen: continue
    seen.add(norm(n))
    try: d = metadata.distribution(n)
    except metadata.PackageNotFoundError:
        out.append({"name": n, "installed": False}); continue
    m = d.metadata
    out.append({"name": m["Name"] or n, "version": d.version, "installed": True,
                "licenseExpression": m.get("License-Expression"), "license": m.get("License"),
                "classifiers": [c for c in (m.get_all("Classifier") or []) if c.startswith("License ::")]})
    for r in d.requires or []:
        if "extra ==" in r: continue
        mm = re.match(r"\\s*([A-Za-z0-9][A-Za-z0-9._-]*)", r)
        if mm: queue.append(mm.group(1))
print(json.dumps(out))
`;

/** Declared dependency names of one python root (a directory with pyproject.toml, or a Hermes plugin.yaml). */
export function readPythonRoot(dir) {
  const py = join(dir, "pyproject.toml");
  if (existsSync(py)) {
    const proj = parsePyproject(readFileSync(py, "utf8"));
    const own = typeof proj.license === "string" ? proj.license : null;
    const deps = (Array.isArray(proj.dependencies) ? proj.dependencies : []).map(requirementName).filter(Boolean);
    return { dir, kind: "pyproject", name: proj.name ?? dir, ownLicense: own, deps };
  }
  const yml = join(dir, "plugin.yaml");
  if (existsSync(yml)) {
    const text = readFileSync(yml, "utf8");
    const block = /^pip_dependencies:\s*\r?\n((?:[ \t]*-[^\n]*\n?)+)/m.exec(text)?.[1] ?? "";
    const deps = block.split(/\r?\n/).map((l) => /^\s*-\s*["']?([^"'#]+?)["']?\s*(?:#.*)?$/.exec(l)?.[1]).filter(Boolean).map(requirementName).filter(Boolean);
    return { dir, kind: "plugin.yaml", name: /^name:\s*(\S+)/m.exec(text)?.[1] ?? dir, ownLicense: null, deps };
  }
  return { dir, kind: "none", name: dir, ownLicense: null, deps: [] };
}

const PYTHON_ROOTS = ["clients/python/plur1bus-memory-client", "hosts/hermes/plur1bus"];

const firstLine = (s) => String(s).trim().split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 200) ?? "";

function collectPython(root, run) {
  const entries = [];
  const notes = [];
  const wanted = new Map();
  for (const rel of PYTHON_ROOTS) {
    const dir = join(root, rel);
    if (!existsSync(dir)) { notes.push(`python: ${rel} not found`); continue; }
    const info = readPythonRoot(dir);
    notes.push(`python: ${rel} (${info.kind}) own licence ${info.ownLicense ?? "not declared"}, ${info.deps.length} declared dependencies`);
    for (const d of info.deps) wanted.set(d.toLowerCase(), d);
  }
  if (wanted.size === 0) return { entries, notes };
  const r = run("python3", ["-I", "-c", PY_SNIPPET, JSON.stringify([...wanted.values()])], { cwd: root, timeoutMs: 60_000 });
  if (r.error || r.status !== 0) return { entries, notes, incomplete: `python3 metadata lookup failed: ${firstLine(r.error ?? r.stderr)}` };
  const norm = (n) => n.toLowerCase().replace(/[-_.]+/g, "-");
  const direct = new Set([...wanted.keys()].map(norm));
  for (const d of JSON.parse(r.stdout)) {
    entries.push({
      ecosystem: "python", name: d.name, version: d.version ?? "(not installed)",
      license: d.installed ? pythonLicense(d) : null, direct: direct.has(norm(d.name)),
    });
  }
  return { entries, notes };
}

function collectPnpm(root, run) {
  const r = run("pnpm", ["licenses", "list", "--json"], { cwd: root });
  if (r.error || r.status !== 0) return { entries: [], incomplete: `pnpm licenses list failed (is \`pnpm install\` done?): ${firstLine(r.error ?? (r.stdout + r.stderr))}` };
  let doc;
  try { doc = JSON.parse(r.stdout); } catch { return { entries: [], incomplete: "pnpm licenses list: output is not JSON" }; }
  if (doc.error) return { entries: [], incomplete: `pnpm licenses list: ${doc.error.code ?? "error"}` };
  return { entries: parsePnpmLicenses(doc, pnpmDirectNames(root)) };
}

function collectCargo(root, run, ecosystem, manifest, offlineOnly) {
  const mp = join(root, manifest);
  if (!existsSync(mp)) return { entries: [], incomplete: `${manifest} not found` };
  const base = ["metadata", "--format-version", "1", "--locked", "--manifest-path", mp];
  let r = run("cargo", [...base, "--offline"], { cwd: root });
  if ((r.error || r.status !== 0) && !offlineOnly) r = run("cargo", base, { cwd: root });
  if (r.error || r.status !== 0) return { entries: [], incomplete: `cargo metadata (${manifest}) failed: ${firstLine(r.error ?? r.stderr)}` };
  try { return { entries: parseCargoMetadata(JSON.parse(r.stdout), ecosystem) }; } catch { return { entries: [], incomplete: `cargo metadata (${manifest}): output is not JSON` }; }
}

export function collectAll({ root, run = defaultRun, only = ECOSYSTEMS, offlineOnly = false }) {
  const entries = [];
  const incomplete = [];
  const notes = [];
  const take = (eco, res) => {
    entries.push(...res.entries);
    if (res.incomplete) incomplete.push({ ecosystem: eco, reason: res.incomplete });
    notes.push(...(res.notes ?? []));
  };
  if (only.includes("pnpm")) take("pnpm", collectPnpm(root, run));
  if (only.includes("cargo")) take("cargo", collectCargo(root, run, "cargo", "Cargo.toml", offlineOnly));
  if (only.includes("cargo-desktop")) take("cargo-desktop", collectCargo(root, run, "cargo-desktop", "apps/desktop/Cargo.toml", offlineOnly));
  if (only.includes("python")) take("python", collectPython(root, run));
  // The same package may be reached more than once; keep one row per ecosystem+name+version.
  const seen = new Map();
  for (const e of entries) {
    const k = `${e.ecosystem}\0${e.name}\0${e.version}`;
    const prev = seen.get(k);
    if (!prev) seen.set(k, { ...e }); else prev.direct ||= e.direct;
  }
  return { entries: [...seen.values()], incomplete, notes };
}

// ---------------------------------------------------------------------------------------------------------------------
// Advisories mode (second mode; never fails because a tool or the network is missing)

export function parsePnpmAudit(stdout) {
  let doc;
  try { doc = JSON.parse(stdout); } catch { return { status: "skipped", reason: "pnpm audit gave no JSON (no network?)" }; }
  const v = doc?.metadata?.vulnerabilities;
  if (!v) return { status: "skipped", reason: `pnpm audit gave no result${doc?.error?.code ? ` (${doc.error.code})` : ""}` };
  const findings = Object.values(doc.advisories ?? {}).map((a) => `${a.module_name}: ${a.title} [${a.severity}]${a.url ? ` ${a.url}` : ""}`);
  const count = Object.values(v).reduce((s, n) => s + (Number(n) || 0), 0);
  return count > 0 || findings.length > 0 ? { status: "findings", findings, summary: JSON.stringify(v) } : { status: "ok", findings: [] };
}

export function parseCargoAudit(stdout) {
  let doc;
  try { doc = JSON.parse(stdout); } catch { return { status: "skipped", reason: "cargo audit gave no JSON (advisory db unreachable?)" }; }
  if (!doc?.vulnerabilities) return { status: "skipped", reason: "cargo audit gave no result" };
  const findings = (doc.vulnerabilities.list ?? []).map((x) => `${x.package?.name} ${x.package?.version}: ${x.advisory?.id} ${x.advisory?.title}`);
  const warnings = Object.values(doc.warnings ?? {}).flat().map((w) => `${w.package?.name} ${w.package?.version}: ${w.kind} ${w.advisory?.id ?? ""}`.trim());
  return doc.vulnerabilities.found ? { status: "findings", findings, warnings } : { status: "ok", findings: [], warnings };
}

export function runAdvisories({ root, run = defaultRun }) {
  const results = [];
  const p = run("pnpm", ["audit", "--json"], { cwd: root, timeoutMs: 120_000 });
  results.push({ name: "pnpm audit", ...(p.error ? { status: "skipped", reason: `pnpm not runnable: ${p.error}` } : parsePnpmAudit(p.stdout)) });
  const ver = run("cargo", ["audit", "--version"], { cwd: root, timeoutMs: 20_000 });
  const haveCargoAudit = !ver.error && ver.status === 0;
  for (const [label, lock] of [["cargo audit (workspace)", "Cargo.lock"], ["cargo audit (apps/desktop)", "apps/desktop/Cargo.lock"]]) {
    if (!haveCargoAudit) { results.push({ name: label, status: "skipped", reason: "cargo-audit is not installed (cargo install cargo-audit --locked)" }); continue; }
    const r = run("cargo", ["audit", "--json", "--file", join(root, lock)], { cwd: root, timeoutMs: 120_000 });
    results.push({ name: label, ...(r.error ? { status: "skipped", reason: r.error } : parseCargoAudit(r.stdout)) });
  }
  results.push({ name: "python", status: "skipped", reason: "no advisory tool wired (pip-audit needs installed packages and network)" });
  return results;
}

// ---------------------------------------------------------------------------------------------------------------------
// Output

function table(headers, rows) {
  const w = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r) => r.map((c, i) => String(c).padEnd(w[i])).join("  ").trimEnd();
  return [line(headers), line(w.map((n) => "-".repeat(n))), ...rows.map(line)].join("\n");
}

export function renderReport({ rows, stale, incomplete, notes }, { verbose = false } = {}) {
  const out = [];
  const eco = [...new Set(rows.map((r) => r.ecosystem))].sort();
  const count = (e, f) => rows.filter((r) => r.ecosystem === e && f(r)).length;
  out.push(table(["ecosystem", "packages", "direct", "ok", "exception", "violations"],
    eco.map((e) => [e, count(e, () => true), count(e, (r) => r.direct), count(e, (r) => r.verdict === "ok"), count(e, (r) => r.verdict === "exception"), count(e, (r) => FAILING.has(r.verdict))])));
  const shown = rows.filter((r) => verbose || r.verdict !== "ok" || r.note);
  if (shown.length) {
    out.push("", table(["ecosystem", "package", "version", "dep", "licence", "verdict", "note"],
      shown.sort((a, b) => a.ecosystem.localeCompare(b.ecosystem) || a.name.localeCompare(b.name)).map((r) => [r.ecosystem, r.name, r.version, r.direct ? "direct" : "trans.", r.license ?? "(none)", r.verdict.toUpperCase(), r.note])));
  }
  const byLicense = new Map();
  for (const r of rows) byLicense.set(r.license ?? "(none)", (byLicense.get(r.license ?? "(none)") ?? 0) + 1);
  out.push("", "licences: " + [...byLicense].sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} x${n}`).join(", "));
  for (const s of stale) out.push(`warning: exception for ${s.ecosystem}/${s.name}${s.version ? `@${s.version}` : ""} matches no dependency (stale?)`);
  for (const n of notes ?? []) out.push(`note: ${n}`);
  for (const i of incomplete) out.push(`INCOMPLETE ${i.ecosystem}: ${i.reason}`);
  return out.join("\n");
}

// ---------------------------------------------------------------------------------------------------------------------
// CLI

const USAGE = `usage: node scripts/audit-deps.mjs [--advisories] [--json] [--verbose] [--only <eco[,eco]>] [--offline]
                                   [--allow-incomplete] [--root <dir>] [--policy <file>] [--exceptions <file>]
ecosystems: ${ECOSYSTEMS.join(", ")}`;

export function parseArgs(argv) {
  const o = { advisories: false, json: false, verbose: false, offline: false, allowIncomplete: false, only: ECOSYSTEMS, root: null, policy: null, exceptions: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === "--advisories") o.advisories = true;
    else if (a === "--json") o.json = true;
    else if (a === "--verbose") o.verbose = true;
    else if (a === "--offline") o.offline = true;
    else if (a === "--allow-incomplete") o.allowIncomplete = true;
    else if (a === "--only") {
      o.only = val().split(",").map((s) => s.trim()).filter(Boolean);
      const bad = o.only.filter((e) => !ECOSYSTEMS.includes(e));
      if (bad.length) throw new Error(`unknown ecosystem: ${bad.join(", ")}`);
    } else if (a === "--root") o.root = val();
    else if (a === "--policy") o.policy = val();
    else if (a === "--exceptions") o.exceptions = val();
    else if (a === "-h" || a === "--help") o.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

/** Returns the process exit code; all I/O goes through `io` so tests can drive it. */
export function main(argv, io = {}) {
  const log = io.log ?? console.log;
  const err = io.err ?? console.error;
  const run = io.run ?? defaultRun;
  let o;
  try { o = parseArgs(argv); } catch (e) { err(`audit-deps: ${e.message}\n${USAGE}`); return 2; }
  if (o.help) { log(USAGE); return 0; }
  const root = resolve(o.root ?? join(dirname(fileURLToPath(import.meta.url)), ".."));

  if (o.advisories) {
    const results = runAdvisories({ root, run });
    if (o.json) log(JSON.stringify({ mode: "advisories", results }, null, 2));
    else {
      log(table(["check", "status", "detail"], results.map((r) => [r.name, r.status, r.reason ?? (r.findings?.length ? `${r.findings.length} finding(s)` : "")])));
      for (const r of results) for (const f of r.findings ?? []) log(`  ${r.name}: ${f}`);
      for (const r of results) for (const w of r.warnings ?? []) log(`  ${r.name} (warning): ${w}`);
    }
    return results.some((r) => r.status === "findings") ? 1 : 0;
  }

  let policy, exceptions;
  try {
    policy = parsePolicy(readFileSync(o.policy ?? join(root, "docs/dependency-policy.md"), "utf8"));
    const exFile = o.exceptions ?? join(root, "docs/dependency-exceptions.json");
    exceptions = existsSync(exFile) ? parseExceptions(readFileSync(exFile, "utf8")) : [];
  } catch (e) { err(`audit-deps: ${e.message}`); return 2; }

  const { entries, incomplete, notes } = collectAll({ root, run, only: o.only, offlineOnly: o.offline });
  const { rows, stale } = judge(entries, policy, exceptions);
  const violations = rows.filter((r) => FAILING.has(r.verdict));
  if (o.json) log(JSON.stringify({ mode: "licenses", violations: violations.length, incomplete, stale, rows }, null, 2));
  else {
    log(renderReport({ rows, stale, incomplete, notes }, { verbose: o.verbose }));
    log(violations.length ? `\nFAIL: ${violations.length} dependency licence violation(s)` : "\nOK: no licence violations");
  }
  if (violations.length) return 1;
  if (incomplete.length && !o.allowIncomplete) { err(`audit-deps: ${incomplete.length} ecosystem(s) could not be collected (exit 3; --allow-incomplete to accept)`); return 3; }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exit(main(process.argv.slice(2)));
