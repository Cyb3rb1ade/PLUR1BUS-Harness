import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { OutputStore } from "../../media/src/index.ts";
import type { Attachment } from "./port.ts";

export interface OutputPort {
  store: Pick<OutputStore, "get" | "root">;
  authorize(outputId: string, chatId: string): Promise<boolean>;
  compress?: (image: Attachment, maxBytes: number) => Promise<Attachment>;
}
/** Reads verified bytes from the trusted output store. The host checks sharing rights for the destination (authorize first). */
export async function outputAttachment(
  port: OutputPort,
  id: string,
  chatId: string,
  maxBytes: number,
  index = 0,
): Promise<Attachment> {
  if (!/^[a-f0-9-]{36}$/.test(id) || !(await port.authorize(id, chatId))) throw new Error("media output denied");
  const manifest = await port.store.get(id),
    file = manifest?.files[index];
  if (!file || !/^\d+\.(png|jpeg|webp)$/.test(file.path) || file.bytes > 50 * 1024 * 1024)
    throw new Error("media output unavailable");
  const data = await readFile(join(port.store.root, id, file.path));
  if (data.length !== file.bytes || createHash("sha256").update(data).digest("hex") !== file.sha256)
    throw new Error("media output integrity");
  let image: Attachment = { kind: "image", data, mimeType: `image/${file.format}`, filename: file.path };
  if (data.length > maxBytes) {
    if (!port.compress) throw new Error("media output needs compression");
    image = await port.compress(image, maxBytes);
  }
  if (image.kind !== "image" || !/^image\/(png|jpeg|webp)$/.test(image.mimeType) || !image.data.length || image.data.length > maxBytes)
    throw new Error("media output exceeds attachment limit");
  return image;
}
