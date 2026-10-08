import { MatrixChannel, type MatrixChannelOptions, type MatrixDeps } from "./channel.ts";
import type { MatrixConfig } from "./config.ts";

export { MatrixChannel, defaultSleep } from "./channel.ts";
export type { MatrixChannelOptions, MatrixDeps } from "./channel.ts";
export type { MatrixConfig, ReplyPolicy, ResolvedConfig } from "./config.ts";
export { resolveConfig, DEFAULT_MAX_MEDIA_BYTES, HARD_MAX_MEDIA_BYTES } from "./config.ts";
export { MatrixApi, MatrixApiError, validateHomeserverUrl, parseMxc, clampRetryAfter, multipartPart, MIN_RETRY_AFTER_MS, MAX_RETRY_AFTER_MS } from "./api.ts";
export type { MatrixErrorKind, MatrixApiOptions } from "./api.ts";
export { FileSyncTokenStore, MemorySyncTokenStore } from "./sync-store.ts";
export { splitMessage, MATRIX_MAX_BODY_BYTES } from "./split.ts";
export { toMatrixText, toPlatformMarkdown, safeHref, escapeHtml } from "./markdown.ts";
export type { MatrixText } from "./markdown.ts";
export { redactString, redactAttrs } from "./redact.ts";
export { ReactionApprovals, choiceEmoji } from "./approvals.ts";
export { TokenBucket } from "./rate-limit.ts";
export { outputAttachment, type OutputPort } from "./outputs.ts";
export { SYNC_FILTER, formatChatId, parseChatId } from "./events.ts";
export type * from "./port.ts";

/** Factory for the registry: `cfg` is the JSON-serialisable config, `deps` the non-JSON seams. */
export function createMatrixChannel(cfg: MatrixConfig, deps: MatrixDeps): MatrixChannel {
  const opts: MatrixChannelOptions = { ...cfg, ...deps };
  return new MatrixChannel(opts);
}
