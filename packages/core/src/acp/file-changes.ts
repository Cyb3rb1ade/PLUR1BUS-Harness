/** ACP change presentation consumes Core events; it never reads or writes editor/worktree files. */
import path from "node:path";
import { acpText, type AcpLanguage } from "./text.ts";

// Even JSON's worst-case six-byte escapes fit under ACP's 1 MiB line budget, including the path/envelope.
export const MAX_DIFF_CONTENT_BYTES = 128 * 1024;
export const MAX_RETAINED_FILE_CALLS = 16;
const MAX_SEEN_FILE_CALLS = 1024;
const MAX_PATCH_BYTES = 32 * 1024;
const MAX_RESULT_PARSE_BYTES = 2 * 1024 * 1024;
export type AcpFileContent =
  | { type: "diff"; path: string; oldText: string | null; newText: string }
  | { type: "content"; content: { type: "text"; text: string } };

interface FileCall {
  name: "file.write" | "file.edit";
  content?: string;
  oversized: boolean;
  utf8: boolean;
  ambiguous: boolean;
}
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function clipped(text: string, notice: string): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= MAX_PATCH_BYTES) return text.toWellFormed();
  let end = MAX_PATCH_BYTES;
  while ((bytes[end]! & 0xc0) === 0x80) end--;
  return `${bytes.subarray(0, end).toString("utf8")}\n${notice}`;
}

function fullPath(root: string | undefined, value: Record<string, unknown>): string | undefined {
  if (!root || value.rootId !== "coding-worktree" || typeof value.path !== "string") return;
  const relative = value.path;
  if (!relative || relative.length > 4096 || /[\\\u0000:]/u.test(relative) ||
    path.posix.isAbsolute(relative) || relative.split("/").some(part => !part || part === "." || part === "..")) return;
  const native = /^[a-z]:[\\/]|^\\\\/iu.test(root) ? path.win32 : path.posix;
  if (!native.isAbsolute(root)) return;
  const result = native.resolve(root, relative);
  const tail = native.relative(root, result);
  if (!tail || tail === ".." || tail.startsWith(`..${native.sep}`) || native.isAbsolute(tail)) return;
  return result;
}

function layers(envelope: unknown): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (let value = envelope; object(value) && rows.length < 5; value = value.value ?? value.data ?? value.result) {
    rows.push(value);
  }
  return rows;
}

/** Keeps only bounded call details needed to explain completed file operations. */
export class AcpFileChanges {
  readonly #root: string | undefined;
  readonly #text: ReturnType<typeof acpText>;
  readonly #calls = new Map<string, FileCall>();
  readonly #seen = new Set<string>();

  constructor(root?: string, language: AcpLanguage = "en") {
    this.#root = root;
    this.#text = acpText(language);
  }

  /** Retain at most 2 MiB of full text, only for known file tools, and reject ambiguous/reused call ids. */
  call(id: string, name: string, args: unknown): void {
    if ((name !== "file.write" && name !== "file.edit") || !id || id.length > 256) return;
    const duplicate = this.#seen.has(id);
    if (!duplicate && this.#seen.size >= MAX_SEEN_FILE_CALLS) return;
    this.#seen.add(id);
    const previous = this.#calls.get(id);
    if (previous) {
      previous.ambiguous = true;
      return;
    }
    const content = object(args) && typeof args.content === "string" ? args.content : undefined;
    const oversized = content !== undefined && Buffer.byteLength(content) > MAX_DIFF_CONTENT_BYTES;
    this.#calls.set(id, { name, oversized, ambiguous: duplicate,
      utf8: object(args) && (args.encoding === undefined || args.encoding === "utf8"),
      ...(content !== undefined && !oversized ? { content } : {}) });
    if (this.#calls.size > MAX_RETAINED_FILE_CALLS) this.#calls.delete(this.#calls.keys().next().value!);
  }

  /** Standard ACP diff only for a proved complete new-file write; all other patches remain labelled text. */
  result(id: string, output: string): AcpFileContent[] | undefined {
    const call = this.#calls.get(id);
    this.#calls.delete(id);
    let parsed: unknown;
    if (Buffer.byteLength(output) <= MAX_RESULT_PARSE_BYTES) {
      try {
        parsed = JSON.parse(output);
      } catch {
        // Older tools may return plain text; it is still data, never invented file contents.
      }
    }
    const rows = layers(parsed);
    const patch = rows.map(row => row.diff ?? row.unifiedDiff).find(value => typeof value === "string");
    if (!call && !this.#seen.has(id) && typeof patch !== "string" &&
      !(object(parsed) && (parsed.tool === "file.write" || parsed.tool === "file.edit"))) return;
    const truncated = rows.some(row => (row.truncated !== undefined && row.truncated !== false) ||
      row.diffTruncated === true || (object(row.meta) && row.meta.truncated === true));
    const value = rows.find(row => row.rootId === "coding-worktree" && typeof row.path === "string");
    const target = value ? fullPath(this.#root, value) : undefined;
    const failed = rows.some(row => row.isError === true);
    // The persisted public envelope omits dispatcher ids: the owned turn's call/result event pair supplies them.
    // If a producer does include ids, a mismatch is still a refusal of complete-content presentation.
    if (call?.name === "file.write" && !call.ambiguous && call.utf8 && call.content?.isWellFormed() &&
      !call.oversized && !truncated && !failed && object(parsed) && parsed.isError === false &&
      (parsed.tool === undefined || parsed.tool === "file.write") &&
      (parsed.callId === undefined || parsed.callId === id) && value?.created === true && target &&
      value.bytesWritten === Buffer.byteLength(call.content)) {
      return [{ type: "diff", path: target, oldText: null, newText: call.content }];
    }
    const text = this.#text;
    const reason = [truncated ? text.truncated : undefined, call?.oversized ? text.sizeLimit : undefined,
      failed ? text.toolFailed : undefined, text.unknownContents].filter(Boolean).join("; ");
    const heading = typeof patch === "string" ? `${text.patch} (${reason}):` :
      `${text.toolResult} (${reason}; ${text.noPatch}):`;
    return [{ type: "content", content: { type: "text",
      text: `${heading}\n${clipped(patch ?? output, text.displayClipped)}` } }];
  }
}
