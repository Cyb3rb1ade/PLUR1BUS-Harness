import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { OutputStore } from "../../media/src/index.ts";
import type { Attachment } from "./port.ts";
export const TELEGRAM_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export interface OutputPort {
  store: Pick<OutputStore, "get" | "root">;
  authorize(outputId: string, chatId: string): Promise<boolean>;
  compress?: (image: Attachment, maxBytes: number) => Promise<Attachment>;
}
/** Reads verified bytes from the trusted output store. The host checks sharing rights for the destination. */
export async function outputAttachment(
  port: OutputPort,
  id: string,
  chatId: string,
  index = 0,
): Promise<Attachment> {
  if (!/^[a-f0-9-]{36}$/.test(id) || !(await port.authorize(id, chatId)))
    throw new Error("media output denied");
  const manifest = await port.store.get(id),
    file = manifest?.files[index];
  if (
    !file ||
    !/^\d+\.(png|jpeg|webp)$/.test(file.path) ||
    file.bytes > 50 * 1024 * 1024
  )
    throw new Error("media output unavailable");
  const data = await readFile(join(port.store.root, id, file.path));
  if (
    data.length !== file.bytes ||
    createHash("sha256").update(data).digest("hex") !== file.sha256
  )
    throw new Error("media output integrity");
  let image: Attachment = {
    kind: "photo",
    data,
    mimeType: `image/${file.format}`,
    filename: file.path,
  };
  if (data.length > TELEGRAM_PHOTO_MAX_BYTES) {
    if (!port.compress) throw new Error("media output needs compression");
    image = await port.compress(image, TELEGRAM_PHOTO_MAX_BYTES);
  }
  if (
    image.kind !== "photo" ||
    !/^image\/(png|jpeg|webp)$/.test(image.mimeType) ||
    !image.data.length ||
    image.data.length > TELEGRAM_PHOTO_MAX_BYTES
  )
    throw new Error("media output exceeds photo limit");
  return image;
}
