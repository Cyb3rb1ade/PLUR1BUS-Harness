import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { OutputStore } from "../../media/src/index.ts";
import type { Attachment } from "./port.ts";
export const TELEGRAM_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export const TELEGRAM_VIDEO_MAX_BYTES = 50 * 1024 * 1024;
export class VideoOutputTooLarge extends Error { constructor() { super('video exceeds Telegram limit; download it with plur1bus media output'); } }
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
    !/^\d+\.(png|jpeg|webp|mp4|webm|mov)$/.test(file.path) ||
    file.bytes > 50 * 1024 * 1024
  )
    throw manifest?.kind === "video" && file && file.bytes > TELEGRAM_VIDEO_MAX_BYTES ? new VideoOutputTooLarge() : new Error("media output unavailable");
  const data = await readFile(join(port.store.root, id, file.path));
  if (
    data.length !== file.bytes ||
    createHash("sha256").update(data).digest("hex") !== file.sha256
  )
    throw new Error("media output integrity");
  if (manifest?.kind === 'video') {
    if (data.length > TELEGRAM_VIDEO_MAX_BYTES) throw new VideoOutputTooLarge();
    return {kind:file.format === 'mp4' ? 'video' : 'document',data,mimeType:`video/${file.format === 'mov' ? 'quicktime' : file.format}`,filename:file.path};
  }
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
