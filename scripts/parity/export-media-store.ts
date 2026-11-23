// W4: record generated output publication, quota, retrieval and retention from OutputStore.
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OutputStore } from "../../packages/media/src/store.ts";
import { MediaError } from "../../packages/media/src/types.ts";
import { makePng } from "../../packages/media/test/adapters-fixtures.ts";
import { exporterMain } from "./lib.mjs";

async function refusal(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    if (error instanceof MediaError) return error.code;
    throw error;
  }
  throw new Error("Expected the output store to refuse the operation");
}

export async function recordMediaStore() {
  const root = await mkdtemp(join(tmpdir(), "p4-w-media-store-"));
  const now = 1_700_000_000_000;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const storeRoot = join(root, "out");
    const png = makePng();
    const request = { prompt: "A fixture tree 🌳", format: "png" as const, embedMetadata: false };
    const reference = { bytes: png, format: "png" as const };
    const withSources = { ...request, referenceImages: [reference], mask: reference };
    const metadata = { adapter: "fixture", model: "fixture-model", durationMs: 7 };
    const output = { files: [reference], metadata, partial: true };
    const id = "fixture-a";
    const store = new OutputStore(storeRoot, { retentionMs: 1000 });
    const manifest = await store.put(id, withSources, output);
    const published = await readFile(join(storeRoot, id, manifest.files[0]!.path));
    const charge = (await readFile(join(storeRoot, id, "manifest.json"))).length + published.length;
    const get = await store.get(id);
    const duplicate = await refusal(() => store.put(id, withSources, output));
    const restricted = new OutputStore(storeRoot, { quotaBytes: charge * 2 - 1 });
    const quota = await refusal(() => restricted.put("fixture-b", withSources, output));
    const wrongFormat = await refusal(() => store.put("fixture-c", request, {
      ...output, files: [{ bytes: png, format: "jpeg" }],
    }));
    const visibleAfterRefusals = await readdir(storeRoot);
    const retained = await store.prune(now + 999);
    const expired = await store.prune(now + 1000);
    return {
      "output-store": {
        source: "packages/media/src/store.ts",
        input: { now, id, request, metadata, bytes: published.toString("base64"), partial: true },
        expected: { manifest, get, charge, duplicate, quota, wrongFormat, visibleAfterRefusals, retained, expired,
          afterExpiry: await store.get(id) },
      },
    };
  } finally {
    Date.now = realNow;
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "media", build: recordMediaStore });
}
