// N-C2/C3: dispatcher-ready skill reads expose only admitted resources, never execution or ambient filesystem access.
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, type FileHandle } from "node:fs/promises";
import { join, sep } from "node:path";
import type { IndexedSkill } from "./live-index.ts";
import type { ToolDef } from "../tools/registry.ts";
import { denyEntriesFor } from "../host-tools/denylist.ts";
import { isSecretFileName } from "../import/secret-file-names.ts";
import { matchDeny } from "../policy/paths.ts";

export const MAX_SKILL_FILE_BYTES = 64 * 1024;
const MAX_SKILL_FILES = 1024;
const MAX_SKILL_LIST_BYTES = 16 * 1024;
const MAX_SKILL_DIRECTORY_DEPTH = 32;
const MAX_SKILL_RESULT_BYTES = 128 * 1024;
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

type SkillAccessCode = "skill-unavailable" | "unsafe-path" | "secret-file" | "too-large" | "file-list-too-large";

/** Fixed, path-free messages keep filesystem failures useful without disclosing host identities. */
export class SkillAccessError extends Error {
  readonly code: SkillAccessCode;
  constructor(code: SkillAccessCode) {
    const messages: Record<SkillAccessCode, string> = {
      "skill-unavailable": "The skill is unavailable to this agent; use capabilities.search to find an available skill.",
      "unsafe-path": "The resource is unavailable or unsafe; use a regular file relative to the listed skill directory.",
      "secret-file": "Credential-style files are never exposed by skills; use a resource from the listed files.",
      "too-large": "The skill resource exceeds the 64 KiB read limit; request a smaller resource.",
      "file-list-too-large": "The skill file list exceeds its limit; reduce the number or depth of skill resources.",
    };
    super(messages[code]);
    this.name = "SkillAccessError";
    this.code = code;
  }
}

export interface SkillToolsOptions {
  home: string;
  skills: readonly IndexedSkill[];
  /** Records a successful load, including a harness-triggered load through this same tool. */
  onLoad?: (name: string) => void;
}

/** The name classes of the policy deny list (`.env`, `.ssh`, `id_rsa`, `credentials.json` ...), without any home directory. */
const DENY_NAMES = denyEntriesFor("/", {}, "linux").filter(entry => "name" in entry);

/**
 * A path inside a skill folder that looks like a credential: a secret file name (the importer's and packer's rule) or a
 * name the policy deny list covers, in any component. Such files are not listed and not read, as `file.read` would refuse
 * them; a README that tells the agent to read one changes nothing.
 */
function isCredentialPath(parts: readonly string[]): boolean {
  return parts.some(isSecretFileName) || matchDeny(parts.join("/"), DENY_NAMES) !== null;
}

function relativeParts(path: unknown): string[] {
  if (typeof path !== "string" || !path || /[\\\u0000-\u001f\u007f]/.test(path) || /^[A-Za-z]:/.test(path)) {
    throw new SkillAccessError("unsafe-path");
  }
  const parts = path.split("/");
  if (parts.some(part => !part || part === "." || part === "..")) throw new SkillAccessError("unsafe-path");
  return parts;
}

async function checkedPath(root: string, parts: readonly string[]): Promise<string> {
  let current = root;
  const components = [root, ...parts.map(part => { current = join(current, part); return current; })];
  for (const [index, component] of components.entries()) {
    const info = await lstat(component);
    if (info.isSymbolicLink() || (index < components.length - 1 && !info.isDirectory())) {
      throw new SkillAccessError("unsafe-path");
    }
    if (await realpath(component) !== component) throw new SkillAccessError("unsafe-path");
  }
  const resolved = components.at(-1)!;
  if (resolved !== root && !resolved.startsWith(root + sep)) throw new SkillAccessError("unsafe-path");
  return resolved;
}

async function skillRoot(home: string, name: string): Promise<string> {
  const canonicalHome = await realpath(home);
  const root = await checkedPath(canonicalHome, ["skills", name]);
  if (!(await lstat(root)).isDirectory()) throw new SkillAccessError("unsafe-path");
  return root;
}

async function verifyHandle(root: string, parts: readonly string[], handle: FileHandle): Promise<void> {
  const path = await checkedPath(root, parts);
  const [named, opened] = await Promise.all([lstat(path), handle.stat()]);
  if (!opened.isFile() || named.dev !== opened.dev || named.ino !== opened.ino) {
    throw new SkillAccessError("unsafe-path");
  }
  if (opened.size > MAX_SKILL_FILE_BYTES) throw new SkillAccessError("too-large");
}

async function readSkillFile(root: string, parts: readonly string[], signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const path = await checkedPath(root, parts);
  if (!(await lstat(path)).isFile()) throw new SkillAccessError("unsafe-path");
  // A regular file can be replaced between lstat and open; nonblocking mode also keeps a raced FIFO harmless.
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    await verifyHandle(root, parts, handle);
    const buffer = Buffer.alloc(MAX_SKILL_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      signal.throwIfAborted();
      const read = await handle.read(buffer, length, buffer.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > MAX_SKILL_FILE_BYTES) throw new SkillAccessError("too-large");
    await verifyHandle(root, parts, handle);
    signal.throwIfAborted();
    return buffer.subarray(0, length).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function listSkillFiles(root: string, signal: AbortSignal): Promise<string[]> {
  const files: string[] = [];
  const pending: string[][] = [[]];
  let bytes = 0;
  let directories = 0;
  while (pending.length) {
    signal.throwIfAborted();
    const parts = pending.pop()!;
    directories++;
    if (parts.length > MAX_SKILL_DIRECTORY_DEPTH || directories > MAX_SKILL_FILES) {
      throw new SkillAccessError("file-list-too-large");
    }
    const folder = await checkedPath(root, parts);
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const child = [...parts, entry.name];
      if (entry.isSymbolicLink() || isCredentialPath(child)) continue;
      if (entry.isDirectory()) {
        pending.push(child);
        if (pending.length > MAX_SKILL_FILES) throw new SkillAccessError("file-list-too-large");
      } else if (entry.isFile()) {
        const relative = child.join("/");
        files.push(relative);
        bytes += Buffer.byteLength(relative);
        if (files.length > MAX_SKILL_FILES || bytes > MAX_SKILL_LIST_BYTES) {
          throw new SkillAccessError("file-list-too-large");
        }
      }
    }
  }
  return files.sort();
}

function withoutFrontmatter(text: string): string {
  return text.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
}

/** Classification never throws on a malformed path: the path check in `execute` owns that refusal. */
function requestsCredential(args: unknown): boolean {
  const path = (args as { path?: unknown } | null)?.path;
  return typeof path === "string" && isCredentialPath(path.split(/[\\/]+/).filter(Boolean));
}

/** The admitted view is frozen by the caller at the turn boundary; all resource paths are rechecked at use time. */
export function createSkillTools(options: SkillToolsOptions): ToolDef[] {
  if (!options.skills.length) return [];
  const admitted = new Set(options.skills.map(skill => skill.entry.name));
  const execute = async (args: unknown, signal: AbortSignal, mode: "load" | "read") => {
    signal.throwIfAborted();
    const input = args as { name?: unknown; path?: unknown } | null;
    const name = input?.name;
    if (typeof name !== "string" || !SAFE_NAME.test(name) || !admitted.has(name)) {
      throw new SkillAccessError("skill-unavailable");
    }
    try {
      const parts = mode === "load" ? ["SKILL.md"] : relativeParts(input?.path);
      if (isCredentialPath(parts)) throw new SkillAccessError("secret-file");
      const root = await skillRoot(options.home, name);
      const text = await readSkillFile(root, parts, signal);
      if (mode === "read") return { name, path: parts.join("/"), text };
      const files = await listSkillFiles(root, signal);
      options.onLoad?.(name);
      return { name, text: withoutFrontmatter(text), files };
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof SkillAccessError) throw error;
      throw new SkillAccessError("unsafe-path");
    }
  };
  return (["load", "read"] as const).map(mode => ({
    name: `skill.${mode}`,
    description: mode === "load"
      ? "Load an available skill's instructions and relative resource file list. Follow the loaded workflow."
      : "Read one listed skill resource as text. Paths are relative to that skill; scripts are never executed.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: { name: { type: "string", minLength: 1, maxLength: 64 },
        ...(mode === "read" ? { path: { type: "string", minLength: 1, maxLength: 4096 } } : {}) },
      required: mode === "load" ? ["name"] : ["name", "path"],
    },
    capability: "fs.read", effect: "read", risk: "low", trust: "first-party",
    limits: { maxResultBytes: MAX_SKILL_RESULT_BYTES },
    discovery: { category: "general.chat", summary: `Read available skill ${mode === "load" ? "instructions" : "resources"}.`,
      useWhen: mode === "load" ? "An available skill matches the task." : "A loaded skill refers to a resource file.",
      notFor: "Executing scripts, reading other skills or bypassing agent visibility." },
    // The dispatcher refuses a deny-list hit before the tool runs, as it does for file.read; `execute` refuses it again.
    classify: args => ({ flags: { outsideRoots: false, denyListHit: mode === "read" && requestsCredential(args) } }),
    execute: async (args, context) => execute(args, context.signal, mode),
  }));
}
