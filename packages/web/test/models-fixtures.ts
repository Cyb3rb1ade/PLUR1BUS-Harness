// Shared fixtures for the Models page state, role and name tests: the models.* handlers of docs/rpc.md over test/mock-rpc.ts.
// Provider and model names are neutral on purpose (alpha, beta, ...): the page must show whatever the backend sends, and a
// fixture that borrowed a real vendor name could hide a hard-coded one (see models-names.test.ts).
import { rpcError, type MockRpc } from "./mock-rpc.ts";

export type Model = Record<string, unknown>;

/** A complete ModelEntry as the backend sends it (every required key of the schema, contextWindow set). */
export const model = (o: Model = {}): Model => ({
  provider: "alpha", id: "alpha-1", displayName: "Alpha One", kind: "chat", contextWindow: 32000, capabilities: ["tools"], aliases: [],
  status: "available", firstSeen: "2026-10-03T07:12:44.120Z", lastSeen: "2026-10-03T07:12:44.120Z", source: "scan", overrides: {}, ...o,
});

/** Only the keys the schema requires; every optional field (contextWindow, new) is left out. */
export const requiredOnly = (o: Model = {}): Model => ({
  provider: "alpha", id: "plain", displayName: "Plain", kind: "unknown", capabilities: [], aliases: [],
  status: "available", firstSeen: "2026-10-03T07:12:44.120Z", lastSeen: "2026-10-03T07:12:44.120Z", source: "scan", overrides: {}, ...o,
});

export const keyOf = (m: Model): string => `${String(m.provider)}\u0000${String(m.id)}`;

export type Catalog = {
  models: Model[];
  providers: Model[];
  warnings: Model[];
  newIds: Set<string>;
  /** When true, every entry carries `new: boolean` as the backend does (ModelEntry.new in rpc.schema.json). */
  sendNewFlag: boolean;
};

/** The three-provider catalog most tests use. alpha-1 and beta-1 are new; alpha-3 and gamma-1 are unavailable; beta-2 is manual. */
export function defaultCatalog(): Catalog {
  const models = [
    model(),
    model({ id: "alpha-2", displayName: "Alpha Two", kind: "embedding" }),
    model({ id: "alpha-3", displayName: "Alpha Three", status: "unavailable" }),
    model({ provider: "beta", id: "beta-1", displayName: "Beta One" }),
    model({ provider: "beta", id: "beta-2", displayName: "Beta Manual", source: "manual", status: "manual", overrides: { displayName: "Beta Manual" } }),
    model({ provider: "gamma", id: "gamma-1", displayName: "Gamma One", status: "unavailable" }),
  ];
  return {
    models,
    providers: [
      { provider: "alpha", lastScanAt: "2026-10-03T07:12:44.120Z", lastResult: "ok" },
      { provider: "beta", lastScanAt: "2026-10-03T07:12:44.120Z", lastResult: "ok" },
    ],
    warnings: [],
    newIds: new Set([keyOf(models[0]!), keyOf(models[3]!)]),
    sendNewFlag: false,
  };
}

/** What models.list answers for `params` over the catalog `c`. */
export function listResult(c: Catalog, params: unknown): Model {
  const only = (params as { newOnly?: boolean } | undefined)?.newOnly === true;
  const shown = only ? c.models.filter((m) => c.newIds.has(keyOf(m))) : c.models;
  const models = c.sendNewFlag ? shown.map((m) => ({ ...m, new: c.newIds.has(keyOf(m)) })) : shown;
  return { models, providers: c.providers, newCount: c.newIds.size, warnings: c.warnings };
}

/** Installs models.list, acknowledge, scan, setOverride and removeManual over a mutable catalog and returns it. */
export function installCatalog(rpc: MockRpc, over: Partial<Catalog> = {}): Catalog {
  const c: Catalog = { ...defaultCatalog(), ...over };
  rpc.handle("models.list", (p) => listResult(c, p), { write: false });
  rpc.handle("models.acknowledge", () => { c.newIds.clear(); return { acknowledgedAt: "2026-10-07T08:00:00Z" }; });
  rpc.handle("models.scan", () => ({ startedAt: "2026-10-07T08:00:00Z", finishedAt: "2026-10-07T08:00:01Z", providers: [] }));
  rpc.handle("models.setOverride", (p) => {
    const q = p as { provider: string; id: string; set?: Model; create?: boolean };
    const found = c.models.find((m) => m.provider === q.provider && m.id === q.id);
    if (found) { Object.assign(found, q.set ?? {}); found.overrides = { ...(found.overrides as Model), ...(q.set ?? {}) }; return found; }
    const created = model({ provider: q.provider, id: q.id, displayName: q.id, source: "manual", status: "manual", ...(q.set ?? {}), overrides: q.set ?? {} });
    c.models.push(created);
    return created;
  });
  rpc.handle("models.removeManual", (p) => {
    const q = p as { provider: string; id: string };
    const n = c.models.length;
    c.models = c.models.filter((m) => !(m.provider === q.provider && m.id === q.id));
    return { removed: c.models.length < n };
  });
  return c;
}

/** A promise a test opens by hand: lets a handler hold its answer without any timer. */
export function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait, open };
}

export { rpcError };
