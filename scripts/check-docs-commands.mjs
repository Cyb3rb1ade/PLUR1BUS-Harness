#!/usr/bin/env node
// Checks the user documentation (docs/user/**/*.md) against the code:
//   - every `plur1bus ...` command names a real command and real options, as docs/cli.md (generated from the clap
//     tree) lists them; a stub command (help text ending in a milestone label such as "— M2") is refused unless the
//     line carries the comment `# planned`;
//   - every `<home>/<dir>` path names a directory or file the code knows (a string literal or path segment under
//     crates/ or packages/<name>/src);
//   - the English and German copies of a page contain the same commands in the same order.
// No dependencies, no network. Exit 0 when clean, 1 with `file:line: message` lines otherwise.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

// ---- docs/cli.md -------------------------------------------------------------------------------------------------

const STUB_LABEL = /\s—\s(M\d[\w-]*)\s*$/;
const HELP_FLAGS = new Map([["--help", false], ["-h", false], ["--version", false], ["-V", false]]);

/** Parses the generated CLI reference into `{ commands: Map<path, {flags: Map<name, takesValue>, stub}>, globalFlags }`. */
export function parseCliReference(markdown) {
  const commands = new Map();
  const globalFlags = new Map(HELP_FLAGS);
  let current = null; // path string ("" = the program itself) or null before the first command heading
  let inOptions = false;
  let wantDescription = false;
  for (const raw of markdown.split("\n")) {
    const line = raw.trimEnd();
    const heading = line.match(/^## `plur1bus(?: ([^`]+))?`$/);
    if (heading) {
      current = heading[1] ?? "";
      inOptions = false;
      wantDescription = true;
      if (current !== "") commands.set(current, { flags: new Map(), stub: false });
      continue;
    }
    if (/^#{1,2} /.test(line)) { current = null; inOptions = false; wantDescription = false; continue; }
    if (current === null) continue;
    if (/^###### /.test(line)) { inOptions = /\*\*Options:\*\*/.test(line); wantDescription = false; continue; }
    if (wantDescription && line.trim() !== "") {
      wantDescription = false;
      if (current !== "" && STUB_LABEL.test(line)) commands.get(current).stub = true;
      continue;
    }
    const opt = inOptions ? line.match(/^\* `([^`]+)`/) : null;
    if (opt) {
      const takesValue = opt[1].includes("<");
      const target = current === "" ? globalFlags : commands.get(current).flags;
      for (const name of opt[1].match(/--[a-z0-9][a-z0-9-]*|(?<![\w-])-[A-Za-z](?![\w-])/g) ?? []) target.set(name, takesValue);
    }
  }
  return { commands, globalFlags };
}

// ---- tokenising ----------------------------------------------------------------------------------------------------

const OPERATOR = /^(?:\|\|?|&&?|;|[0-9]?>>?.*|<)$/;

/** Splits a shell-ish line into `{ text, op, quoted }` tokens and a trailing `# comment`. Quotes group; `\` is not special
 *  (a Windows path stays whole); `<PATH>` is a placeholder, not a redirect. */
export function tokenize(line) {
  const tokens = [];
  let comment = "";
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i += 1;
    if (i >= line.length) break;
    if (line[i] === "#") { comment = line.slice(i + 1).trim(); break; }
    let text = "";
    let quoted = false;
    while (i < line.length && !/\s/.test(line[i])) {
      const c = line[i];
      if (c === '"' || c === "'") {
        quoted = true;
        const end = line.indexOf(c, i + 1);
        const stop = end === -1 ? line.length : end;
        text += line.slice(i + 1, stop);
        i = stop + 1;
      } else { text += c; i += 1; }
    }
    tokens.push({ text, op: !quoted && OPERATOR.test(text), quoted });
  }
  return { tokens, comment };
}

const isAssignment = (t) => !t.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t.text);

/** Splits tokens at operators into segments, each without leading `NAME=value` assignments. A redirect drops its target. */
function segments(tokens) {
  const out = [];
  let cur = [];
  let skipTarget = false;
  for (const t of tokens) {
    if (skipTarget) { skipTarget = false; continue; }
    if (t.op) {
      out.push(cur);
      cur = [];
      if (t.text === "<" || t.text === ">" || t.text === ">>") skipTarget = true;
      continue;
    }
    cur.push(t);
  }
  out.push(cur);
  return out.map((seg) => { let k = 0; while (k < seg.length && isAssignment(seg[k])) k += 1; return seg.slice(k); });
}

// ---- command extraction ------------------------------------------------------------------------------------------

/** Every `plur1bus ...` command in a Markdown page: `{ line, text, planned }`. Fenced blocks may chain commands with
 *  pipes and continue with a trailing backslash; inline code counts when the span starts with `plur1bus `. */
export function extractCommands(markdown) {
  const found = [];
  const lines = markdown.split("\n");
  let inFence = false;
  for (let n = 0; n < lines.length; n += 1) {
    const raw = lines[n];
    if (/^\s*(```|~~~)/.test(raw)) { inFence = !inFence; continue; }
    if (inFence) {
      let text = raw.replace(/^\s*[$>]\s+/, "");
      const startLine = n + 1;
      while (/\\\s*$/.test(text) && n + 1 < lines.length) { n += 1; text = text.replace(/\\\s*$/, " ") + lines[n].trim(); }
      const { tokens, comment } = tokenize(text);
      for (const seg of segments(tokens)) {
        if (seg[0]?.text === "plur1bus") found.push({ line: startLine, text: seg.map((t) => t.text).join(" "), planned: /planned|geplant/i.test(comment) });
      }
      continue;
    }
    for (const m of raw.matchAll(/`([^`]+)`/g)) {
      const span = m[1].trim();
      if (!span.startsWith("plur1bus ")) continue;
      const { tokens, comment } = tokenize(span);
      const seg = segments(tokens)[0];
      if (seg?.[0]?.text === "plur1bus") found.push({ line: n + 1, text: seg.map((t) => t.text).join(" "), planned: /planned|geplant/i.test(comment) });
    }
  }
  return found;
}

// ---- checking one command ----------------------------------------------------------------------------------------

/** null when `text` is a real invocation, else a message. `planned` allows a stub command. */
export function checkCommand(ref, text, { planned = false } = {}) {
  const all = tokenize(text).tokens;
  let k = 0;
  while (k < all.length && isAssignment(all[k])) k += 1;
  const tokens = [];
  for (const t of all.slice(k)) { if (t.op) break; tokens.push(t); }
  if (tokens[0]?.text !== "plur1bus") return `not a plur1bus command: ${text}`;

  const valueFlag = (name, path) => {
    if (ref.globalFlags.has(name)) return ref.globalFlags.get(name);
    for (let d = path.length; d > 0; d -= 1) {
      const f = ref.commands.get(path.slice(0, d).join(" "))?.flags;
      if (f?.has(name)) return f.get(name);
    }
    for (const c of ref.commands.values()) if (c.flags.get(name)) return true; // a later subcommand's option
    return false;
  };
  const hasChild = (path) => [...ref.commands.keys()].some((c) => c.startsWith(`${path.join(" ")} `));

  const path = [];
  const flags = [];
  let closed = false;
  for (let i = 1; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (!t.quoted && /^-{1,2}[A-Za-z]/.test(t.text)) {
      const name = t.text.split("=")[0];
      flags.push(name);
      if (!t.text.includes("=") && valueFlag(name, path)) i += 1;
      continue;
    }
    if (closed || /^<.*>$/.test(t.text)) continue;
    const candidate = [...path, t.text].join(" ");
    if (ref.commands.has(candidate)) { path.push(t.text); continue; }
    if (path.length === 0) return `unknown command "${t.text}" (not in docs/cli.md)`;
    if (hasChild(path)) return `unknown subcommand "${t.text}" under "plur1bus ${path.join(" ")}"`;
    closed = true;
  }

  const allowed = new Map(ref.globalFlags);
  for (let d = 1; d <= path.length; d += 1) for (const [f, v] of ref.commands.get(path.slice(0, d).join(" ")).flags) allowed.set(f, v);
  for (const f of flags) {
    if (!allowed.has(f)) return `unknown option ${f} for "plur1bus${path.length ? ` ${path.join(" ")}` : ""}"`;
  }
  if (path.length > 0 && ref.commands.get(path.join(" ")).stub && !planned) {
    return `"plur1bus ${path.join(" ")}" is a stub in docs/cli.md; mark the line with "# planned" or leave it out`;
  }
  return null;
}

// ---- paths, languages, the whole tree ------------------------------------------------------------------------------

/** `<home>/<first segment>` references whose segment `has` does not know: `[{ line, message }]`. */
export function checkHomePaths(markdown, has) {
  const problems = [];
  markdown.split("\n").forEach((line, idx) => {
    const seen = new Set();
    for (const m of line.matchAll(/<home>[\\/]+([A-Za-z0-9_.][A-Za-z0-9_.-]*)/g)) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      if (!has(m[1])) problems.push({ line: idx + 1, message: `<home>/${m[1]} is not a path the code knows` });
    }
  });
  return problems;
}

/** null when the two command lists are equal, else a message (1-based position). */
export function compareLanguages(en, de) {
  if (en.length !== de.length) return `${en.length} commands in en, ${de.length} in de`;
  for (let i = 0; i < en.length; i += 1) {
    if (en[i].text !== de[i].text) return `command lists differ at command ${i + 1}: "${en[i].text}" (en) vs "${de[i].text}" (de)`;
  }
  return null;
}

/** `files`: Map of repo-relative path -> text, every page under docs/user. */
export function checkDocs({ cliMarkdown, files, sourceHas }) {
  const ref = parseCliReference(cliMarkdown);
  const problems = [];
  const extracted = new Map();
  for (const [file, text] of files) {
    const cmds = extractCommands(text);
    extracted.set(file, cmds);
    for (const c of cmds) {
      const msg = checkCommand(ref, c.text, { planned: c.planned });
      if (msg) problems.push({ file, line: c.line, message: msg });
    }
    for (const p of checkHomePaths(text, sourceHas)) problems.push({ file, line: p.line, message: p.message });
  }
  for (const [file, cmds] of extracted) {
    const m = file.match(/^(.*\/)en\/(.+)$/);
    if (!m) continue;
    const peer = `${m[1]}de/${m[2]}`;
    if (!extracted.has(peer)) { problems.push({ file, message: `no German counterpart ${peer}` }); continue; }
    const msg = compareLanguages(cmds, extracted.get(peer));
    if (msg) problems.push({ file, message: msg });
  }
  for (const file of extracted.keys()) {
    const m = file.match(/^(.*\/)de\/(.+)$/);
    if (m && !extracted.has(`${m[1]}en/${m[2]}`)) problems.push({ file, message: `no English counterpart ${m[1]}en/${m[2]}` });
  }
  return problems;
}

// ---- the repository -------------------------------------------------------------------------------------------------

const SKIP_DIRS = new Set(["node_modules", "target", "dist", ".git", "tests", "test", "fixtures"]);

function walk(dir, accept, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name), accept, out); }
    else if (accept(e.name)) out.push(join(dir, e.name));
  }
  return out;
}

/** RULING: a path segment is "known" when a non-test source file under crates/ or packages/<name>/src contains it as a
 *  quoted string or after a slash. A heuristic that catches an invented directory, not a proof of the full path. */
export function makeSourceHas(root) {
  let corpus = null;
  return (seg) => {
    if (corpus === null) {
      const files = walk(join(root, "crates"), (n) => n.endsWith(".rs"));
      for (const p of readdirSync(join(root, "packages"), { withFileTypes: true })) {
        const src = join(root, "packages", p.name, "src");
        if (p.isDirectory() && existsSync(src)) files.push(...walk(src, (n) => n.endsWith(".ts") && !n.endsWith(".test.ts")));
      }
      corpus = files.map((f) => readFileSync(f, "utf8")).join("\n");
    }
    return corpus.includes(`"${seg}"`) || corpus.includes(`'${seg}'`) || corpus.includes(`/${seg}`) || corpus.includes(`\`${seg}\``);
  };
}

export function main(root = join(dirname(fileURLToPath(import.meta.url)), "..")) {
  const docsDir = join(root, "docs", "user");
  const files = new Map();
  if (existsSync(docsDir) && statSync(docsDir).isDirectory()) {
    for (const f of walk(docsDir, (n) => n.endsWith(".md"))) files.set(relative(root, f).split(sep).join("/"), readFileSync(f, "utf8"));
  }
  if (files.size === 0) { console.error("check-docs-commands: no pages under docs/user"); return 1; }
  const problems = checkDocs({
    cliMarkdown: readFileSync(join(root, "docs", "cli.md"), "utf8"),
    files,
    sourceHas: makeSourceHas(root),
  });
  for (const p of problems) console.error(`${p.file}${p.line ? `:${p.line}` : ""}: ${p.message}`);
  if (problems.length === 0) console.log(`check-docs-commands: ${files.size} pages, all commands and paths found in the code`);
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main());
