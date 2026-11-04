/** One supported upload catalogue, shared by routing, persistence and authenticated ingress. */
export type UploadKind = "image" | "audio" | "video";
export const UPLOAD_TYPES: Readonly<Record<string, readonly [UploadKind, string]>> = Object.freeze({
  "image/png": ["image", "png"], "image/jpeg": ["image", "jpeg"], "image/webp": ["image", "webp"],
  "image/gif": ["image", "gif"], "audio/wav": ["audio", "wav"], "audio/x-wav": ["audio", "wav"],
  "audio/mpeg": ["audio", "mp3"], "audio/mp3": ["audio", "mp3"], "audio/ogg": ["audio", "ogg"],
  "audio/flac": ["audio", "flac"], "audio/aac": ["audio", "aac"], "audio/mp4": ["audio", "m4a"],
  "audio/x-m4a": ["audio", "m4a"], "audio/webm": ["audio", "webm"], "video/mp4": ["video", "mp4"],
  "video/quicktime": ["video", "mov"], "video/webm": ["video", "webm"], "video/ogg": ["video", "ogv"],
});

export function uploadMediaType(mimeType: string): readonly [UploadKind, string] | undefined {
  return Object.hasOwn(UPLOAD_TYPES, mimeType) ? UPLOAD_TYPES[mimeType] : undefined;
}

/** Specific transport labels must agree; document/file labels permit any supported medium. */
export function supportedUpload(mimeType: string, transportKind: string): boolean {
  const type = uploadMediaType(mimeType);
  if (!type) return false;
  if (transportKind === "photo" || transportKind === "image") return type[0] === "image";
  if (transportKind === "voice" || transportKind === "audio") return type[0] === "audio";
  if (transportKind === "video") return type[0] === "video";
  return transportKind === "document" || transportKind === "file";
}
