import { SENTINEL_KEY } from "./fake-vendor.ts";
import type { UsageReport } from "../../src/types.ts";

export const getSecret = async (name: string): Promise<string | undefined> => (name === "voice.key" ? SENTINEL_KEY : undefined);
export const noSleep = async (): Promise<void> => {};

export function usageSink(): { sink: (r: UsageReport) => void; reports: UsageReport[] } {
  const reports: UsageReport[] = [];
  return { sink: (r) => { reports.push(r); }, reports };
}

export async function collect<T>(it: AsyncIterable<T>, limit = 1000): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) { out.push(x); if (out.length >= limit) break; }
  return out;
}

/** Collect events until `stop` matches (inclusive). */
export async function until<T>(it: AsyncIterator<T>, stop: (x: T) => boolean, limit = 200): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < limit; i++) {
    const r = await it.next();
    if (r.done) break;
    out.push(r.value);
    if (stop(r.value)) break;
  }
  return out;
}

/** Fail if the sentinel secret appears anywhere in the serialised values. */
export function assertNoKey(values: unknown, where: string): void {
  const text = JSON.stringify(values, (_k, v) => (v instanceof Uint8Array ? `bytes:${v.byteLength}` : v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v)) ?? "";
  if (text.includes(SENTINEL_KEY) || text.includes(encodeURIComponent(SENTINEL_KEY))) throw new Error(`provider key leaked into ${where}`);
}
