// Original MIT benchmark fixture; the generated README states the contract.
import { readFileSync } from "node:fs";
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function compare(a: string, b: string): number {
  const left = Array.from(a, (ch) => ch.codePointAt(0)!),
    right = Array.from(b, (ch) => ch.codePointAt(0)!);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i]! - right[i]!;
  }
  return left.length - right.length;
}
try {
  const input: unknown = JSON.parse(readFileSync(0, "utf8"));
  if (!Array.isArray(input)) throw new Error("invalid events");
  const ids = new Set<string>(),
    sequences = new Set<number>();
  const events: { id: string; seq: number; key: string; op: "put" | "delete"; value?: string }[] = [];
  for (const event of input) {
    if (
      !object(event) ||
      typeof event.id !== "string" ||
      !event.id ||
      ids.has(event.id) ||
      typeof event.key !== "string" ||
      !event.key ||
      typeof event.seq !== "number" ||
      !Number.isSafeInteger(event.seq) ||
      event.seq < 0 ||
      sequences.has(event.seq)
    )
      throw new Error("invalid event");
    const keys = Object.keys(event).sort().join(",");
    if (event.op === "put" && keys === "id,key,op,seq,value" && typeof event.value === "string") {
      events.push({ id: event.id, seq: event.seq, key: event.key, op: "put", value: event.value });
    } else if (event.op === "delete" && keys === "id,key,op,seq") {
      events.push({ id: event.id, seq: event.seq, key: event.key, op: "delete" });
    } else throw new Error("invalid event fields");
    ids.add(event.id);
    sequences.add(event.seq);
  }
  const state = new Map<string, string>();
  for (const event of events.sort((a, b) => a.seq - b.seq)) {
    if (event.op === "put") state.set(event.key, event.value!);
    else state.delete(event.key);
  }
  const fields = [...state.keys()]
    .sort(compare)
    .map((key) => JSON.stringify(key) + ":" + JSON.stringify(state.get(key)));
  process.stdout.write("{" + fields.join(",") + "}\n");
} catch {
  process.exitCode = 2;
}
