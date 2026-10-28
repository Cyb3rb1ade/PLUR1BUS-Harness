/** Read-only, bounded MCP metadata loading from the active versioned package tree (M-A4-v2, owner decision 5).
 * Runtime resolution never searches PATH, downloads an interpreter or executes installation hooks.
 */
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { McpServerDefinition } from "./types.ts";
import { DEFAULT_TIMEOUTS } from "./types.ts";

const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_ITEMS = 4096;
const NAME = /^[a-z0-9][a-z0-9-]{0,127}$/;
const VERSION = new RegExp(
  "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)" +
  "(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?" +
  "(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$",
);
type ObjectValue = Record<string, unknown>;

/** Manifest disclosure carried into the D109 bridge; server annotations can only raise these effects (M-A6). */
export interface McpExtensionDeclaration {
  tools: readonly { name: string; effect: "read" | "write" | "destructive" }[];
  network: "none" | "declared";
}

/** Trusted runtime resolver result. The host supplies a pinned uv and an already provisioned Python; never PATH. */
export interface McpExtensionRuntime {
  uv?: { command: string; version: string; python: string; pythonVersion: string };
}

/** One verified installed record and its current launch definition, or the overlay that prevents launching it. */
export interface InstalledMcpExtension {
  name: string;
  /** One installation-wide version; retained and reserved per-agent versions never choose the executable tree. */
  activeVersion?: string;
  /** Digest recorded by the verified installer, also binds code updates to a fresh registration generation. */
  manifestSha256?: string;
  definition?: McpServerDefinition;
  declaration?: McpExtensionDeclaration;
  overlay?: "needs-setup" | "error";
}

function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("invalid MCP extension metadata");
  return value as ObjectValue;
}

function within(root: string, path: string): boolean {
  const local = relative(root, path);
  return local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local);
}

async function contained(root: string, path: string): Promise<string> {
  const canonical = await realpath(path);
  if (!within(root, canonical)) throw Error("MCP extension path escapes its package");
  return canonical;
}

async function readJson(root: string, path: string, maxBytes: number, expectedSha256?: string): Promise<ObjectValue> {
  await contained(root, path);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) throw Error("MCP extension metadata exceeds its limit");
    // Read at most max+1 even if an external writer grows the file after stat.
    const bytes = Buffer.alloc(Math.min(info.size + 1, maxBytes + 1));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > maxBytes || bytesRead > info.size) throw Error("MCP extension metadata changed while reading");
    const content = bytes.subarray(0, bytesRead);
    if (expectedSha256 && createHash("sha256").update(content).digest("hex") !== expectedSha256) {
      throw Error("installed MCP manifest does not match its approved package");
    }
    return object(JSON.parse(content.toString("utf8")));
  } finally { await handle.close(); }
}

function declaration(raw: unknown): McpExtensionDeclaration {
  const capabilities = object(raw);
  const tools = capabilities.tools ?? [];
  if (!Array.isArray(tools) || tools.length > MAX_ITEMS) throw Error("invalid MCP tool declarations");
  return {
    network: object(capabilities.network).mode === "none" ? "none" : "declared",
    tools: tools.map(rawTool => {
      const tool = object(rawTool);
      if (typeof tool.name !== "string" || tool.name.length > 256 ||
          !["read", "write", "destructive"].includes(String(tool.effect))) throw Error("invalid MCP tool declaration");
      return { name: tool.name, effect: tool.effect as "read" | "write" | "destructive" };
    }),
  };
}

function versionTuple(value: string): number[] | undefined {
  return /^\d+(?:\.\d+){0,2}$/.test(value) ? value.split(".").map(Number) : undefined;
}

function compareVersion(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

/** Numeric runtime constraints only: unsupported range syntax fails closed and requires host runtime setup. */
function runtimeMatches(version: string, range: unknown): boolean {
  const current = versionTuple(version.replace(/^v/, ""));
  if (!current || typeof range !== "string" || !range.length || range.length > 200) return false;
  return range.split("||").some(branch => branch.trim().split(/\s+/).every(term => {
    const match = /^(>=|<=|>|<|=|\^|~)?(\d+(?:\.\d+){0,2})$/.exec(term);
    if (!match) return false;
    const wanted = versionTuple(match[2]!)!;
    const order = compareVersion(current, wanted);
    switch (match[1]) {
      case ">=": return order >= 0;
      case "<=": return order <= 0;
      case ">": return order > 0;
      case "<": return order < 0;
      case "^": return order >= 0 && current[0] === wanted[0] &&
        (wanted[0] !== 0 || current[1] === (wanted[1] ?? 0));
      case "~": return order >= 0 && current[0] === wanted[0] &&
        (wanted.length < 2 || current[1] === wanted[1]);
      case "=": return order === 0;
      default: return wanted.every((n, index) => current[index] === n);
    }
  }));
}

async function executable(path: string): Promise<string> {
  if (!isAbsolute(path) || !(await stat(path)).isFile()) throw Error("pinned MCP runtime is unavailable");
  return path;
}

function launchArgs(raw: unknown, payload: string, entry: string): string[] {
  if (raw === undefined) return [entry];
  if (!Array.isArray(raw) || raw.length > 256) throw Error("invalid MCP launch arguments");
  return raw.map(arg => {
    if (typeof arg !== "string" || arg.length > 8192 || arg.includes("\0")) throw Error("invalid MCP launch argument");
    const expanded = arg.replaceAll("${__dirname}", payload).replaceAll("${__filename}", entry);
    if (expanded.includes("${")) throw Error("MCP configuration needs setup");
    return expanded;
  });
}

async function localDefinition(name: string, manifest: ObjectValue, packageRoot: string,
  runtime: McpExtensionRuntime): Promise<McpServerDefinition | undefined> {
  const requirement = object(object(manifest.requires).runtime);
  if (requirement.type === "python" && !runtime.uv) return undefined;
  if (requirement.type === "node" && !runtimeMatches(process.versions.node, requirement.range)) return undefined;
  const payload = await contained(packageRoot, join(packageRoot, "payload"));
  const metadataFile = object(object(manifest.files)["payload/manifest.json"]);
  if (typeof metadataFile.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(metadataFile.sha256)) {
    throw Error("MCP bundle manifest has no approved digest");
  }
  const mcpb = await readJson(payload, join(payload, "manifest.json"), MAX_METADATA_BYTES, metadataFile.sha256);
  const server = object(mcpb.server);
  if (typeof server.entry_point !== "string" || !server.entry_point.length || isAbsolute(server.entry_point) ||
      server.entry_point.startsWith("-")) throw Error("invalid MCP entry point");
  const entry = await contained(payload, resolve(payload, server.entry_point));
  let command: string;
  let prefix: string[] = [];
  switch (requirement.type) {
    case "node":
      if (server.type !== "node") throw Error("MCP runtime and server type disagree");
      command = await executable(process.execPath);
      break;
    case "python": {
      const uv = runtime.uv!;
      if (requirement.via !== "uv" || !runtimeMatches(uv.pythonVersion, requirement.range)) return undefined;
      if (server.type !== "python" && server.type !== "uv") throw Error("MCP runtime and server type disagree");
      command = await executable(uv.command);
      const python = await executable(uv.python);
      if (typeof requirement.lock !== "string" || !requirement.lock.startsWith("payload/")) return undefined;
      await contained(packageRoot, join(packageRoot, requirement.lock));
      // D58: no runtime installation or unconstrained dependency resolution from a package start.
      prefix = ["run", "--project", payload, "--frozen", "--offline", "--no-python-downloads", "--python", python];
      break;
    }
    case "binary":
      if (server.type !== "binary") throw Error("MCP runtime and server type disagree");
      command = await executable(entry);
      break;
    default: return undefined;
  }
  const config = server.mcp_config === undefined ? {} : object(server.mcp_config);
  // A7 supplies declared secret/config interpolation through trusted ports; never copy package env or ambient keys.
  if (config.env && Object.keys(object(config.env)).length) return undefined;
  const args = requirement.type === "binary" && config.args === undefined ? [] : launchArgs(config.args, payload, entry);
  return { name, scope: { kind: "installation" }, transport: { type: "stdio", command, args: [...prefix, ...args],
    cwd: packageRoot, env: {}, fromHost: [] }, trust: "untrusted", timeouts: { ...DEFAULT_TIMEOUTS } };
}

async function loadItem(mcpRoot: string, name: string, raw: unknown,
  runtime: McpExtensionRuntime): Promise<InstalledMcpExtension> {
  const record = object(raw);
  if (record.integrity && object(record.integrity).ok !== true) throw Error("installed MCP integrity failed");
  if (typeof record.manifestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.manifestSha256)) {
    throw Error("installed MCP manifest has no approved digest");
  }
  const activeVersion = record.activeVersion;
  if (typeof activeVersion !== "string" || activeVersion.length > 200 || !VERSION.test(activeVersion) ||
      record.version !== activeVersion) throw Error("invalid active MCP version");
  const nameRoot = await contained(mcpRoot, join(mcpRoot, name));
  const packageRoot = await contained(nameRoot, join(nameRoot, activeVersion));
  const manifest = await readJson(packageRoot, join(packageRoot, "p1x.json"), MAX_METADATA_BYTES, record.manifestSha256);
  if (manifest.kind !== "mcp-server" || manifest.name !== name || record.name !== name ||
      manifest.id !== record.id || manifest.version !== record.version) throw Error("installed MCP record mismatch");
  const declared = declaration(manifest.capabilities);
  const slots = object(manifest.capabilities).secrets ?? [];
  if (!Array.isArray(slots)) throw Error("invalid MCP secret slots");
  if (slots.some(slot => object(slot).required === true)) return { name, overlay: "needs-setup", declaration: declared };
  let definition: McpServerDefinition | undefined;
  if (manifest.remote !== null && manifest.remote !== undefined) {
    const remote = object(manifest.remote);
    if (remote.auth !== "none") return { name, overlay: "needs-setup", declaration: declared };
    if (typeof remote.url !== "string") throw Error("invalid remote MCP URL");
    const url = new URL(remote.url);
    if (url.username || url.password || url.hash) throw Error("invalid remote MCP URL");
    definition = { name, scope: { kind: "installation" }, transport: { type: "http", url: url.toString(), headers: {} },
      trust: "untrusted", timeouts: { ...DEFAULT_TIMEOUTS } };
  } else definition = await localDefinition(name, manifest, packageRoot, runtime);
  return { name, activeVersion, manifestSha256: record.manifestSha256, declaration: declared,
    ...(definition ? { definition } : { overlay: "needs-setup" as const }) };
}

/** Read installed records only. A malformed item is held back independently; malformed state refuses the whole snapshot. */
export async function installedMcpExtensions(home: string, runtime: McpExtensionRuntime = {}): Promise<InstalledMcpExtension[]> {
  const root = await realpath(home);
  let state: ObjectValue;
  try { state = await readJson(root, join(root, "extensions", "state.json"), MAX_STATE_BYTES); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (state.schemaVersion !== 1) throw Error("unsupported extension state version");
  const items = Object.entries(object(state.items));
  if (items.length > MAX_ITEMS) throw Error("too many installed MCP extensions");
  const mcpRoot = await contained(root, join(root, "mcp"));
  const result: InstalledMcpExtension[] = [];
  for (const [name, raw] of items) {
    const item = object(raw);
    if (item.kind !== "mcp-server" || item.removedByUser === true) continue;
    if (!NAME.test(name)) throw Error("invalid installed MCP extension name");
    try { result.push(await loadItem(mcpRoot, name, item, runtime)); }
    catch { result.push({ name, overlay: "error" }); }
  }
  return result;
}
