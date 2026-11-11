// Parity vectors (mode V) for canonical JSON and the action hash of `packages/core/src/tools/dispatcher.ts`: the T1 parity
// vectors D120 §11.2 asks for, consumed by crates/plur1bus-core (P4-03). Recorded, never edited by hand.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-dispatcher.ts [--check]
//
// `canonical-json`: inputs are raw JSON text (`inputJson`), so a number is parsed by the consumer exactly as written; the
// expected string is what `canonicalJson` returns for `JSON.parse(inputJson)`.
// `action-hash`: each hash is captured from the approval request of a real `ToolDispatcher.call`, not recomputed here; the
// exporter then checks that it equals sha256 of `hashInput`, the canonical string the dispatcher hashes.
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { exporterMain } from "./lib.mjs";
import { ToolDispatcher, canonicalJson } from "../../packages/core/src/tools/dispatcher.ts";
import { ToolRegistry } from "../../packages/core/src/tools/registry.ts";

const canonicalCases: Array<[name: string, inputJson: string, note?: string]> = [
  ["null", "null"], ["true", "true"], ["false", "false"], ["empty-object", "{}"], ["empty-array", "[]"], ["empty-string", '""'],
  ["flat-keys-sorted", '{"b":1,"a":2,"c":3}'],
  ["nested-keys-sorted", '{"z":{"y":1,"x":[{"b":1,"a":2}]},"a":null}'],
  ["array-order-kept", "[3,1,2]"],
  ["mixed-array", '[1,"a",null,true,{"k":[]}]'],
  ["key-order-digits", '{"10":1,"9":2,"1":3,"b":4,"B":5}', "keys sort as strings, not as numbers; upper case before lower case"],
  ["bmp-accents", '{"z":1,"é":2,"a":3,"É":4}'],
  ["astral-vs-bmp-key-order", '{"\\uFF5E":1,"\\ud83d\\ude00":2}', "keys sort by UTF-16 code unit: the emoji (D83D..) sorts before U+FF5E; UTF-8 byte order says the opposite"],
  ["unicode-values", '{"s":"日本語 \\ud83d\\ude00 é"}'],
  ["control-characters", '{"s":"\\u0000\\u0001\\b\\t\\n\\f\\r\\u001f\\u007f"}'],
  ["quotes-and-backslash", '{"s":"a\\"b\\\\c/d"}'],
  ["line-separators", '{"s":"\\u2028\\u2029"}', "emitted raw by JSON.stringify"],
  ["integers", "[0,1,-1,42,-42]"],
  ["negative-zero", "[-0,0]", "-0 serialises as 0"],
  ["fractions", "[0.5,1.25,-0.125,0.30000000000000004]"],
  ["exponent-forms", "[1e21,1e-7,1.5e300,5e-324,1E3,123456789012345680000]", "JS number formatting: 1e+21, 1e-7, 1.5e+300, 5e-324, 1000, 123456789012345680000"],
  ["integer-above-2-pow-53", "[9007199254740993,18446744073709551616]", "parsed as a double: 9007199254740992 and 18446744073709552000; a consumer that keeps u64 exactly diverges"],
  ["numbers-as-keys-values", '{"n":1.0,"m":1e2}', "1.0 and 1e2 are the integers 1 and 100"],
  ["deep-nesting", '{"a":{"a":{"a":{"a":{"a":{"a":[[[[[1]]]]]}}}}}}'],
  ["duplicate-keys-last-wins", '{"a":1,"a":2}', "JSON.parse keeps the last value"],
  ["proto-like-key", '{"__proto__":1,"constructor":2}', "ordinary own keys"],
];

interface HashCase { name: string; tool: string; argsJson: string; targets?: string[]; hashExtra?: string }
const hashCases: HashCase[] = [
  { name: "plain", tool: "demo.net", argsJson: '{"q":"a"}' },
  { name: "empty-args", tool: "demo.net", argsJson: "{}" },
  { name: "args-key-order-a", tool: "demo.net", argsJson: '{"q":1,"z":2}' },
  { name: "args-key-order-b", tool: "demo.net", argsJson: '{"z":2,"q":1}' },
  { name: "args-value-differs", tool: "demo.net", argsJson: '{"q":2,"z":2}' },
  { name: "tool-name-differs", tool: "demo.other", argsJson: '{"q":"a"}' },
  { name: "with-targets", tool: "demo.net", argsJson: '{"q":"a"}', targets: ["/work/a", "/work/b"] },
  { name: "targets-order-differs", tool: "demo.net", argsJson: '{"q":"a"}', targets: ["/work/b", "/work/a"] },
  { name: "empty-targets", tool: "demo.net", argsJson: '{"q":"a"}', targets: [] },
  { name: "with-hash-extra", tool: "demo.net", argsJson: '{"q":"a"}', hashExtra: "env:v1:0123" },
  { name: "nested-args", tool: "demo.net", argsJson: '{"o":{"y":[1,{"b":2,"a":1}],"x":null},"s":"t"}' },
  { name: "unicode-args", tool: "demo.net", argsJson: '{"\\uFF5E":"é","\\ud83d\\ude00":"日本語"}' },
  { name: "number-forms", tool: "demo.net", argsJson: '{"a":1e21,"b":0.30000000000000004,"c":-0,"d":9007199254740993}' },
];

const CAPABILITY = "net.submit"; // intrinsic effect "external": the policy asks, so the approval request carries the hash
const CTX = { agentId: "bernd", principal: "user:v1:o", sessionId: "s1", surface: 3 as const, signal: new AbortController().signal };

async function dispatcherHash(c: HashCase): Promise<string> {
  const registry = new ToolRegistry();
  registry.register({
    name: c.tool, description: "parity vector tool", inputSchema: { type: "object" }, capability: CAPABILITY, effect: "external", risk: "medium", trust: "operator-vetted",
    classify: () => ({ ...(c.targets ? { targets: c.targets } : {}), ...(c.hashExtra ? { hashExtra: c.hashExtra } : {}) }),
    execute: async () => ({}),
  });
  const hashes: string[] = [];
  const dispatcher = new ToolDispatcher({
    registry, approvals: { async request(ask) { hashes.push(ask.request.actionHash); return { approved: false }; } },
    grants: { list: () => [], get: () => undefined }, clock: { now: () => 1000 }, timers: { set: () => () => {} },
  });
  await dispatcher.call({ id: "c1", name: c.tool, args: JSON.parse(c.argsJson) }, CTX);
  if (hashes.length !== 1) throw new Error(`${c.name}: expected exactly one approval request carrying the action hash, got ${hashes.length}`);
  return hashes[0]!;
}

export async function buildDispatcherVectors(): Promise<Record<string, unknown>> {
  const actionCases = [];
  for (const c of hashCases) {
    const args = JSON.parse(c.argsJson);
    const hashInput = canonicalJson({ capability: CAPABILITY, tool: c.tool, args, targets: c.targets ?? [], ...(c.hashExtra ? { hashExtra: c.hashExtra } : {}) });
    const actionHash = await dispatcherHash(c);
    if (createHash("sha256").update(hashInput).digest("hex") !== actionHash) throw new Error(`${c.name}: the dispatcher's hash is not sha256 of the canonical hash input; the exporter's model of the dispatcher is wrong`);
    actionCases.push({ name: c.name, capability: CAPABILITY, tool: c.tool, argsJson: c.argsJson, ...(c.targets ? { targets: c.targets } : {}), ...(c.hashExtra ? { hashExtra: c.hashExtra } : {}), hashInput, actionHash });
  }
  return {
    "canonical-json": {
      schema: "plur1bus.parity-vectors/1", source: "packages/core/src/tools/dispatcher.ts#canonicalJson", exporter: "scripts/parity/export-dispatcher.ts",
      cases: canonicalCases.map(([name, inputJson, note]) => ({ name, inputJson, canonical: canonicalJson(JSON.parse(inputJson)), ...(note ? { note } : {}) })),
    },
    "action-hash": {
      schema: "plur1bus.parity-vectors/1", source: "packages/core/src/tools/dispatcher.ts#ToolDispatcher.#buildCall", exporter: "scripts/parity/export-dispatcher.ts",
      hash: "sha256 over canonicalJson({capability, tool, args, targets, hashExtra?}), lower-case hex; targets is [] when absent",
      cases: actionCases,
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await exporterMain({ area: "dispatcher", build: buildDispatcherVectors }));
}
