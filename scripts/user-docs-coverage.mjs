// Read-only CLI coverage report. Uses the documentation checker's parser; does not maintain another command grammar.
// --checker accepts a separately inspected checker snapshot (for example an unmerged parser correction).
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as defaultChecker from "./check-docs-commands.mjs";

export function countCoverage(cliText, docs, checker = defaultChecker) {
  const commands = checker.parseCliMd(cliText);
  const paths = [...commands.keys()].filter(Boolean);
  const leaves = paths.filter((p) => !paths.some((other) => other.startsWith(`${p} `))).sort();
  const leafSet = new Set(leaves);
  const languages = {};
  const problems = [];
  for (const lang of ["de", "en"]) {
    const pages = docs.filter((d) => d.lang === lang);
    const covered = new Set();
    for (const doc of pages) {
      for (const example of checker.extractCommands(doc.text)) {
        const { path, errs } = checker.checkCommand(example.text, commands);
        if (errs.length) {
          problems.push(...errs.map((e) => `${doc.file}:${example.line}: ${e}`));
        } else if (!path && /^plur1bus\s+(?:--(?:version|help)\b|-[hV]\b|<[^>]+>)/.test(example.text)) {
          // Root flags and an explicitly generic placeholder do not name a leaf command.
          continue;
        } else if (!path || !commands.has(path)) {
          problems.push(`${doc.file}:${example.line}: unresolved command: ${example.text}`);
        } else if (leafSet.has(path)) {
          covered.add(path);
        }
      }
    }
    languages[lang] = { pages: pages.length, covered: [...covered].sort(), missing: leaves.filter((p) => !covered.has(p)) };
  }
  const groups = Object.fromEntries([...new Set(leaves.map((p) => p.split(" ")[0]))].sort().map((group) => {
    const own = (p) => p.split(" ")[0] === group;
    return [group, { leaves: leaves.filter(own).length, de: languages.de.covered.filter(own).length, en: languages.en.covered.filter(own).length }];
  }));
  return { leaves: leaves.length, languages, groups, problems: problems.sort() };
}

function workingDocs(root) {
  return ["de", "en"].flatMap((lang) => {
    const dir = join(root, "docs/user", lang);
    return readdirSync(dir).filter((f) => f.endsWith(".md")).sort().map((name) => ({ file: `docs/user/${lang}/${name}`, lang, text: readFileSync(join(dir, name), "utf8") }));
  });
}

function gitDocs(root, ref) {
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  // A commit object, not a checkout: reading another documentation snapshot cannot disturb the worktree.
  const commit = git("rev-parse", "--verify", `${ref}^{commit}`).trim();
  return git("ls-tree", "-r", "--name-only", commit, "docs/user/de", "docs/user/en").split("\n").flatMap((file) => {
    const lang = /^docs\/user\/(de|en)\/[^/]+\.md$/.exec(file)?.[1];
    return lang ? [{ file, lang, text: git("show", `${commit}:${file}`) }] : [];
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const args = process.argv.slice(2);
  let checkerPath;
  let docsRef;
  while (args.length) {
    const flag = args.shift();
    if (!["--checker", "--docs-ref"].includes(flag) || !args[0] || args[0].startsWith("--")) throw new Error("Usage: node scripts/user-docs-coverage.mjs [--checker <module.mjs>] [--docs-ref <commit>]");
    if (flag === "--checker") checkerPath = args.shift(); else docsRef = args.shift();
  }
  const checker = checkerPath ? await import(pathToFileURL(resolve(checkerPath)).href) : defaultChecker;
  const result = countCoverage(readFileSync(join(root, "docs/cli.md"), "utf8"), docsRef ? gitDocs(root, docsRef) : workingDocs(root), checker);
  console.log(JSON.stringify(result, null, 2));
  if (result.problems.length) process.exitCode = 1;
}
