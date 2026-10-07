#!/usr/bin/env node
// i18n completeness check (E2): de/en key parity, placeholder parity, dead and unknown keys, and a heuristic for
// hard-coded user text outside the catalogue. Config: <root>/scripts/i18n.config.json. Exit 1 on any finding.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const STR = String.raw`"(?:[^"\\]|\\.)*"`;
const ENTRY = new RegExp(String.raw`^\s*(${STR}|[A-Za-z_$][\w$]*)\s*:\s*(${STR})\s*,?\s*$`);

export function placeholders(s) {
  return [...new Set([...s.matchAll(/\{([A-Za-z_][\w]*)\}/g)].map((m) => m[1]))].sort();
}

/** Parse `const <name> ... = {` up to the closing `}` line; every inner line must be `"key": "value",`. */
export function parseCatalogue(text, name, file, errors) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(String.raw`^(?:export\s+)?const\s+${name}\b[^=]*=\s*\{\s*$`).test(l));
  if (start < 0) { errors.push(`${file}: catalogue "${name}" not found`); return new Map(); }
  const out = new Map();
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\}/.test(l)) return out;
    if (/^\s*(\/\/.*)?$/.test(l)) continue;
    const m = ENTRY.exec(l);
    if (!m) { errors.push(`${file}:${i + 1}: unparseable catalogue line (expected "key": "text",)`); continue; }
    const key = m[1].startsWith('"') ? JSON.parse(m[1]) : m[1];
    if (out.has(key)) errors.push(`${file}:${i + 1}: duplicate key "${key}" in ${name}`);
    out.set(key, JSON.parse(m[2]));
  }
  errors.push(`${file}: catalogue "${name}" is not closed`);
  return out;
}

function walk(dir, acc = []) {
  for (const e of readdirSync(dir).sort()) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx|js|mjs)$/.test(e)) acc.push(p);
  }
  return acc;
}

const hasText = (s) => /[A-Za-z]{2}/.test(s) && !/^[a-z][\w-]*$/.test(s);

/** Heuristic: text literals that are children of h(...) or values of aria-label/title/placeholder/alt. */
export function hardcodedLiterals(src) {
  const hits = [];
  src.split(/\r?\n/).forEach((line, idx) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    for (const m of line.matchAll(new RegExp(String.raw`(?:aria-label|"aria-label"|title|placeholder|alt)"?\s*:\s*(${STR})`, "g"))) {
      const v = JSON.parse(m[1]);
      if (hasText(v)) hits.push({ line: idx + 1, text: v });
    }
    if (!/\bh\(/.test(line)) return;
    const rest = line.replace(/\bh\(\s*"[^"]*"/g, "h(");
    for (const m of rest.matchAll(new RegExp(STR, "g"))) {
      const before = rest.slice(0, m.index);
      if (/\bt\(\s*$/.test(before)) continue; // catalogue lookup
      if (/[!=]==?\s*$/.test(before)) continue; // comparison, not display text
      if (/(?:[{,]|^)\s*"?[\w-]+"?\s*:\s*$/.test(before)) continue; // property value (props handled above)
      const v = JSON.parse(m[0]);
      if (hasText(v)) hits.push({ line: idx + 1, text: v });
    }
  });
  return hits;
}

export function check(root) {
  const errors = [];
  const cfgPath = join(root, "scripts", "i18n.config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  const allow = new Set();
  const deadOk = new Set();
  const allowPath = join(root, ...cfg.allowlist.split("/"));
  if (existsSync(allowPath)) {
    const a = JSON.parse(readFileSync(allowPath, "utf8"));
    for (const e of a.entries ?? []) allow.add(`${e.file}\u0000${e.text}`);
    for (const e of a.deadKeys ?? []) deadOk.add(`${e.file}\u0000${e.key}`);
  }
  const catFiles = new Set(cfg.catalogues.map((c) => resolve(root, ...c.file.split("/"))));
  const sources = cfg.sources.flatMap((s) => walk(join(root, ...s.split("/")))).filter((f) => !catFiles.has(resolve(f)));
  const sourceText = sources.map((f) => [f, readFileSync(f, "utf8")]);
  const rel = (f) => relative(root, f).split(sep).join("/");

  for (const c of cfg.catalogues) {
    const file = c.file;
    const text = readFileSync(join(root, ...file.split("/")), "utf8");
    const en = parseCatalogue(text, c.en, file, errors);
    const de = parseCatalogue(text, c.de, file, errors);
    for (const k of en.keys()) if (!de.has(k)) errors.push(`${file}: key "${k}" missing in ${c.de}`);
    for (const k of de.keys()) if (!en.has(k)) errors.push(`${file}: key "${k}" missing in ${c.en}`);
    for (const [k, v] of en) {
      if (!de.has(k)) continue;
      const a = placeholders(v).join(","), b = placeholders(de.get(k)).join(",");
      if (a !== b) errors.push(`${file}: placeholders differ for "${k}": ${c.en}={${a}} ${c.de}={${b}}`);
      if (v.trim() === "" || de.get(k).trim() === "") errors.push(`${file}: empty text for "${k}"`);
    }
    const all = sourceText.map(([, s]) => s).join("\n");
    for (const k of en.keys()) {
      const q = JSON.stringify(k);
      if (!all.includes(q) && !all.includes(`'${k}'`) && !deadOk.has(`${file}\u0000${k}`)) errors.push(`${file}: dead key "${k}" (never referenced)`);
    }
    for (const [f, s] of sourceText)
      for (const m of s.matchAll(/\bt\(\s*"([^"]+)"/g))
        if (!en.has(m[1])) errors.push(`${rel(f)}: t("${m[1]}") uses a key not in the catalogue`);
  }

  for (const [f, s] of sourceText)
    for (const h of hardcodedLiterals(s))
      if (!allow.has(`${rel(f)}\u0000${h.text}`)) errors.push(`${rel(f)}:${h.line}: hard-coded text "${h.text}" (move to the catalogue or allowlist it)`);
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--root");
  const root = resolve(i > 0 ? process.argv[i + 1] : fileURLToPath(new URL("..", import.meta.url)));
  const errors = check(root);
  if (errors.length) {
    console.error(`check-i18n: ${errors.length} problem(s)\n` + errors.map((e) => `  ${e}`).join("\n"));
    process.exit(1);
  }
  console.log("check-i18n: ok");
}
