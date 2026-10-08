import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { OutputStore } from "../../media/src/index.ts";
import type { Attachment } from "./port.ts";

export interface OutputPort {
  store: Pick<OutputStore, "get" | "root">;
  authorize(outputId: string, chatId: string): Promise<boolean>;
}

/** Reads a verified image from the trusted output store for one destination. Authorize before read; check size and SHA-256. */
export async function outputAttachment(
  port: OutputPort,
  id: string,
  chatId: string,
  maxBytes: number,
  index = 0,
): Promise<Attachment> {
  if (!/^[a-f0-9-]{36}$/.test(id) || !(await port.authorize(id, chatId))) throw new Error("media output denied");
  const manifest = await port.store.get(id);
  const file = manifest?.files[index];
  if (!file || !/^\d+\.(png|jpeg|webp)$/.test(file.path) || file.bytes > maxBytes)
    throw new Error("media output unavailable");
  const data = await readFile(join(port.store.root, id, file.path));
  if (data.length !== file.bytes || createHash("sha256").update(data).digest("hex") !== file.sha256)
    throw new Error("media output integrity");
  return { kind: "image", data, mimeType: `image/${file.format}`, filename: file.path };
}
