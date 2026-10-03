// Model catalog overrides and manual entries (spec §2.7, R5, R14; plan Task 5).
import { CAPABILITIES, MODEL_KINDS } from "./types.ts";
import type { CatalogFile, CatalogModel, ModelOverrides } from "./types.ts";
import { enrich, type CompiledTable } from "./metadata.ts";

export class CatalogError extends Error {
  readonly code: "invalid" | "conflict" | "not-found" | "not-manual";
  readonly field?: string;
  constructor(code: CatalogError["code"], field?: string) {
    super(`catalog error: ${code}${field ? ` (${field})` : ""}`);
    this.name = "CatalogError";
    this.code = code;
    if (field !== undefined) this.field = field;
  }
}

export interface SetOverride {
  provider: string;
  id: string;
  set?: ModelOverrides;
  clear?: (keyof ModelOverrides)[] | "all";
  create?: boolean;
}

export function validateOverrides(set: ModelOverrides, provider: string, id: string, catalog: CatalogFile): void {
  if (set.displayName !== undefined && (typeof set.displayName !== "string" || set.displayName.length === 0)) {
    throw new CatalogError("invalid", "displayName");
  }
  if (set.kind !== undefined && !(MODEL_KINDS as readonly unknown[]).includes(set.kind)) {
    throw new CatalogError("invalid", "kind");
  }
  if (set.contextWindow !== undefined && !(typeof set.contextWindow === "number" && Number.isInteger(set.contextWindow) && set.contextWindow > 0)) {
    throw new CatalogError("invalid", "contextWindow");
  }
  if (set.capabilities !== undefined && !(Array.isArray(set.capabilities) && set.capabilities.every((c) => (CAPABILITIES as readonly unknown[]).includes(c)))) {
    throw new CatalogError("invalid", "capabilities");
  }
  if (set.aliases !== undefined) {
    if (!Array.isArray(set.aliases) || set.aliases.length > 16 || !set.aliases.every((a) => typeof a === "string")) {
      throw new CatalogError("invalid", "aliases");
    }
    const seen = new Set<string>();
    for (const a of set.aliases) {
      if (seen.has(a)) throw new CatalogError("invalid", "aliases");
      seen.add(a);
    }
    for (const m of catalog.models) {
      if (m.provider === provider && m.id !== id && set.aliases.includes(m.id)) {
        throw new CatalogError("conflict", "aliases");
      }
    }
  }
}

export function applyOverride(
  c: CatalogFile,
  p: SetOverride,
  now: string,
  t: CompiledTable,
  vendor: string | undefined,
): { catalog: CatalogFile; entry: CatalogModel } {
  if (p.set) validateOverrides(p.set, p.provider, p.id, c);

  if (p.create) {
    if (c.models.some((m) => m.provider === p.provider && m.id === p.id)) {
      throw new CatalogError("conflict");
    }
    const overrides: ModelOverrides = p.set ? structuredClone(p.set) : {};
    const entry: CatalogModel = {
      provider: p.provider,
      id: p.id,
      displayName: overrides.displayName ?? p.id,
      kind: overrides.kind ?? "unknown",
      ...(overrides.contextWindow !== undefined ? { contextWindow: overrides.contextWindow } : {}),
      capabilities: [...(overrides.capabilities ?? [])],
      aliases: [...(overrides.aliases ?? [])],
      status: "manual",
      firstSeen: now,
      lastSeen: now,
      source: "manual",
      overrides,
    };
    return {
      catalog: { ...c, models: [...c.models, entry] },
      entry,
    };
  }

  const idx = c.models.findIndex((m) => m.provider === p.provider && m.id === p.id);
  if (idx === -1) throw new CatalogError("not-found");
  const existing = c.models[idx]!;

  const overrides: ModelOverrides = p.clear === "all" ? {} : structuredClone(existing.overrides);
  if (Array.isArray(p.clear)) {
    for (const k of p.clear) delete overrides[k];
  }
  if (p.set) {
    Object.assign(overrides, structuredClone(p.set));
  }

  let updated: CatalogModel;
  if (existing.source === "manual") {
    const { contextWindow: _oldCw, ...rest } = existing;
    void _oldCw;
    updated = {
      ...rest,
      displayName: overrides.displayName ?? existing.id,
      kind: overrides.kind ?? "unknown",
      ...(overrides.contextWindow !== undefined ? { contextWindow: overrides.contextWindow } : {}),
      capabilities: [...(overrides.capabilities ?? [])],
      aliases: [...(overrides.aliases ?? [])],
      overrides,
    };
  } else {
    const { fields, source } = enrich(existing.id, existing.api ?? {}, overrides, t, vendor);
    const { contextWindow: _oldCw, ...rest } = existing;
    void _oldCw;
    updated = {
      ...rest,
      ...fields,
      source,
      overrides,
    };
  }

  const models = [...c.models];
  models[idx] = updated;
  return {
    catalog: { ...c, models },
    entry: updated,
  };
}

export function removeManualEntry(c: CatalogFile, provider: string, id: string): CatalogFile {
  const idx = c.models.findIndex((m) => m.provider === provider && m.id === id);
  if (idx === -1) throw new CatalogError("not-found");
  if (c.models[idx]!.source !== "manual") throw new CatalogError("not-manual");
  const models = c.models.filter((_, i) => i !== idx);
  return { ...c, models };
}
