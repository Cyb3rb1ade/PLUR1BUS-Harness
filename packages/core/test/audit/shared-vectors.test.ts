import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createAuditChain, hashLine, ACTIVE_NAME, ANCHOR_NAME } from "../../src/audit/chain.ts";
import { tempDir } from "../helpers/temp-dir.ts";

it("shares raw UTF-8, null target, CRLF and rotation vectors with the Rust writer", () => {
  const fixture = JSON.parse(readFileSync(new URL("../../../../tests/fixtures/audit-chain-v1.json", import.meta.url), "utf8"));
  const dir = tempDir("audit-vectors-");
  for (const v of fixture.lines) assert.equal(hashLine(v.line), v.hash);
  writeFileSync(path.join(dir, ACTIVE_NAME), fixture.lines.map((v: { line: string }) => v.line + "\r\n").join(""));
  const last = fixture.lines.at(-1);
  writeFileSync(path.join(dir, ANCHOR_NAME), JSON.stringify({ v: 1, seq: last.seq, hash: last.hash }));
  const chain = createAuditChain({ dir });
  assert.deepEqual([chain.verify().ok, chain.verify().lastHash], [true, last.hash]);
  chain.rotate();
  chain.append({ at: 2000, actor: { user: "test", host: "fixture" }, action: "secret.list", target: null, detail: {} });
  assert.deepEqual([chain.verify().ok, chain.verify().lastSeq, chain.verify().files], [true, 4, 2]);
  const line = JSON.parse(readFileSync(path.join(dir, ACTIVE_NAME), "utf8"));
  assert.equal(line.prev, last.hash);
});
