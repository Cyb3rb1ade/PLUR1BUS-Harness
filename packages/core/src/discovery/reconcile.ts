// Model catalog reconciliation (spec §2.7, R4-R6, R14, R15; plan Task 5).
// Pure: never reads a clock, a file or the network; does not bump revision.
import type { ApiFields, CatalogFile, CatalogModel, RawEntry, ScanWarning } from "./types.ts";
import { enrich, type CompiledTable } from "./metadata.ts";
import { roleWarnings } from "./roles.ts";

export interface ReconcileInput {
  catalog: CatalogFile;
  provider: string;
  raw: readonly RawEntry[];
  now: string;
  table: CompiledTable;
  vendor?: string;
  roles: Readonly<Record<string, string>>;
}

export interface ReconcileResult {
  catalog: CatalogFile;
  new: string[];
  reappeared: string[];
  unavailable: string[];
  unchanged: number;
  shadowed: string[];
  warnings: ScanWarning[];
}

export function reconcile(i: ReconcileInput): ReconcileResult {
  if (i.raw.length === 0) {
    throw new RangeError("empty raw list");
  }

  const rawMap = new Map<string, RawEntry>();
  for (const r of i.raw) rawMap.set(r.id, r);

  const newIds: string[] = [];
  const reappearedIds: string[] = [];
  const unavailableIds: string[] = [];
  let unchangedCount = 0;
  const shadowedIds: string[] = [];
  const warnings: ScanWarning[] = [];

  const otherModels = i.catalog.models.filter((m) => m.provider !== i.provider);
  const providerModels = i.catalog.models.filter((m) => m.provider === i.provider);

  // 1. Manual entries are never touched. A colliding raw id is shadowed.
  for (const m of providerModels) {
    if (m.source === "manual" && rawMap.has(m.id)) {
      shadowedIds.push(m.id);
      warnings.push({ code: "shadowed_by_manual", provider: i.provider, id: m.id });
      rawMap.delete(m.id);
    }
  }

  // 2. Existing entries for this provider
  const updatedProviderModels: CatalogModel[] = providerModels.map((m) => {
    if (m.source === "manual") {
      return structuredClone(m);
    }

    if (rawMap.has(m.id)) {
      const raw = rawMap.get(m.id)!;
      rawMap.delete(m.id);

      if (m.status === "unavailable") {
        reappearedIds.push(m.id);
      } else {
        unchangedCount += 1;
      }

      const api: ApiFields = {
        ...(raw.displayName !== undefined ? { displayName: raw.displayName } : {}),
        ...(raw.kind !== undefined ? { kind: raw.kind } : {}),
        ...(raw.contextWindow !== undefined ? { contextWindow: raw.contextWindow } : {}),
        ...(raw.capabilities !== undefined ? { capabilities: raw.capabilities } : {}),
      };

      const { fields, source } = enrich(m.id, api, m.overrides, i.table, i.vendor);
      const { contextWindow: _oldCw, ...rest } = m;
      void _oldCw;

      return {
        ...rest,
        ...fields,
        status: "available",
        lastSeen: i.now,
        source,
        api,
      };
    }

    // Missing: an entry whose id is not in raw becomes unavailable
    if (m.status === "available") {
      unavailableIds.push(m.id);
      return {
        ...m,
        status: "unavailable",
      };
    }

    return structuredClone(m);
  });

  // 3. New entries from remaining items in rawMap
  for (const [id, raw] of rawMap) {
    newIds.push(id);
    const api: ApiFields = {
      ...(raw.displayName !== undefined ? { displayName: raw.displayName } : {}),
      ...(raw.kind !== undefined ? { kind: raw.kind } : {}),
      ...(raw.contextWindow !== undefined ? { contextWindow: raw.contextWindow } : {}),
      ...(raw.capabilities !== undefined ? { capabilities: raw.capabilities } : {}),
    };

    const { fields, source } = enrich(id, api, {}, i.table, i.vendor);
    const newEntry: CatalogModel = {
      provider: i.provider,
      id,
      ...fields,
      status: "available",
      firstSeen: i.now,
      lastSeen: i.now,
      source,
      overrides: {},
      api,
    };
    updatedProviderModels.push(newEntry);
  }

  const nextCatalog: CatalogFile = {
    ...i.catalog,
    models: [...otherModels, ...updatedProviderModels],
  };

  // Role warnings
  const rWarnings = roleWarnings(nextCatalog, i.roles, i.provider);
  warnings.push(...rWarnings);

  return {
    catalog: nextCatalog,
    new: newIds,
    reappeared: reappearedIds,
    unavailable: unavailableIds,
    unchanged: unchangedCount,
    shadowed: shadowedIds,
    warnings,
  };
}
