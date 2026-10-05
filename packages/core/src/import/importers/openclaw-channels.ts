// OpenClaw channel allowlist extractor (docs/import.md §2.2).
// Maps `channels.<platform>.allowFrom` to harness bot-connection allowlists.
// Safe metadata only; channel tokens are secrets handled separately.

export interface ChannelAllowlistReport {
  platform: string;
  allowFrom: string[];
  groups?: string[];
  action: "imported";
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
        allowFrom,
        ...(groups ? { groups } : {}),
        action: "imported",
      });
    }
  }
  return reports.sort((a, b) => a.platform.localeCompare(b.platform));
}
