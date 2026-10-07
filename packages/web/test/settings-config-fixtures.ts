// Mock config.get / config.set for the Settings config sections. State lives in the returned object; `set` records applied calls.
import { rpcError, type MockRpc } from "./mock-rpc.ts";

export const RESTART: Record<string, string> = {
  "core.logLevel": "live", "core.recall.softBudgetMs": "core", "core.recall.hardBudgetMs": "live", "metrics.enabled": "core", "metrics.port": "core",
  "embedding.useClass": "core", "egress.allowHosts": "live", "egress.allowPorts": "live", "egress.allowLoopback": "live", "models.scan.enabled": "live",
  "models.scan.intervalHours": "live", "modelRoles": "live", "providers": "live",
};

export type Fake = { config: Record<string, unknown>; revision: number; sets: unknown[] };

const at = (o: unknown, key: string): unknown => key.split(".").reduce<unknown>((a, s) => (typeof a === "object" && a !== null ? (a as Record<string, unknown>)[s] : undefined), o);
function put(o: Record<string, unknown>, key: string, v: unknown): void {
  const segs = key.split(".");
  let cur = o;
  for (const s of segs.slice(0, -1)) cur = (cur[s] ??= {}) as Record<string, unknown>;
  cur[segs[segs.length - 1]!] = v;
}

export function seedConfig(rpc: MockRpc, config: Record<string, unknown> = {}): Fake {
  const f: Fake = {
    config: { schemaVersion: 1, core: { logLevel: "warn", recall: { softBudgetMs: 400 } }, metrics: { port: 9464 }, egress: { allowHosts: ["api.example.com"], allowPorts: [443] },
      modelRoles: { chat: "anthropic/claude-x", apiKey: "sk-should-not-show" }, providers: { anthropic: { apiKey: "sk-secret-123", baseUrl: "https://x" } },
      embedding: { useClass: "general" }, ...config },
    revision: 1, sets: [],
  };
  rpc.handle("config.get", (p) => {
    const key = (p as { key?: string } | undefined)?.key;
    if (key === undefined) return { key: null, tier: null, value: f.config, restartClass: null, restart: null, revision: `r${f.revision}` };
    const cls = RESTART[key] ?? null;
    return { key, tier: "advanced", value: at(f.config, key) ?? null, restartClass: cls, restart: cls, revision: `r${f.revision}` };
  }, { write: false });
  rpc.handle("config.set", (p) => {
    const q = p as { changes: { key: string; value: unknown }[]; dryRun?: boolean; ifRevision?: string };
    if (q.ifRevision !== `r${f.revision}`) throw rpcError("E_CONFLICT", "config changed", "config-changed");
    const plan = { live: q.changes.filter((c) => RESTART[c.key] === "live").map((c) => c.key), core: q.changes.some((c) => RESTART[c.key] === "core"), modules: [] };
    if (!q.dryRun) {
      f.sets.push(p);
      for (const c of q.changes) put(f.config, c.key, c.value);
      f.revision += 1;
    }
    return { applied: !q.dryRun, dryRun: q.dryRun === true, changed: q.changes.map((c) => c.key), restart: plan, revision: `r${f.revision}`, restarted: !q.dryRun && plan.core ? ["core"] : [], durationMs: 3 };
  });
  return f;
}
