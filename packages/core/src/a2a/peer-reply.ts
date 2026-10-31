import { A2aPeerError } from "./peer-error.ts";

/** Decode structured returns before masking: a later JSON.parse must not revive a credential. */
export function redactPeerReply(raw: string, redact: (text: string) => string): string {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return redact(raw); }
  let nodes = 0;
  const walk = (v: unknown, depth: number): unknown => {
    if (++nodes > 8192 || depth > 32) throw new A2aPeerError("request-failed");
    if (typeof v === "string") return redact(v);
    if (typeof v === "number" && !Number.isFinite(v)) throw new A2aPeerError("request-failed");
    if (Array.isArray(v)) return v.map(child => walk(child, depth + 1));
    if (v && typeof v === "object") {
      const result: Record<string, unknown> = Object.create(null);
      for (const [key, child] of Object.entries(v)) {
        const safeKey = redact(key);
        if (Object.hasOwn(result, safeKey)) throw new A2aPeerError("request-failed");
        result[safeKey] = walk(child, depth + 1);
      }
      return result;
    }
    return v;
  };
  return redact(JSON.stringify(walk(value, 0)));
}
