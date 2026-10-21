import assert from "node:assert/strict";
import { test } from "node:test";
import * as checker from "./check-docs-commands.mjs";
import { countCoverage } from "./user-docs-coverage.mjs";

const cli = `## \`plur1bus\`
## \`plur1bus item\`
## \`plur1bus item list\`
###### **Options:**
* \`--limit <N>\`
## \`plur1bus item remove\`
## \`plur1bus status\`
`;
const doc = (lang, text, name = "page.md") => ({ file: `docs/user/${lang}/${name}`, lang, text });

test("counts unique valid leaves per language, never groups, flags or repeated examples", () => {
  const r = countCoverage(cli, [doc("de", "`plur1bus item list --limit 2`\n`plur1bus item`"), doc("de", "`plur1bus item list`", "other.md"), doc("en", "`plur1bus status`")], checker);
  assert.equal(r.leaves, 3);
  assert.equal(r.languages.de.pages, 2);
  assert.deepEqual(r.languages.de.covered, ["item list"]);
  assert.deepEqual(r.languages.de.missing, ["item remove", "status"]);
  assert.deepEqual(r.languages.en.covered, ["status"]);
  assert.deepEqual(r.groups.item, { leaves: 2, de: 1, en: 0 });
  assert.deepEqual(r.problems, []);
});

test("invalid examples are reported with their source and do not establish coverage", () => {
  const r = countCoverage(cli, [doc("de", "`plur1bus item list --invented`")], checker);
  assert.deepEqual(r.languages.de.covered, []);
  assert.match(r.problems[0], /docs\/user\/de\/page.md:1:.*--invented/);
});

test("root version/help and a generic command placeholder are not leaf commands", () => {
  const r = countCoverage(cli, [doc("en", "`plur1bus --version`\n`plur1bus --help`\n`plur1bus <command> --help`")], checker);
  assert.deepEqual(r.languages.en.covered, []);
  assert.deepEqual(r.problems, []);
});

test("an older parser leaving a global-flag example at the root cannot silently undercount", () => {
  const r = countCoverage(cli, [doc("en", "`plur1bus --json item list`")], { ...checker, checkCommand: () => ({ path: "", errs: [] }) });
  assert.match(r.problems[0], /unresolved command.*plur1bus --json item list/);
  assert.deepEqual(r.languages.en.covered, []);
});

test("uses the supplied checker result so a global-flag-aware parser counts the real leaf", () => {
  const text = "`plur1bus --json item list`";
  const r = countCoverage(cli, [doc("de", text), doc("en", text)], { ...checker, checkCommand: (command) => {
    assert.equal(command, "plur1bus --json item list");
    return { path: "item list", errs: [] };
  } });
  assert.deepEqual(r.languages.de.covered, ["item list"]);
  assert.deepEqual(r.languages.en.covered, ["item list"]);
  assert.deepEqual(r.problems, []);
});
