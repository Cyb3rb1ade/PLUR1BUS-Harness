// Record the RE-D151 native exception for `lib/query-refiner.js` at the Node pin.
//
//   node record-query-refiner-exceptions.mjs --source <copy of lib/query-refiner.js at the pin> --out <file>
//
// `SYNONYM_MAP[w.toLowerCase()]` reads a plain object literal, so at the pin a word whose lower
// case names an inherited `Object.prototype` member (only `constructor` survives the punctuation
// replacement and lower-casing) "expands" to that member's source text. The native port treats
// such a word as a word without a synonym. Node's output is recorded next to the native
// expectation, which is the same pinned code with only that lookup restricted to own keys.
// The source hash is checked before any import.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const COMMIT = "9f34008c143c5da87b2194b5a28442b407ff8ba7";
const PATH = "lib/query-refiner.js";
const SHA256 = "136e4aa6b2408bffbe6a02791b118818abb5ae4e1c3a25d1565b27373453c389";
const LOOKUP = "SYNONYM_MAP[w.toLowerCase()]";
const OWN = "(Object.hasOwn(SYNONYM_MAP, w.toLowerCase()) ? SYNONYM_MAP[w.toLowerCase()] : undefined)";

const argument = (name) => {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing ${name}`);
  return process.argv[index + 1];
};
const source = readFileSync(argument("--source"), "utf8");
if (createHash("sha256").update(source).digest("hex") !== SHA256) {
  throw new Error("query-refiner source does not match the pin");
}
if (source.split(LOOKUP).length !== 2) throw new Error("expected exactly one synonym lookup");
const dir = mkdtempSync(join(tmpdir(), "query-refiner-exceptions-"));
let pinned;
let native;
try {
  writeFileSync(join(dir, "pinned.mjs"), source);
  writeFileSync(join(dir, "native.mjs"), source.replace(LOOKUP, OWN));
  pinned = await import(pathToFileURL(join(dir, "pinned.mjs")).href);
  native = await import(pathToFileURL(join(dir, "native.mjs")).href);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const reason =
  "inherited Object.prototype member through SYNONYM_MAP[w.toLowerCase()]; native: a word without a synonym";
const inputs = ["Constructor setup", "the constructor pattern", "CONSTRUCTOR", "constructor docker"];
const cases = inputs.map((input) => {
  const node = { expandQuery: pinned.expandQuery(input), refineQuery: pinned.refineQuery(input, []) };
  const expected = { expandQuery: native.expandQuery(input), refineQuery: native.refineQuery(input, []) };
  if (node.expandQuery === expected.expandQuery) throw new Error(`no exception for ${input}`);
  return { input, node, native: expected, reason };
});
const output = {
  exception: "RE-D151",
  source: { commit: COMMIT, path: PATH, sha256: SHA256 },
  node: { version: process.version },
  cases,
};
writeFileSync(argument("--out"), `${JSON.stringify(output, null, 2)}\n`);
