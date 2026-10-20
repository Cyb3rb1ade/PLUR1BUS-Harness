// The A2A push POST and the OAuth token POST go through `egress.request` and nothing else: pinning, the response and
// request caps, the deadline, the redirect rules and the egress decision counters live in one place (egress/service.ts
// over tools/web/http.ts). This guards that statically, in the style of tools/call-paths.test.ts: neither file may open
// a socket, call fetch or reach the guarded client behind the egress service's back.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");
const FILES = ["a2a/push.ts", "auth/http.ts"] as const;
/** The file's code: comment lines and trailing line comments removed, so a doc comment cannot trip or hide a match. */
const code = (file: string): string =>
  readFileSync(path.join(SRC, file), "utf8").split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).map(l => l.replace(/\s\/\/\s.*$/, "")).join("\n");

const FORBIDDEN: [string, RegExp][] = [
  ["node:http / node:https / node:http2", /from\s+["']node:https?["']|from\s+["']node:http2["']|require\(\s*["']node:https?["']\s*\)|\bimport\(\s*["']node:https?["']\s*\)/],
  ["node:net / node:tls / node:dgram / node:dns", /["']node:(net|tls|dgram|dns|dns\/promises)["']/],
  ["bare http/https specifiers", /from\s+["'](https?|net|tls|dgram|dns)["']/],
  ["fetch", /(^|[^.\w])fetch\s*\(|globalThis\.fetch|\bundici\b/],
  ["WebSocket / XMLHttpRequest / EventSource", /\b(new\s+WebSocket|XMLHttpRequest|new\s+EventSource)\b/],
  ["a request or socket call", /\b(http|https|net|tls)\.(request|get|connect|createConnection)\s*\(/],
  ["a custom socket lookup", /\blookup\s*:/],
  ["the guarded client, bypassing the egress service", /tools\/web\/http\.ts|\bguardedRequest\b/],
];

describe("A2A push and the OAuth token POST reach the network only through egress.request (static guard)", () => {
  for (const file of FILES) {
    it(`${file} opens no socket and calls no fetch`, () => {
      const text = code(file);
      for (const [what, re] of FORBIDDEN) assert.ok(!re.test(text), `${file} must not use ${what}; send the request with egress.request`);
    });
    it(`${file} sends its POST with egress.request`, () => {
      const text = code(file);
      assert.match(text, /\begress\.request\(/, `${file} must call egress.request`);
      assert.match(text, /method:\s*["']POST["']/, `${file} must send a POST`);
      assert.match(text, /import type \{[^}]*\bEgress\b[^}]*\} from ["']\.\.\/egress\/service\.ts["']/, `${file} takes the Egress service`);
    });
  }
  it("the guard itself recognises each forbidden form (so a pass above means something)", () => {
    const hits: Record<string, string> = {
      "node:http / node:https / node:http2": 'import https from "node:https";',
      "node:net / node:tls / node:dgram / node:dns": 'import net from "node:net";',
      "bare http/https specifiers": 'import http from "http";',
      fetch: "const r = await fetch(url);",
      "WebSocket / XMLHttpRequest / EventSource": "const s = new WebSocket(u);",
      "a request or socket call": "https.request(opts);",
      "a custom socket lookup": "const o = { lookup: pin };",
      "the guarded client, bypassing the egress service": 'import { guardedRequest } from "../tools/web/http.ts";',
    };
    for (const [what, re] of FORBIDDEN) assert.match(hits[what]!, re, what);
  });
});
