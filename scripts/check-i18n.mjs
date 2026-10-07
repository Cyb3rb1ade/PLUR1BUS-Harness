// i18n completeness check (de/en). Run: node scripts/check-i18n.mjs [--root <dir>] [--config <file>]
//
// What it checks, per registered "surface" (a message catalogue dir holding en.json + de.json, plus the source
// dirs whose code reads it):
//   missing-key         key present in one language only
//   empty-message       blank or non-string value
//   placeholder-mismatch  {name} variables differ between en and de (as multisets)
//   dead-key            key never referenced by the sources (literal use, or a template like `pair.error.${x}`)
//   hardcoded-text      user-visible literal outside the catalogues (heuristic, see HARDCODED below)
// Repo-wide:
//   unregistered-catalogue  a directory with en.json + de.json that no surface covers
//   invalid-json            a catalogue that does not parse to a flat string map
//   stale-allow             an allowlist entry that no longer matches anything (keeps the allowlist honest)
//
// The config (scripts/check-i18n.config.json) registers surfaces and holds the allowlist; every allow entry needs
// a "reason". Heuristics are deliberately conservative toward reporting: a false positive costs one allowlist line,
// a false negative ships an untranslated string. Not covered: Rust-side tables (tray menu, CLI/clap help), which
// have no de/en catalogue today; they are out of this script's reach and listed as an open point in the PR.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, sep, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SKIP_DIRS = new Set(["node_modules", "dist", "target", "generated", ".git", "__pycache__", ".venv", "venv"]);
const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".html"]);
const posix = (p) => p.split(sep).join("/");

function walk(root, dir, out = []) {
  let entries;
  try { entries = readdirSync(join(root, dir), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) walk(root, rel, out);
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

export function placeholders(text) {
  return [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

/** Blank out comments, keep strings and line structure (so offsets map to the original line numbers). */
export function stripComments(src) {
  let out = "";
  for (let i = 0; i < src.length;) {
    const c = src[i], n = src[i + 1];
    if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") { out += " "; i++; } continue; }
    if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      for (; i < stop; i++) out += src[i] === "\n" ? "\n" : " ";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) { if (src[j] === "\\") j++; if (c !== "`" && src[j] === "\n") break; j++; }
      out += src.slice(i, j + 1); i = j + 1; continue;
    }
    out += c; i++;
  }
  return out;
}

const lineOf = (text, index) => text.slice(0, index).split("\n").length;
const looksLikeText = (s) => /[A-Za-zÀ-ɏ]{2,}/.test(s.replace(/\{\w+\}|\$\{[^}]*\}/g, "")) && (/\s/.test(s.trim()) || /^[A-ZÀ-Þ]/.test(s.trim()));
const Q = String.raw`(["'\`])((?:\\.|(?!\1)[^\\\n])*)\1`;

// Each heuristic yields { index, text }. Strings are group 2 (or the group named in `g`).
const HARDCODED = [
  { why: "inline bilingual ternary", re: new RegExp(String.raw`\b(?:de|german|isDe|isGerman)\s*\?\s*${Q}\s*:\s*["'\`]`, "g"), g: 2 },
  { why: "assigned to textContent/innerText/placeholder/title/alt/ariaLabel", re: new RegExp(String.raw`\.(?:textContent|innerText|placeholder|title|alt|ariaLabel)\s*=\s*${Q}`, "g"), g: 2 },
  { why: "text-bearing attribute via setAttribute", re: new RegExp(String.raw`setAttribute\(\s*["'](?:aria-label|aria-description|title|placeholder|alt)["']\s*,\s*${Q}`, "g"), g: 2 },
  { why: "createTextNode literal", re: new RegExp(String.raw`createTextNode\(\s*${Q}`, "g"), g: 2 },
  { why: "element(tag, class, literal)", re: new RegExp(String.raw`\belement\(\s*["'][a-z0-9]+["']\s*,\s*[^,()]+?,\s*${Q}`, "g"), g: 2 },
];

function htmlTexts(src) {
  const found = [];
  const body = src.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, (m) => m.replace(/[^\n]/g, " "));
  for (const m of body.matchAll(/>([^<>]+)</g)) {
    const t = m[1].trim();
    if (t && looksLikeText(t)) found.push({ index: m.index + 1, text: t, why: "html text node" });
  }
  for (const m of body.matchAll(/\b(?:aria-label|title|placeholder|alt)="([^"]+)"/gi)) if (looksLikeText(m[1])) found.push({ index: m.index, text: m[1], why: "html attribute" });
  return found;
}

function hardcodedIn(rel, raw) {
  const out = [];
  if (rel.endsWith(".html")) {
    for (const f of htmlTexts(raw)) out.push({ line: lineOf(raw, f.index), text: f.text, why: f.why });
    return out;
  }
  const src = stripComments(raw);
  for (const h of HARDCODED) {
    for (const m of src.matchAll(h.re)) {
      const text = m[h.g];
      if (looksLikeText(text)) out.push({ line: lineOf(src, m.index), text, why: h.why });
    }
  }
  return out;
}

function usedKeys(keys, sourceTexts) {
  const literal = new Set(), patterns = [];
  for (const txt of sourceTexts) {
    for (const m of txt.matchAll(/(["'`])([A-Za-z0-9_.\-]+)\1/g)) literal.add(m[2]);
    for (const m of txt.matchAll(/`([A-Za-z0-9_.\-]*(?:\$\{[^}]*\}[A-Za-z0-9_.\-]*)+)`/g)) {
      if (!m[1].includes(".")) continue; // a bare `${x}` would match every key
      const re = m[1].split(/\$\{[^}]*\}/).map((p) => p.replace(/[.*+?^${}()|[\]\\\-]/g, "\\$&")).join("[\\w-]+");
      patterns.push(new RegExp(`^${re}$`));
    }
  }
  return new Set(keys.filter((k) => literal.has(k) || patterns.some((p) => p.test(k))));
}

function loadCatalogue(root, dir, lang, findings) {
  const file = `${dir}/${lang}.json`;
  try {
    const data = JSON.parse(readFileSync(join(root, file), "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("not an object");
    return data;
  } catch (e) {
    findings.push({ kind: "invalid-json", file, detail: String(e.message) });
    return null;
  }
}

export function checkI18n({ root, config }) {
  const findings = [];
  const allow = (config.allow ?? []).map((a) => ({ ...a, hits: 0 }));
  const surfaces = config.surfaces ?? [];
  const files = walk(root, "");
  const covered = new Set(surfaces.map((s) => s.catalogueDir));
  const ignorePrefixes = config.ignore ?? [];

  for (const f of files) {
    if (!f.endsWith("/en.json") || ignorePrefixes.some((p) => f.startsWith(p))) continue;
    const dir = f.slice(0, -"/en.json".length);
    if (files.includes(`${dir}/de.json`) && !covered.has(dir)) findings.push({ kind: "unregistered-catalogue", file: dir, detail: "en.json + de.json not covered by any surface in the config" });
  }

  for (const s of surfaces) {
    const en = loadCatalogue(root, s.catalogueDir, "en", findings);
    const de = loadCatalogue(root, s.catalogueDir, "de", findings);
    if (!en || !de) continue;
    for (const k of Object.keys(en)) if (!(k in de)) findings.push({ kind: "missing-key", file: `${s.catalogueDir}/de.json`, key: k, detail: "missing in de" });
    for (const k of Object.keys(de)) if (!(k in en)) findings.push({ kind: "missing-key", file: `${s.catalogueDir}/en.json`, key: k, detail: "missing in en" });
    for (const [lang, cat] of [["en", en], ["de", de]]) {
      for (const [k, v] of Object.entries(cat)) if (typeof v !== "string" || !v.trim()) findings.push({ kind: "empty-message", file: `${s.catalogueDir}/${lang}.json`, key: k, detail: "blank or non-string" });
    }
    for (const k of Object.keys(en)) {
      if (typeof en[k] !== "string" || typeof de[k] !== "string" || !en[k].trim() || !de[k].trim()) continue;
      const a = placeholders(en[k]).join(","), b = placeholders(de[k]).join(",");
      if (a !== b) findings.push({ kind: "placeholder-mismatch", file: `${s.catalogueDir}/de.json`, key: k, detail: `en {${a}} vs de {${b}}` });
    }
    const sourceFiles = (s.sourceDirs ?? []).flatMap((d) => files.filter((f) => f.startsWith(`${d}/`) && SOURCE_EXT.has(f.slice(f.lastIndexOf("."))) && !/\.test\.[a-z]+$/.test(f) && !f.startsWith(`${s.catalogueDir}/`)));
    const raws = sourceFiles.map((f) => [f, readFileSync(join(root, f), "utf8")]);
    const used = usedKeys(Object.keys(en), raws.map(([, t]) => stripComments(t)));
    for (const k of Object.keys(en)) if (!used.has(k)) findings.push({ kind: "dead-key", file: `${s.catalogueDir}/en.json`, key: k, detail: "not referenced by any source" });
    for (const [f, raw] of raws) for (const h of hardcodedIn(f, raw)) findings.push({ kind: "hardcoded-text", file: f, line: h.line, detail: `${h.why}: ${JSON.stringify(h.text)}` });
  }

  const kept = findings.filter((f) => {
    const hit = allow.find((a) => a.kind === f.kind && (a.key === undefined || a.key === f.key) && (a.file === undefined || a.file === f.file) && (a.key !== undefined || a.file !== undefined));
    if (hit) { hit.hits++; return false; }
    return true;
  });
  for (const a of allow) {
    if (!a.reason) kept.push({ kind: "stale-allow", file: a.file ?? "(config)", key: a.key, detail: "allow entry without a reason" });
    else if (a.hits === 0) kept.push({ kind: "stale-allow", file: a.file ?? "(config)", key: a.key, detail: `allow entry for ${a.kind} matches nothing; remove it` });
  }
  return kept;
}

export function format(f) {
  return `${f.kind}  ${f.file}${f.line ? `:${f.line}` : ""}${f.key ? `  [${f.key}]` : ""}  ${f.detail}`;
}

function main() {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(opt("--root", join(here, "..")));
  const configPath = resolve(opt("--config", join(here, "check-i18n.config.json")));
  if (!existsSync(configPath) || !statSync(configPath).isFile()) { console.error(`check-i18n: config not found: ${configPath}`); process.exit(2); }
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const findings = checkI18n({ root, config });
  if (findings.length === 0) { console.log(`check-i18n: ok (${(config.surfaces ?? []).length} surface(s), ${(config.allow ?? []).length} allowlisted)`); return; }
  for (const f of findings) console.error(format(f));
  console.error(`check-i18n: ${findings.length} finding(s)`);
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
