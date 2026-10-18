// OpenClaw PLUR1BUS store take-over and routing (docs/import.md §2.3, §2.3.1, M7 acceptance 2 and 5).
// The OpenClaw source holds one LanceDB partition per agent and per shared pool. Each partition is decided on its own:
//   - identity matches the harness (the engine's sample cosine probe agrees, same dimension, same schema) -> its copy is
//     staged and swapped into state/lancedb whole, without re-embedding;
//   - anything else (another model or dimension, identity not provable) -> NOT copied; the report names the guided
//     re-embedding migration (`plur1bus memory reembed`) as the next step. A foreign vector space never enters the store.
// All of the copy/inspect/commit machinery is the Hermes store adopt of #100 (hermes-stores.ts): copyStoreDirectorySafe
// (copy-never-move, no links), inspectStoreAdopt (Engine.stores.adopt dry run on the COPY), commitStoreAdopt (swap,
// backup on replace, ledger entry that rollback.ts understands). This file only adds the per-partition decision.
// Probing happens in a one-partition store root so a verdict belongs to exactly one store; a probe copy lives next to the
// staging dir (apply: state/lancedb.adopt-<runId>.probe, dry run: the OS temp dir) and is removed on every exit path.
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Layout } from "../../paths.ts";
import type { Identity } from "../identity.ts";
import { writeAtomicSync } from "../fs-atomic.ts";
import { readSourceFileSafe } from "../fs-safe.ts";
import { storeIdempotencyKey, type ConflictStrategy, type ImportLedger } from "../ledger.ts";
import { ImportError, type StoreReport } from "../types.ts";
import {
  commitStoreAdopt,
  copyStoreDirectorySafe,
  inspectStoreAdopt,
  type PreparedStoreAdopt,
  type StoreAdoptReport,
} from "./hermes-stores.ts";

const SCHEMA_MARKER = "_schema.json";
/** The engine could not vouch for the vectors: a different model/dimension, or no proof either way (never assumed equal). */
const ROUTED_REASONS = new Set(["identity-mismatch", "dimension-mismatch", "identity-unverifiable", "identity-unreadable"]);

export type OpenclawStoreAction = "taken-over" | "preview-ok" | "matched-existing" | "re-embedding-migration" | "skipped";

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

export interface PreparedOpenclawStores {
  stores: OpenclawStoreReport[];
  adopt: PreparedStoreAdopt | undefined;
  adoptReport: StoreAdoptReport | undefined;
  errors: Array<{ sourceRef: string; reason: string }>;
}

export interface PrepareOpenclawStoresOptions {
  stores: StoreReport[];
  /** `SourceReport.plur1bus.storeRoot`: where the source's store root is. */
  storeRoot: Record<string, unknown> | null;
  l: Layout;
  isApply: boolean;
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
function partitionContained(src: string, dst: string): boolean {
  const dstStat = lstatSync(dst, { throwIfNoEntry: false });
  if (!dstStat || !dstStat.isDirectory() || dstStat.isSymbolicLink()) return false;
  for (const ent of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, ent.name);
    const d = join(dst, ent.name);
    if (ent.isSymbolicLink()) return false;
    if (ent.isDirectory()) {
      if (!partitionContained(s, d)) return false;
    } else if (ent.isFile()) {
      const dst1 = lstatSync(d, { throwIfNoEntry: false });
      if (!dst1 || !dst1.isFile() || dst1.size !== lstatSync(s).size || sha256File(s) !== sha256File(d)) return false;
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

export async function prepareOpenclawStores(o: PrepareOpenclawStoresOptions): Promise<PreparedOpenclawStores> {
  const out: PreparedOpenclawStores = { stores: [], adopt: undefined, adoptReport: undefined, errors: [] };
  const base = typeof o.storeRoot?.baseDbPath === "string" ? resolve(o.storeRoot.baseDbPath) : null;
  const make = (s: StoreReport, action: OpenclawStoreAction, reasons: string[], nextStep: string | null, identitySource?: "manifest" | "probe"): OpenclawStoreReport => ({
    storeId: s.storeId, kind: s.kind, agentId: s.agentId, rows: s.rows, plannedAction: s.identity.plannedAction, action, reasons, identitySource, nextStep,
  });
  const byId = new Map<string, OpenclawStoreReport>();
  const set = (r: OpenclawStoreReport) => { byId.set(r.storeId, r); };

  const candidates: { s: StoreReport; rel: string }[] = [];
  for (const s of o.stores) {
    if (s.identity.plannedAction === "re-embedding-migration") {
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
  let pending = candidates;
  // The harness already has a store: it is never merged into. Without --conflict replace nothing is staged, but every
  // candidate is still probed, so a foreign-vector store is reported as such rather than as a mere conflict.
  let blocked: string | null = null;
  if (targetExists) {
    const matched = candidates.filter(({ s, rel }) => partitionContained(s.path, join(o.l.lancedb, ...rel.split("/"))));
    for (const { s } of matched) set(make(s, "matched-existing", [], null));
    pending = candidates.filter((c) => !matched.includes(c));
    if (pending.length > 0 && o.onConflict === "replace") pending = candidates; // swapped whole: stage the matching ones again too
    else if (pending.length > 0) blocked = o.onConflict === "rename" ? "store-rename-unsupported" : "store-exists-skipped";
  }
  if (pending.length === 0) return finish();

  const stagingDir = join(o.l.state, `lancedb.adopt-${o.runId}`);
  const probeBase = o.isApply ? join(o.l.state, `lancedb.adopt-${o.runId}.probe`) : mkdtempSync(join(tmpdir(), "p1b-oc-probe-"));
  const markerSrc = join(base, SCHEMA_MARKER);
  let marker: Buffer | null = null;
  try { marker = readSourceFileSafe(markerSrc, 1024 * 1024); } catch { marker = null; }
  let staged = 0;
  let identitySource: "manifest" | "probe" | undefined;
  try {
    if (o.isApply) {
      rmSync(stagingDir, { recursive: true, force: true });
      rmSync(probeBase, { recursive: true, force: true });
      mkdirSync(probeBase, { recursive: true, mode: 0o700 });
    }
    let probeIdx = 0;
    for (const { s, rel } of pending) {
      const root = join(probeBase, `p${probeIdx++}`);
      rmSync(root, { recursive: true, force: true });
      mkdirSync(root, { recursive: true, mode: 0o700 });
      if (marker) writeAtomicSync(join(root, SCHEMA_MARKER), marker, 0o600);
      try {
        copyStoreDirectorySafe(s.path, join(root, "probe"));
      } catch (err) {
        const reason = err instanceof ImportError ? err.reason : "copy-failed";
        out.errors.push({ sourceRef: s.storeId, reason });
        set(make(s, "skipped", [reason], "Not copied: the partition could not be copied safely (links or special files are refused). The source is left as it is."));
        rmSync(root, { recursive: true, force: true });
        continue;
      }
      let check: Awaited<ReturnType<typeof inspectStoreAdopt>>;
      try {
        check = await inspectStoreAdopt({ storePath: root, targetConfig: o.targetConfig, testInternals: o.testInternals });
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
      if (blocked) {
        set(make(s, "skipped", [blocked], "The harness already has a store and the import never merges into it. Re-run with --conflict replace to swap it whole: the old store is backed up under imports/<runId>/replaced and a rollback restores it.", check.identitySource));
        rmSync(root, { recursive: true, force: true });
        continue;
      }
      identitySource = check.identitySource;
      set(make(s, "preview-ok", [], null, check.identitySource));
      if (o.isApply) {
        if (staged === 0) {
          mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
          if (marker) writeAtomicSync(join(stagingDir, SCHEMA_MARKER), marker, 0o600);
        }
        const dst = join(stagingDir, ...rel.split("/"));
        mkdirSync(dirname(dst), { recursive: true, mode: 0o700 });
        renameSync(join(root, "probe"), dst);
      }
      staged += 1;
      rmSync(root, { recursive: true, force: true });
    }
  } catch (err) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw err;
  } finally {
    rmSync(probeBase, { recursive: true, force: true });
  }

  const accepted = [...byId.values()].some((r) => r.action === "preview-ok");
  if (accepted) {
    const report: StoreAdoptReport = { attempted: true, sourcePath: base, targetPath: o.l.lancedb, verdict: "ok", action: "preview-ok", identitySource };
    out.adoptReport = report;
    if (o.isApply && existsSync(stagingDir)) out.adopt = { report, resolvedSource: base, stagingDir, replacesExisting: targetExists };
  }
  return finish();
}

/** Swaps the verified staging dir into state/lancedb (apply, after snapshot + ledger exist). */
export function commitOpenclawStores(p: PreparedOpenclawStores, opts: { l: Layout; ledger?: ImportLedger | undefined; replacedBackupDir?: string | undefined }): void {
  if (!p.adopt?.stagingDir) return;
  const rows = () => p.stores.map((s) => ({ storeId: s.storeId, action: s.action === "preview-ok" ? "taken-over" : s.action, reasons: s.reasons }));
  p.adoptReport = commitStoreAdopt(p.adopt, { ...opts, extraDetails: { stores: rows() } });
  for (const s of p.stores) if (s.action === "preview-ok") s.action = "taken-over";
}
