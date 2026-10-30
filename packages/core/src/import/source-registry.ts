/** Durable GUI source capabilities own sealed local snapshots; remote sessions close before any maintenance stop. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix, relative, sep, win32 } from "node:path";
import { createLocalFs, RemoteFsError, type ReadonlyFs, type SftpSession } from "@plur1bus/remote-fs";
import { validateParams, type ImportDetection, type ImportDiscovery, type ImportSource } from "@plur1bus/rpc-schema";
import type { Principal } from "../rbac/types.ts";
import { maintenanceRunDirectory } from "./maintenance-journal.ts";
import { privateBytes, readColdBytes, relativePath } from "./maintenance-files.ts";
import { createSnapshot, type SnapshotMetadata } from "./snapshot.ts";
import { claimImportSnapshot } from "./snapshot-upload.ts";
import { verifySourceSnapshot } from "./snapshot-source.ts";
import { readSource } from "./source.ts";
import { resolveOpenclawRoot } from "./sources/openclaw.ts";
import { resolveHermesRoot } from "./sources/hermes.ts";
import { listWslDistros, type WslDistro } from "./wsl.ts";
import { locateSource } from "./paths.ts";
import { SourceReader, type SourceReaderOptions } from "./source-reader.ts";
import { sourceView } from "./source-view.ts";
import { isImportSecretName } from "./source-secrets.ts";
import { parseJson5 } from "./json5.ts";
import { ImportError, isSourceType, type SourceType } from "./types.ts";
import { discoverReaderSources } from "./reader-discovery.ts";
import { createMappedSnapshot } from "./mapped-snapshot.ts";

const TTL_MS = 24 * 60 * 60 * 1000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$(?![\s\S])/;
const HASH = /^[a-f0-9]{64}$(?![\s\S])/;
const SNAPSHOT = /^[A-Za-z0-9_-]{43}$(?![\s\S])/;
const unavailable = () => new ImportError("E_NOT_AVAILABLE", "source-unavailable", "Import source is unavailable");

interface SshSources {
  listConnections(principal: Principal | null): Promise<{ connections: readonly { id: string; roots: readonly string[] }[] }>;
  open(id: string, root: string, principal: Principal | null, signal?: AbortSignal): Promise<SftpSession>;
}
export interface SourceRecord {
  schema: "import.source/1";
  id: string;
  ownerId: string;
  sourceType: SourceType;
  snapshotId: string;
  sourceSha256: string;
  selection: ImportSource;
  maps?: { from: string; to: string }[];
  sourceSnapshots?: { id: string; sha256: string }[];
  createdAt: string;
  expiresAt: string;
}
export interface SourceRegistryOptions {
  home: string;
  ssh?: SshSources;
  now?: () => number;
  /** Native WSL metadata and a root-confined UNC filesystem; never a shell/exec source port. */
  wsl?: { list(): Promise<WslDistro[]>; open(root: string, signal?: AbortSignal): Promise<ReadonlyFs> };
  /** Trusted host boundary for automatic discovery only; never accepted from a public source descriptor. */
  localDiscovery?: { home: string; open(root: string, signal?: AbortSignal): Promise<ReadonlyFs> };
}
interface OpenSource { source: string; reader: SourceReaderOptions; close(): Promise<void> }
type SourceAuthority = ImportSource | { kind: "local-discovery"; root: string };
const windowsPath = (path: string) => /^(?:[A-Za-z]:[\\/]|\\\\)/.test(path);

/** Translate a discovered POSIX view back through the original host authority, including native Windows drives. */
function physicalSelection(opened: OpenSource, view: OpenSource, authority: SourceAuthority, path: string): string {
  if (authority.kind !== "wsl" && !(authority.kind === "local-discovery" && windowsPath(opened.source))) return path;
  const P = authority.kind === "local-discovery" ? win32 : new SourceReader(opened.reader).paths;
  return P.join(opened.source, ...posix.relative(view.source, path).split("/"));
}

/** Known POSIX discovery locations retain their confined UNC or native drive authority through this view. */
function discoverySource(opened: OpenSource, source: SourceAuthority): OpenSource {
  if (source.kind !== "wsl" && !(source.kind === "local-discovery" && windowsPath(opened.source))) return opened;
  const P = source.kind === "local-discovery" ? win32 : new SourceReader(opened.reader).paths;
  const root = source.kind === "wsl" ? posix.resolve(source.path) : "/";
  const physical = (path: string) => {
    const delta = posix.relative(root, posix.resolve(root, path));
    if (delta === ".." || delta.startsWith("../") || posix.isAbsolute(delta)) throw unavailable();
    return P.join(opened.source, ...delta.split("/"));
  };
  const virtual = (path: string) => {
    const delta = P.relative(opened.source, path);
    if (delta === ".." || delta.startsWith(".." + P.sep) || P.isAbsolute(delta)) throw unavailable();
    return posix.join(root, ...delta.split(P.sep));
  };
  const fs = opened.reader.fs;
  return { source: root, close: opened.close, reader: { root, remote: true, fs: Object.freeze({
    stat: (path: string) => fs.stat(physical(path)), lstat: (path: string) => fs.lstat(physical(path)),
    readdir: (path: string) => fs.readdir(physical(path)), readFile: (path: string, max: number) => fs.readFile(physical(path), max),
    realpath: async (path: string) => virtual(await fs.realpath(physical(path))),
    readlink: async (path: string) => {
      const target = await fs.readlink(physical(path));
      return P.isAbsolute(target) ? virtual(target) : target.split(P.sep).join("/");
    },
  }) } };
}

function person(principal: Principal): void {
  if (principal.kind !== "person" || !["owner", "admin"].includes(principal.role)) {
    throw new ImportError("E_DENIED", "import-person-required", "Import requires a human administrator");
  }
}

function selection(value: ImportSource): SourceType {
  if (!validateParams("admin.import.detect", { source: value }).ok || !isSourceType(value.family)) {
    throw new ImportError("E_INVALID_PARAMS", "source-family-invalid", "Import source is invalid");
  }
  return value.family;
}

function record(value: unknown, id: string, principal: Principal): SourceRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  const raw = value as SourceRecord;
  if (Object.keys(raw).some(key => !["schema", "id", "ownerId", "sourceType", "snapshotId", "sourceSha256",
    "selection", "maps", "sourceSnapshots", "createdAt", "expiresAt"].includes(key)) || raw.schema !== "import.source/1" || raw.id !== id
    || raw.ownerId !== principal.userId || !isSourceType(raw.sourceType) || !SNAPSHOT.test(raw.snapshotId)
    || !HASH.test(raw.sourceSha256) || selection(raw.selection) !== raw.sourceType
    || !Number.isFinite(Date.parse(raw.createdAt)) || !Number.isFinite(Date.parse(raw.expiresAt))) throw unavailable();
  if (raw.maps !== undefined && (!Array.isArray(raw.maps) || raw.maps.length > 64
    || raw.maps.some(mapping => !mapping || typeof mapping.from !== "string" || !mapping.from
      || typeof mapping.to !== "string" || !relativePath(mapping.to)))) throw unavailable();
  if (raw.sourceSnapshots !== undefined && (!Array.isArray(raw.sourceSnapshots) || raw.sourceSnapshots.length > 64
    || raw.sourceSnapshots.some(item => !item || typeof item.id !== "string" || !SNAPSHOT.test(item.id)
      || typeof item.sha256 !== "string" || !HASH.test(item.sha256)))) throw unavailable();
  return raw;
}

async function localReader(root: string, signal?: AbortSignal): Promise<SourceReaderOptions> {
  const fs = await createLocalFs({ root, limits: { timeoutMs: 600_000,
    maxFileBytes: 512 * 1024 * 1024, maxTotalBytes: 1024 ** 3, maxEntries: 100_000 },
  ...(signal ? { signal } : {}) });
  return { root: await fs.realpath("."), fs };
}

async function channels(read: Awaited<ReturnType<typeof readSource>>, reader: SourceReader): Promise<number> {
  if (read.report.sourceType === "openclaw" && read.report.source.configPath) {
    const decoded: unknown = parseJson5(await reader.text(read.report.source.configPath, 16 * 1024 * 1024));
    const config = decoded && typeof decoded === "object" ? decoded as Record<string, unknown> : {};
    return config.channels && typeof config.channels === "object" ? Object.keys(config.channels).length : 0;
  }
  const names = new Set<string>();
  for (const agent of read.report.agents) {
    if (!agent.workspace) continue;
    const directory = reader.paths.join(agent.workspace, "platforms", "pairing");
    for (const name of await reader.names(directory)) if (name.endsWith("-approved.json")) names.add(name);
  }
  return names.size;
}

export function createSourceRegistry(options: SourceRegistryOptions) {
  const now = options.now ?? Date.now;
  const discovered = new Map<string, { source: ImportSource; authority: SourceAuthority; path: string; ownerId: string; expiresAt: number }>();
  const stores = new Map<string, { authority: SourceAuthority; path: string; ownerId: string; expiresAt: number }>();
  const storeFor = (to: string, principal: Principal) => {
    const id = to.startsWith("store:") ? to.slice(6) : "";
    const found = UUID.test(id) ? stores.get(id) : undefined;
    return found?.ownerId === principal.userId && found.expiresAt > now() ? found : undefined;
  };
  const descriptor = (source: ImportSource, ownerId: string) => createHash("sha256")
    .update(JSON.stringify([ownerId, Object.entries(source).sort(([a], [b]) => a.localeCompare(b))])).digest("hex");
  const file = (id: string) => {
    if (!UUID.test(id)) throw unavailable();
    return join(maintenanceRunDirectory(options.home, "sources"), id + ".json");
  };
  const openAuthority = async (source: SourceAuthority, principal: Principal, signal?: AbortSignal): Promise<OpenSource> => {
    if (source.kind === "local-discovery") {
      const fs = options.localDiscovery ? await options.localDiscovery.open(source.root, signal) : undefined;
      const reader = fs ? { root: await fs.realpath("."), fs } : await localReader(source.root, signal);
      return { source: reader.root, reader, close: async () => {} };
    }
    const family = selection(source);
    if (source.kind === "snapshot") throw unavailable();
    if (source.kind === "ssh") {
      if (!options.ssh) throw unavailable();
      const connection = (await options.ssh.listConnections(principal)).connections.find(item => item.id === source.connectionId);
      const authority = connection?.roots.filter(root => source.path === root
        || source.path.startsWith(root.endsWith("/") ? root : root + "/"))
        .sort((a, b) => b.length - a.length)[0];
      if (!authority) throw unavailable();
      const session = await options.ssh.open(source.connectionId, authority, principal, signal);
      try {
        const reader = { fs: session.fs, root: authority, remote: true };
        const selected = await new SourceReader(reader).select(source.path);
        return { source: selected, reader, close: () => session.close() };
      } catch (error) {
        await session.close();
        throw error;
      }
    }
    if (source.kind === "wsl") {
      const distro = (await (options.wsl?.list() ?? listWslDistros())).find(item => item.name === source.distro);
      if (!distro || distro.state === "Stopped" && !source.probeStopped) {
        throw new ImportError("E_DENIED", "wsl-probe-required", "WSL probing requires consent");
      }
      const location = locateSource({ accessRoot: `wsl:${source.distro}:${source.path}`, platform: process.platform,
        env: process.env, home: homedir(), harnessHome: options.home, skipSnapshotCheck: true }).accessRoot;
      const path = process.platform === "win32" ? location : location.replaceAll("\\", "/");
      const reader = options.wsl ? { root: path, fs: await options.wsl.open(path, signal) } : await localReader(path, signal);
      return { source: path, reader, close: async () => {} };
    }
    const given = source.kind === "path" ? source.path : undefined;
    const resolved = family === "openclaw" ? resolveOpenclawRoot({ source: given, env: process.env, homedir: homedir() })
      : resolveHermesRoot({ source: given, env: process.env, homedir: homedir() });
    return { source: resolved.root, reader: await localReader(resolved.root, signal), close: async () => {} };
  };
  const open = async (source: ImportSource, principal: Principal, signal?: AbortSignal): Promise<OpenSource> => {
    const prior = discovered.get(descriptor(source, principal.userId));
    if (!prior || prior.expiresAt <= now()) return openAuthority(source, principal, signal);
    const opened = await openAuthority(prior.authority, principal, signal);
    try {
      const view = discoverySource(opened, prior.authority);
      const selected = await new SourceReader(view.reader).select(prior.path);
      if (selected !== prior.path) throw unavailable();
      return { ...opened, source: physicalSelection(opened, view, prior.authority, selected) };
    } catch (error) { await opened.close(); throw error; }
  };
  const get = async (id: string, principal: Principal, allowExpired = false) => {
    person(principal);
    const saved = record(JSON.parse((await readColdBytes(file(id), 64 * 1024)).toString("utf8")), id, principal);
    if (!allowExpired && Date.parse(saved.expiresAt) <= now()) throw unavailable();
    const root = join(options.home, "import", saved.snapshotId, "snapshot");
    if (!verifySourceSnapshot(root, options.home)) throw unavailable();
    const bytes = await readColdBytes(join(root, "snapshot.json"), 8 * 1024 * 1024);
    if (createHash("sha256").update(bytes).digest("hex") !== saved.sourceSha256) throw unavailable();
    const metadata = JSON.parse(bytes.toString("utf8")) as SnapshotMetadata;
    const reader = await localReader(root);
    const read = await readSource({ sourceType: saved.sourceType, source: root, home: options.home, reader,
      ...(saved.maps ? { maps: saved.maps.map(mapping => ({ from: mapping.from, to: join(root, mapping.to) })) } : {}),
      ...("profile" in saved.selection && saved.selection.profile ? { profile: saved.selection.profile } : {}) });
    const view = sourceView({ sourceId: id, sourceType: saved.sourceType, sourceSha256: saved.sourceSha256,
      expiresAt: saved.expiresAt, root, read, metadata, channels: await channels(read, new SourceReader(reader)) });
    return { record: saved, root, read, metadata, view, reader };
  };
  return {
    get,
    async map(id: string, maps: readonly { from: string; to: string }[], principal: Principal, signal?: AbortSignal) {
      person(principal);
      const source = await get(id, principal);
      const sessions: OpenSource[] = [];
      let resolved;
      try {
        const entries = [];
        for (const mapping of maps) {
          if (!mapping.to.startsWith("store:")) { entries.push(mapping); continue; }
          const found = storeFor(mapping.to, principal);
          if (!found) throw unavailable();
          const opened = discoverySource(await openAuthority(found.authority, principal, signal), found.authority);
          sessions.push(opened);
          const selected = await new SourceReader(opened.reader).select(found.path);
          if (selected !== found.path) throw unavailable();
          entries.push({ from: mapping.from, to: selected, reader: opened.reader });
        }
        resolved = await createMappedSnapshot({ home: options.home, source, maps: entries, ...(signal ? { signal } : {}) });
      } finally { await Promise.allSettled(sessions.map(session => session.close())); }
      const mapped = resolved;
      let kept = false;
      try {
        const saved: SourceRecord = { ...source.record, id: randomUUID(), snapshotId: mapped.snapshotId,
          sourceSnapshots: [...source.record.sourceSnapshots ?? [], { id: source.record.snapshotId, sha256: source.record.sourceSha256 }],
          sourceSha256: mapped.sha256, maps: mapped.maps, createdAt: new Date(now()).toISOString(),
          expiresAt: new Date(now() + TTL_MS).toISOString() };
        await privateBytes(file(saved.id), Buffer.from(JSON.stringify(saved) + "\n"));
        const captured = await get(saved.id, principal);
        kept = true;
        return { source: captured, maps: mapped.maps.map(mapping => ({ from: mapping.from, to: join(mapped.root, mapping.to) })) };
      } finally {
        if (!kept) await rm(join(options.home, "import", mapped.snapshotId), { recursive: true, force: true });
      }
    },
    approves(source: ImportSource, principal: Principal): boolean {
      const prior = discovered.get(descriptor(source, principal.userId));
      return !!prior && prior.ownerId === principal.userId && prior.expiresAt > now();
    },
    approvesMaps(maps: readonly { from: string; to: string }[], principal: Principal): boolean {
      return maps.length > 0 && maps.every(mapping => !!storeFor(mapping.to, principal));
    },
    async approvesDiscoveryRoot(source: ImportSource, principal: Principal): Promise<boolean> {
      person(principal);
      selection(source);
      if (source.kind !== "ssh" || !options.ssh) return false;
      const connection = (await options.ssh.listConnections(principal)).connections.find(item => item.id === source.connectionId);
      return connection?.roots.includes(source.path) ?? false;
    },
    async discover(source: ImportSource, principal: Principal, signal?: AbortSignal): Promise<ImportDiscovery> {
      person(principal);
      selection(source);
      if (source.kind === "snapshot") throw unavailable();
      let authority: SourceAuthority = source;
      let hostHome: string | undefined;
      if (source.kind === "auto") {
        hostHome = options.localDiscovery?.home ?? homedir();
        const root = (windowsPath(hostHome) ? win32 : posix).parse(hostHome).root;
        if (!root) throw unavailable();
        authority = { kind: "local-discovery", root };
      }
      const acquired = source.kind === "auto" ? await openAuthority(authority, principal, signal) : await open(source, principal, signal);
      const opened = discoverySource(acquired, authority);
      try {
        const roots = [opened.source];
        if (hostHome !== undefined) {
          let home = hostHome;
          if (windowsPath(acquired.source)) {
            const delta = win32.relative(acquired.source, home);
            if (delta === ".." || delta.startsWith("..\\") || win32.isAbsolute(delta)) throw unavailable();
            home = posix.join("/", ...delta.split(win32.sep));
          }
          try {
            const canonical = await new SourceReader(opened.reader).select(home);
            if (!roots.includes(canonical)) roots.push(canonical);
          } catch (error) {
            if (!(error instanceof RemoteFsError && ["not-found", "permission-denied", "path-denied"].includes(error.reason))) throw error;
          }
        }
        const unique = new Map<string, Awaited<ReturnType<typeof discoverReaderSources>>[number]>();
        for (const root of roots) for (const candidate of await discoverReaderSources({ reader: { ...opened.reader, root },
          ...(signal ? { signal } : {}) })) {
          const id = `${candidate.kind}:${candidate.family ?? ""}:${candidate.path}`;
          if (!unique.has(id)) unique.set(id, candidate);
          if (unique.size > 256) throw new ImportError("E_LIMIT_EXCEEDED", "source-candidate-limit", "Too many source candidates");
        }
        const candidates = [...unique.values()];
        const selectable = candidates.filter(candidate => candidate.kind === "source" && candidate.family);
        const storeCandidates = candidates.filter(candidate => candidate.kind === "store");
        if (selectable.length > 256 || storeCandidates.length > 256 || candidates.some(candidate => candidate.path.length > 4096)) {
          throw new ImportError("E_LIMIT_EXCEEDED", "source-candidate-limit", "Too many source candidates");
        }
        for (const [key, prior] of discovered) if (prior.expiresAt <= now()) discovered.delete(key);
        for (const [key, prior] of stores) if (prior.expiresAt <= now()) stores.delete(key);
        if (discovered.size + stores.size + selectable.length + storeCandidates.length > 4096) {
          throw new ImportError("E_LIMIT_EXCEEDED", "source-candidate-limit", "Too many source candidates");
        }
        const offered = selectable.map(candidate => {
          const path = authority.kind === "local-discovery"
            ? physicalSelection(acquired, opened, authority, candidate.path) : candidate.path;
          const selected: ImportSource = source.kind === "ssh" ? { kind: "ssh", family: candidate.family!,
            connectionId: source.connectionId, path } : source.kind === "wsl" ? {
            ...source, family: candidate.family!, path } : {
            kind: "path", family: candidate.family!, path };
          discovered.set(descriptor(selected, principal.userId), { source: selected, authority: structuredClone(authority),
            path: candidate.path, ownerId: principal.userId,
            expiresAt: now() + TTL_MS });
          return { id: randomUUID(), source: selected, displayName: path.slice(0, 256) };
        });
        const foundStores = storeCandidates.map(candidate => {
          const id = randomUUID();
          const path = authority.kind === "local-discovery"
            ? physicalSelection(acquired, opened, authority, candidate.path) : candidate.path;
          stores.set(id, { authority: structuredClone(authority), path: candidate.path, ownerId: principal.userId, expiresAt: now() + TTL_MS });
          const sameHome = selectable.flatMap((entry, index) => entry.home === candidate.home ? [index] : []);
          const contained = sameHome.filter(index => candidate.path.startsWith(selectable[index]!.path + "/"))
            .sort((a, b) => selectable[b]!.path.length - selectable[a]!.path.length);
          const associated = contained[0] ?? (sameHome.length === 1 ? sameHome[0] : undefined);
          return { id, displayName: path.slice(0, 256), path,
            ...(associated === undefined ? {} : { candidateId: offered[associated]!.id }) };
        });
        return { discovery: true, candidates: offered, stores: foundStores, warnings: candidates.filter(candidate => candidate.kind === "wsl")
          .map(candidate => ({ code: "E_SOURCE_UNSUPPORTED", reason: candidate.reason ?? "source-unavailable" })) };
      } finally { await opened.close(); }
    },
    async detect(source: ImportSource, principal: Principal, signal?: AbortSignal): Promise<ImportDetection> {
      person(principal);
      const sourceType = selection(source);
      const snapshotId = source.kind === "snapshot" ? source.snapshotId : randomBytes(32).toString("base64url");
      const root = join(options.home, "import", snapshotId, "snapshot");
      let owned = false;
      try {
        if (source.kind === "snapshot") await claimImportSnapshot({ home: options.home, snapshotId, userId: principal.userId,
          ...(signal ? { signal } : {}) });
        else {
          const opened = await open(source, principal, signal);
          try {
            await createSnapshot({ sourceType, sourceRoot: opened.source, home: options.home, stagingDir: root,
              reader: opened.reader, timeoutMs: 600_000, ...(signal ? { signal } : {}) });
          } finally {
            await opened.close();
          }
        }
        owned = true;
        const bytes = await readColdBytes(join(root, "snapshot.json"), 8 * 1024 * 1024);
        const saved: SourceRecord = { schema: "import.source/1", id: randomUUID(), ownerId: principal.userId, sourceType,
          snapshotId, sourceSha256: createHash("sha256").update(bytes).digest("hex"), selection: structuredClone(source),
          createdAt: new Date(now()).toISOString(), expiresAt: new Date(now() + TTL_MS).toISOString() };
        await privateBytes(file(saved.id), Buffer.from(JSON.stringify(saved) + "\n"));
        const result = await get(saved.id, principal);
        owned = false;
        return result.view;
      } catch (error) {
        if (error instanceof ImportError) throw error;
        throw unavailable();
      } finally {
        if (owned) await rm(join(options.home, "import", snapshotId), { recursive: true, force: true });
      }
    },
    async collectSecrets(id: string, principal: Principal, signal?: AbortSignal,
      selectedAgents?: readonly string[], planBound = false): Promise<Map<string, Buffer>> {
      person(principal);
      if (principal.role !== "owner") throw new ImportError("E_DENIED", "secret-owner-required", "Secret import requires Owner");
      const captured = await get(id, principal, planBound);
      const saved = captured.record;
      if (saved.selection.kind === "snapshot") {
        throw new ImportError("E_NOT_AVAILABLE", "snapshot-credentials-omitted", "Snapshot credentials require manual setup");
      }
      const opened = await open(saved.selection, principal, signal);
      const result = new Map<string, Buffer>();
      try {
        const reader = new SourceReader(opened.reader);
        const files = new Set([".env"]);
        if (saved.sourceType === "hermes") for (const agent of captured.read.report.agents) {
          if (!agent.workspace || selectedAgents && !selectedAgents.includes(agent.agentId)) continue;
          const part = relative(captured.root, agent.workspace).split(sep).join("/");
          if (part && /^profiles\/[^/]+$/.test(part)) files.add(part + "/.env");
        }
        for (const file of files) {
        const declared = new Set(captured.metadata.envKeys[file] ?? []);
        if (!declared.size) continue;
        const path = reader.paths.join(opened.source, file);
        if (!await reader.isFile(path)) continue;
        const bytes = await reader.read(path, 1024 * 1024);
        try {
          for (const line of new TextDecoder("utf-8", { fatal: true }).decode(bytes).split(/\r?\n/)) {
            const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
            if (!match || !isImportSecretName(match[1]!) || !declared.has(match[1]!)) continue;
            let value = match[2]!.trim();
            if (value.startsWith('"')) value = JSON.parse(value) as string;
            else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
            else value = value.replace(/\s+#.*$/, "").trim();
            if (!value || /\$\{|\$[A-Za-z_]/.test(value)) continue;
            const previous = result.get(match[1]!);
            if (previous && previous.toString() !== value) throw new ImportError("E_CONFLICT", "source-secret-conflict", "Source secret declarations conflict");
            previous?.fill(0);
            result.set(match[1]!, Buffer.from(value));
          }
        } finally {
          bytes.fill(0);
        }
        }
        return result;
      } catch (error) {
        for (const value of result.values()) value.fill(0);
        if (error instanceof ImportError) throw error;
        throw unavailable();
      } finally {
        await opened.close();
      }
    },
  };
}

export type SourceRegistry = ReturnType<typeof createSourceRegistry>;
