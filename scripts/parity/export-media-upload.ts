import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { OutputStore } from "../../packages/media/src/store.ts";
import { MediaError } from "../../packages/media/src/types.ts";
import { UploadIndex } from "../../packages/media/src/upload-index.ts";
import { makePng } from "../../packages/media/test/adapters-fixtures.ts";
import { exporterMain } from "./lib.mjs";

const ID = "00000000-0000-4000-8000-000000000000";

async function refusal(operation: () => Promise<unknown>) {
  try { await operation(); }
  catch (error) {
    if (error instanceof MediaError) return error.code;
    throw error;
  }
  throw new Error("Expected upload refusal");
}

export async function recordMediaUpload() {
  const root = await mkdtemp(join(tmpdir(), "p4-w-media-upload-"));
  const now = 1_700_000_000_000;
  const realNow = Date.now;
  Date.now = () => now;
  try {
    const data = Buffer.concat([makePng(), Buffer.from("unchanged upload bytes")]);
    const kind = "image" as const;
    const mimeType = "image/png";
    const filename = "  folder/sample🌳.png  ";
    const store = new OutputStore(root, { retentionMs: 1000 });
    const output = await store.putUploaded({ data, kind, mimeType, filename });
    const manifest = { ...output.manifest, id: ID };
    const raw = (await readFile(output.file)).toString("base64");
    const index = await new UploadIndex(root).read(output.manifest.id);
    if (!index) throw new Error("Missing upload charge");
    const quota = await refusal(() => new OutputStore(root, { quotaBytes: index.bytes * 2 - 1 })
      .putUploaded({ data, kind, mimeType, filename }));
    const wrongType = await refusal(() => store.putUploaded({ data, kind, mimeType: "image/jpeg" }));
    const generatedLookup = await store.get(output.manifest.id);
    await writeFile(output.file, Buffer.alloc(data.length));
    const changedHash = await refusal(() => store.getUploaded(output.manifest.id));
    await writeFile(output.file, data);
    const retained = await store.prune(now + 999);
    const failing = store.addListener({ onDeleteUploaded: () => { throw new Error("fixture binding"); } });
    const cleanupFailure = await refusal(() => store.prune(now + 1000));
    failing();
    const presentAfterFailure = Boolean(await store.getUploaded(output.manifest.id));
    const expired = await store.prune(now + 1000);
    return { "upload-store": {
      source: "packages/media/src/store.ts",
      input: { id: ID, now, kind, mimeType, filename, data: data.toString("base64") },
      expected: { manifest, raw, index, quota, wrongType, generatedLookup, changedHash,
        retained, cleanupFailure, presentAfterFailure, expired, absent: await store.getUploaded(output.manifest.id) },
    } };
  } finally {
    Date.now = realNow;
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "media", build: recordMediaUpload });
}
