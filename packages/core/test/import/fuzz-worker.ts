// Worker for parsers-fuzz.test.ts: runs one batch of seeded cases against one parser and reports per-case progress, so the test
// can terminate it when a single case hangs (a synchronous hang cannot be interrupted from inside the thread, and the test
// runner's own timeout cannot fire while the thread is busy). The batch is fully determined by (parser, seed, cases).
import { parentPort, workerData } from "node:worker_threads";
import assert from "node:assert/strict";
import { parseJson5 } from "../../src/import/json5.ts";
import { readYaml } from "../../src/import/yaml-lite.ts";
import { mulberry32, randomValue, randomYamlValue, toJson5, toYaml, soup, mutate, prototypeFingerprint } from "./helpers.ts";

interface Job { parser: "json5" | "yaml"; seed: number; cases: number }
const job = workerData as Job;
const post = (m: unknown): void => parentPort!.postMessage(m);
const failures: string[] = [];
const counts = { roundTrip: 0, truncated: 0, soup: 0, mutated: 0, deep: 0, accepted: 0, rejected: 0 };
const fingerprint = prototypeFingerprint();

function checkJson5(text: string, label: string, expected?: { value: unknown }): void {
  let result: { value: unknown } | { error: unknown };
  try { result = { value: parseJson5(text) }; } catch (error) { result = { error }; }
  if ("error" in result) {
    counts.rejected++;
    const e = result.error;
    if (!(e instanceof SyntaxError) || !/^JSON5: /.test(e.message)) failures.push(`${label}: unexpected exception ${e instanceof Error ? `${e.constructor.name}: ${e.message.slice(0, 80)}` : String(e)}`);
    else if (expected) failures.push(`${label}: valid document rejected: ${e.message}`);
    return;
  }
  counts.accepted++;
  if (expected) { try { assert.deepStrictEqual(result.value, expected.value); } catch { failures.push(`${label}: value differs from the generated one`); } }
}

function checkYaml(text: string, label: string, expected?: { value: unknown }): void {
  let r: ReturnType<typeof readYaml>;
  try { r = readYaml(text); } catch (e) { failures.push(`${label}: readYaml threw ${e instanceof Error ? `${e.constructor.name}: ${e.message.slice(0, 80)}` : String(e)}`); return; }
  if (!Array.isArray(r.unsupported) || r.unsupported.some(u => typeof u !== "string")) failures.push(`${label}: unsupported is not a string list`);
  const v = r.value;
  if (!(v === null || Array.isArray(v) || (typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype))) failures.push(`${label}: odd value type`);
  if (expected) {
    counts.accepted++;
    try { assert.deepStrictEqual(v, expected.value); assert.deepStrictEqual(r.unsupported, []); } catch { failures.push(`${label}: round trip differs (unsupported=${JSON.stringify(r.unsupported).slice(0, 80)})`); }
  }
}

const rnd = mulberry32(job.seed);
const texts: string[] = [];
for (let i = 0; i < job.cases; i++) {
  post({ progress: i });
  const label = `seed=0x${job.seed.toString(16)} case=${i}`;
  const group = i % 10; // 4: round trip, 3: truncated, 2: soup, 1: mutated (deep nesting runs separately)
  if (job.parser === "json5") {
    if (group < 4) { const v = randomValue(rnd, 0, { dangerous: true }); const text = toJson5(v, rnd); texts.push(text); counts.roundTrip++; checkJson5(text, `${label} roundtrip text=${JSON.stringify(text.slice(0, 120))}`, { value: v }); }
    else if (group < 7) { const base = texts.length ? texts[Math.floor(rnd() * texts.length)]! : "{a:1}"; const cut = base.slice(0, Math.floor(rnd() * (base.length + 1))); counts.truncated++; checkJson5(cut, `${label} truncated text=${JSON.stringify(cut.slice(0, 120))}`); }
    else if (group < 9) { const s = soup(rnd, "json5"); counts.soup++; checkJson5(s, `${label} soup text=${JSON.stringify(s.slice(0, 120))}`); }
    else { const base = texts.length ? texts[Math.floor(rnd() * texts.length)]! : "{a:1}"; const m = mutate(base, rnd, "json5"); counts.mutated++; checkJson5(m, `${label} mutated text=${JSON.stringify(m.slice(0, 120))}`); }
  } else {
    if (group < 4) { const v = randomYamlValue(rnd); const text = toYaml(v, rnd); texts.push(text); counts.roundTrip++; checkYaml(text, `${label} roundtrip text=${JSON.stringify(text.slice(0, 160))}`, { value: v }); }
    else if (group < 7) { const base = texts.length ? texts[Math.floor(rnd() * texts.length)]! : "a: 1\n"; const cut = base.slice(0, Math.floor(rnd() * (base.length + 1))); counts.truncated++; checkYaml(cut, `${label} truncated text=${JSON.stringify(cut.slice(0, 120))}`); }
    else if (group < 9) { const s = soup(rnd, "yaml"); counts.soup++; checkYaml(s, `${label} soup text=${JSON.stringify(s.slice(0, 120))}`); }
    else { const base = texts.length ? texts[Math.floor(rnd() * texts.length)]! : "a: 1\n"; const m = mutate(base, rnd, "yaml"); counts.mutated++; checkYaml(m, `${label} mutated text=${JSON.stringify(m.slice(0, 120))}`); }
  }
}
if (prototypeFingerprint() !== fingerprint) failures.push(`seed=0x${job.seed.toString(16)}: a shared prototype changed during the batch`);
if ((Object.prototype as unknown as Record<string, unknown>)["polluted"] !== undefined) failures.push("Object.prototype.polluted is set");
post({ done: true, failures: failures.slice(0, 20), failureCount: failures.length, counts });
