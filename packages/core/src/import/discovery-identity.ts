// Stable, bounded display identities for untrusted source configuration; no source field grants target authority.
import { createHash } from "node:crypto";
import type { SourceType } from "./types.ts";

/** SHA-256 of a fixed, JSON-safe import descriptor. Credential values must never be passed here. */
export function discoveryFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** A readable ASCII label; the identity hash, rather than this lossy label, distinguishes collisions. */
export function discoveryLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "unknown";
}

/** Assigns a p1x-compatible name while keeping case-distinct source profiles distinct in the identity. */
export function discoveryIdentity(source: SourceType, profile: string | null, name: string) {
  const identity = discoveryFingerprint([source, profile, name]);
  const label = `${source}-${profile === null ? "default" : discoveryLabel(profile)}-${discoveryLabel(name)}`;
  return { name: `${label.slice(0, 49).replace(/-+$/g, "")}-${identity.slice(0, 12)}`,
    profile: profile === null ? null : discoveryLabel(profile), identity };
}
