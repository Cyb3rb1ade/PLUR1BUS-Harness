import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { AcpClient } from "../../src/external-agents/acp-client.ts";
import { parseWatchdogDetail, WatchdogDetailBuffer, WatchdogFailure, WATCHDOG_DETAIL_MAX_BYTES, type WatchdogDetail } from "../../src/external-agents/watchdog-detail.ts";

const detail: WatchdogDetail = {
  version: 1, cause: "task-info-unavailable", operation: "task-info", phase: "runtime",
  sample: 2, elapsedMicros: 1234, pid: 321, returned: 0, expected: 96, errno: 3,
  probeReturned: 0, probeErrno: 0, ppid: 123, pgid: 123, status: 5,
  startSeconds: 1700000000, startMicros: 500, processRssBytes: 0, count: 2, rssBytes: 1048576,
};

test("native diagnostic preserves the exact typed numeric cause across fragmented fd data", () => {
  const buffer = new WatchdogDetailBuffer();
  const bytes = Buffer.from(JSON.stringify(detail) + "\n");
  for (let i = 0; i < bytes.length; i += 7) buffer.accept(bytes.subarray(i, i + 7));
  assert.deepEqual(buffer.finish(), detail);
  assert.deepEqual(parseWatchdogDetail(JSON.stringify({ ...detail, cause: "identity-unavailable", operation: "alive", returned: -1, probeReturned: -1, probeErrno: 1 })),
    { ...detail, cause: "identity-unavailable", operation: "alive", returned: -1, probeReturned: -1, probeErrno: 1 });
});

test("aggregate RSS failure survives the trusted detail parser", () => {
  const expected = { ...detail, cause: "aggregate-rss-incomplete" };
  assert.deepEqual(parseWatchdogDetail(JSON.stringify(expected)), expected);
});

test("diagnostic parser rejects untrusted strings, unknown fields, malformed numbers and oversized records", () => {
  const invalid = [null, [], "SECRET", { ...detail, version: 2 }, { ...detail, cause: "SECRET" },
    { ...detail, operation: "command=SECRET" }, { ...detail, phase: "SECRET" }, { ...detail, argv: ["SECRET"] },
    { ...detail, errno: "SECRET" }, { ...detail, pid: -2 }, { ...detail, returned: -2 },
    { ...detail, count: 0.5 }, { ...detail, rssBytes: Number.MAX_SAFE_INTEGER + 1 }];
  for (const value of invalid) assert.equal(parseWatchdogDetail(JSON.stringify(value)), undefined);
  const missing = { ...detail } as Partial<WatchdogDetail>; delete missing.errno;
  assert.equal(parseWatchdogDetail(JSON.stringify(missing)), undefined);
  assert.equal(parseWatchdogDetail("sandbox watchdog detail: " + JSON.stringify(detail)), undefined);
  assert.equal(parseWatchdogDetail(JSON.stringify(detail) + "\n" + JSON.stringify(detail)), undefined);
  const buffer = new WatchdogDetailBuffer();
  buffer.accept(Buffer.alloc(WATCHDOG_DETAIL_MAX_BYTES + 1, 32));
  buffer.accept(Buffer.from(JSON.stringify(detail)));
  assert.equal(buffer.finish(), undefined);
});

test("ACP refusal adds only the internal typed detail; arbitrary errors cannot inject detail", async () => {
  for (const typed of [true, false]) {
    const input = new PassThrough(), output = new PassThrough();
    const response = new Promise<Record<string, unknown>>(resolve => output.once("data", chunk => resolve(JSON.parse(String(chunk)))));
    const error = typed ? new WatchdogFailure(detail) : Object.assign(new Error("sandbox-unavailable"), { detail: { cause: "SECRET", command: "SECRET" } });
    const client = new AcpClient({ input, output, handlers: { readText: async () => "", writeText: async () => {},
      permission: async () => ({}), terminal: async () => { throw error; }, onUpdate() {} } });
    try {
      input.write(JSON.stringify({ jsonrpc: "2.0", id: "wait", method: "terminal/wait_for_exit", params: { terminalId: "t1" } }) + "\n");
      assert.deepEqual(await response, { jsonrpc: "2.0", id: "wait", error: { code: -32602, message: "refused",
        data: { reason: "sandbox-unavailable", ...(typed ? { detail } : {}) } } });
    } finally { client.close(); }
  }
});
