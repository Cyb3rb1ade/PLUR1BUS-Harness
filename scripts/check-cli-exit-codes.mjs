#!/usr/bin/env node
// Extracts the exit codes the plur1bus CLI can produce from crates/plur1bus/src/** and checks them against the
// "CLI-Exit-Codes" section of docs/errors.md. Pure text analysis, no Rust toolchain needed.
//
// Sources recognised (see crates/plur1bus/src/output.rs):
//   <x>.fail(code, message, extra, EXIT)   Out::fail, the exit code is the last argument
//   std::process::exit(N) / output::exit(N) / exit(N)
//   fail(layout, N, msg)                    supervisor::fail (only in supervisor/)
//   exit_code_for(..) match arms            RPC error code -> exit code
//   const EXIT_*: i32 = N                   named exit constants
//
// Usage: node scripts/check-cli-exit-codes.mjs [--check] [--list] [--json]
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// The two paths can be overridden (tests point them at a synthetic tree).
const SRC = process.env.P1B_EXIT_SRC ?? join(ROOT, 'crates/plur1bus/src')
const DOC = process.env.P1B_EXIT_DOC ?? join(ROOT, 'docs/errors.md')
export const SECTION = 'CLI-Exit-Codes'

/** Replaces comments with spaces (same length, newlines kept) so offsets and line numbers survive. String literals are kept. */
export function stripComments(src) {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++ }
    } else if (c === '/' && n === '*') {
      let depth = 0
      while (i < src.length) {
        if (src[i] === '/' && src[i + 1] === '*') { depth++; out += '  '; i += 2 }
        else if (src[i] === '*' && src[i + 1] === '/') { depth--; out += '  '; i += 2; if (!depth) break }
        else { out += src[i] === '\n' ? '\n' : ' '; i++ }
      }
    } else if (c === '"') {
      out += c; i++
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\') { out += src[i++] }
        out += src[i++]
      }
      out += src[i++] ?? ''
    } else if (c === 'r' && (n === '"' || n === '#') && /^r#*"/.test(src.slice(i, i + 12))) {
      const hashes = /^r(#*)"/.exec(src.slice(i, i + 12))[1]
      const end = '"' + hashes
      const close = src.indexOf(end, i + 2 + hashes.length)
      const stop = close < 0 ? src.length : close + end.length
      out += src.slice(i, stop)
      i = stop
    } else if (c === "'" && /^'(\\.|[^\\'])'/.test(src.slice(i, i + 4))) {
      const m = /^'(\\.|[^\\'])'/.exec(src.slice(i, i + 4))
      out += m[0]; i += m[0].length
    } else {
      out += c; i++
    }
  }
  return out
}

/** 1 for every offset inside a string literal (quotes included), so code patterns can skip text in strings. Expects comment-free input. */
export function stringMask(src) {
  const mask = new Uint8Array(src.length)
  let i = 0
  while (i < src.length) {
    const raw = src[i] === 'r' && /^r#*"/.exec(src.slice(i, i + 12))
    if (src[i] === '"' || raw) {
      let stop
      if (raw) {
        const end = '"' + raw[0].slice(1, -1)
        const close = src.indexOf(end, i + raw[0].length)
        stop = close < 0 ? src.length : close + end.length
      } else {
        stop = i + 1
        while (stop < src.length && src[stop] !== '"') { if (src[stop] === '\\') stop++; stop++ }
        stop++
      }
      mask.fill(1, i, Math.min(stop, src.length))
      i = stop
    } else if (src[i] === "'" && /^'(\\.|[^\\'])'/.test(src.slice(i, i + 4))) {
      i += /^'(\\.|[^\\'])'/.exec(src.slice(i, i + 4))[0].length
    } else i++
  }
  return mask
}

/** Splits the text after an opening paren into top-level arguments. Returns { args, end } or null if unbalanced. */
export function splitArgs(text, open) {
  const args = []
  let depth = 0
  let start = open + 1
  let i = open
  while (i < text.length) {
    const c = text[i]
    if (c === '"') {
      i++
      while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++ }
    } else if (c === '(' || c === '[' || c === '{') {
      depth++
    } else if (c === ')' || c === ']' || c === '}') {
      depth--
      if (depth === 0) {
        const last = text.slice(start, i).trim()
        if (last) args.push(last)
        return { args, end: i }
      }
    } else if (c === ',' && depth === 1) {
      args.push(text.slice(start, i).trim())
      start = i + 1
    }
    i++
  }
  return null
}

const lineOf = (text, offset) => text.slice(0, offset).split('\n').length
const intOf = (s) => (/^-?\d+$/.test(s) ? Number(s) : null)

/**
 * Finds every exit-code source in one Rust file.
 * Entry: { file, line, kind, context, code (number|null), key, expr }.
 * `code === null` means the exit value is not a literal (see `expr`).
 */
export function extract(rawSrc, file = '<memory>', knownConsts = {}) {
  const src = stripComments(rawSrc)
  const inString = stringMask(src)
  const found = []
  const consts = { ...knownConsts }
  for (const m of src.matchAll(/\bconst\s+(EXIT_[A-Z0-9_]+)\s*:\s*i32\s*=\s*(\d+)\s*;/g)) {
    if (inString[m.index]) continue
    consts[m[1]] = Number(m[2])
    found.push({ file, line: lineOf(src, m.index), kind: 'const', context: m[1], code: Number(m[2]), key: m[1], expr: m[2] })
  }
  // `if cond { 0 } else { 1 }` with integer-literal branches yields several codes
  const branchCodes = (expr) => {
    if (!/^if\b/.test(expr)) return null
    const lits = [...expr.matchAll(/\{\s*(\d+)\s*\}/g)].map((m) => Number(m[1]))
    return lits.length >= 2 ? [...new Set(lits)] : null
  }
  const resolveExit = (expr) => {
    const bare = expr.replace(/^(?:super::|crate::supervisor::)+/, '')
    return intOf(expr) ?? consts[bare] ?? null
  }
  // fn context: nearest preceding `fn name`
  const fns = [...src.matchAll(/\bfn\s+([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => [m.index, m[1]])
  const fnAt = (off) => {
    let name = '(top level)'
    for (const [at, n] of fns) { if (at < off) name = n; else break }
    return name
  }

  // Out::fail: `.fail(code, message, extra, exit)`; the definition `fn fail(&self, ..)` has no leading dot.
  for (const m of src.matchAll(/\.fail\s*\(/g)) {
    if (inString[m.index]) continue
    const r = splitArgs(src, m.index + m[0].length - 1)
    if (!r || r.args.length !== 4) continue
    const [errCode, , , exit] = r.args
    const key = /^"([^"]*)"$/.exec(errCode)?.[1] ?? `<${errCode.replace(/\s+/g, ' ').slice(0, 40)}>`
    found.push({ file, line: lineOf(src, m.index), kind: 'Out::fail', context: fnAt(m.index), code: resolveExit(exit), key, expr: exit })
  }

  // process::exit(N) / output::exit(N) / bare exit(N) (not method calls, not definitions)
  for (const m of src.matchAll(/(?<![\w.])(?:(?:std::)?process::exit|output::exit|exit)\s*\(/g)) {
    if (inString[m.index]) continue
    const before = src.slice(Math.max(0, m.index - 12), m.index)
    if (/\bfn\s+$/.test(before)) continue
    const r = splitArgs(src, m.index + m[0].length - 1)
    if (!r || r.args.length !== 1) continue
    const exit = r.args[0]
    for (const code of branchCodes(exit) ?? [resolveExit(exit)]) {
      found.push({ file, line: lineOf(src, m.index), kind: 'exit', context: fnAt(m.index), code, key: '', expr: exit })
    }
  }

  // supervisor::fail(layout, N, msg): a free function with an integer second argument
  if (/supervisor[\\/]/.test(file) || file === '<memory>') {
    for (const m of src.matchAll(/(?<![\w.:])fail\s*\(/g)) {
    if (inString[m.index]) continue
      const before = src.slice(Math.max(0, m.index - 12), m.index)
      if (/\bfn\s+$/.test(before)) continue
      const r = splitArgs(src, m.index + m[0].length - 1)
      if (!r || r.args.length !== 3) continue
      const exit = r.args[1]
      found.push({ file, line: lineOf(src, m.index), kind: 'supervisor::fail', context: fnAt(m.index), code: resolveExit(exit), key: '', expr: exit })
    }
  }

  // `exit_code_for(..)` and `fn exit(&self)`: `"E_X" => N,` arms (+ the `_ => N` default)
  for (const fm of src.matchAll(/\bfn\s+(exit_code_for\b|exit\s*\(\s*&self)/g)) {
    if (inString[fm.index]) continue
    const open = src.indexOf('{', fm.index)
    let depth = 0
    let end = open
    for (; end < src.length; end++) {
      if (src[end] === '{') depth++
      else if (src[end] === '}' && --depth === 0) break
    }
    const body = src.slice(open, end)
    for (const m of body.matchAll(/((?:"[A-Z0-9_]+"\s*\|?\s*)+|\b_)\s*=>\s*(\d+)/g)) {
      const keys = m[1] === '_' ? ['(any other code)'] : [...m[1].matchAll(/"([A-Z0-9_]+)"/g)].map((k) => k[1])
      for (const key of keys) {
        found.push({ file, line: lineOf(src, open + m.index), kind: 'exit_code_for', context: fnAt(open), code: Number(m[2]), key, expr: m[2] })
      }
    }
  }

  // `=> ("E_X", N)` tuples (BackupError::code): the pair feeds Out::fail's code and exit arguments
  for (const m of src.matchAll(/=>\s*\(\s*"(E_[A-Z0-9_]+)"\s*,\s*(\d+)\s*\)/g)) {
    if (inString[m.index]) continue
    found.push({ file, line: lineOf(src, m.index), kind: 'code-map', context: fnAt(m.index), code: Number(m[2]), key: m[1], expr: m[2] })
  }
  return found
}

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (name.endsWith('.rs')) out.push(p)
  }
  return out
}

/** Cuts the Rust `#[cfg(test)] mod tests { ... }` blocks (test code exits are not CLI behaviour). */
export function dropTestModules(src) {
  const code = stripComments(src)
  let out = ''
  let last = 0
  for (const m of code.matchAll(/#\[cfg\(test\)\]\s*(?:pub\s+)?mod\s+\w+\s*\{/g)) {
    if (m.index < last) continue
    let depth = 0
    let i = m.index + m[0].length - 1
    for (; i < code.length; i++) {
      if (code[i] === '"') { i++; while (i < code.length && code[i] !== '"') { if (code[i] === '\\') i++; i++ } }
      else if (code[i] === '{') depth++
      else if (code[i] === '}' && --depth === 0) break
    }
    out += code.slice(last, m.index) + code.slice(m.index, i + 1).replace(/[^\n]/g, ' ')
    last = i + 1
  }
  return out + code.slice(last)
}

export function extractAll(srcDir = SRC) {
  const files = walk(srcDir).map((f) => [relative(ROOT, f), dropTestModules(readFileSync(f, 'utf8'))])
  // EXIT_* constants are shared across files (`super::EXIT_PANIC`)
  const consts = {}
  for (const [, src] of files) {
    for (const m of src.matchAll(/\bconst\s+(EXIT_[A-Z0-9_]+)\s*:\s*i32\s*=\s*(\d+)\s*;/g)) consts[m[1]] = Number(m[2])
  }
  return files.flatMap(([file, src]) => extract(src, file, consts))
}

/** Exit codes named in the first column of the table under `## CLI-Exit-Codes`. Accepts `3`, `1..255`, `1, 2` and `130`. */
export function documentedCodes(md) {
  const lines = md.split('\n')
  const h = lines.findIndex((l) => new RegExp(`^##\\s+${SECTION}\\s*$`).test(l))
  if (h < 0) return null
  const codes = new Set()
  for (let i = h + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]) && !/^###/.test(lines[i])) break
    if (!lines[i].startsWith('|')) continue
    const cell = lines[i].split('|')[1]?.trim() ?? ''
    if (!/^[\d\s,.`-]+$/.test(cell) || !/\d/.test(cell)) continue
    for (const part of cell.replace(/`/g, '').split(',')) {
      const range = /^\s*(\d+)\s*\.\.\s*(\d+)\s*$/.exec(part)
      if (range) for (let n = +range[1]; n <= +range[2]; n++) codes.add(n)
      else if (/^\s*\d+\s*$/.test(part)) codes.add(Number(part))
    }
  }
  return codes
}

export function missing(found, documented) {
  return found.filter((f) => f.kind !== 'const' && f.code !== null && !documented.has(f.code))
}

function main(argv) {
  const found = extractAll()
  const real = found.filter((f) => f.kind !== 'const')
  if (argv.includes('--json')) {
    console.log(JSON.stringify(found, null, 2))
    return 0
  }
  if (argv.includes('--list') || !argv.includes('--check')) {
    const byCode = new Map()
    for (const f of real) {
      const k = f.code ?? `dynamic(${f.expr})`
      if (!byCode.has(k)) byCode.set(k, [])
      byCode.get(k).push(f)
    }
    for (const [k, v] of [...byCode].sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'en', { numeric: true }))) {
      console.log(`exit ${k}: ${v.length} site(s)`)
      for (const f of v) console.log(`  ${f.file}:${f.line} ${f.kind} ${f.context}${f.key ? ' ' + f.key : ''}`)
    }
    if (!argv.includes('--check')) return 0
  }
  const documented = documentedCodes(readFileSync(DOC, 'utf8'))
  if (!documented) {
    console.error(`check-cli-exit-codes: docs/errors.md has no "## ${SECTION}" section`)
    return 1
  }
  const bad = missing(real, documented)
  if (bad.length) {
    console.error(`check-cli-exit-codes: ${bad.length} exit code site(s) use a code missing from the "${SECTION}" table in docs/errors.md:`)
    for (const f of bad) console.error(`  exit ${f.code}  ${f.file}:${f.line}  ${f.kind} ${f.context}${f.key ? ' ' + f.key : ''}`)
    return 1
  }
  const used = new Set(real.map((f) => f.code).filter((c) => c !== null))
  console.log(`check-cli-exit-codes: ${real.length} sites, codes in use: ${[...used].sort((a, b) => a - b).join(', ')}; all documented`)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
