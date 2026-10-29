// A13's internal discovery channel stays beside SourceReport, whose existing CLI JSON projection remains unchanged.
import { extensionSourceLimit, parseImportedMcpConfig, type ImportedMcpCandidate } from "./mcp-config.ts";
import { discoverForeignPlugins, type ClassifiedForeignPlugin } from "./plugin-classification.ts";
import type { SourceType } from "./types.ts";

/** Sanitized facts for the new GUI/RPC source view; never spread into an existing CLI report. */
export interface SourceDiscovery {
  mcpCandidates: ImportedMcpCandidate[];
  plugins: ClassifiedForeignPlugin[];
}

/** Captures decoded source configurations in memory and immediately drops all fields outside the pure projections. */
export function createSourceDiscovery(source: SourceType) {
  const discovery: SourceDiscovery = { mcpCandidates: [], plugins: [] };
  return {
    discovery,
    capture(config: unknown, profile: string | null): void {
      const candidates = parseImportedMcpConfig({ source, profile, config });
      const plugins = discoverForeignPlugins({ source, profile, config });
      if (discovery.mcpCandidates.length + candidates.length > 256 || discovery.plugins.length + plugins.length > 256) extensionSourceLimit();
      discovery.mcpCandidates.push(...candidates);
      discovery.plugins.push(...plugins);
    },
  };
}
