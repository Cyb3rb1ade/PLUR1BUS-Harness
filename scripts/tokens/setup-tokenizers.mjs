/** Fetches only licensed, pinned tokenizer artifacts into an external cache; payloads never enter the repository. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const LICENSES = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD", "CC0-1.0"]);
const HASH = /^[a-f0-9]{64}$/;
const NAME = /^[a-z0-9][a-z0-9._-]*$/;
const DEFAULT_MANIFEST = new URL("../../crates/plur1bus-engine/src/tokens/artifacts.json", import.meta.url);
const NOTICE = new URL("./NOTICE", import.meta.url);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function validateManifest(manifest) {
  if (manifest?.version !== 1 || !Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    throw new Error("tokenizer manifest: version 1 and a nonempty artifact list are required");
  }
  const seen = new Set();
  for (const artifact of manifest.artifacts) {
    const fail = () => { throw new Error(`tokenizer manifest: invalid or unapproved artifact ${artifact?.id ?? "unknown"}`); };
    if (!artifact || typeof artifact !== "object") fail();
    for (const key of ["id", "family", "file", "repository", "revision", "url", "sha256", "license", "licenseStatus"]) {
      if (typeof artifact[key] !== "string" || !artifact[key]) fail();
    }
    if (!NAME.test(artifact.id) || !NAME.test(artifact.file) || artifact.id.includes("..") || artifact.file.includes("..")) {
      fail();
    }
    if (seen.has(artifact.id) || !HASH.test(artifact.sha256) || !/^[a-f0-9]{40}$/.test(artifact.revision)) fail();
    if (artifact.licenseStatus !== "permissive" || !LICENSES.has(artifact.license)) fail();
    // RE-D25: these conditional licenses require an explicit owner decision, not a setup-time switch.
    if (["gemma3", "grok-2"].includes(artifact.family)) fail();
    const format = artifact.sourceFormat ?? "tokenizer-json";
    if (!["tokenizer-json", "tiktoken-ranks"].includes(format)) fail();
    if (format === "tiktoken-ranks" && (artifact.family !== "o200k" || artifact.file.toLowerCase() === "notice" ||
      !HASH.test(artifact.sourceSha256 ?? ""))) fail();
    let url;
    try { url = new URL(artifact.url); } catch { fail(); }
    if (url.protocol !== "https:" || url.username || url.password || !url.pathname.includes(artifact.revision)) fail();
    if (!url.pathname.includes(`/${artifact.repository}/`)) fail();
    seen.add(artifact.id);
  }
}

async function isCached(path, expected) {
  try {
    return sha256(await readFile(path)) === expected;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function fetchArtifact(artifact, fetchImpl) {
  const response = await fetchImpl(artifact.url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`tokenizer HTTP ${response.status}: ${artifact.id}`);
  const source = Buffer.from(await response.arrayBuffer());
  let bytes = source;
  if (artifact.sourceFormat === "tiktoken-ranks") {
    if (sha256(source) !== artifact.sourceSha256) throw new Error(`tokenizer source sha256 mismatch: ${artifact.id}`);
    const { convertTiktokenToJson } = await import("./tiktoken-to-json.mjs");
    bytes = Buffer.from(convertTiktokenToJson(source.toString("utf8")));
  }
  if (sha256(bytes) !== artifact.sha256) throw new Error(`tokenizer sha256 mismatch: ${artifact.id}`);
  return bytes;
}

async function writeAtomically(path, bytes) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function ensureLicense(artifact, directory) {
  if (artifact.sourceFormat !== "tiktoken-ranks") return;
  const bytes = await readFile(NOTICE);
  const path = join(directory, artifact.id, "NOTICE");
  if (!await isCached(path, sha256(bytes))) await writeAtomically(path, bytes);
}

/** Verify every cached artifact or fetch and verify it; any failed artifact rejects the whole setup. */
export async function setupTokenizers({ manifest, directory, fetchImpl = globalThis.fetch }) {
  validateManifest(manifest);
  if (typeof directory !== "string" || !directory.trim()) throw new Error("PLUR1BUS_TOKENIZER_DIR is required");
  const results = [];
  for (const artifact of manifest.artifacts) {
    const path = join(directory, artifact.id, artifact.file);
    if (await isCached(path, artifact.sha256)) {
      await ensureLicense(artifact, directory);
      results.push({ id: artifact.id, path, state: "cached" });
      continue;
    }
    const bytes = await fetchArtifact(artifact, fetchImpl);
    await mkdir(join(directory, artifact.id), { recursive: true });
    await ensureLicense(artifact, directory);
    await writeAtomically(path, bytes);
    results.push({ id: artifact.id, path, state: "downloaded" });
  }
  return results;
}

async function main() {
  let manifestPath = DEFAULT_MANIFEST;
  let directory = process.env.PLUR1BUS_TOKENIZER_DIR;
  const arguments_ = process.argv.slice(2);
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index], value = arguments_[index + 1];
    if (!value || !["--manifest", "--directory"].includes(name)) {
      throw new Error("Usage: node scripts/tokens/setup-tokenizers.mjs [--manifest path] [--directory path]");
    }
    if (name === "--manifest") manifestPath = value;
    else directory = value;
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  for (const result of await setupTokenizers({ manifest, directory })) console.log(`${result.id}: ${result.state}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
