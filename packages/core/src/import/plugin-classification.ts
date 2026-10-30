// Mv2 A13 display-only foreign plugin classification. Declarations describe portability; no plugin code is loaded.
import { discoveryIdentity } from "./discovery-identity.ts";
import { extensionSourceLimit, sourceObject, type ImportedConfigInput } from "./mcp-config.ts";
import type { SourceType } from "./types.ts";

/** A display projection only; it grants no bridge capability or installation authority. */
export interface ClassifiedForeignPlugin {
  source: SourceType;
  profile: string | null;
  name: string;
  classification: "bridge-possible" | "nonportable" | "unknown";
  parts: string[];
  reasons: string[];
}

/** Manifest facts or explicit registered-part facts, supplied by a source reader without executing the plugin. */
export interface ForeignPluginEvidence {
  source: SourceType;
  profile: string | null;
  name: string;
  manifest?: unknown;
  registeredParts?: unknown;
}

const PORTABLE = new Set(["tool", "command", "service"]);
const NONPORTABLE = new Set(["memory", "channel", "provider", "context-engine"]);
const MAX_PARTS = 256;

/** Classifies only explicit declared parts; a generic hook or incomplete declaration remains unknown. */
export function classifyForeignPlugin(input: ForeignPluginEvidence): ClassifiedForeignPlugin {
  const identity = discoveryIdentity(input.source, input.profile, input.name);
  const parts = new Set<string>();
  let unknown = false;
  let nonportable = false;
  const declared = Array.isArray(input.registeredParts) ? input.registeredParts : [];
  const manifestKind = sourceObject(input.manifest).kind;
  const facts = [...(typeof manifestKind === "string" ? [{ kind: manifestKind }] : []), ...declared];
  if (facts.length > MAX_PARTS) unknown = true;
  for (const fact of facts.slice(0, MAX_PARTS)) {
    const part = sourceObject(fact);
    if (typeof part.kind !== "string") { unknown = true; continue; }
    if (NONPORTABLE.has(part.kind)) { parts.add(part.kind); nonportable = true; }
    else if (PORTABLE.has(part.kind)) parts.add(part.kind);
    else if (part.kind === "hook" && part.mode === "read-only") parts.add("hook:read-only");
    else if (part.kind === "hook" && part.mode === "rewriting") { parts.add("hook:rewriting"); nonportable = true; }
    else unknown = true;
  }
  const classification = nonportable ? "nonportable" : unknown || parts.size === 0 ? "unknown" : "bridge-possible";
  return { source: input.source, profile: identity.profile, name: identity.name, classification,
    parts: [...parts].sort(), reasons: [nonportable ? "declared-nonportable-parts"
      : classification === "unknown" ? "incomplete-declaration" : "declared-bridge-parts"] };
}

/** Lists configured plugin IDs as unknown: configuration claims are not manifest/registered-part evidence. */
export function discoverForeignPlugins(input: ImportedConfigInput): ClassifiedForeignPlugin[] {
  const config = sourceObject(input.config);
  const plugins = sourceObject(config.plugins);
  const names = new Set(Object.keys(sourceObject(plugins.entries)));
  if (Array.isArray(config.plugins)) {
    for (const name of config.plugins) if (typeof name === "string") names.add(name);
  }
  if (names.size > MAX_PARTS) extensionSourceLimit();
  return [...names].sort().map(name => classifyForeignPlugin({
    source: input.source, profile: input.profile ?? null, name,
  }));
}
