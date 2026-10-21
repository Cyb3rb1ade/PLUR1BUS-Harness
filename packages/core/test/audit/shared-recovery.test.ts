// The writer's verdict for chain/anchor states, from the vectors the Rust writer reads too (tests/fixtures/audit-chain-recovery-v1.json).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createAuditChain, hashLine, ACTIVE_NAME, ANCHOR_NAME, ANCHOR_ADVANCED_ACTION } from "../../src/audit/chain.ts";
import { tempDir } from "../helpers/temp-dir.ts";

interface Case { name: string; lines: string[]; anchor: string | null; expect: { outcome: "appended" | "refused"; advanced?: boolean; fromSeq?: number; toSeq?: number; message?: string } }
const fixture = JSON.parse(readFileSync(new URL("../../../../tests/fixtures/audit-chain-recovery-v1.json", import.meta.url), "utf8")) as { cases: Case[] };

describe("shared writer-verdict vectors (same file as the Rust writer)", () => {
  for (const c of fixture.cases) {
    it(c.name, () => {
      const dir = tempDir("audit-recovery-vec-"); mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, ACTIVE_NAME), c.lines.map((l) => `${l}\n`).join(""));
      if (c.anchor !== null) writeFileSync(path.join(dir, ANCHOR_NAME), c.anchor);
      const chain = createAuditChain({ dir });
      const event = { at: 5000, actor: { user: "test", host: "fixture" }, action: "vector.event", target: "t", detail: {} };
      if (c.expect.outcome === "refused") {
        assert.throws(() => chain.append(event), new RegExp(c.expect.message as string));
        assert.deepEqual(readFileSync(path.join(dir, ACTIVE_NAME), "utf8").split("\n").filter(Boolean), c.lines, "a refusal changes no line");
        assert.equal(c.anchor === null ? false : readFileSync(path.join(dir, ANCHOR_NAME), "utf8") === c.anchor, c.anchor !== null, "nor the anchor");
        return;
      }
      chain.append(event);
      const all = readFileSync(path.join(dir, ACTIVE_NAME), "utf8").split("\n").filter(Boolean);
      assert.deepEqual(all.slice(0, c.lines.length), c.lines);
      const rest = all.slice(c.lines.length).map((l) => JSON.parse(l));
      assert.equal(rest.length, c.expect.advanced ? 2 : 1);
      if (c.expect.advanced) {
        assert.deepEqual([rest[0].rec.action, rest[0].rec.detail.fromSeq, rest[0].rec.detail.toSeq], [ANCHOR_ADVANCED_ACTION, c.expect.fromSeq, c.expect.toSeq]);
      }
      assert.equal(rest.at(-1).rec.action, "vector.event");
      const anchor = JSON.parse(readFileSync(path.join(dir, ANCHOR_NAME), "utf8"));
      assert.deepEqual([anchor.seq, anchor.hash], [all.length, hashLine(all.at(-1) as string)]);
      assert.equal(chain.verify().ok, true);
    });
  }
});
