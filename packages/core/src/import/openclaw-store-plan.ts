/** Shared per-partition store decisions; live callers own scratch probes and no target staging capability. */
import { SourceReader } from "./source-reader.ts";
import type { ImportStoreProbe } from "./execution.ts";
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Layout } from "../paths.ts";
import type { Identity } from "./identity.ts";
import { writeAtomicSync } from "./fs-atomic.ts";
import { storeIdempotencyKey, type ConflictStrategy } from "./ledger.ts";
import { ImportError, type StoreReport } from "./types.ts";
import { copyStoreDirectorySafe, inspectStoreAdopt, type PreparedStoreAdopt, type StoreAdoptReport } from "./store-probe.ts";

/** Only offline apply constructs the target-filesystem staging adapter. */
export interface OpenclawStoreStaging {
  readonly probeBase: string;
  begin(): void;
  accept(root: string, relative: string, marker: Buffer | null, first: boolean): void;
  abort(): void;
  close(): void;
  prepared(report: StoreAdoptReport, source: string, replacesExisting: boolean): PreparedStoreAdopt | undefined;
}

const SCHEMA_MARKER = "_schema.json";
/** The engine could not vouch for the vectors: a different model/dimension, or no proof either way (never assumed equal). */
export const ROUTED_REASONS: ReadonlySet<string> = new Set(["identity-mismatch", "dimension-mismatch", "identity-unverifiable", "identity-unreadable"]);

/** Stable outcome names used by the existing per-partition report. */
export type OpenclawStoreAction = "taken-over" | "preview-ok" | "matched-existing" | "re-embedding-migration" | "skipped";

/** One partition's immutable decision and its subsequent offline outcome, in the legacy report shape. */
export interface OpenclawStoreReport {
  storeId: string;
  kind: "agent" | "shared";
  agentId: string | null;
  rows: number | null;
  /** What the recorded evidence (config, cache, store metadata) says, before any probe. */
  plannedAction: "take-over" | "re-embedding-migration";
  /** What happened (apply) or would happen (dry run, `preview-ok`). */
  action: OpenclawStoreAction;
  reasons: string[];
  identitySource?: "manifest" | "probe" | undefined;
  /** What the owner does next; null when nothing is left to do. */
  nextStep: string | null;
}

/** Shared per-partition decisions plus an optional offline staging receipt. */
export interface PreparedOpenclawStores {
  stores: OpenclawStoreReport[];
  adopt: PreparedStoreAdopt | undefined;
  adoptReport: StoreAdoptReport | undefined;
  errors: Array<{ sourceRef: string; reason: string }>;
}

/** Source evidence and read-only target context; these fields never authorize target staging. */
export interface PlanOpenclawStoresOptions {
  /** A trusted supervised source-model configuration may probe incomplete legacy identity evidence. */
  probeSourceStoreId?: string;
  probe?: ImportStoreProbe;
  reader?: SourceReader;
  stores: StoreReport[];
  /** `SourceReport.plur1bus.storeRoot`: where the source's store root is. */
  storeRoot: Record<string, unknown> | null;
  l: Layout;
  runId: string;
  onConflict: ConflictStrategy;
  /** Target harness config: the identity a store must match is the TARGET engine's identity. */
  targetConfig: unknown;
  /** The harness's embedding identity (report wording only). */
  targetEmbedding: Identity;
  testInternals?: Record<string, unknown> | undefined;
  /** Ledger text of the run being resumed (if any): a take-over it recorded is never repeated. */
  resumeLedgerText?: string | undefined;
}

/** The partition's place in a flat engine store root (what the harness engine reads), or null when the source layout
 *  (namespaces, generations) cannot be mapped onto it. */
function flatRelPath(s: StoreReport, base: string): string | null {
  let rel: string;
  if (s.kind === "agent") {
    if (s.namespace !== null || !s.agentId) return null;
    rel = s.agentId;
  } else {
    const m = /^shared:(workspaces|users):([A-Za-z0-9_-]+)$/.exec(s.storeId);
    if (!m) return null;
    rel = `.plur1bus-shared/${m[1]}/${m[2]}`;
  }
  return resolve(s.path) === resolve(join(base, ...rel.split("/"))) ? rel : null;
}

function sha256File(path: string): string {
  const h = createHash("sha256");
  const buf = Buffer.allocUnsafe(1024 * 1024);
  const fd = openSync(path, "r");
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return h.digest("hex");
}

/** Every file of `src` exists in `dst` with the same content (dst may hold more: LanceDB only appends versions). */
async function partitionContained(src: string, dst: string, reader: SourceReader): Promise<boolean> {
  const dstStat = lstatSync(dst, { throwIfNoEntry: false });
  if (!dstStat || !dstStat.isDirectory() || dstStat.isSymbolicLink()) return false;
  for (const name of await reader.names(src)) {
    const source = reader.paths.join(src, name), target = join(dst, name);
    const info = await reader.stat(source, false);
    if (info?.type === "directory") {
      if (!await partitionContained(source, target, reader)) return false;
    } else if (info?.type === "file") {
      const existing = lstatSync(target, { throwIfNoEntry: false });
      if (!existing?.isFile() || existing.size !== info.size) return false;
      const bytes = await reader.read(source, Number.MAX_SAFE_INTEGER);
      if (createHash("sha256").update(bytes).digest("hex") !== sha256File(target)) return false;
    } else return false;
  }
  return true;
}

function describeIdentity(s: StoreReport): { model: string | null; dimension: number | null } {
  const model = s.identity.fields.model.value;
  const dimension = s.identity.fields.dimension.value;
  return { model: typeof model === "string" ? model : null, dimension: typeof dimension === "number" ? dimension : null };
}

function routeNextStep(s: StoreReport, target: Identity, probed: boolean): string {
  const { model, dimension } = describeIdentity(s);
  const tgtModel = typeof target.model.value === "string" ? target.model.value : "the harness model";
  const tgtDim = typeof target.dimension.value === "number" ? `${target.dimension.value}-d` : "";
  const base = `Not copied: its vectors are not in the harness's vector space (${tgtModel}${tgtDim ? `, ${tgtDim}` : ""}); the source store is left as it is.`;
  if (probed) {
    return `${base} The recorded identity says it matches, but the sample probe shows its vectors come from another model. Next step: guided re-embedding migration; make the harness embed with the store's real model, re-run this import, then run \`plur1bus memory reembed --plan --model ${tgtModel}\`.`;
  }
  if (model) {
    return `${base} Next step: guided re-embedding migration. Set engine.embedding.local.model to ${model}${dimension ? ` (${dimension}-d)` : ""} so the store can be taken over, re-run this import, then run \`plur1bus memory reembed --plan --model ${tgtModel}\`.`;
  }
  return `${base} Its embedding identity could not be determined, so it is never assumed to match. Next step: guided re-embedding migration; establish which model wrote it, then proceed as above with \`plur1bus memory reembed --plan --model ${tgtModel}\`.`;
}

const schemaNextStep = (reason: string) =>
  `Not copied: the store's schema version is not the one this harness expects (${reason}). The import never migrates or writes to a source store; migrate a copy of it (engine admin migrate), then import from the copy.`;

function carriedFromLedger(text: string | undefined, key: string): Map<string, { action: string; reasons: string[] }> | null {
  if (typeof text !== "string") return null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e?.entity === "store" && e?.idempotencyKey === key && Array.isArray(e?.details?.stores)) {
        const out = new Map<string, { action: string; reasons: string[] }>();
        for (const r of e.details.stores) if (typeof r?.storeId === "string") out.set(r.storeId, { action: String(r.action), reasons: Array.isArray(r.reasons) ? r.reasons.map(String) : [] });
        return out;
      }
    } catch { /* torn line: ignored, the ledger loader repairs it */ }
  }
  return null;
}

/** Plans and verifies each candidate on a private copy; only an explicit offline adapter stages accepted copies. */
export async function planOpenclawStores(o: PlanOpenclawStoresOptions, staging?: OpenclawStoreStaging): Promise<PreparedOpenclawStores> {
  const reader = o.reader ?? await SourceReader.local();
  const out: PreparedOpenclawStores = { stores: [], adopt: undefined, adoptReport: undefined, errors: [] };
  const base = typeof o.storeRoot?.baseDbPath === "string" ? reader.paths.resolve(o.storeRoot.baseDbPath) : null;
  const make = (s: StoreReport, action: OpenclawStoreAction, reasons: string[], nextStep: string | null, identitySource?: "manifest" | "probe"): OpenclawStoreReport => ({
    storeId: s.storeId, kind: s.kind, agentId: s.agentId, rows: s.rows, plannedAction: s.identity.plannedAction, action, reasons, identitySource, nextStep,
  });
  const byId = new Map<string, OpenclawStoreReport>();
  const set = (r: OpenclawStoreReport) => { byId.set(r.storeId, r); };

  const candidates: { s: StoreReport; rel: string }[] = [];
  for (const s of o.stores) {
    if (s.identity.plannedAction === "re-embedding-migration" && o.probeSourceStoreId !== s.storeId) {
      set(make(s, "re-embedding-migration", s.identity.reasons, routeNextStep(s, o.targetEmbedding, false)));
      continue;
    }
    const rel = base ? flatRelPath(s, base) : null;
    if (!base || !rel) {
      set(make(s, "skipped", ["layout-unsupported"], "Not copied: this partition sits in a namespaced or generation layout that the import does not map onto the harness store yet. The source is left as it is."));
      continue;
    }
    candidates.push({ s, rel });
  }

  const finish = (): PreparedOpenclawStores => {
    out.stores = o.stores.map((s) => byId.get(s.storeId)!);
    return out;
  };
  if (candidates.length === 0 || !base) return finish();

  // A take-over this run already committed (--resume after a crash behind the swap) is reported from its ledger entry.
  const carried = carriedFromLedger(o.resumeLedgerText, storeIdempotencyKey(base));
  if (carried) {
    for (const { s } of candidates) {
      const c = carried.get(s.storeId);
      if (c && c.action === "taken-over") set(make(s, "taken-over", [], null));
      else if (c && c.action === "re-embedding-migration") set(make(s, "re-embedding-migration", c.reasons, routeNextStep(s, o.targetEmbedding, true), "probe"));
      else set(make(s, "skipped", c?.reasons ?? ["adopt-already-committed-in-run"], null));
    }
    return finish();
  }

  const targetExists = existsSync(o.l.lancedb);
  const existingMatches = new Set<string>();
  let pending = candidates;
  // The harness already has a store: it is never merged into. Without --conflict replace nothing is staged, but every
  // candidate is still probed, so a foreign-vector store is reported as such rather than as a mere conflict.
  let blocked: string | null = null;
  if (targetExists) {
    const matched: typeof candidates = [];
    for (const candidate of candidates) if (await partitionContained(candidate.s.path, join(o.l.lancedb, ...candidate.rel.split("/")), reader)) matched.push(candidate);
    for (const { s } of matched) {
      existingMatches.add(s.storeId);
      if (o.probeSourceStoreId !== s.storeId) set(make(s, "matched-existing", [], null));
    }
    pending = candidates.filter((c) => !matched.includes(c) || o.probeSourceStoreId === c.s.storeId);
    if (pending.length > 0 && o.onConflict === "replace") pending = candidates; // swapped whole: stage the matching ones again too
    else if (pending.length > 0) blocked = o.onConflict === "rename" ? "store-rename-unsupported" : "store-exists-skipped";
  }
  if (pending.length === 0) return finish();

  const probeBase = staging?.probeBase ?? mkdtempSync(join(tmpdir(), "p1b-oc-probe-"));
  const markerSrc = reader.paths.join(base, SCHEMA_MARKER);
  let marker: Buffer | null = null;
  try { marker = await reader.read(markerSrc, 1024 * 1024); } catch (error) { SourceReader.refuseFatal(error); marker = null; }
  let staged = 0;
  let identitySource: "manifest" | "probe" | undefined;
  try {
    staging?.begin();
    let probeIdx = 0;
    for (const { s, rel } of pending) {
      const root = join(probeBase, `p${probeIdx++}`);
      rmSync(root, { recursive: true, force: true });
      mkdirSync(root, { recursive: true, mode: 0o700 });
      if (marker) writeAtomicSync(join(root, SCHEMA_MARKER), marker, 0o600);
      try {
        await copyStoreDirectorySafe(s.path, join(root, "probe"), reader);
      } catch (err) {
        const reason = err instanceof ImportError ? err.reason : "copy-failed";
        out.errors.push({ sourceRef: s.storeId, reason });
        set(make(s, "skipped", [reason], "Not copied: the partition could not be copied safely (links or special files are refused). The source is left as it is."));
        rmSync(root, { recursive: true, force: true });
        continue;
      }
      let check: Awaited<ReturnType<typeof inspectStoreAdopt>>;
      try {
        check = await inspectStoreAdopt({ storePath: root, targetConfig: o.targetConfig, targetHome: o.l.home, testInternals: o.testInternals,
          ...(o.probe ? { probe: o.probe } : {}) });
      } catch (err) {
        // The probe engine could not even start (e.g. an engine setting in config.json it rejects): nothing is vouched for.
        const code = (err as { code?: unknown } | null)?.code;
        const reason = typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : "engine-unavailable";
        out.errors.push({ sourceRef: s.storeId, reason: `store-check-failed:${reason}` });
        set(make(s, "skipped", ["store-check-failed"], "Not copied: the engine could not be started with the target config, so the store could not be verified. Fix the engine settings in config.json and re-run the import."));
        rmSync(root, { recursive: true, force: true });
        continue;
      }
      if (check.verdict !== "ok") {
        const reason = check.reason ?? "identity-unverifiable";
        if (ROUTED_REASONS.has(reason)) set(make(s, "re-embedding-migration", [reason], routeNextStep(s, o.targetEmbedding, s.identity.plannedAction === "take-over"), check.identitySource));
        else set(make(s, "skipped", [reason], reason.startsWith("schema-") ? schemaNextStep(reason) : "Not copied: the engine's store check refused it. The source is left as it is."));
        rmSync(root, { recursive: true, force: true });
        continue;
      }
      if (existingMatches.has(s.storeId) && o.onConflict !== "replace") {
        set(make(s, "matched-existing", [], null, check.identitySource));
        rmSync(root, { recursive: true, force: true });
        continue;
      }
      if (blocked) {
        set(make(s, "skipped", [blocked], "The harness already has a store and the import never merges into it. Re-run with --conflict replace to swap it whole: the old store is backed up under imports/<runId>/replaced and a rollback restores it.", check.identitySource));
        rmSync(root, { recursive: true, force: true });
        continue;
      }
      identitySource = check.identitySource;
      set(make(s, "preview-ok", [], null, check.identitySource));
      staging?.accept(root, rel, marker, staged === 0);
      staged += 1;
      rmSync(root, { recursive: true, force: true });
    }
  } catch (err) {
    staging?.abort();
    throw err;
  } finally {
    if (staging) staging.close();
    else rmSync(probeBase, { recursive: true, force: true });
  }

  const accepted = [...byId.values()].some((r) => r.action === "preview-ok");
  if (accepted) {
    const report: StoreAdoptReport = { attempted: true, sourcePath: base, targetPath: o.l.lancedb, verdict: "ok", action: "preview-ok", identitySource };
    out.adoptReport = report;
    out.adopt = staging?.prepared(report, base, targetExists);
  }
  return finish();
}
