import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCommand, extractCommands, parseCliMd } from "./check-docs-commands.mjs";

const cli = parseCliMd(`## \`plur1bus\`\n\n###### **Options:**\n\n* \`--home <PATH>\`\n\n## \`plur1bus agent\`\n\n## \`plur1bus agent create\`\n\n## \`plur1bus update\`\n\n###### **Options:**\n\n* \`--check\` — x\n\n## \`plur1bus login\`\n\n###### **Arguments:**\n\n* \`<PROVIDER>\` — provider name\n\n###### **Options:**\n\n* \`-y\`, \`--yes\` — confirm\n\n## \`plur1bus login status\`\n`);

test("known command and flag pass", () => {
  assert.deepEqual(checkCommand("plur1bus agent create main --json", cli).errs, []);
  assert.deepEqual(checkCommand("plur1bus update --check --home <dir>", cli).errs, []);
  assert.deepEqual(checkCommand("plur1bus login openai", cli).errs, []);
  assert.deepEqual(checkCommand("plur1bus login -y", cli).errs, []);
  assert.deepEqual(checkCommand("plur1bus login --yes", cli).errs, []);
});
test("unknown subcommand, flag and group word fail", () => {
  assert.equal(checkCommand("plur1bus agent make main", cli).errs.length, 1);
  assert.equal(checkCommand("plur1bus update --apply", cli).errs.length, 1);
  assert.equal(checkCommand("plur1bus backup create", cli).errs.length, 1);
  assert.equal(checkCommand("plur1bus login --nope", cli).errs.length, 1);
});
test("comments and pipes end a command", () => {
  assert.deepEqual(checkCommand("plur1bus agent list # --nope", cli).path, "agent");
  assert.deepEqual(checkCommand("plur1bus update --check | jq --nope", cli).errs, []);
});
test("extracts fenced lines and inline spans only", () => {
  const md = "Use `plur1bus update --check` or plur1bus alone.\n```sh\n$ plur1bus agent list\necho plur1bus x\n```\nThe `plur1bus` binary.\n";
  assert.deepEqual(extractCommands(md).map((c) => c.text), ["plur1bus update --check", "plur1bus agent list"]);
});
