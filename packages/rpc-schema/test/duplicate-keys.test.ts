import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// JSON.parse keeps the last of two equal keys and says nothing, so a duplicated definition
// (e.g. a $defs entry) silently shadows the first one. This scanner walks the text itself.

function findDuplicateKeys(text: string): string[] {
  const dups: string[] = [];
  let i = 0;
  const ws = () => { while (i < text.length && /\s/.test(text[i]!)) i++; };
  const str = (): string => {
    const start = i++;
    while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const value = (path: string): void => {
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      const seen = new Set<string>();
      ws();
      if (text[i] === "}") { i++; return; }
      for (;;) {
        ws();
        const key = str();
        if (seen.has(key)) dups.push(`${path}/${key}`);
        seen.add(key);
        ws(); i++; // ':'
        value(`${path}/${key}`);
        ws();
        if (text[i++] === "}") return;
      }
    } else if (c === "[") {
      i++;
      ws();
      if (text[i] === "]") { i++; return; }
      for (let n = 0; ; n++) {
        value(`${path}/${n}`);
        ws();
        if (text[i++] === "]") return;
      }
    } else if (c === '"') {
      str();
    } else {
      while (i < text.length && !/[,\]}\s]/.test(text[i]!)) i++;
    }
  };
  value("");
  return dups;
}

function jsonFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...jsonFiles(p));
    else if (name.endsWith(".json")) out.push(p);
  }
  return out;
}

describe("rpc-schema duplicate keys", () => {
  it("the scanner finds duplicates JSON.parse swallows", () => {
    assert.deepEqual(findDuplicateKeys('{"a":1,"b":{"x":1,"x":2},"c":[{"y":1,"y":1}],"a":3}'), ["/b/x", "/c/0/y", "/a"]);
    assert.deepEqual(findDuplicateKeys('{"a":"q\\"","b":[1,2,{"c":null}],"d":{}}'), []);
  });

  it("no schema source, fixture or generated JSON repeats an object key", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const files = jsonFiles(root);
    assert.ok(files.some((f) => f.endsWith("rpc.schema.json")));
    assert.ok(files.some((f) => relative(root, f).startsWith("generated")), "generated output must be covered (the test script builds first)");
    const bad: string[] = [];
    for (const f of files) for (const d of findDuplicateKeys(readFileSync(f, "utf8"))) bad.push(`${relative(root, f)}: ${d}`);
    assert.deepEqual(bad, []);
  });
});
