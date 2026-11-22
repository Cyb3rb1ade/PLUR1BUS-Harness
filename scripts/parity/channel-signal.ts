import { Duplex } from "node:stream";
import { JsonRpcClient, SignalRpcError } from "../../packages/channels-signal/src/rpc.ts";
import { FakeClock } from "../../packages/channels-discord/test/helpers/fake-clock.ts";

const line = (data: unknown) => Buffer.from(JSON.stringify(data) + "\n");
const bytes64 = (data: Buffer) => data.toString("base64");

export async function signalRpc(oversize: boolean) {
  const sent: Buffer[] = [];
  const port = new Duplex({
    read() {},
    write(bytes: Buffer, _encoding, done) { sent.push(Buffer.from(bytes)); done(); },
  });
  const outcomes: unknown[] = [];
  const notifications: unknown[] = [];
  const closures: string[] = [];
  const clock = new FakeClock();
  const calls = oversize ? [
    { method: "listGroups", paramsJson: "{}", timeout: 2000 },
  ] : [
    { method: "send", paramsJson: '{"account":"fixture","recipient":["sample"],"message":"Hallo 👋"}', timeout: 2000 },
    { method: "listGroups", paramsJson: "{}", timeout: 2000 },
    { method: "listIdentities", paramsJson: '{"account":"fixture"}', timeout: 2000 },
  ];
  const maxLineBytes = oversize ? 32 : 4096;
  const rpc = new JsonRpcClient({
    stream: port, timeoutMs: 2000, timeout: clock.sleep, maxLineBytes,
    onNotification: (method, params) => notifications.push({ method, params }),
    onClose: (reason) => closures.push(reason),
  });
  const pending = calls.map(({ method, paramsJson }, i) => rpc.call(method, JSON.parse(paramsJson)).then(
    (result) => { outcomes.push({ id: i + 1, result: result ?? null }); },
    (error: unknown) => {
      if (!(error instanceof SignalRpcError)) throw error;
      const { kind, message, retryAfterMs, code } = error;
      outcomes.push({ id: i + 1, error: { kind, message, retryAfterMs, code } });
    },
  ));
  const before = sent.length;
  const note = line({ jsonrpc: "2.0", method: "receive", params: { text: "Grüße" } });
  const cut = note.indexOf(Buffer.from("ü")) + 1;
  const responses = oversize ? [Buffer.from("x".repeat(16)), Buffer.from("x".repeat(17))] : [
    Buffer.concat([Buffer.from("{invalid line}\n"), line({ jsonrpc: "2.0", id: "2", result: ["group"] }), note.subarray(0, cut)]),
    Buffer.concat([note.subarray(cut),
      line({ jsonrpc: "2.0", id: "daemon-method", method: "unsupported", params: {} }),
      line({ jsonrpc: "2.0", id: 1, error: { code: -12, message: "RATE_LIMIT while processing", data: { retryAfterSeconds: 1.2349 } } }),
    ]),
  ];
  for (const response of responses) port.push(response);
  await clock.advance(2000);
  await Promise.all(pending);
  try {
    if (before !== calls.length || (oversize ? closures[0] !== "oversize" : sent.length !== before + 1)) {
      throw new Error("Signal wire fixture did not settle");
    }
    const exchanges = [{ sendBase64: sent.slice(0, before).map(bytes64), receiveChunksBase64: responses.map(bytes64) }];
    if (sent.length > before) exchanges.push({ sendBase64: sent.slice(before).map(bytes64), receiveChunksBase64: [] });
    return { source: "packages/channels-signal/src/rpc.ts", transport: "lines", exchanges,
      calls, maxLineBytes, expected: { outcomes, notifications, closures: [...closures] },
    };
  } finally {
    rpc.close();
  }
}
