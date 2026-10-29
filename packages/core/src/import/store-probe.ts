/** Private scratch-copy store inspection shared by live previews and the offline mutation adapters. */
import { SourceReader } from "./source-reader.ts";
import type { ImportStoreProbe } from "./execution.ts";
import { importEnginePorts } from "./engine-ports.ts";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { isInsideDir, writeAtomicSync } from "./fs-atomic.ts";
import { ImportError } from "./types.ts";
import { createEngine } from "@cyb3rb1ade/plur1bus-memory/engine/create-engine.js";
import { defaults } from "@plur1bus/config-schema";
import { buildEngineConfig } from "../engine-config.ts";
import { layout } from "../paths.ts";
import { platformCapabilities } from "../platform.ts";
import type { HostServices } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";

/** Existing strategies offered when source vectors differ from the selected target identity. */
export type AdoptStrategy = "reembed" | "import";

/** Legacy report projection shared by dry-run planning and offline store adoption. */
export interface StoreAdoptReport {
  attempted: boolean;
  sourcePath: string;
  targetPath: string;
  verdict: "ok" | "incompatible";
  action: "taken-over" | "aborted" | "preview-ok" | "skipped";
  reason?: string | undefined;
  identitySource?: "manifest" | "probe" | undefined;
  schemaVersion?: string | undefined;
  routedTo?: AdoptStrategy | undefined;
  offeredStrategies?: readonly AdoptStrategy[] | undefined;
  hint?: string | undefined;
}

/** Supplies an Engine owner with explicit scratch state and the target home's existing policy ports. */
export function createTempHost(stateDir: string, workspaceDir: (id: string) => Promise<string>, targetHome = dirname(stateDir)): HostServices {
  return {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    stateDir,
    configPath: () => join(stateDir, "config.json"),
    workspaceDir: async (id: string) => workspaceDir(id),
    config: () => ({} as any),
    platform: {
      os: process.platform,
      arch: process.arch,
      memoryTotalBytes: () => 0,
      memoryFreeBytes: () => 0,
      ...platformCapabilities,
    },
    runtime: null,
    ...importEnginePorts(targetHome),
  } as unknown as HostServices;
}

/** Copies regular source entries into the caller-owned destination without following links or moving source data. */
export async function copyStoreDirectorySafe(src: string, dst: string, sourceReader?: SourceReader): Promise<void> {
  const reader = sourceReader ?? await SourceReader.local();
  const normSrc = reader.paths.resolve(src);
  const normDst = resolve(dst);
  if (!reader.remote && (normSrc === normDst || isInsideDir(normDst, normSrc) || isInsideDir(normSrc, normDst))) {
    throw new ImportError("E_STORE_INCOMPATIBLE", "overlapping-store-paths", "source and destination store paths overlap");
  }
  mkdirSync(dst, { recursive: true, mode: 0o700 });
  for (const name of await reader.names(src)) {
    const srcPath = reader.paths.join(src, name), dstPath = join(dst, name);
    const st = await reader.stat(srcPath, false);
    if (st?.type === "directory") await copyStoreDirectorySafe(srcPath, dstPath, reader);
    else if (st?.type === "file") writeAtomicSync(dstPath, await reader.read(srcPath, Number.MAX_SAFE_INTEGER), 0o600);
    else throw new ImportError("E_STORE_INCOMPATIBLE", "unsafe-store-entry", "store contains a nonregular or linked entry");
  }
}

/** Asks the existing Engine to inspect a supplied copy while every Engine-owned state path stays in scratch storage. */
export async function inspectStoreAdopt(opts: {
  probe?: ImportStoreProbe;
  storePath: string;
  expectedIdentity?: any;
  /** Target harness config: the identity a copied store must match is the TARGET engine's identity. */
  targetConfig?: unknown;
  targetHome?: string | undefined;
  testInternals?: Record<string, unknown> | undefined;
}): Promise<{
  verdict: "ok" | "incompatible";
  reason?: string | undefined;
  identitySource?: "manifest" | "probe" | undefined;
  schemaVersion?: string | undefined;
}> {
  const { storePath, expectedIdentity, targetConfig, testInternals } = opts;
  if (opts.probe) return opts.probe(storePath, expectedIdentity);
  const tmpDir = mkdtempSync(join(tmpdir(), "p1b-adopt-probe-"));
  const tmpL = layout(tmpDir);

  const engine = createEngine(
    createTempHost(tmpL.state, async (id: string) => tmpL.workspaceDir(id), opts.targetHome),
    buildEngineConfig((targetConfig ?? defaults()) as any, tmpL) as any,
    testInternals ? { internals: testInternals } : undefined,
  );

  try {
    const identities = engine.embedding.identities();
    const identity = expectedIdentity || identities[0];
    if (!identity) {
      return { verdict: "incompatible", reason: "identity-unverifiable" };
    }
    const res = await engine.stores.adopt({
      path: resolve(storePath),
      expectedIdentity: identity,
      dryRun: true,
    });
    return {
      verdict: res.verdict === "ok" ? "ok" : "incompatible",
      reason: res.reason ?? (res.verdict === "ok" ? undefined : "identity-mismatch"),
      identitySource: res.identitySource,
      schemaVersion: res.storeSchema?.current ?? undefined,
    };
  } catch (err: any) {
    const code = typeof err?.code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(err.code) ? err.code : "store-unreadable";
    return { verdict: "incompatible", reason: code };
  } finally {
    try {
      await engine.close({ budgetMs: 1_000 });
    } catch {}
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Planner result; only an offline staging capability can attach a target staging directory. */
export interface PreparedStoreAdopt {
  report: StoreAdoptReport;
  resolvedSource: string;
  /** Present only in apply mode after a verified copy: the staged store waiting for commit. */
  stagingDir?: string | undefined;
  /** state/lancedb existed when the copy was verified (only with --conflict replace). */
  replacesExisting: boolean;
}
