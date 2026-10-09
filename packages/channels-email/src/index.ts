import type { EmailConfig } from "./config.ts";
import { EmailChannel, type EmailDeps } from "./channel.ts";

export function createEmailChannel(cfg: EmailConfig, deps: EmailDeps): EmailChannel {
  return new EmailChannel({ ...cfg, ...deps });
}

export { EmailChannel, defaultSleep } from "./channel.ts";
export type { EmailChannelOptions, EmailDeps } from "./channel.ts";
export type { EmailConfig, EmailImapConfig, EmailServerConfig, NormalizedConfig } from "./config.ts";
export { normalizeConfig } from "./config.ts";
export { ImapConnection, openImap, quote, IMAP_MAX_LITERAL } from "./imap.ts";
export type { ImapResponse, ImapTagged, ImapOpened, SelectResult } from "./imap.ts";
export { sendMail, smtpNoop, dotStuff, checkAddrSpec } from "./smtp.ts";
export type { SmtpOptions, SendOptions } from "./smtp.ts";
export { parseMessage, parseStrictMailbox, parseAddressList, decodeEncodedWords, decodeQuotedPrintable, HeaderMap } from "./mime-parse.ts";
export type { ParsedMessage, Mailbox, ParsedAttachment, FromProblem } from "./mime-parse.ts";
export { htmlToText, decodeEntities } from "./html-text.ts";
export { buildMessage, encodeWords, sanitizeFilename, assertHeaderValue } from "./mime-build.ts";
export type { BuildInput, OutAttachment } from "./mime-build.ts";
export { markdownToHtml, inlineHtml, escapeHtml } from "./markdown.ts";
export { splitMessage, truncateBody, EMAIL_MAX_BODY_CHARS } from "./split.ts";
export { redactString, redactAttrs } from "./redact.ts";
export { FileUidStore, MemoryUidStore } from "./uid-store.ts";
export { FileThreadStore, MemoryThreadStore, threadKey, replySubject, capReferences, chainFor } from "./threading.ts";
export type { ThreadRecord, ThreadStore } from "./threading.ts";
export { outputAttachment } from "./outputs.ts";
export type { OutputPort } from "./outputs.ts";
export { MESSAGES } from "./messages.ts";
export type { Locale, Messages } from "./messages.ts";
export {
  parseAuthResults,
  stripCfws,
  loopReason,
  senderMatches,
  parseApprovalReply,
  parseLinkCommand,
  stripQuotedText,
  SlidingWindow,
} from "./policy.ts";
export { UnsupportedError } from "./port.ts";
export { EmailError } from "./wire.ts";
export type * from "./port.ts";
