import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseCliReference,
  extractCommands,
  checkCommand,
  checkHomePaths,
  compareLanguages,
  checkDocs,
  makeSourceHas,
} from "./check-docs-commands.mjs";

// A miniature of the generated docs/cli.md: the same heading and option shapes, three levels deep, one stub.
const CLI = `# CLI reference

## \`plur1bus\`

PLUR1BUS harness

###### **Subcommands:**

* \`daemon\` — Supervisor control
* \`update\` — Apply a release
* \`login\` — Provider login (API keys, OAuth) — M2

###### **Options:**

* \`--home <PATH>\` — State root
* \`--json\` — Machine-readable output

## \`plur1bus daemon\`

Supervisor control

## \`plur1bus daemon start\`

Start

###### **Options:**

* \`--no-wait\` — return early

## \`plur1bus daemon status\`

Status

## \`plur1bus update\`

Apply

###### **Options:**

* \`--check\` — plan only
* \`--manifest <PATH|URL>\` — manifest

## \`plur1bus update status\`

Where the last update stands

## \`plur1bus login\`

Provider login (API keys, OAuth) — M2
`;

const ref = parseCliReference(CLI);

test("parseCliReference builds the tree, the options and the stub set", () => {
  assert.deepEqual([...ref.commands.keys()].sort(), ["daemon", "daemon start", "daemon status", "login", "update", "update status"]);
  assert.equal(ref.commands.get("daemon start").flags.get("--no-wait"), false);
  assert.equal(ref.commands.get("update").flags.get("--manifest"), true);
  assert.equal(ref.globalFlags.get("--home"), true);
  assert.equal(ref.globalFlags.get("--json"), false);
  assert.equal(ref.commands.get("login").stub, true);
  assert.equal(ref.commands.get("daemon").stub, false);
});

test("a real command with global options and a value-taking global option passes", () => {
  assert.equal(checkCommand(ref, "plur1bus daemon start --no-wait --json"), null);
  assert.equal(checkCommand(ref, "plur1bus --home /tmp/h daemon status"), null);
  assert.equal(checkCommand(ref, "plur1bus update --manifest ./release.json --check"), null);
  assert.equal(checkCommand(ref, "plur1bus update status"), null);
  assert.equal(checkCommand(ref, "plur1bus --version"), null);
});

test("an unknown subcommand is refused, at the top level and below a group", () => {
  assert.match(checkCommand(ref, "plur1bus frobnicate"), /unknown command/);
  assert.match(checkCommand(ref, "plur1bus daemon bounce"), /unknown subcommand/);
});

test("an unknown flag is refused, including one that belongs to a sibling command", () => {
  assert.match(checkCommand(ref, "plur1bus daemon status --no-wait"), /unknown option --no-wait/);
  assert.match(checkCommand(ref, "plur1bus update --force"), /unknown option --force/);
});

test("placeholders, quotes, pipes and redirects do not confuse the parser", () => {
  assert.equal(checkCommand(ref, "plur1bus update --manifest <PATH> --check"), null);
  assert.equal(checkCommand(ref, 'plur1bus update --manifest "my release.json"'), null);
  assert.equal(checkCommand(ref, "plur1bus daemon status --json | jq .core"), null);
  assert.equal(checkCommand(ref, "plur1bus daemon status > status.txt"), null);
});

test("a stub command is refused unless marked planned", () => {
  assert.match(checkCommand(ref, "plur1bus login"), /stub/);
  assert.equal(checkCommand(ref, "plur1bus login", { planned: true }), null);
});

test("extractCommands reads fenced blocks, continuations and inline code, with line numbers", () => {
  const md = [
    "Run `plur1bus daemon status` first.",
    "",
    "```sh",
    "$ plur1bus update \\",
    "    --check",
    "echo not-a-command",
    "plur1bus login   # planned",
    "```",
    "",
    "Not a command: `plur1bus` alone is the program, and `curl plur1bus.app`.",
  ].join("\n");
  const got = extractCommands(md);
  assert.deepEqual(
    got.map((c) => [c.line, c.text, c.planned]),
    [
      [1, "plur1bus daemon status", false],
      [4, "plur1bus update --check", false],
      [7, "plur1bus login", true],
    ],
  );
});

test("checkHomePaths names a <home> directory the code does not know", () => {
  const known = new Set(["logs", "run", "config.json"]);
  const has = (seg) => known.has(seg);
  assert.deepEqual(checkHomePaths("see <home>/logs/core.log and <home>/config.json", has), []);
  const errs = checkHomePaths("a\nb <home>/vault/x and <home>\\run\\core.pid", has);
  assert.equal(errs.length, 1);
  assert.equal(errs[0].line, 2);
  assert.match(errs[0].message, /vault/);
});

test("compareLanguages demands the same commands in the same order", () => {
  const en = [{ text: "plur1bus a" }, { text: "plur1bus b" }];
  assert.equal(compareLanguages(en, [{ text: "plur1bus a" }, { text: "plur1bus b" }]), null);
  assert.match(compareLanguages(en, [{ text: "plur1bus b" }, { text: "plur1bus a" }]), /differ at command 1/);
  assert.match(compareLanguages(en, [{ text: "plur1bus a" }]), /2 commands in en, 1 in de/);
});

test("checkDocs ties it together over an in-memory docs tree", () => {
  const files = new Map([
    ["docs/user/en/a.md", "`plur1bus daemon status`\n\n`plur1bus daemon explode`\n"],
    ["docs/user/de/a.md", "`plur1bus daemon status`\n"],
  ]);
  const problems = checkDocs({ cliMarkdown: CLI, files, sourceHas: () => true });
  const text = problems.map((p) => `${p.file}${p.line ? `:${p.line}` : ""}: ${p.message}`).join("\n");
  assert.match(text, /docs\/user\/en\/a\.md:3: unknown subcommand/);
  assert.match(text, /docs\/user\/en\/a\.md: 2 commands in en, 1 in de/);
});

test("the real docs/cli.md parses, and the stubs it names are the stubs", async () => {
  const { readFileSync } = await import("node:fs");
  const real = parseCliReference(readFileSync(new URL("../docs/cli.md", import.meta.url), "utf8"));
  assert.equal(checkCommand(real, "plur1bus --home /tmp/h backup restore --dry-run ./b.tar.gz"), null);
  assert.equal(checkCommand(real, "plur1bus 1staid repair --only run.stale-files.remove --yes"), null);
  assert.equal(checkCommand(real, "plur1bus memory add --agent main \"likes tea\""), null);
  assert.match(checkCommand(real, "plur1bus backup restore --force x"), /unknown option --force/);
  const stubs = [...real.commands].filter(([, c]) => c.stub).map(([name]) => name).sort();
  assert.deepEqual(stubs, ["channel", "login", "project", "uninstall"]);
});

test("makeSourceHas knows the real home layout and refuses an invented directory", () => {
  const has = makeSourceHas(new URL("..", import.meta.url).pathname);
  for (const seg of ["logs", "run", "state", "config.json", "manifest.json", "backups", ".restore-"]) assert.equal(has(seg), true, seg);
  assert.equal(has("vault-of-secrets"), false);
});
