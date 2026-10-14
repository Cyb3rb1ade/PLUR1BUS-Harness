// The curated model metadata table and enrichment (spec §2.5, R7, R8; plan Task 2).
// Precedence per field: user override > API value > table > name heuristic (kind only) > unknown / absent / [].
// No network, no third-party catalog: the table changes only with a harness release.
import bundled from "../../catalog/model-metadata.json" with { type: "json" };
import { CAPABILITIES, MODEL_KINDS } from "./types.ts";
import type { ApiFields, CatalogFile, CatalogModel, Capability, ModelKind, ModelOverrides, RawEntry } from "./types.ts";

export interface MetadataRule { pattern: string; kind: ModelKind; contextWindow?: number; capabilities: Capability[]; aliases?: string[] }
export interface CompiledTable { revision: string; sections: Map<string, { rule: MetadataRule; re: RegExp }[]> }

const MAX_PATTERN = 200;
// The RE2-safe subset: no backreference, no named back-reference, no lookaround, no nested quantifier; anchored; at most 200 characters.
const BACKREF = /\\[1-9]|\\k</;
const LOOKAROUND = /\(\?<?[=!]/;

/** The table that ships with the harness, compiled. The only way to get it besides calling `loadMetadataTable()` with no argument. */
export function loadBundledMetadataTable(): CompiledTable { return loadMetadataTable(bundled); }

/**
 * True when a repeated group (`+`, `*`, `{n,}` or `{n,m}` with m > 1) contains another such repetition at any depth, e.g.
 * `(a+)+`, `(a|b*)*`, `((a+)b)+`, `(a{1,3}){2,5}` (exponential or polynomial backtracking in a JavaScript RegExp).
 * `?` is not a repetition here. Escapes and character classes are skipped as single atoms.
 */
export function hasNestedQuantifier(p: string): boolean {
  const quantifier = (i: number): { len: number; repeating: boolean } => {
    const lazy = (n: number) => n + (p[i + n] === "?" ? 1 : 0);
    const c = p[i];
    if (c === "*" || c === "+") return { len: lazy(1), repeating: true };
    if (c === "?") return { len: lazy(1), repeating: false };
    if (c === "{") {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(p.slice(i, i + 24));
      if (m) return { len: lazy(m[0].length), repeating: (m[2] === undefined ? Number(m[1]) : m[3] === "" ? Infinity : Number(m[3])) > 1 };
    }
    return { len: 0, repeating: false };
  };
  const groups: { inner: boolean }[] = [{ inner: false }];
  let i = 0;
  while (i < p.length) {
    const c = p[i]!;
    if (c === "(") {
      groups.push({ inner: false }); i++;
      if (p[i] === "?") { i++; if (p[i] === ":") i++; else if (p[i] === "<") { while (i < p.length && p[i] !== ">") i++; i++; } }
      continue;
    }
    if (c === ")" && groups.length > 1) {
      const g = groups.pop()!; i++;
      const q = quantifier(i); i += q.len;
      if (q.repeating && g.inner) return true;
      if (q.repeating || g.inner) groups[groups.length - 1]!.inner = true;
      continue;
    }
    if (c === "\\") i += 2;
    else if (c === "[") {
      i++; if (p[i] === "^") i++; if (p[i] === "]") i++;
      while (i < p.length && p[i] !== "]") i += p[i] === "\\" ? 2 : 1;
      i++;
    } else i++;
    const q = quantifier(i); i += q.len;
    if (q.repeating) groups[groups.length - 1]!.inner = true;
  }
  return false;
}

/**
 * Throws an Error listing every violation. Calling it with NO argument loads the bundled table (an explicit request);
 * passing `undefined` (e.g. the result of a failed read of an external table) throws instead of silently falling back.
 */
export function loadMetadataTable(...args: [raw?: unknown]): CompiledTable {
  const raw = args.length === 0 ? bundled : args[0];
  const errors: string[] = [];
  const sections = new Map<string, { rule: MetadataRule; re: RegExp }[]>();
  const seen = new Map<string, string>();
  const seenAliases = new Map<string, string>();
  const r = raw as { schema?: unknown; revision?: unknown; vendors?: unknown } | null;
  if (typeof r !== "object" || r === null) throw new Error("metadata table must be an object");
  if (r.schema !== "plur1bus.model-metadata/1") errors.push("schema must be plur1bus.model-metadata/1");
  if (typeof r.revision !== "string" || r.revision === "") errors.push("revision must be a non-empty string");
  if (typeof r.vendors !== "object" || r.vendors === null || Array.isArray(r.vendors)) errors.push("vendors must be an object");
  else {
    for (const [section, rules] of Object.entries(r.vendors as Record<string, unknown>)) {
      if (!Array.isArray(rules)) { errors.push(`${section}: must be an array of rules`); continue; }
      const compiled: { rule: MetadataRule; re: RegExp }[] = [];
      rules.forEach((x: unknown, i: number) => {
        const w = `${section}[${i}]`;
        const rule = x as Partial<MetadataRule> | null;
        if (typeof rule !== "object" || rule === null || typeof rule.pattern !== "string") { errors.push(`${w}: pattern must be a string`); return; }
        const p = rule.pattern;
        let ok = true;
        if (p.length > MAX_PATTERN) { errors.push(`${w}: pattern longer than ${MAX_PATTERN} characters`); ok = false; }
        if (!p.startsWith("^") || !p.endsWith("$")) { errors.push(`${w}: pattern must be anchored with ^ and $`); ok = false; }
        if (BACKREF.test(p) || LOOKAROUND.test(p)) { errors.push(`${w}: pattern is outside the RE2-safe subset`); ok = false; }
        else if (hasNestedQuantifier(p)) { errors.push(`${w}: pattern is outside the RE2-safe subset (nested quantifier)`); ok = false; }
        if (seen.has(p)) { errors.push(`${w}: duplicate pattern (also ${seen.get(p)})`); ok = false; } else seen.set(p, w);
        if (!(MODEL_KINDS as readonly unknown[]).includes(rule.kind)) { errors.push(`${w}: kind is not in the vocabulary`); ok = false; }
        if (!(Array.isArray(rule.capabilities) && rule.capabilities.every((c) => (CAPABILITIES as readonly unknown[]).includes(c)))) { errors.push(`${w}: capabilities not in the vocabulary`); ok = false; }
        if (rule.contextWindow !== undefined && !(Number.isInteger(rule.contextWindow) && rule.contextWindow > 0)) { errors.push(`${w}: contextWindow must be a positive integer`); ok = false; }
        if (rule.aliases !== undefined) {
          if (!(Array.isArray(rule.aliases) && rule.aliases.every((a) => typeof a === "string"))) {
            errors.push(`${w}: aliases must be strings`);
            ok = false;
          } else {
            for (const a of rule.aliases) {
              if (seenAliases.has(a)) {
                errors.push(`${w}: duplicate alias (also ${seenAliases.get(a)})`);
                ok = false;
              } else {
                seenAliases.set(a, w);
              }
            }
          }
        }
        if (!ok) return;
        let re: RegExp;
        try { re = new RegExp(p); } catch { errors.push(`${w}: pattern does not compile`); return; }
        compiled.push({ rule: rule as MetadataRule, re });
      });
      sections.set(section, compiled);
    }
  }
  if (errors.length > 0) throw new Error(`invalid model metadata table:\n- ${errors.join("\n- ")}`);
  return { revision: r.revision as string, sections };
}

/** The vendor section first, then "generic"; the first match wins. */
export function lookup(t: CompiledTable, vendor: string | undefined, id: string): MetadataRule | null {
  const names = vendor !== undefined && vendor !== "generic" ? [vendor, "generic"] : ["generic"];
  for (const n of names) for (const { rule, re } of t.sections.get(n) ?? []) if (re.test(id)) return rule;
  return null;
}

/** A fallback for `kind` only, from conservative id fragments; "unknown" when nothing matches, never "chat". */
export function heuristicKind(id: string): ModelKind {
  const s = id.toLowerCase();
  if (/gpt-live|realtime/.test(s)) return "realtime";
  if (/embed/.test(s)) return "embedding";
  if (/rerank/.test(s)) return "rerank";
  if (/whisper|transcribe/.test(s)) return "asr";
  if (/(^|[^a-z])tts([^a-z]|$)|speech/.test(s)) return "tts";
  if (/moderation/.test(s)) return "moderation";
  if (/dall-e|imagen|image/.test(s)) return "image";
  return "unknown";
}

export type Effective = Pick<CatalogModel, "displayName" | "kind" | "contextWindow" | "capabilities" | "aliases">;

export function enrich(id: string, api: ApiFields, overrides: ModelOverrides, t: CompiledTable, vendor: string | undefined): { fields: Effective; source: "scan" | "table" } {
  const rule = lookup(t, vendor, id);
  const contextWindow = overrides.contextWindow ?? api.contextWindow ?? rule?.contextWindow;
  const fields: Effective = {
    displayName: overrides.displayName ?? api.displayName ?? id,
    kind: overrides.kind ?? api.kind ?? rule?.kind ?? heuristicKind(id),
    capabilities: [...(overrides.capabilities ?? api.capabilities ?? rule?.capabilities ?? [])],
    aliases: [...(overrides.aliases ?? rule?.aliases ?? [])],
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
  const tableFilled = rule !== null && (
    api.kind === undefined
    || (rule.contextWindow !== undefined && api.contextWindow === undefined)
    || (rule.capabilities.length > 0 && api.capabilities === undefined)
  );
  return { fields, source: tableFilled ? "table" : "scan" };
}

/** Enforce uniqueness of resolved alias -> id mapping per provider after enrichment (F4).
 * Returns a new array of models where duplicate aliases within any single provider have been dropped,
 * without mutating input model objects.
 */
export function dedupResolvedAliases(
  models: readonly CatalogModel[],
  rawEntries?: readonly RawEntry[],
  logger?: { debug(m: string, f?: object): void }
): CatalogModel[] {
  const rawMap = new Map<string, RawEntry>();
  if (rawEntries) {
    for (const r of rawEntries) rawMap.set(r.id, r);
  }

  const byProvider = new Map<string, CatalogModel[]>();
  for (const m of models) {
    const list = byProvider.get(m.provider) ?? [];
    list.push(m);
    byProvider.set(m.provider, list);
  }

  const result: CatalogModel[] = [];

  for (const [provider, provModels] of byProvider) {
    const aliasMap = new Map<string, CatalogModel[]>();
    for (const m of provModels) {
      for (const a of m.aliases) {
        const list = aliasMap.get(a) ?? [];
        list.push(m);
        aliasMap.set(a, list);
      }
    }

    const droppedAliases = new Map<string, Set<string>>();

    for (const [alias, claimants] of aliasMap) {
      if (claimants.length <= 1) continue;

      const scored = claimants.map((m) => {
        const raw = rawMap.get(m.id);
        const rawCreated = raw?.created;

        const dateMatch = m.id.match(/-(\d{4})-?(\d{2})-?(\d{2})/);
        let idDateMs: number | undefined;
        if (dateMatch) {
          const y = parseInt(dateMatch[1]!, 10);
          const mon = parseInt(dateMatch[2]!, 10) - 1;
          const d = parseInt(dateMatch[3]!, 10);
          idDateMs = Date.UTC(y, mon, d);
        }

        const isBaseMatch = !dateMatch;

        return {
          model: m,
          // A user's own alias (override or manual entry) outranks a table alias, and a model that is still
          // listed outranks one that has gone: the alias must resolve to something that can be used.
          userAlias: m.source === "manual" || (m.overrides.aliases?.includes(alias) ?? false),
          live: m.status !== "unavailable",
          rawCreated,
          idDateMs,
          isBaseMatch,
        };
      });

      scored.sort((a, b) => {
        if (a.userAlias !== b.userAlias) return a.userAlias ? -1 : 1;
        if (a.live !== b.live) return a.live ? -1 : 1;
        if (a.rawCreated !== undefined && b.rawCreated !== undefined) {
          return b.rawCreated - a.rawCreated;
        }
        if (a.rawCreated !== undefined && b.rawCreated === undefined) return -1;
        if (a.rawCreated === undefined && b.rawCreated !== undefined) return 1;

        if (a.isBaseMatch && !b.isBaseMatch) return -1;
        if (!a.isBaseMatch && b.isBaseMatch) return 1;

        if (a.idDateMs !== undefined && b.idDateMs !== undefined) {
          return b.idDateMs - a.idDateMs;
        }
        return a.model.id.localeCompare(b.model.id);
      });

      const winner = scored[0]!.model;
      const losers = scored.slice(1).map((s) => s.model);

      for (const loser of losers) {
        let set = droppedAliases.get(loser.id);
        if (!set) {
          set = new Set();
          droppedAliases.set(loser.id, set);
        }
        set.add(alias);
      }

      logger?.debug("resolved alias collision", {
        provider,
        alias,
        winner: winner.id,
        droppedFrom: losers.map((l) => l.id),
      });
    }

    for (const m of provModels) {
      const dropped = droppedAliases.get(m.id);
      if (dropped && dropped.size > 0) {
        result.push({
          ...m,
          aliases: m.aliases.filter((a) => !dropped.has(a)),
        });
      } else {
        result.push({ ...m, aliases: [...m.aliases] });
      }
    }
  }

  return result;
}

/** Re-runs the table for entries whose source is "table" (from their stored API values); overrides, scan and manual entries stay. */
export function reenrichCatalog(
  c: CatalogFile,
  t: CompiledTable,
  vendorOf: (provider: string) => string | undefined,
  logger?: { debug(m: string, f?: object): void }
): CatalogFile {
  const models = c.models.map((m): CatalogModel => {
    if (m.source !== "table") return m;
    const { fields, source } = enrich(m.id, m.api ?? {}, m.overrides, t, vendorOf(m.provider));
    const { contextWindow: _old, ...rest } = m; void _old;
    return { ...rest, ...fields, source };
  });
  const dedupedModels = dedupResolvedAliases(models, undefined, logger);
  return { ...c, tableRevision: t.revision, models: dedupedModels };
}
