/** Bounded known-location discovery only; it never walks arbitrary trees, mounts images, or starts a WSL distro. */
import { RemoteFsError } from "@plur1bus/remote-fs";
import { SourceReader, type SourceReaderOptions } from "./source-reader.ts";
import { ImportError, type SourceType } from "./types.ts";
import type { WslDistro } from "./wsl.ts";

export interface ReaderCandidate {
  kind: "source" | "store" | "wsl";
  path: string;
  home: string | null;
  family?: SourceType;
  reason?: string;
}

export interface ReaderDiscoveryOptions {
  reader: SourceReaderOptions;
  /** The host has already authorized these additions; canonical authority is still checked here. */
  additionalPaths?: readonly string[];
  /** Trusted local enumeration only. Stopped distros remain unprobed even when explicitly listed. */
  wslDistributions?: readonly WslDistro[];
  signal?: AbortSignal;
}

export async function discoverReaderSources(options: ReaderDiscoveryOptions): Promise<ReaderCandidate[]> {
  const reader = new SourceReader({ ...options.reader, ...(options.signal ? { signal: options.signal } : {}) });
  const P = reader.paths;
  const root = await reader.select(options.reader.root);
  const homes = new Set<string>([root]);
  const candidates = new Map<string, ReaderCandidate>();
  const seen = new Set<string>();
  const inside = (path: string) => {
    const delta = P.relative(root, path);
    return delta !== ".." && !delta.startsWith(`..${P.sep}`) && !P.isAbsolute(delta);
  };
  const optional = async <T>(run: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await run(); }
    catch (error) {
      if (error instanceof RemoteFsError && ["not-found", "path-denied", "permission-denied"].includes(error.reason)) return fallback;
      throw error;
    }
  };
  const add = (candidate: ReaderCandidate) => {
    candidates.set(`${candidate.kind}:${candidate.family ?? ""}:${candidate.path}`, candidate);
    if (candidates.size > 256) throw new ImportError("E_LIMIT_EXCEEDED", "source-candidate-limit", "Too many source candidates", 3);
  };
  const probe = async (path: string, home: string | null) => {
    if (!inside(path) || !await optional(() => reader.isDir(path), false)) return;
    const canonical = await optional(() => reader.select(path), "");
    if (!canonical || seen.has(canonical)) return;
    seen.add(canonical);
    if (await optional(() => reader.isFile(P.join(path, "openclaw.json")), false)
      || await optional(() => reader.isFile(P.join(path, "clawdbot.json")), false)
      || await optional(() => reader.isFile(P.join(path, "state", "openclaw.sqlite")), false)) {
      add({ kind: "source", family: "openclaw", path: canonical, home });
    }
    if (await optional(() => reader.isFile(P.join(path, "config.yaml")), false)) add({ kind: "source", family: "hermes", path: canonical, home });
    for (const suffix of ["memory/lancedb-namespaced", "state/lancedb"]) {
      const store = P.join(path, suffix);
      if (await optional(() => reader.isDir(store), false)) {
        const selected = await optional(() => reader.select(store), "");
        if (selected) add({ kind: "store", path: selected, home });
      }
    }
  };
  const parents = new Set(["/home", "/Users"]);
  if (/^\/[A-Za-z]:(?:\/|$)/.test(root)) parents.add(`/${root[1]}:/Users`);
  if (root === "/") for (const name of await reader.names(root)) {
    if (/^[A-Za-z]:$/.test(name)) parents.add(`/${name}/Users`);
  }
  for (const parent of parents) {
    if (!inside(parent)) continue;
    for (const name of await optional(() => reader.subdirs(parent), [])) homes.add(P.join(parent, name));
  }
  if (inside("/root") && await optional(() => reader.isDir("/root"), false)) homes.add("/root");
  for (const home of homes) {
    await probe(home, home);
    for (const name of [".openclaw", ".clawdbot", ".hermes", "AppData/Local/hermes", ".plur1bus",
      ".local/share/plur1bus", "Library/Application Support/plur1bus", "AppData/Local/plur1bus", "AppData/Local/PLUR1BUS"]) {
      await probe(P.join(home, name), home);
    }
    for (const name of await optional(() => reader.names(home), [])) {
      if (/^\.openclaw-[A-Za-z0-9_-]{1,64}$/.test(name)) await probe(P.join(home, name), home);
    }
    // A WSL image is metadata, never a mountable input to this read-only transport.
    const packages = P.join(home, "AppData", "Local", "Packages");
    for (const name of await optional(() => reader.subdirs(packages), [])) {
      if (!/^(?:CanonicalGroupLimited\.|TheDebianProject\.|KaliLinux\.|SUSE\.|WhitewaterFoundry\.)/i.test(name)) continue;
      const image = P.join(packages, name, "LocalState", "ext4.vhdx");
      if (await reader.isFile(image)) add({ kind: "wsl", path: image, home, reason: "image-only-not-mounted" });
    }
  }
  for (const path of options.additionalPaths ?? []) {
    // Do not make an additional path a new FS authority before following its aliases.
    await reader.select(path);
    await probe(path, null);
  }
  for (const distro of options.wslDistributions ?? []) add({ kind: "wsl", path: distro.name, home: null,
    reason: distro.state === "Stopped" ? "stopped-not-probed" : "requires-authorized-filesystem" });
  return [...candidates.values()].sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
}
