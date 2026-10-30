import { SourceReader } from "../source-reader.ts";
// Hermes platform pairings allowlist extractor (docs/import.md §3.3, M7 Batch 3).
// Scans platforms/pairing/*-approved.json and *-pending.json.
// Approved pairing user IDs are non-reversibly fingerprinted (#104); plain text IDs never appear in reports or ledgers.
// Pending pairing codes (*-pending.json) are strictly excluded (§3.2).
// Channel allowlists are reported as "deferred" until target channel integration is configured.
import { join } from "node:path";
import { idFingerprints } from "../fingerprint.ts";
import { ImportError } from "../types.ts";

export interface HermesChannelAllowlistReport {
  platform: string;
  allowFromCount: number;
  allowFromFingerprints: string[];
  groupsCount: number;
  groupFingerprints: string[];
  action: "deferred";
  pendingExcludedCount: number;
}

export async function readHermesPairings(
  searchDirs: string[],
  errors?: Array<{ sourceRef: string; reason: string }>,
  sourceReader?: SourceReader,
): Promise<HermesChannelAllowlistReport[]> {
  const reader = sourceReader ?? await SourceReader.local();
  const reportsByPlatform = new Map<string, { rawIds: Set<string>; pendingCount: number }>();

  for (const dir of searchDirs) {
    const pairingDir = reader.paths.join(dir, "platforms", "pairing");
    if (!await reader.isDir(pairingDir)) continue;

    let entries: string[] = [];
    try {
      entries = await reader.names(pairingDir);
    } catch {
      continue;
    }

    for (const ent of entries) {
      const fullPath = reader.paths.join(pairingDir, ent);
      if (!ent.endsWith("-approved.json") && !ent.endsWith("-pending.json")) continue;
      // A refused file (symlink, FIFO, oversized) is reported by reason code, never read and never skipped silently.
      const refuse = (reason: string) => errors?.push({ sourceRef: `platforms/pairing/${ent}`, reason });

      if (ent.endsWith("-approved.json")) {
        const platform = ent.slice(0, ent.length - "-approved.json".length);
        if (!platform) continue;

        if (!await reader.exists(fullPath)) continue;
        let content: string;
        try { content = await reader.text(fullPath, 1024 * 1024); }
        catch (error) { refuse(error instanceof ImportError ? error.reason : "source-unreadable"); continue; }

        try {
          const data = JSON.parse(content);
          if (data && typeof data === "object" && !Array.isArray(data)) {
            let record = reportsByPlatform.get(platform);
            if (!record) {
              record = { rawIds: new Set<string>(), pendingCount: 0 };
              reportsByPlatform.set(platform, record);
            }
            for (const rawId of Object.keys(data)) {
              if (rawId && typeof rawId === "string") {
                record.rawIds.add(rawId);
              }
            }
          }
        } catch {
          refuse("json-unparseable");
        }
      } else if (ent.endsWith("-pending.json")) {
        const platform = ent.slice(0, ent.length - "-pending.json".length);
        if (!platform) continue;

        if (!await reader.exists(fullPath)) continue;
        let content: string;
        try { content = await reader.text(fullPath, 1024 * 1024); }
        catch (error) { refuse(error instanceof ImportError ? error.reason : "source-unreadable"); continue; }

        try {
          const data = JSON.parse(content);
          if (data && typeof data === "object" && !Array.isArray(data)) {
            let record = reportsByPlatform.get(platform);
            if (!record) {
              record = { rawIds: new Set<string>(), pendingCount: 0 };
              reportsByPlatform.set(platform, record);
            }
            record.pendingCount += Object.keys(data).length;
          }
        } catch {
          refuse("json-unparseable");
        }
      }
    }
  }

  const reports: HermesChannelAllowlistReport[] = [];
  for (const [platform, record] of reportsByPlatform.entries()) {
    const sortedRaw = [...record.rawIds].sort();
    const fingerprints = idFingerprints(platform, sortedRaw);
    reports.push({
      platform,
      allowFromCount: fingerprints.length,
      allowFromFingerprints: fingerprints,
      groupsCount: 0,
      groupFingerprints: [],
      action: "deferred",
      pendingExcludedCount: record.pendingCount,
    });
  }

  return reports.sort((a, b) => a.platform.localeCompare(b.platform));
}
