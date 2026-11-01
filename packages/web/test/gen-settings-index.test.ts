import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const generator = fileURLToPath(new URL("../scripts/gen-settings-index.mjs", import.meta.url));

test("direct and linked reference declarations generate protection without an x-sensitive annotation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "settings-reference-direct-"));
  const outFile = join(dir, "settings-index.ts");
  const savedArgs = process.argv;
  try {
    process.argv = [process.execPath, generator, "--out", outFile];
    const { generateFileContent } = await import(pathToFileURL(generator).href);
    process.argv = savedArgs;
    const canonical = JSON.parse(readFileSync(new URL("../../config-schema/schema/config.schema.json", import.meta.url), "utf8"));
    const direct = { type: "string", "x-secret-reference": true, "x-tier": "advanced" };
    const schema = {
      type: "object",
      "x-secret-reference-policy": canonical["x-secret-reference-policy"],
      $defs: { name: direct },
      properties: {
        direct,
        linked: { type: "string", "x-secret-reference": { $ref: "#/$defs/name" } },
        disabled: { type: "string", "x-secret-reference": false },
      },
    };
    writeFileSync(outFile, generateFileContent(schema));
    const generated = await import(pathToFileURL(outFile).href);
    assert.deepEqual(generated.CONFIG_POLICY, [
      { key: "direct", referenceSchema: direct },
      { key: "linked", referenceSchema: direct },
    ]);
    assert.ok(generated.SETTINGS.every((row: { referenceSchema?: unknown }) => row.referenceSchema === undefined));
  } finally {
    process.argv = savedArgs;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("generated disclosure policy resolves reference definitions separately from the settings catalogue", async () => {
  const dir = mkdtempSync(join(tmpdir(), "settings-reference-gen-"));
  const outFile = join(dir, "settings-index.ts");
  try {
    execFileSync(process.execPath, [generator, "--out", outFile]);
    const generated = await import(pathToFileURL(outFile).href);
    const schema = JSON.parse(readFileSync(new URL("../../config-schema/schema/config.schema.json", import.meta.url), "utf8"));
    assert.deepEqual(generated.REFERENCE_POLICY, schema["x-secret-reference-policy"]);
    assert.deepEqual(generated.CONFIG_POLICY.find((row: { key: string }) => row.key === "engine.embedding.apiKey")?.referenceSchema,
      schema.$defs.backupEngineSecretReference);
    assert.deepEqual(generated.CONFIG_POLICY.find((row: { key: string }) => row.key === "providers.*.profile.secret_ref")?.referenceSchema,
      schema.$defs.backupSecretName);
    assert.ok(generated.SETTINGS.every((row: { referenceSchema?: unknown }) => row.referenceSchema === undefined));
    assert.ok(!generated.SETTINGS.some((row: { key: string }) => row.key === "engine.embedding.apiKey"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("settings-index generator is byte-stable and --check detects drift", () => {
  const dir = mkdtempSync(join(tmpdir(), "settings-index-gen-"));
  const outFile = join(dir, "settings-index.ts");
  const run = (...args: string[]) => execFileSync(process.execPath, [generator, "--out", outFile, ...args]);

  try {
    run();
    const first = readFileSync(outFile, "utf8");
    run();
    assert.equal(readFileSync(outFile, "utf8"), first);

    // Verify --check succeeds on matching content
    run("--check");

    // Modify file to introduce drift
    writeFileSync(outFile, first.replace("Register local hostctl tools.", "Stale description."));
    const stale = readFileSync(outFile, "utf8");

    const result = spawnSync(process.execPath, [generator, "--out", outFile, "--check"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr.toString(), /settings-index: drift/);
    assert.equal(readFileSync(outFile, "utf8"), stale);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--check accepts a CRLF checkout (core.autocrlf) of an up-to-date file", () => {
  const dir = mkdtempSync(join(tmpdir(), "settings-index-crlf-"));
  const outFile = join(dir, "settings-index.ts");
  try {
    execFileSync(process.execPath, [generator, "--out", outFile]);
    writeFileSync(outFile, readFileSync(outFile, "utf8").replace(/\n/g, "\r\n"));
    const result = spawnSync(process.execPath, [generator, "--out", outFile, "--check"]);
    assert.equal(result.status, 0, result.stderr.toString());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
