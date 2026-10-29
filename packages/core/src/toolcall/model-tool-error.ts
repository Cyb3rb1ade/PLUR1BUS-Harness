/** N1 model-only failure boundary: redact secrets and home identity while preserving raw dispatcher diagnostics.
 * Successful tool values and log/audit redactors are outside this module's ownership.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { createRedactor } from "../logs/redact.ts";
import type { InternalToolFailureCategory, ToolFailure } from "../tools/dispatcher.ts";

const MAX_DETAIL_CHARS = 4096;
const MAX_STRING_CHARS = 500;
const MAX_EXCEPTION_CHARS = 300;
const MAX_ID_CHARS = 128;
const SOURCE_CODE = /^[a-z0-9_.-]{1,64}$/;
// A path may arrive with doubled separators (the escaped spelling util.inspect and JSON give), so every separator is a run.
const NAME = String.raw`[^\\/\r\n"'<>|:;,()[\]{}]+`;
const USER_HOME = new RegExp(
  String.raw`(?:(?<![A-Za-z0-9_./\\~-])|(?<=file://)|(?<=file:///))` +
  String.raw`(/(?:var/)?home|/Users|/mnt/[A-Za-z]/Users|/Volumes/[^/\\\r\n"'<>|:;,()[\]{}]+/Users` +
  String.raw`|(?:[\\/]{2,4}\?[\\/]{1,2})?[A-Za-z]:[\\/]+Users` +
  // A WSL distribution seen from Windows: \\wsl$\<distro>\home and \\wsl.localhost\<distro>\home.
  String.raw`|[\\/]{2,}wsl(?:\$|\.localhost)[\\/]+[^\\/\r\n"'<>|:;,()[\]{}]+[\\/]+(?:var[\\/]+)?home)` +
  String.raw`([\\/]+)(${NAME})`, "gi",
);
const FIXED_MESSAGES: Record<InternalToolFailureCategory, string> = {
  "internal-error": "The tool call failed because of an internal error.",
  "classification-failure": "The tool call could not be classified safely.",
  "approval-port-failure": "The approval service is unavailable; the tool did not run.",
  "audit-unavailable": "The audit trail is unavailable; the tool did not run.",
};
const PROCESS_HOME = homedir();
// Resolve once at module startup; a missing/inaccessible home still has its lexical prefix sanitized.
const PROCESS_REAL_HOME = (() => {
  try {
    return realpathSync.native(PROCESS_HOME);
  } catch {
    return PROCESS_HOME;
  }
})();

/** Optional home/platform injection keeps the model-only path rules deterministic in tests. */
export interface ModelToolErrorOptions {
  home?: string;
  realHome?: string;
  platform?: NodeJS.Platform;
}

const clip = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
const escapePattern = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function homePatterns(options: ModelToolErrorOptions): RegExp[] {
  const home = options.home ?? PROCESS_HOME;
  const realHome = options.realHome ?? (options.home === undefined ? PROCESS_REAL_HOME : home);
  const platform = options.platform ?? process.platform;
  const flags = platform === "win32" || platform === "darwin" ? "gi" : "g";
  return [...new Set([home, realHome])].filter(path => path.length > 1).sort((a, b) => b.length - a.length)
    .map(path => {
      const normal = path.replace(/^\\\\\?\\/, "").replace(/[\\/]+$/, "");
      const prefix = /^[A-Za-z]:/.test(normal) ? String.raw`(?:[\\/]{2,4}\?[\\/]{1,2})?` : "";
      const body = normal.split(/[\\/]/).map(escapePattern).join(String.raw`[\\/]+`);
      return new RegExp(
        String.raw`(?:(?<![A-Za-z0-9_./\\~-])|(?<=file://)|(?<=file:///))` + prefix + body
          + String.raw`(?=$|[\\/\s"'<>|:;,()[\]{}])`, flags,
      );
    });
}

function mapStrings(value: unknown, text: (input: string) => string): unknown {
  if (typeof value === "string") return text(value);
  if (Array.isArray(value)) return value.map(item => mapStrings(item, text));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, text)]));
}

function boundedFailure(output: ToolFailure): ToolFailure {
  if (JSON.stringify(output).length <= MAX_DETAIL_CHARS) return output;
  const { sourceCode } = output.error;
  const origin = output.provenance.origin;
  return {
    callId: clip(output.callId, MAX_ID_CHARS), tool: clip(output.tool, MAX_ID_CHARS), isError: true,
    error: {
      code: output.error.code, message: output.error.message,
      ...(sourceCode === undefined ? {} : { sourceCode }),
    },
    provenance: {
      origin: {
        system: clip(origin.system, MAX_ID_CHARS),
        agent: origin.agent === null ? null : clip(origin.agent, MAX_ID_CHARS),
        principal: clip(origin.principal, MAX_ID_CHARS), trust: origin.trust,
      },
      hops: output.provenance.hops, transformedBy: [],
    },
    meta: output.meta,
  };
}

/**
 * Return a separate model-safe failed envelope, at most 4096 characters as JSON. N1 internal categories expose only
 * fixed sentences; tool exceptions expose a redacted first line of at most 300 characters and a validated source code.
 * Other typed failures preserve their details when they fit. Every string passes the existing redactor and home step.
 * The caller applies this only to failures immediately before serialization for the model; logs keep the original.
 */
export function modelToolError(
  output: ToolFailure,
  secrets: Iterable<string> = [],
  options: ModelToolErrorOptions = {},
): ToolFailure {
  const redactor = createRedactor({ secrets });
  const patterns = homePatterns(options);
  const text = (input: string): string => {
    let result = input;
    for (const pattern of patterns) result = result.replace(pattern, "~");
    return clip(result.replace(USER_HOME, "$1$2<user>"), MAX_STRING_CHARS);
  };
  const safe = mapStrings(redactor.value(output), text) as ToolFailure;
  const internalFailure = output.error.internalFailure;
  delete safe.error.internalFailure;
  const typedFailure = safe.error.typedFailure;
  delete safe.error.typedFailure;
  if (internalFailure !== undefined) {
    safe.error = { code: output.error.code, message: FIXED_MESSAGES[internalFailure] };
  } else {
    if (typedFailure) {
      safe.error = { ...typedFailure, code: output.error.code, sourceCode: typedFailure.code };
    }
    const limit = output.error.code === "tool-failed" ? MAX_EXCEPTION_CHARS : MAX_STRING_CHARS;
    safe.error.message = clip(safe.error.message.split(/[\r\n\u2028\u2029]/, 1)[0] ?? "", limit);
    if (safe.error.sourceCode !== undefined && !SOURCE_CODE.test(safe.error.sourceCode)) delete safe.error.sourceCode;
  }
  return boundedFailure(safe);
}
