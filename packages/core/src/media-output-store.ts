/** Shared production media storage policy for generated outputs and channel uploads. */
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { OutputStore } from "../../media/src/index.ts";
import { safeId } from "../../media/src/files.ts";

export const MEDIA_OUTPUT_QUOTA_BYTES = 1024 ** 3;
export const MEDIA_OUTPUT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** All production construction sites use the same bounded store. */
export function createMediaOutputStore(home: string, log?: { warn(message: string, fields?: Record<string, unknown>): void }): OutputStore {
  const store = new OutputStore(join(home, "media", "outputs"), {
    quotaBytes: MEDIA_OUTPUT_QUOTA_BYTES,
    retentionMs: MEDIA_OUTPUT_RETENTION_MS,
  });
  store.addListener({
    async onDeleteUploaded(id) {
      let ownerId: string;
      try { ownerId = safeId(id); } catch { return; }
      await rm(join(home, "media", "owners", `${ownerId}.json`), { force: true });
    },
    onCorruptUploadRemoved() { log?.warn("media upload recovered", { code: "corrupt-upload-removed" }); },
  });
  return store;
}
