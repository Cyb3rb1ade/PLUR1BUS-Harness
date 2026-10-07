import { createHash, randomBytes, randomUUID } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

/** W3C trace-id: 16 bytes hex, not all-zero. */
export function newTraceId(): string {
  let id: string;
  do { id = randomBytes(16).toString("hex"); } while (/^0+$/.test(id));
  return id;
}

/** W3C span-id: 8 bytes hex, not all-zero. */
export function newSpanId(): string {
  let id: string;
  do { id = randomBytes(8).toString("hex"); } while (/^0+$/.test(id));
  return id;
}

export function traceparent(traceId: string, spanId: string, sampled = true): string {
  return `00-${traceId}-${spanId}-${sampled ? "01" : "00"}`;
}

export function repeatKey(fromAgent: string, toAgent: string, question: string): string {
  const norm = question.trim().toLowerCase().replace(/\s+/g, " ");
  return createHash("sha256").update(`${fromAgent}\0${toAgent}\0${norm}`).digest("hex");
}

export function pairKey(fromAgent: string, toAgent: string): string {
  return `${fromAgent}\0${toAgent}`;
}
