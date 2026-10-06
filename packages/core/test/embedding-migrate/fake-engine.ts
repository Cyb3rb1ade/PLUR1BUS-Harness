// A fake engine with the real coordinator's observable semantics: plan with a one-time token, ONE batch per apply/resume,
// a durable record, source drift detection, and the active generation answering every recall until a switch changes it.
import { createHash } from "node:crypto";
import type { EmbeddingFingerprint } from "../../src/embedding-migrate/probe.ts";
import type { EngineRecord, EnginePlan, PlanRequest, ReembedEngine, SwitchPort } from "../../src/embedding-migrate/port.ts";

export interface Row { id: string; text: string; vector: number[] }
export const fp = (model: string, dimensions: number): EmbeddingFingerprint => ({ provider: "fake", model, dimensions, normalize: true });
const idOf = (f: EmbeddingFingerprint) => `embedding:v1:sha256:${createHash("sha256").update(JSON.stringify(f)).digest("hex")}`;

/** Deterministic text → unit vector; related words share buckets so recall ranking is meaningful. */
export function embed(f: EmbeddingFingerprint, text: string): number[] {
  const v = new Array<number>(f.dimensions).fill(0);
  for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    const h = createHash("sha256").update(`${f.model}|${word}`).digest();
    for (let k = 0; k < 3; k++) v[(h[k]! + h[k + 3]! * 7) % f.dimensions]! += 1 + (h[k + 6]! % 3) * 0.01;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}
const cosine = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);

export interface FakeOptions {
  rows?: Record<string, number>; // table → row count
  batchSize?: number;
  /** Throw this from the n-th (1-based) provider batch overall. */
  failBatch?: { n: number; error: Error };
  withValidate?: boolean;
  diskFree?: number;
}

export function createFakeEngine(o: FakeOptions = {}) {
  const source = fp("a", 8);
  const tables = new Map<string, Row[]>();
  for (const [t, n] of Object.entries(o.rows ?? { memories: 10, shared: 5 })) {
    tables.set(t, Array.from({ length: n }, (_, i) => {
      const text = `fact ${t} ${i} about topic${i % 4} and item${i}`;
      return { id: `${t}-${i}`, text, vector: embed(source, text) };
    }));
  }
  const state = {
    activeGeneration: "g0" as string, activeFingerprint: source,
    generations: new Map<string, { fingerprint: EmbeddingFingerprint; tables: Map<string, Row[]> }>(),
    records: new Map<string, EngineRecord & { token: string }>(),
    calls: [] as string[], providerBatches: 0, busy: false, sourceVersion: 1,
  };
  state.generations.set("g0", { fingerprint: source, tables });
  const batchSize = o.batchSize ?? 3;

  const guard = async <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
    state.calls.push(name);
    if (state.busy) throw new Error("another reembedding coordinator operation is active");
    state.busy = true;
    try { await Promise.resolve(); return await fn(); } finally { state.busy = false; }
  };
  const snapshot = (r: EngineRecord & { token: string }): EngineRecord => { const { token: _t, ...rest } = r; return structuredClone(rest); };
  const tablesOf = () => [...state.generations.get(state.activeGeneration)!.tables].map(([tableId, rows]) => ({ tableId, version: String(state.sourceVersion), rowCount: rows.length, estimatedBytes: rows.length * 100 }));
  const drift = (r: EngineRecord) => { if (r.source.tables[0]!.version !== String(state.sourceVersion)) throw new Error(`reembedding source version drift: ${r.source.tables[0]!.tableId}`); };

  const runBatch = (r: EngineRecord & { token: string }): void => {
    drift(r);
    const t = r.source.tables[r.cursor.tableIndex]!;
    const srcRows = state.generations.get(r.source.generation)!.tables.get(t.tableId)!;
    const rows = srcRows.slice(r.cursor.offset, r.cursor.offset + batchSize);
    state.providerBatches += 1;
    if (o.failBatch && o.failBatch.n === state.providerBatches) throw o.failBatch.error;
    const g = state.generations.get(r.target.generation)!;
    const out = g.tables.get(t.tableId) ?? [];
    for (const row of rows) out.push({ id: row.id, text: row.text, vector: embed(r.target.fingerprint, row.text) });
    g.tables.set(t.tableId, out);
    const offset = r.cursor.offset + rows.length;
    r.cursor = { tableIndex: offset >= t.rowCount ? r.cursor.tableIndex + 1 : r.cursor.tableIndex, offset: offset >= t.rowCount ? 0 : offset, completedRows: r.cursor.completedRows + rows.length, providerCalls: r.cursor.providerCalls + 1, bytes: r.cursor.bytes + 100 * rows.length };
    if (r.cursor.tableIndex >= r.source.tables.length) r.state = "validating";
  };

  const engine: ReembedEngine & { validate?: ReembedEngine["validate"] } = {
    batchSize,
    plan: (req: PlanRequest): Promise<EnginePlan> => guard("plan", () => {
      if (idOf(req.target.fingerprint) === idOf(state.activeFingerprint)) throw new Error("reembedding plan does not change the embedding fingerprint");
      if (o.diskFree !== undefined && o.diskFree < 1) throw new Error("insufficient disk space for reembedding target generation (required 1 bytes)");
      const inv = tablesOf(); const rowsN = inv.reduce((s, t) => s + t.rowCount, 0);
      const targetGeneration = req.targetGeneration ?? `generation-${req.id}`;
      const src = { generation: state.activeGeneration, fingerprintId: idOf(state.activeFingerprint), fingerprint: state.activeFingerprint, tables: inv };
      const tgt = { generation: targetGeneration, fingerprintId: idOf(req.target.fingerprint), fingerprint: req.target.fingerprint };
      const token = `reemb_v1_${createHash("sha256").update(req.id).digest("base64url")}`;
      state.generations.set(targetGeneration, { fingerprint: req.target.fingerprint, tables: new Map() });
      state.records.set(req.id, { id: req.id, state: "planned", cursor: { tableIndex: 0, offset: 0, completedRows: 0, providerCalls: 0, bytes: 0 }, source: src, target: tgt, error: null, token });
      return { plan: { id: req.id, source: src, target: { ...tgt, probeStatus: "passed" }, estimates: { rows: rowsN, providerCalls: rowsN, sourceBytes: rowsN * 100, targetBytes: rowsN * 300, requiredFreeBytes: rowsN * 375, freeBytes: 1e9 } }, planDigest: `sha256:${"0".repeat(64)}`, confirmation: { token } };
    }),
    apply: ({ id, token }) => guard("apply", () => {
      const r = state.records.get(id); if (!r) throw new Error("reembedding migration not found");
      if (token !== r.token) throw new Error("invalid or expired reembedding confirmation");
      if (r.state === "planned") r.state = "running";
      if (r.state !== "running") throw new Error(`reembedding apply requires planned, confirmed, or running state; found ${r.state}`);
      runBatch(r); return snapshot(r);
    }),
    resume: ({ id, token }) => guard("resume", () => {
      const r = state.records.get(id); if (!r) throw new Error("reembedding migration not found");
      if (token !== r.token) throw new Error("invalid or expired reembedding confirmation");
      if (r.state === "validating") return snapshot(r);
      if (r.state !== "running") throw new Error(`reembedding resume requires running state; found ${r.state}`);
      runBatch(r); return snapshot(r);
    }),
    status: (id) => Promise.resolve(state.records.has(id) ? snapshot(state.records.get(id)!) : null),
  };
  if (o.withValidate !== false) {
    engine.validate = ({ id }) => guard("validate", () => {
      const r = state.records.get(id)!; if (r.state !== "validating") throw new Error(`reembedding validate requires validating state; found ${r.state}`);
      const g = state.generations.get(r.target.generation)!;
      for (const t of r.source.tables) if ((g.tables.get(t.tableId)?.length ?? 0) !== t.rowCount) throw new Error("reembedding target generation row count mismatch");
      r.state = "ready_to_switch"; return snapshot(r);
    });
  }

  /** Recall against the ACTIVE generation, embedding the query with that generation's own model. */
  const recall = (query: string, k = 5): string[] => {
    const g = state.generations.get(state.activeGeneration)!; const q = embed(g.fingerprint, query);
    return [...g.tables.values()].flat().map((r) => ({ id: r.id, s: cosine(q, r.vector) })).sort((a, b) => b.s - a.s || (a.id < b.id ? -1 : 1)).slice(0, k).map((x) => x.id);
  };
  /** The fake switch port: one assignment, like one config.set replacing config.json. */
  const switchPort: SwitchPort & { applied: unknown[] } = {
    applied: [],
    async apply(sel) { state.activeGeneration = sel.generation; state.activeFingerprint = state.generations.get(sel.generation)!.fingerprint; switchPort.applied.push(sel); },
  };
  return { engine, state, recall, switchPort, source };
}
