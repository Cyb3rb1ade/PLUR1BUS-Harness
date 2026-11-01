/** Runtime-generated canaries test the encrypted store and publication scanner without retaining credential literals. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { realTempDir } from "../helpers/real-temp-dir.ts";
import {
  codingSecretValues,
  cleanupCodingHome,
  scanCodingPublications,
  setupCodingSecrets,
} from "../../src/toolcall/coding-bench-secrets.ts";

const models = [
  {
    provider: "fixture",
    model: "structural-test",
    wireFormat: "chat_completions" as const,
    baseUrl: "http://127.0.0.1:1",
    local: true,
  },
];

test("setup refuses existing owner directories and cleanup never deletes an unmarked directory", async () => {
  const root = await realTempDir("p1b-coding-secrets-");
  try {
    await assert.rejects(setupCodingSecrets(root, models, {}));
    await assert.rejects(cleanupCodingHome(root));
    await access(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a stored runtime canary is found in encoded logs; clean reports pass and the owned home is removable", async () => {
  const root = await realTempDir("p1b-coding-canary-");
  try {
    const home = join(root, "home");
    await setupCodingSecrets(home, models, {});
    const values = await codingSecretValues(home, models);
    const canary = values.find((value) => value.length >= 32)!;
    assert.equal(typeof canary, "string");
    const file = join(root, "output.json");
    await writeFile(file, JSON.stringify({ encoded: Buffer.from(canary).toString("base64") }));
    await assert.rejects(scanCodingPublications(home, models, [file]), /coding publication scan refused/);
    await writeFile(file, '{"checked":72}\n');
    await scanCodingPublications(home, models, [file]);
    await cleanupCodingHome(home);
    await assert.rejects(access(home));
    await mkdir(home);
    await assert.rejects(cleanupCodingHome(home));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
