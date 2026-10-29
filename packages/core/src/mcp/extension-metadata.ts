/** Read-only, bounded MCP metadata loading from the active versioned package tree (M-A4-v2, owner decision 5).
 * Runtime resolution never searches PATH, downloads an interpreter or executes installation hooks.
 */
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { extensionSecretName, type ExtensionSecretDefinition } from "../extensions/secret-env.ts";
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
  /** True only when the host actually bound this server to its resource-scoped OAuth provider. */
  oauthReady?: (name: string) => boolean;
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
  /** Authenticated templates and declared names only; credential values are leased separately at spawn. */
  setup?: ExtensionSecretDefinition;
  overlay?: "needs-setup" | "error";
  reason?: "auth-required";
  /** Authenticated resource binding remains available while OAuth awaits person interaction. */
  remote?: { url: string; auth: "none" | "header" | "oauth" };
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
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink()) throw Error("invalid MCP extension metadata file");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
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

function launchArgs(raw: unknown, payload: string, entry: string, setup: ExtensionSecretDefinition): string[] {
  if (raw === undefined) return [entry];
  if (!Array.isArray(raw) || raw.length > 256) throw Error("invalid MCP launch arguments");
  return raw.flatMap(arg => {
    if (typeof arg !== "string" || arg.length > 8192 || arg.includes("\0")) throw Error("invalid MCP launch argument");
    const multiple = /^\$\{user_config\.([^}]+)\}$/.exec(arg);
    if (multiple && !Object.hasOwn(setup.userConfigSlots ?? {}, multiple[1]!)) {
      const values = setup.userConfig?.[multiple[1]!];
      if (Array.isArray(values)) {
        if (values.length > 64 || values.some(value => !["string", "number", "boolean"].includes(typeof value))) {
          throw Error("invalid MCP multiple configuration values");
        }
        return values.map(value => String(value));
      }
    }
    const expanded = arg.replace(/\$\{([^}]+)\}/g, (_whole: string, key: string) => {
      if (key.startsWith("user_config.")) {
        const name = key.slice("user_config.".length);
        const slot = setup.userConfigSlots?.[name] ?? name;
        if (setup.slots.some(item => item.slot === slot)) throw Error("MCP secret arguments are forbidden");
        const value = setup.userConfig?.[name];
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
      } else if (setup.variables && Object.hasOwn(setup.variables, key)) return setup.variables[key]!;
      throw Error("MCP configuration needs setup");
    });
    if (expanded.includes("${")) throw Error("MCP configuration needs setup");
    return expanded;
  });
}

function secretSlots(capabilities: unknown): ExtensionSecretDefinition["slots"] {
  const raw = object(capabilities).secrets ?? [];
  if (!Array.isArray(raw) || raw.length > 256) throw Error("invalid extension secret slots");
  const seen = new Set<string>();
  return raw.map(item => {
    const value = object(item);
    if (typeof value.slot !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value.slot) ||
        typeof value.required !== "boolean" || seen.has(value.slot)) throw Error("invalid extension secret slots");
    seen.add(value.slot);
    return { slot: value.slot, required: value.required };
  });
}

async function localMetadata(name: string, manifest: ObjectValue, packageRoot: string) {
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
  const slots = secretSlots(manifest.capabilities);
  const userConfigSlots: Record<string, string> = Object.create(null) as Record<string, string>;
  const wrapperFile = object(manifest.files)["payload/.plur1bus/mcpb.json"];
  if (wrapperFile !== undefined) {
    const file = object(wrapperFile);
    if (typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) throw Error("invalid MCPB wrapper digest");
    const wrapper = await readJson(payload, join(payload, ".plur1bus", "mcpb.json"), MAX_METADATA_BYTES, file.sha256);
    if (wrapper.format !== 1) throw Error("unsupported MCPB wrapper metadata");
    for (const [key, slot] of Object.entries(object(wrapper.secretSlots))) {
      if (typeof slot !== "string" || !slots.some(item => item.slot === slot)) throw Error("invalid MCPB secret mapping");
      userConfigSlots[key] = slot;
    }
  }
  const userConfig: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, raw] of Object.entries(mcpb.user_config === undefined ? {} : object(mcpb.user_config))) {
    const value = object(raw);
    if (value.sensitive === true) {
      const slot = userConfigSlots[key] ?? key;
      if (!slots.some(item => item.slot === slot)) throw Error("MCPB secret slot is not declared");
      userConfigSlots[key] = slot;
    } else if (value.default !== undefined) userConfig[key] = value.default;
  }
  const base = server.mcp_config === undefined ? {} : object(server.mcp_config);
  const overrides = base.platform_overrides === undefined ? {} : object(base.platform_overrides);
  const selected = overrides[process.platform];
  const config = { ...base, ...(selected === undefined ? {} : object(selected)) };
  const rawEnv = config.env === undefined ? {} : object(config.env);
  if (Object.keys(rawEnv).length > 256 || Object.values(rawEnv).some(value => typeof value !== "string")) {
    throw Error("invalid MCPB environment templates");
  }
  const setup: ExtensionSecretDefinition = { name, slots, env: rawEnv as Record<string, string>,
    userConfigSlots: { ...userConfigSlots },
    userConfig, variables: { __dirname: payload, __filename: entry, pathSeparator: sep, "/": sep,
      HOME: homedir(), DOCUMENTS: join(homedir(), "Documents"), DESKTOP: join(homedir(), "Desktop"),
      DOWNLOADS: join(homedir(), "Downloads") } };
  return { payload, server, entry, config, setup };
}

async function localDefinition(name: string, manifest: ObjectValue, packageRoot: string,
  runtime: McpExtensionRuntime, metadata: Awaited<ReturnType<typeof localMetadata>>): Promise<McpServerDefinition | undefined> {
  const requirement = object(object(manifest.requires).runtime);
  if (requirement.type === "python" && !runtime.uv) return undefined;
  if (requirement.type === "node" && !runtimeMatches(process.versions.node, requirement.range)) return undefined;
  const { payload, server, entry, config, setup } = metadata;
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
  const args = requirement.type === "binary" && config.args === undefined ? [] : launchArgs(config.args, payload, entry, setup);
  return { name, scope: { kind: "installation" }, transport: { type: "stdio", command, args: [...prefix, ...args],
    cwd: packageRoot, env: {}, fromHost: [] }, trust: "untrusted", timeouts: { ...DEFAULT_TIMEOUTS } };
}

async function loadItem(mcpRoot: string, name: string, raw: unknown,
  runtime: McpExtensionRuntime, availableSecrets?: ReadonlySet<string>): Promise<InstalledMcpExtension> {
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
  const slots = secretSlots(manifest.capabilities);
  const base = { name, activeVersion, manifestSha256: record.manifestSha256, declaration: declared };
  const setup: ExtensionSecretDefinition = { name, slots };
  // A13 imports no local code or command. Its inert placeholder stays held even after an explicit enable request.
  if (record.trust === "imported" && manifest.remote == null) return { ...base, setup, overlay: "needs-setup" };
  const missing = slots.some(item => item.required && !availableSecrets?.has(extensionSecretName(name, item.slot)));
  let definition: McpServerDefinition | undefined;
  if (manifest.remote !== null && manifest.remote !== undefined) {
    const remote = object(manifest.remote);
    if (typeof remote.url !== "string" || !["none", "header", "oauth"].includes(String(remote.auth))) {
      throw Error("invalid remote MCP endpoint");
    }
    const url = new URL(remote.url);
    if (url.username || url.password || url.hash) throw Error("invalid remote MCP URL");
    const binding = { url: url.toString(), auth: remote.auth as "none" | "header" | "oauth" };
    const required = slots.filter(item => item.required);
    if (missing || (remote.auth === "header" && required.length !== 1)) {
      return { ...base, setup, remote: binding, overlay: "needs-setup" };
    }
    if (remote.auth === "oauth" && runtime.oauthReady?.(name) !== true) {
      return { ...base, setup, remote: binding, overlay: "error", reason: "auth-required" };
    }
    definition = { name, scope: { kind: "installation" }, transport: { type: "http", url: url.toString(), headers: {} },
      ...(remote.auth === "header" ? { authSecret: extensionSecretName(name, required[0]!.slot) } : {}),
      trust: "untrusted", timeouts: { ...DEFAULT_TIMEOUTS } };
    return { ...base, setup, remote: binding, definition };
  } else {
    const local = await localMetadata(name, manifest, packageRoot);
    if (missing) return { ...base, setup: local.setup, overlay: "needs-setup" };
    definition = await localDefinition(name, manifest, packageRoot, runtime, local);
    return { ...base, setup: local.setup, ...(definition ? { definition } : { overlay: "needs-setup" as const }) };
  }
}

/** Read installed records only. A malformed item is held back independently; malformed state refuses the whole snapshot. */
export async function installedMcpExtensions(home: string, runtime: McpExtensionRuntime = {},
  availableSecrets?: ReadonlySet<string>): Promise<InstalledMcpExtension[]> {
  const root = await realpath(home);
  let state: ObjectValue;
  try { state = await readJson(root, join(root, "extensions", "state.json"), MAX_STATE_BYTES); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (state.schemaVersion !== 1) throw Error("unsupported extension state version");
  const items = Object.entries(object(state.items)).filter(([, raw]) => {
    const item = object(raw);
    return item.kind === "mcp-server" && item.removedByUser !== true;
  });
  if (items.length > MAX_ITEMS) throw Error("too many installed MCP extensions");
  if (!items.length) return [];
  const mcpRoot = await contained(root, join(root, "mcp"));
  const result: InstalledMcpExtension[] = [];
  for (const [name, raw] of items) {
    const item = object(raw);
    if (item.kind !== "mcp-server" || item.removedByUser === true) continue;
    if (!NAME.test(name)) throw Error("invalid installed MCP extension name");
    try { result.push(await loadItem(mcpRoot, name, item, runtime, availableSecrets)); }
    catch { result.push({ name, overlay: "error" }); }
  }
  return result;
}

/** Declared slots for setup, across every installed kind; MCP launch templates also require authenticated payloads. */
export async function installedExtensionSecretDefinition(home: string, name: string):
  Promise<ExtensionSecretDefinition | undefined> {
  extensionSecretName(name, "validation");
  const root = await realpath(home);
  let state: ObjectValue;
  try { state = await readJson(root, join(root, "extensions", "state.json"), MAX_STATE_BYTES); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (state.schemaVersion !== 1) throw Error("unsupported extension state version");
  const raw = object(state.items)[name];
  if (raw === undefined) return undefined;
  const record = object(raw);
  if (record.name !== name || record.removedByUser === true) return undefined;
  const slots = secretSlots(record.capabilities);
  if (record.kind !== "mcp-server") return { name, slots };
  const mcpRoot = await contained(root, join(root, "mcp"));
  return (await loadItem(mcpRoot, name, record, {})).setup;
}

/** Recheck the approved active tree at each spawn; cached supervisor overlays never authenticate executable bytes. */
export async function verifyInstalledMcpPayload(home: string, expected: InstalledMcpExtension,
  signal?: AbortSignal): Promise<void> {
  const checkAbort = () => { if (signal?.aborted) throw Error("MCP payload verification aborted"); };
  checkAbort();
  if (!NAME.test(expected.name) || !expected.activeVersion || !VERSION.test(expected.activeVersion) ||
      !expected.manifestSha256 || !/^[a-f0-9]{64}$/.test(expected.manifestSha256)) {
    throw Error("MCP payload has no approved registration");
  }
  const root = await realpath(home);
  // Reject directory links as well as file links, including links which remain inside the package.
  const directory = async (path: string) => {
    if (!within(root, path)) throw Error("invalid MCP payload directory");
    let current = root;
    for (const component of relative(root, path).split(sep).filter(Boolean)) {
      current = join(current, component);
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(current) !== current) {
        throw Error("invalid MCP payload directory");
      }
    }
  };
  const approvedRecord = async () => {
    await directory(join(root, "extensions"));
    const state = await readJson(root, join(root, "extensions", "state.json"), MAX_STATE_BYTES);
    const record = object(object(state.items)[expected.name]);
    if (state.schemaVersion !== 1 || record.kind !== "mcp-server" || record.name !== expected.name ||
        record.removedByUser === true || record.activeVersion !== expected.activeVersion ||
        record.version !== expected.activeVersion || record.manifestSha256 !== expected.manifestSha256 ||
        (record.integrity && object(record.integrity).ok !== true)) throw Error("MCP approval changed before launch");
    return record;
  };
  const record = await approvedRecord();
  const packageRoot = join(root, "mcp", expected.name, expected.activeVersion);
  await directory(join(packageRoot, "payload"));
  const manifest = await readJson(packageRoot, join(packageRoot, "p1x.json"), MAX_METADATA_BYTES,
    expected.manifestSha256);
  if (manifest.id !== record.id || manifest.name !== expected.name || manifest.kind !== "mcp-server" ||
      manifest.version !== expected.activeVersion) throw Error("MCP package approval mismatch");
  const files = object(manifest.files);
  const entries = Object.entries(files);
  if (!entries.length || entries.length > 20_000) throw Error("MCP payload file limit exceeded");
  let total = 0;
  for (const [path, raw] of entries) {
    checkAbort();
    const components = path.split("/");
    const file = object(raw);
    if (components[0] !== "payload" || components.length < 2 || components.length > 16 ||
        Buffer.byteLength(path) > 240 || components.some(part => !part || part === "." || part === ".." ||
          /[\\\u0000-\u001f\u007f:]/.test(part)) || typeof file.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) ||
        (file.size as number) < 0 || (file.size as number) > 128 * 1024 * 1024 ||
        (file.exec !== undefined && typeof file.exec !== "boolean")) throw Error("invalid approved MCP payload file");
    total += file.size as number;
    if (total > 256 * 1024 * 1024) throw Error("MCP payload byte limit exceeded");
    const local = join(packageRoot, ...components);
    await directory(join(local, ".."));
    const handle = await open(local, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size !== file.size ||
          (process.platform !== "win32" && Boolean(before.mode & 0o111) !== (file.exec === true))) {
        throw Error("MCP payload type, size or mode changed");
      }
      const hash = createHash("sha256");
      const chunk = Buffer.alloc(64 * 1024);
      let read = 0;
      for (;;) {
        checkAbort();
        const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, before.size - read + 1), read);
        if (!bytesRead) break;
        read += bytesRead;
        if (read > before.size) throw Error("MCP payload grew while verifying");
        hash.update(chunk.subarray(0, bytesRead));
      }
      const after = await handle.stat();
      const current = await lstat(local);
      if (read !== file.size || hash.digest("hex") !== file.sha256 || !current.isFile() ||
          [after, current].some(info => info.dev !== before.dev || info.ino !== before.ino ||
            info.size !== before.size || info.mtimeMs !== before.mtimeMs || info.ctimeMs !== before.ctimeMs ||
            info.mode !== before.mode)) throw Error("MCP payload changed while verifying");
    } finally { await handle.close(); }
  }
  // The entry must be part of the approved file inventory, rather than just an existing contained path.
  const local = await localMetadata(expected.name, manifest, packageRoot);
  if (!Object.hasOwn(files, relative(packageRoot, local.entry).split(sep).join("/"))) {
    throw Error("MCP entry has no approved payload digest");
  }
  await directory(join(packageRoot, "payload"));
  await approvedRecord();
  checkAbort();
}
