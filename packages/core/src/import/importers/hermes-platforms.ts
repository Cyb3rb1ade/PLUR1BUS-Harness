// Hermes platform pairings allowlist extractor (docs/import.md §3.3, M7 Batch 3).
// Scans platforms/pairing/*-approved.json and *-pending.json.
// Approved pairing user IDs are hashed with SHA-256; plain text IDs never appear in reports or ledgers.
// Pending pairing codes (*-pending.json) are strictly excluded (§3.2).
// Channel allowlists are reported as "deferred" until target channel integration is configured.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDir, isFile } from "../readonly.ts";

export interface HermesChannelAllowlistReport {
  platform: string;
  count: number;
  allowFromHashes: string[];
  action: "deferred";
  pendingExcludedCount: number;
}

export function readHermesPairings(searchDirs: string[]): HermesChannelAllowlistReport[] {
  const reportsByPlatform = new Map<string, { hashes: Set<string>; pendingCount: number }>();

  for (const dir of searchDirs) {
    const pairingDir = join(dir, "platforms", "pairing");
    if (!isDir(pairingDir)) continue;

    let entries: string[] = [];
    try {
      entries = readdirSync(pairingDir);
    } catch {
      continue;
    }

    for (const ent of entries) {
      const fullPath = join(pairingDir, ent);
      if (!isFile(fullPath)) continue;

      if (ent.endsWith("-approved.json")) {
        const platform = ent.slice(0, ent.length - "-approved.json".length);
        if (!platform) continue;

        try {
          const content = readFileSync(fullPath, "utf8");
          const data = JSON.parse(content);
          if (data && typeof data === "object" && !Array.isArray(data)) {
            let record = reportsByPlatform.get(platform);
            if (!record) {
              record = { hashes: new Set<string>(), pendingCount: 0 };
              reportsByPlatform.set(platform, record);
            }
            for (const rawId of Object.keys(data)) {
              if (rawId && typeof rawId === "string") {
                // Hash channel ID so plain text never leaks
                const hash = createHash("sha256").update(rawId).digest("hex").slice(0, 16);
                record.hashes.add(hash);
              }
            }
          }
        } catch {
          // Bad JSON ignored safely
        }
      } else if (ent.endsWith("-pending.json")) {
        const platform = ent.slice(0, ent.length - "-pending.json".length);
        if (!platform) continue;

        try {
          const content = readFileSync(fullPath, "utf8");
          const data = JSON.parse(content);
          if (data && typeof data === "object" && !Array.isArray(data)) {
            let record = reportsByPlatform.get(platform);
            if (!record) {
              record = { hashes: new Set<string>(), pendingCount: 0 };
              reportsByPlatform.set(platform, record);
            }
            record.pendingCount += Object.keys(data).length;
          }
        } catch {
          // Ignored
        }
      }
    }
  }

  const reports: HermesChannelAllowlistReport[] = [];
  for (const [platform, record] of reportsByPlatform.entries()) {
    reports.push({
      platform,
      count: record.hashes.size,
      allowFromHashes: [...record.hashes].sort(),
      action: "deferred",
      pendingExcludedCount: record.pendingCount,
    });
  }

  return reports.sort((a, b) => a.platform.localeCompare(b.platform));
}
