// Role resolution for model discovery (spec §2.7 step 6, R15; plan Task 5, P9).
import type { CatalogFile, ScanWarning } from "./types.ts";

export interface ResolvedRole {
  provider: string;
  id: string;
  state: "available" | "unavailable";
}

/**
 * Resolves a role value in order:
 * (1) <provider>/<rest> for the longest provider id P with value starting P + "/", matching rest against id or alias of P;
 * (2) bare value against id or alias of every entry.
 * A role warns only if every match is unavailable.
 */
export function resolveRole(value: string, catalog: CatalogFile): ResolvedRole | null {
  const providers = Array.from(new Set(catalog.models.map((m) => m.provider))).sort((a, b) => b.length - a.length);

  for (const p of providers) {
    const prefix = `${p}/`;
    if (value.startsWith(prefix)) {
      const rest = value.slice(prefix.length);
      const matches = catalog.models.filter((m) => m.provider === p && (m.id === rest || m.aliases.includes(rest)));
      if (matches.length > 0) {
        const avail = matches.find((m) => m.status === "available" || m.status === "manual");
        const chosen = avail ?? matches[0]!;
        return {
          provider: chosen.provider,
          id: chosen.id,
          state: chosen.status === "available" || chosen.status === "manual" ? "available" : "unavailable",
        };
      }
    }
  }

  const matches = catalog.models.filter((m) => m.id === value || m.aliases.includes(value));
  if (matches.length > 0) {
    const avail = matches.find((m) => m.status === "available" || m.status === "manual");
    const chosen = avail ?? matches[0]!;
    return {
      provider: chosen.provider,
      id: chosen.id,
      state: chosen.status === "available" || chosen.status === "manual" ? "available" : "unavailable",
    };
  }

  return null;
}

export function roleWarnings(catalog: CatalogFile, roles: Readonly<Record<string, string>>, provider?: string): ScanWarning[] {
  const warnings: ScanWarning[] = [];
  for (const [role, value] of Object.entries(roles)) {
    const res = resolveRole(value, catalog);
    if (res !== null && res.state === "unavailable") {
      if (provider === undefined || res.provider === provider) {
        warnings.push({
          code: "role_unavailable",
          role,
          provider: res.provider,
          id: res.id,
        });
      }
    }
  }
  return warnings;
}
