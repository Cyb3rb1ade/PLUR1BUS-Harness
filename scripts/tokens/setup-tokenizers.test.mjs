/** Exercises the pinned tokenizer setup against real cache files and controlled network responses. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = new URL("./setup-tokenizers.mjs", import.meta.url);
const CONTENT = '{"version":"1.0","model":{"type":"BPE"}}\n';
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const artifact = (changes = {}) => ({
  id: "o200k-test", family: "o200k", repository: "test/provider", revision: "a".repeat(40),
  file: "tokenizer.json", url: `https://example.com/test/provider/${"a".repeat(40)}/tokenizer.json`,
  sha256: sha256(CONTENT), license: "Apache-2.0", licenseStatus: "permissive", ...changes,
});
const manifest = (artifacts = [artifact()]) => ({ version: 1, artifacts });

async function setup() {
  try {
    return await import(SCRIPT.href);
  } catch (error) {
    assert.fail(`The tokenizer setup must exist and load: ${error.message}`);
  }
}

async function scratch(run) {
  const directory = await mkdtemp(join(tmpdir(), "tokenizer-setup-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("downloads a pinned file, verifies SHA-256 and reuses the verified cache without network", async () => {
  const { setupTokenizers } = await setup();
  await scratch(async (directory) => {
    const downloaded = await setupTokenizers({ manifest: manifest(), directory,
      fetchImpl: async (url) => {
        assert.equal(url, artifact().url);
        return new Response(CONTENT);
      } });
    const path = join(directory, "o200k-test", "tokenizer.json");
    assert.equal(await readFile(path, "utf8"), CONTENT);
    assert.deepEqual(downloaded, [{ id: "o200k-test", path, state: "downloaded" }]);
    const cached = await setupTokenizers({ manifest: manifest(), directory,
      fetchImpl: () => assert.fail("a verified cache must not use the network") });
    assert.deepEqual(cached, [{ id: "o200k-test", path, state: "cached" }]);
  });
});

test("detects a corrupt cache and replaces it only with a matching download", async () => {
  const { setupTokenizers } = await setup();
  await scratch(async (directory) => {
    const parent = join(directory, "o200k-test");
    await mkdir(parent);
    const path = join(parent, "tokenizer.json");
    await writeFile(path, "corrupt");
    await assert.rejects(setupTokenizers({ manifest: manifest(), directory,
      fetchImpl: async () => new Response("wrong bytes") }), /sha256.*o200k-test/i);
    assert.equal(await readFile(path, "utf8"), "corrupt");
    assert.deepEqual(await readdir(parent), ["tokenizer.json"], "a failed download must leave no temporary files");
    await setupTokenizers({ manifest: manifest(), directory, fetchImpl: async () => new Response(CONTENT) });
    assert.equal(await readFile(path, "utf8"), CONTENT);
  });
});

test("a missing file with a bad download never becomes a usable cache entry", async () => {
  const { setupTokenizers } = await setup();
  await scratch(async (directory) => {
    await assert.rejects(setupTokenizers({ manifest: manifest(), directory,
      fetchImpl: async () => new Response("wrong bytes") }), /sha256.*o200k-test/i);
    await assert.rejects(readFile(join(directory, "o200k-test", "tokenizer.json")), { code: "ENOENT" });
  });
});

test("converts verified tiktoken ranks and independently verifies the generated tokenizer bytes", async () => {
  const { setupTokenizers } = await setup();
  const { convertTiktokenToJson } = await import("./tiktoken-to-json.mjs");
  const source = Array.from({ length: 256 }, (_, index) =>
    `${Buffer.from([index]).toString("base64")} ${index}\n`).join("");
  const output = convertTiktokenToJson(source);
  const converted = artifact({ sourceFormat: "tiktoken-ranks", sourceSha256: sha256(source), sha256: sha256(output) });
  await scratch(async (directory) => {
    const path = join(directory, converted.id, converted.file);
    await assert.rejects(setupTokenizers({ manifest: manifest([converted]), directory,
      fetchImpl: async () => new Response("wrong source") }), /source sha256.*o200k-test/i);
    await assert.rejects(setupTokenizers({ manifest: manifest([{ ...converted, sha256: "0".repeat(64) }]), directory,
      fetchImpl: async () => new Response(source) }), /sha256.*o200k-test/i);
    await assert.rejects(readFile(path), { code: "ENOENT" });
    await setupTokenizers({ manifest: manifest([converted]), directory, fetchImpl: async () => new Response(source) });
    assert.equal(await readFile(path, "utf8"), output);
    assert.equal(await readFile(join(directory, converted.id, "NOTICE"), "utf8"),
      await readFile(new URL("./NOTICE", import.meta.url), "utf8"));
  });
});

test("restores a missing or modified license beside a verified converted cache without network", async () => {
  const { setupTokenizers } = await setup();
  const converted = artifact({ sourceFormat: "tiktoken-ranks", sourceSha256: "0".repeat(64) });
  const bundledNotice = await readFile(new URL("./NOTICE", import.meta.url), "utf8");
  await scratch(async (directory) => {
    const parent = join(directory, converted.id);
    await mkdir(parent);
    await writeFile(join(parent, converted.file), CONTENT);
    const notice = join(parent, "NOTICE");
    const restore = () => setupTokenizers({ manifest: manifest([converted]), directory,
      fetchImpl: () => assert.fail("a verified tokenizer must restore its license without network") });
    for (const altered of [false, true]) {
      if (altered) await writeFile(notice, "changed license");
      await restore();
      assert.equal(await readFile(notice, "utf8"), bundledNotice);
    }
  });
});

test("propagates HTTP and transport failures rather than silently omitting an artifact", async () => {
  const { setupTokenizers } = await setup();
  await scratch(async (directory) => {
    await assert.rejects(setupTokenizers({ manifest: manifest(), directory,
      fetchImpl: async () => new Response("not found", { status: 404 }) }), /HTTP 404.*o200k-test/i);
    await assert.rejects(setupTokenizers({ manifest: manifest(), directory,
      fetchImpl: async () => { throw new Error("transport unavailable"); } }), /transport unavailable/);
  });
});

test("rejects unsafe paths, unpinned files and pending or restricted licenses before fetching", async () => {
  const { setupTokenizers } = await setup();
  const invalid = [
    manifest([]), { ...manifest(), version: 2 }, manifest([artifact(), artifact()]),
    ...[
      { id: "../outside" }, { id: ".." }, { file: "../tokenizer.json" }, { file: "C:\\tokenizer.json" },
      { sha256: "missing" }, { url: "http://example.com/tokenizer.json" }, { revision: "" },
      { sourceFormat: "unknown" }, { sourceFormat: "tiktoken-ranks" },
      { family: "claude-v2", sourceFormat: "tiktoken-ranks", sourceSha256: sha256(CONTENT) },
      { file: "NOTICE", sourceFormat: "tiktoken-ranks", sourceSha256: sha256(CONTENT) },
      { licenseStatus: "pending" }, { license: "Gemma Terms" }, { license: "xAI Community License" },
      { family: "gemma3" }, { family: "grok-2" },
    ].map((changes) => manifest([artifact(changes)])),
  ];
  await scratch(async (directory) => {
    let fetches = 0;
    for (const input of invalid) {
      await assert.rejects(setupTokenizers({ manifest: input, directory,
        fetchImpl: async () => { fetches += 1; return new Response(CONTENT); } }), /manifest/i);
    }
    assert.equal(fetches, 0, "a refused manifest must not trigger a download");
    assert.deepEqual(await readdir(directory), []);
  });
});

test("the CLI verifies an existing cache and exits nonzero on an invalid manifest", async () => {
  await setup();
  await scratch(async (directory) => {
    const parent = join(directory, "o200k-test");
    await mkdir(parent);
    await writeFile(join(parent, "tokenizer.json"), CONTENT);
    const path = join(directory, "manifest.json");
    await writeFile(path, JSON.stringify(manifest()));
    const run = () => spawnSync(process.execPath, [fileURLToPath(SCRIPT), "--manifest", path, "--directory", directory],
      { encoding: "utf8" });
    const valid = run();
    assert.equal(valid.status, 0, valid.stderr);
    assert.match(valid.stdout, /o200k-test: cached/);
    await writeFile(path, JSON.stringify(manifest([artifact({ licenseStatus: "pending" })])));
    const refused = run();
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /manifest/i);
  });
});

test("CI verifies pinned tokenizer caches before every workspace Cargo test without allowing missing artifacts", async () => {
  // A Windows checkout (core.autocrlf) has CRLF line ends; every pattern below expects LF.
  const yaml = (await readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"))
    .replace(/\r\n/g, "\n");
  const jobs = Object.fromEntries(yaml.slice(yaml.indexOf("\njobs:\n")).split(/(?=^  [a-z][\w-]*:\n)/m).slice(1)
    .map((block) => [/^  ([\w-]+):/.exec(block)[1], block]));
  assert.equal((yaml.match(/node scripts\/tokens\/setup-tokenizers\.mjs/g) ?? []).length, 2);
  for (const name of ["unit", "unit-os"]) {
    const job = jobs[name];
    assert.match(job, /^      PLUR1BUS_TOKENIZER_FILES_REQUIRED: "1"$/m, name);
    // A job's env has no `runner` context; referencing it there makes GitHub reject the whole workflow file, so no
    // job runs at all. The directory is set on setup, Cargo build and Cargo execution steps.
    const jobEnv = /^    env:\n((?:(?: {6}.*)?\n)*)/m.exec(job.slice(0, job.indexOf("\n    steps:\n")))?.[1] ?? "";
    assert.doesNotMatch(jobEnv, /\$\{\{\s*runner\./, `${name}: no runner context in the job's env`);
    const steps = job.split(/(?=^      - )/m);
    const directory = /^          PLUR1BUS_TOKENIZER_DIR: \$\{\{ runner.temp \}\}\/plur1bus-tokenizers$/m;
    const setupStep = steps.find((step) => /node scripts\/tokens\/setup-tokenizers\.mjs/.test(step));
    assert.ok(setupStep, `${name}: explicit verified setup required`);
    assert.match(setupStep, directory, `${name}: setup writes the cache directory`);
    const cargoSteps = steps.filter((step) => /^(?:        run: |          )cargo test --workspace\b/m.test(step));
    assert.equal(cargoSteps.length, 3, `${name}: library build, complete build and execution`);
    for (const step of cargoSteps) {
      assert.match(step, directory, `${name}: every Cargo test step reads the verified cache`);
      assert.ok(job.indexOf(setupStep) < job.indexOf(step), name);
    }
    assert.match(setupStep, /if: \$\{\{ !cancelled\(\) && needs\.changes\.outputs\.rust == 'true' \}\}/, name);
    const cacheStep = job.split(/(?=^      - )/m).find((step) => /path: \$\{\{ runner.temp \}\}\/plur1bus-tokenizers/.test(step));
    assert.ok(cacheStep, `${name}: cache tokenizer files outside the workspace`);
    assert.match(cacheStep, /actions\/cache@[a-f0-9]{40}/, name);
    assert.match(cacheStep, /hashFiles\('crates\/plur1bus-engine\/src\/tokens\/artifacts.json'/, name);
    assert.match(job, /node --test scripts\/tokens\/\*\.test\.mjs/, name);
  }
});
