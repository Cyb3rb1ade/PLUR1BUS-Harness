// Paging and profile vectors from CodingActions and the static profile helpers.
import { pathToFileURL } from "node:url";
import { CodingActions } from "../../packages/core/src/coding/actions.ts";
import { CODING_INSTRUCTIONS, CODING_TOOL_NAMES, mergeCacheSummaries } from "../../packages/core/src/coding/profile.ts";
import { RpcError } from "../../packages/core/src/rpc/errors.ts";
import { exporterMain } from "./lib.mjs";

const owner = { kind: "person", role: "owner", userId: "owner" } as const;
const caller = { channel: "cli", accountId: "host", userId: "owner" } as const;
const text = "α🙂hello\nsecond";

async function diff() {
  const cases = [];
  for (const [name, output, offset, limit] of [
    ["utf16 boundary", JSON.stringify({ diff: text }), 0, 2],
    ["returns tail", JSON.stringify({ diff: text }), 3, 15],
    ["split offset", JSON.stringify({ diff: text }), 2, 2],
    ["offset negative", JSON.stringify({ diff: text }), -1, 2],
    ["limit zero", JSON.stringify({ diff: text }), 0, 0],
    ["limit too large", JSON.stringify({ diff: text }), 0, 65537],
    ["missing", null, 0, 2],
    ["wrapped", JSON.stringify({ value: { data: { result: { unifiedDiff: text } } } }), 0, 3],
    ["too deep", JSON.stringify({ value: { data: { result: { result: { diff: text } } } } }), 0, 3],
    ["no inline patch", "legacy output", 0, 2],
    ["redaction before paging", JSON.stringify({ diff: "secret-fixture" }), 0, 4],
  ] as const) {
    const read = new CodingActions({
      coding: { async requireRoot() { return { binding: { root: "fixture" } }; } } as never,
      storeFor: () => ({ toolResult: () => output } as never),
      verifier: { async run() { throw new Error("not a check"); } },
      redact: value => value.replaceAll("secret-fixture", "[masked]"),
    });
    try {
      cases.push({ name, output, offset, limit, result: { ok: await read.diff({ caller, sessionId: "session", callId: "call", offset, limit }, owner) } });
    } catch (e) {
      if (!(e instanceof RpcError)) throw e;
      cases.push({ name, output, offset, limit, result: { err: { code: e.error, message: e.message, reason: e.reason ?? null } } });
    }
  }
  return cases;
}

type Summary = NonNullable<Parameters<typeof mergeCacheSummaries>[0][number]>;
function profile() {
  const base = (read: number, total: number): Summary => ({
    cacheReadTokens: read, cacheCreationTokens: 1, inputTokens: total - read - 1,
    totalInputTokens: total, turns: 1, hits: read ? 1 : 0, misses: read ? 0 : 1, notCacheable: 0,
    missCauses: { "first-request": 0, "model-changed": 0, "tools-changed": 0, "system-changed": 0, "snapshot-changed": 0, "ttl-expired": 1, provider: 0 } as Summary["missCauses"],
    hitRatio: read / total,
  });
  return { instructions: CODING_INSTRUCTIONS, tools: CODING_TOOL_NAMES,
    cases: [[undefined], [base(0, 4)], [base(10, 20), undefined, base(30, 100)]].map(input => ({
      input: input.map(x => x ?? null), result: mergeCacheSummaries(input) ?? null })) };
}

export async function buildCodingActionVectors() {
  return { "diff-pages": await diff(), profile: profile() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await exporterMain({ area: "coding", build: buildCodingActionVectors });
}
