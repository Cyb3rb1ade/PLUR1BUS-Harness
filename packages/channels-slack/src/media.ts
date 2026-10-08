import type { Attachment } from "./port.ts";

export type AttachmentKind = Attachment["kind"];

/** Conservative allowlist, shared by inbound and outbound. HTML, SVG and executables are never accepted. */
const SAFE_MIME =
  /^(image\/(jpeg|png|webp|gif)|audio\/(ogg|mpeg|mp4|wav|x-wav|flac|webm)|video\/(mp4|webm)|application\/(pdf|zip|json)|text\/plain)$/;

export function kindForMime(mime: string): AttachmentKind {
  if (mime.startsWith("image/")) return "photo";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "document";
}

export function checkMime(kind: AttachmentKind, mime: string): void {
  if (
    !SAFE_MIME.test(mime) ||
    (kind === "photo" && !mime.startsWith("image/")) ||
    ((kind === "voice" || kind === "audio") && !mime.startsWith("audio/")) ||
    (kind === "video" && !mime.startsWith("video/"))
  )
    throw new Error("unsupported media MIME type");
}

export function safeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 100) || "attachment";
}
