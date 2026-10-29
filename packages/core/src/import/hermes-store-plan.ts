/** Shared Hermes store decisions; optional offline staging is supplied only by the maintenance adapter. */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Layout } from "../paths.ts";
import { SourceReader } from "./source-reader.ts";
import type { ImportStoreProbe } from "./execution.ts";
import { storeIdempotencyKey, type ConflictStrategy } from "./ledger.ts";
import { isInsideDir } from "./fs-atomic.ts";
import { ImportError } from "./types.ts";
import { inspectStoreAdopt, type AdoptStrategy, type PreparedStoreAdopt } from "./store-probe.ts";

/** Immutable preview inputs; these fields do not grant target staging authority. */
export interface PlanHermesStoreOptions {
  probe?: ImportStoreProbe;
  reader?: SourceReader;
  sourceStorePath: string;
  l: Layout;
  runId: string;
  onConflict?: ConflictStrategy | undefined;
  expectedIdentity?: any | undefined;
  targetConfig?: unknown;
  testInternals?: Record<string, unknown> | undefined;
  adoptStrategy?: AdoptStrategy | string | undefined;
  /** Ledger of the run being resumed (if any); a recorded take-over of the same source is not repeated. */
  resumeLedgerText?: string | undefined;
}

/** Only the offline importer supplies this narrow staging capability after holding the writer lock. */
export interface HermesStoreStaging {
  stage(source: string, reader: SourceReader): Promise<string>;
  discard(): void;
}

/** Computes the same legacy decisions; without a staging port it never writes to the target. */
export async function planHermesStore(opts: PlanHermesStoreOptions, staging?: HermesStoreStaging): Promise<PreparedStoreAdopt> {
  const { sourceStorePath, l, onConflict = "skip", expectedIdentity, targetConfig, testInternals, adoptStrategy, resumeLedgerText } = opts;
  const reader = opts.reader ?? await SourceReader.local();
  const resolvedSource = reader.paths.resolve(sourceStorePath);
  const targetStore = l.lancedb;
  const alreadyAdoptedInRun = typeof resumeLedgerText === "string"
    && resumeLedgerText.split("\n").some((line) => {
      try {
        const e = JSON.parse(line);
        return e?.entity === "store" && e?.idempotencyKey === storeIdempotencyKey(resolvedSource);
      } catch {
        return false;
      }
    });
  if (!await reader.isDir(resolvedSource)) {
    throw new ImportError("E_SOURCE_NOT_FOUND", "path-unreadable", `store path not found: ${resolvedSource}`);
  }
  if (resolvedSource === resolve(targetStore) || isInsideDir(resolve(targetStore), resolvedSource) || isInsideDir(resolvedSource, resolve(targetStore))) {
    throw new ImportError("E_STORE_INCOMPATIBLE", "overlapping-store-paths", "source store overlaps the target store");
  }

  const base = { attempted: true, sourcePath: resolvedSource, targetPath: targetStore };
  const replacesExisting = existsSync(targetStore);
  // --resume of a run whose ledger already records this take-over: never re-copy (with replace that would discard
  // every card the first attempt wrote into the adopted store).
  if (alreadyAdoptedInRun) {
    return { report: { ...base, verdict: "ok", action: "skipped", reason: "already-adopted-in-run" }, resolvedSource, replacesExisting };
  }
  if (replacesExisting) {
    if (onConflict === "skip") {
      return {
        report: { ...base, verdict: "ok", action: "skipped", reason: "store-exists-skipped" },
        resolvedSource,
        replacesExisting,
      };
    }
    if (onConflict === "rename") {
      throw new ImportError("E_STORE_INCOMPATIBLE", "store-rename-unsupported", "a store cannot be renamed on conflict; use --conflict skip or replace");
    }
  }

  if (!staging) {
    const check = await inspectStoreAdopt({ storePath: resolvedSource, expectedIdentity, targetConfig, targetHome: l.home, testInternals,
      ...(opts.probe ? { probe: opts.probe } : {}) });
    if (check.verdict === "ok") {
      return {
        report: { ...base, verdict: "ok", action: "preview-ok", identitySource: check.identitySource, schemaVersion: check.schemaVersion },
        resolvedSource,
        replacesExisting,
      };
    }
    return {
      report: {
        ...base,
        verdict: "incompatible",
        action: adoptStrategy === "reembed" ? "preview-ok" : adoptStrategy === "import" ? "skipped" : "aborted",
        reason: check.reason,
        identitySource: check.identitySource,
        routedTo: (adoptStrategy === "reembed" || adoptStrategy === "import") ? adoptStrategy : undefined,
        offeredStrategies: ["reembed", "import"],
        hint: "Store embedding identity does not match target. Specify --adopt-strategy reembed (adopt store and run 'memory reembed') or --adopt-strategy import (import cards with target embeddings).",
      },
      resolvedSource,
      replacesExisting,
    };
  }

  const stagingDir = await staging.stage(resolvedSource, reader);

  let check: Awaited<ReturnType<typeof inspectStoreAdopt>>;
  try {
    check = await inspectStoreAdopt({ storePath: stagingDir, expectedIdentity, targetConfig, targetHome: l.home, testInternals,
      ...(opts.probe ? { probe: opts.probe } : {}) });
  } catch (err) {
    staging.discard();
    throw err;
  }
  if (check.verdict !== "ok") {
    if (adoptStrategy === "reembed") {
      return {
        report: {
          ...base,
          verdict: "incompatible",
          action: "preview-ok",
          reason: check.reason,
          identitySource: check.identitySource,
          routedTo: "reembed",
          offeredStrategies: ["reembed", "import"],
        },
        resolvedSource,
        stagingDir,
        replacesExisting,
      };
    }
    staging.discard();
    if (adoptStrategy === "import") {
      return {
        report: {
          ...base,
          verdict: "incompatible",
          action: "skipped",
          reason: check.reason,
          identitySource: check.identitySource,
          routedTo: "import",
          offeredStrategies: ["reembed", "import"],
        },
        resolvedSource,
        replacesExisting,
      };
    }
    return {
      report: {
        ...base,
        verdict: "incompatible",
        action: "aborted",
        reason: check.reason,
        identitySource: check.identitySource,
        offeredStrategies: ["reembed", "import"],
        hint: "Store embedding identity does not match target. Specify --adopt-strategy reembed (adopt store and run 'memory reembed') or --adopt-strategy import (import cards with target embeddings).",
      },
      resolvedSource,
      replacesExisting,
    };
  }
  return {
    report: { ...base, verdict: "ok", action: "preview-ok", identitySource: check.identitySource, schemaVersion: check.schemaVersion },
    resolvedSource,
    stagingDir,
    replacesExisting,
  };
}
