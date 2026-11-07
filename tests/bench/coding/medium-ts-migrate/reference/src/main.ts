// Original MIT benchmark fixture; the generated README states the contract.
import { readFileSync } from "node:fs";
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
try {
  const input: unknown = JSON.parse(readFileSync(0, "utf8"));
  if (
    !object(input) ||
    Object.keys(input).sort().join(",") !== "entries,version" ||
    input.version !== 1 ||
    !Array.isArray(input.entries)
  )
    throw new Error("invalid input");
  const values = new Map<string, string>();
  for (const entry of input.entries) {
    if (
      !object(entry) ||
      Object.keys(entry).sort().join(",") !== "key,value" ||
      typeof entry.key !== "string" ||
      typeof entry.value !== "string"
    )
      throw new Error("invalid entry");
    const key = entry.key.trim();
    if (!key || values.has(key)) throw new Error("duplicate key");
    values.set(key, entry.value);
  }
  process.stdout.write(JSON.stringify({ version: 2, values: Object.fromEntries(values) }) + "\n");
} catch {
  process.exitCode = 2;
}
