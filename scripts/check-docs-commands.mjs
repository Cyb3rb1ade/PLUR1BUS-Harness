// Checks that every `plur1bus ...` command in the user docs (docs/user/**) names a command and long flags that
// exist in docs/cli.md (generated from the clap tree). Also checks that the German and English pages quote the
// same set of commands. Exit 1 on any finding. Run by `pnpm docs:check`.
//
// What counts as a command: a line inside a fenced code block that starts with `plur1bus` (an optional `$ ` prompt
// is ignored), or an inline code span that starts with `plur1bus `. Tokens `<x>`, `[x]` and values are arguments;
// `|`, `>`, `&&`, `;`, `#` end the command. A command group (one that has subcommands in cli.md) must be followed by
// one of them.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export function parseCliMd(text) {
  const commands = new Map(); // "agent create" -> Set of long flags
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const h = /^## `plur1bus(?: ([^`]+))?`\s*$/.exec(line);
    if (h) {
      current = h[1] ?? "";
      commands.set(current, new Set());
      continue;
    }
    if (current === null) continue;
    const f = /^\* `(--[a-z0-9-]+)/.exec(line);
    if (f) commands.get(current).add(f[1]);
  }
  return commands;
}

export function extractCommands(md) {
  const found = [];
  const lines = md.split(/\r?\n/);
  let fenced = false;
  lines.forEach((raw, i) => {
    if (/^\s*```/.test(raw)) {
      fenced = !fenced;
      return;
    }
    if (fenced) {
      const m = /^\s*(?:\$ )?(plur1bus(?:\s.*)?)$/.exec(raw);
      if (m) found.push({ line: i + 1, text: m[1] });
      return;
    }
    for (const m of raw.matchAll(/`(plur1bus(?: [^`]*)?)`/g)) {
      if (m[1].includes(" ")) found.push({ line: i + 1, text: m[1] });
    }
  });
  return found;
}

const STOP = new Set(["|", ">", ">>", "&&", ";", "||", "2>&1"]);
export function checkCommand(text, commands) {
  const toks = [];
  for (const t of text.split(/\s+/).slice(1)) {
    if (t === "" || t.startsWith("#") || STOP.has(t)) break;
    toks.push(t);
  }
  let path = "";
  let i = 0;
  while (i < toks.length && /^[a-z0-9][a-z0-9-]*$/.test(toks[i])) {
    const next = path ? `${path} ${toks[i]}` : toks[i];
    if (!commands.has(next)) break;
    path = next;
    i++;
  }
  const flags = new Set(["--home", "--json", "--help", "--version", "-h", "-V"]);
  for (const f of commands.get(path) ?? []) flags.add(f);
  const hasChildren = [...commands.keys()].some((k) => k !== path && (path === "" ? k !== "" : k.startsWith(`${path} `)));
  const errs = [];
  const rest = toks.slice(i);
  const firstArg = rest.find((t) => !t.startsWith("-"));
  if (hasChildren && firstArg && !/^[<\[]/.test(firstArg) && !rest[0]?.startsWith("-")) {
    errs.push(`\`${firstArg}\` is not a subcommand of \`plur1bus ${path}\``.replace("plur1bus ", "plur1bus" + (path ? " " : "")));
  }
  for (const t of rest) {
    if (!t.startsWith("-") || t === "-") continue;
    const flag = t.split("=")[0];
    if (!flags.has(flag)) errs.push(`${flag} is not an option of \`plur1bus ${path}\``);
  }
  return { path, errs };
}

function mdFiles(dir) {
  const out = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...mdFiles(p));
    else if (n.endsWith(".md")) out.push(p);
  }
  return out;
}

export function run(root, { cliMd = "docs/cli.md", docsDir = "docs/user" } = {}) {
  const commands = parseCliMd(readFileSync(join(root, cliMd), "utf8"));
  const problems = [];
  const perLang = { de: new Set(), en: new Set() };
  for (const file of mdFiles(join(root, docsDir))) {
    const rel = relative(root, file).split("\\").join("/");
    const lang = /\/de\//.test(rel) ? "de" : /\/en\//.test(rel) ? "en" : null;
    for (const c of extractCommands(readFileSync(file, "utf8"))) {
      const { path, errs } = checkCommand(c.text, commands);
      for (const e of errs) problems.push(`${rel}:${c.line}: ${e} — \`${c.text}\``);
      if (lang) perLang[lang].add(path);
    }
  }
  for (const [a, b] of [["en", "de"], ["de", "en"]]) {
    for (const p of perLang[a]) {
      if (!perLang[b].has(p)) problems.push(`command \`plur1bus ${p}\` appears in the ${a} pages but not in the ${b} pages`);
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const problems = run(root);
  if (problems.length) {
    console.error(problems.join("\n"));
    console.error(`\ncheck-docs-commands: ${problems.length} problem(s)`);
    process.exit(1);
  }
  console.log("check-docs-commands: ok");
}
