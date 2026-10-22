import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { hostEvalGate, type HostEvalReport, type ModelRef } from './host-eval.ts';
/** State is not writable by sandboxed agents; invalid/missing/oversized/stale evidence is never a pass. */
export async function readHostEvalReports(home: string, now = Date.now()): Promise<HostEvalReport[]> {
  let h;
  try {
    h = await open(join(home, 'state', 'tool-eval', 'host-reports.json'), 'r');
    const stat = await h.stat(); if (!stat.isFile() || stat.size > 1024*1024) return [];
    const bytes = Buffer.alloc(1024*1024+1); const read = await h.read(bytes,0,bytes.length,0); if(read.bytesRead>1024*1024)return [];
    const raw: unknown = JSON.parse(bytes.subarray(0,read.bytesRead).toString('utf8'));
    if (!Array.isArray(raw) || raw.length > 1000) return [];
    return raw.filter((r): r is HostEvalReport => {
      if (!r || typeof r !== 'object') return false;
      const v = r as HostEvalReport;
      const date = Date.parse(v.generatedAt);
      return typeof v.provider === 'string' && typeof v.model === 'string' && Array.isArray(v.scenarios) && v.scenarios.every(s => s && typeof s.id === 'string' && typeof s.passed === 'boolean') && Number.isFinite(date) && date <= now && now-date < 7*86400000;
    });
  } catch { return []; } finally { await h?.close(); }
}
export async function modelToolUse(home: string, provider: string, model: string) {
  return hostEvalGate([{ provider, model }], await readHostEvalReports(home)).models[0]!.label;
}
export function configuredDefaults(config: { modelProfiles: Record<string, unknown> }): ModelRef[] {
  const refs = new Map<string, ModelRef>();
  const profile = config.modelProfiles.default as { candidates?: { model?: unknown }[] } | undefined;
  for (const c of profile?.candidates ?? []) if (typeof c.model === 'string') {
    const slash = c.model.indexOf('/'); if (slash > 0 && slash < c.model.length-1) { const ref = { provider: c.model.slice(0,slash), model: c.model.slice(slash+1) }; refs.set(c.model,ref); }
  }
  return [...refs.values()];
}
