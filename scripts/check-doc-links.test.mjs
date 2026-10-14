import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDocLinks } from "./check-doc-links.mjs";

const script = fileURLToPath(new URL("./check-doc-links.mjs", import.meta.url));

function tree(files, fn) {
  const root = mkdtempSync(join(tmpdir(), "p1b-doc-links-"));
  try {
    for (const [rel, text] of Object.entries(files)) {
      const path = join(root, ...rel.split("/"));
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, text);
    }
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("relative links and heading anchors pass; external links are not fetched", () => {
  tree({
    "README.md": "# Readme\n[page](docs/page.md#hello-world) [other](other/reference.md#remote-heading) [same](#readme) [web](https://example.invalid/x)",
    "docs/page.md": "# Hello, world!\n",
    "other/reference.md": "# Remote heading\n",
  }, (root) => assert.deepEqual(checkDocLinks(root), []));
});

test("reports missing relative targets and heading anchors", () => {
  tree({
    "README.md": "[missing](docs/nope.md)\n[anchor](docs/page.md#missing-heading)\n",
    "docs/page.md": "# Existing heading\n",
  }, (root) => {
    const problems = checkDocLinks(root);
    assert.equal(problems.length, 2);
    assert.match(problems[0], /^README\.md:1 → broken link: docs\/nope\.md \(target does not exist\)$/);
    assert.match(problems[1], /^README\.md:2 → broken link: docs\/page\.md#missing-heading \(heading anchor does not exist\)$/);
    const result = spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /README\.md:1 → broken link/);
  });
});

test("footnote definitions are not link reference definitions", () => {
  tree({
    "README.md": "# Readme\n\nA claim[^1] and another[^note].\n\n[^1]: See the appendix for details.\n[^note]: Also docs/missing.md is only prose here.\n",
  }, (root) => assert.deepEqual(checkDocLinks(root), []));
});

test("a dangling symlink among the docs is reported, not thrown; a missing docs directory is fine", () => {
  tree({ "README.md": "# Readme\n[ok](#readme)\n", "docs/page.md": "# Page\n" }, (root) => {
    symlinkSync("/nonexistent-target", join(root, "docs", "gone.md"));
    const problems = checkDocLinks(root);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /^docs\/gone\.md: dangling symlink$/);
  });
  tree({ "README.md": "# Readme\n[ok](#readme)\n" }, (root) => assert.deepEqual(checkDocLinks(root), []));
});

test("problems come out in path order whatever the directory order is", () => {
  const files = {};
  for (const name of ["z", "m", "a", "q"]) files[`docs/${name}.md`] = `[x](missing-${name}.md)\n`;
  tree(files, (root) => {
    const problems = checkDocLinks(root);
    assert.deepEqual(problems.map((p) => p.split(":")[0]), ["docs/a.md", "docs/m.md", "docs/q.md", "docs/z.md"]);
  });
});
