// OpenClaw channel allowlist extractor (docs/import.md §2.2).
// Maps `channels.<platform>.allowFrom` to harness bot-connection allowlists.
// Safe metadata only; channel tokens are secrets handled separately.
// Channels are reported as "deferred" until target channel integration is configured.
// The report carries counts + fingerprints only, never the plain ids (docs/import.md "Report privacy").
import { idFingerprints } from "../fingerprint.ts";

export interface ChannelAllowlistReport {
  platform: string;
  allowFromCount: number;
  allowFromFingerprints: string[];
  groupsCount: number;
  groupFingerprints: string[];
  action: "deferred";
}

export function readOpenclawChannels(cfg: Record<string, unknown>): ChannelAllowlistReport[] {
  const ch = cfg.channels as Record<string, any> | undefined;
  if (!ch || typeof ch !== "object") return [];
  const reports: ChannelAllowlistReport[] = [];
  for (const [platform, pcfg] of Object.entries(ch)) {
    if (!pcfg || typeof pcfg !== "object") continue;
    const allowFrom = Array.isArray(pcfg.allowFrom) ? pcfg.allowFrom.map(String) : [];
    const groups = Array.isArray(pcfg.groups) ? pcfg.groups.map(String) : undefined;
    if (allowFrom.length > 0 || (groups && groups.length > 0)) {
      reports.push({
        platform,
        allowFromCount: allowFrom.length,
        allowFromFingerprints: idFingerprints(platform, allowFrom),
        groupsCount: groups?.length ?? 0,
        groupFingerprints: idFingerprints(platform, groups ?? []),
        action: "deferred",
      });
    }
  }
  return reports.sort((a, b) => a.platform.localeCompare(b.platform));
}
