import { createEngine } from "@cyb3rb1ade/plur1bus-memory/engine/create-engine.js";
import { defaults } from "@plur1bus/config-schema";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildEngineConfig } from "../../engine-config.ts";
import { createBackfill } from "../../identity/backfill.ts";
import { createEngineRebindPort, rebindLookupFromService } from "../../identity/engine-rebind.ts";
import { createIdentityService } from "../../identity/service.ts";
import { layout } from "../../paths.ts";
import { ImportError } from "../types.ts";
import { createTempHost } from "./hermes-stores.ts";

export interface BackfillOptions {
  home: string;
  agentId: string;
  apply?: boolean | undefined;
  testInternals?: Record<string, unknown> | undefined;
}

export interface BackfillResultReport {
  schema: "import.backfill/1";
  mode: "dry-run" | "apply";
  agentId: string;
  reboundCount: number;
  links: Array<{
    linkId: string;
    humanId: string;
    channel: string;
    userId: string;
    from: string;
    to: string;
    count: number;
    receipt?: string;
  }>;
}

export async function importBackfill(opts: BackfillOptions): Promise<BackfillResultReport> {
  const l = layout(opts.home);
  const isApply = opts.apply === true;
  const agentId = (opts.agentId ?? "").trim();
  if (!agentId) {
    throw new ImportError("E_INVALID_PARAMS", "agent-missing", "--agent <id> is required for backfill");
  }

  const dbPath = join(l.state, "identity.sqlite");
  if (!existsSync(dbPath)) {
    return {
      schema: "import.backfill/1",
      mode: isApply ? "apply" : "dry-run",
      agentId,
      reboundCount: 0,
      links: [],
    };
  }

  const service = createIdentityService({
    dbPath,
    clock: () => Date.now(),
    audit: () => {},
  });

  let rawConfig: any;
  if (existsSync(l.configPath)) {
    try {
      rawConfig = JSON.parse(readFileSync(l.configPath, "utf8"));
    } catch {
      rawConfig = defaults();
    }
  } else {
    rawConfig = defaults();
  }

  const testInternals = opts.testInternals ?? (
    (process.env.NODE_TEST_CONTEXT || process.env.PLUR1BUS_TEST_INTERNALS === "1")
      ? {
          embeddings: {
            embed: async () => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)),
            embedQuery: async () => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)),
            embedPassage: async () => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)),
            embedBatch: async (texts: string[]) => texts.map(() => Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0))),
            shutdown: async () => {},
          },
          reranker: null,
        }
      : undefined
  );

  const engineDefaults = defaults().engine;
  const engineConfigTarget = {
    ...defaults(),
    ...rawConfig,
    core: {
      ...defaults().core,
      ...(rawConfig.core ?? {}),
      recall: {
        ...defaults().core.recall,
        ...(rawConfig.core?.recall ?? {}),
      },
    },
    engine: {
      ...engineDefaults,
      ...(rawConfig.engine?.baseDbPathOverride ? { baseDbPathOverride: rawConfig.engine.baseDbPathOverride } : {}),
      ...(rawConfig.engine?.embedding ? { embedding: rawConfig.engine.embedding } : {}),
      ...(rawConfig.engine?.reranker ? { reranker: rawConfig.engine.reranker } : {}),
      ...(rawConfig.engine?.recall ? { recall: rawConfig.engine.recall } : {}),
    },
  };

  const engine = createEngine(
    createTempHost(l.state, async (id: string) => l.workspaceDir(id)),
    buildEngineConfig(engineConfigTarget, l) as any,
    testInternals ? { internals: testInternals } : undefined,
  );

  try {
    const lookup = rebindLookupFromService(service);
    const rebindPort = createEngineRebindPort({
      engine,
      agentId,
      lookup,
    });
    const backfill = createBackfill({
      service,
      engine: rebindPort,
      clock: () => Date.now(),
    });

    const actor = { user: "operator", host: "cli" };
    const linksReport: BackfillResultReport["links"] = [];
    let totalRebound = 0;

    const humans = service.list({}).humans;
    for (const human of humans) {
      for (const link of human.identities) {
        if (link.revokedAt !== null) continue;
        try {
          const res = await backfill.run({ linkId: link.id, dryRun: !isApply }, actor);
          totalRebound += res.count;
          linksReport.push({
            linkId: link.id,
            humanId: human.id,
            channel: link.channel,
            userId: link.userId,
            from: res.from,
            to: res.to,
            count: res.count,
            ...(res.receipt ? { receipt: res.receipt } : {}),
          });
        } catch (err: any) {
          if (err?.code === "conflict" && String(err?.message || "").includes("reversed")) {
            continue;
          }
        }
      }
    }

    return {
      schema: "import.backfill/1",
      mode: isApply ? "apply" : "dry-run",
      agentId,
      reboundCount: totalRebound,
      links: linksReport,
    };
  } finally {
    try {
      await (engine as any).close?.({ budgetMs: 1_000 });
    } catch {}
  }
}

export function renderBackfill(r: BackfillResultReport): string {
  const L: string[] = [];
  L.push(`Backfill for agent '${r.agentId}' — ${r.mode === "dry-run" ? "DRY RUN (nothing rebound; add --apply)" : "applied"}`);
  if (r.links.length === 0) {
    L.push("  no active identity links found to rebind");
  } else {
    L.push("", `Identities (${r.links.length}):`);
    for (const l of r.links) {
      L.push(`  ${l.channel}:${l.userId} (${l.from}) → human ${l.humanId} (${l.to}): ${l.count} cards${l.receipt ? ` [receipt: ${l.receipt}]` : ""}`);
    }
  }
  L.push("", `Summary: ${r.mode === "dry-run" ? "would rebind" : "rebound"} ${r.reboundCount} cards across ${r.links.length} identities for agent '${r.agentId}'.`);
  return L.join("\n");
}
