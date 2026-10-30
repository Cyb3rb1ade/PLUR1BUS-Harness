import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createProviderTurnPort,
  createSessionTurnPort,
  openA2aSessionBackend,
  type A2aTurnRequest,
  type TurnChunk,
} from "../../src/a2a/turn-port.ts";
import { FakeChatProvider } from "../../src/session/provider.ts";

async function collect(it: AsyncIterable<TurnChunk>): Promise<TurnChunk[]> {
  const out: TurnChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

const textOf = (cs: TurnChunk[]): string => cs.map((c) => (c.type === "delta" ? c.text : "")).join("");

const req = (text: string, sessionId = "s1"): A2aTurnRequest => ({
  peerId: "peer-1",
  agentId: "bernd",
  contextId: "ctx-1",
  sessionId,
  text,
  signal: new AbortController().signal,
});

describe("M6A-A1.6: remove text-marker seam from production turn-port", () => {
  const markerInputs = [
    "please INPUT_REQUIRED now",
    "AUTH_REQUIRED",
    "this is a REJECT.",
    "REJECT",
  ];

  it("createProviderTurnPort treats marker strings as normal text (no pause or reject chunks)", async () => {
    const port = createProviderTurnPort(() => new FakeChatProvider());
    for (const input of markerInputs) {
      const chunks = await collect(port.run(req(input)));
      assert.ok(chunks.length > 0, `expected chunks for ${input}`);
      assert.ok(
        chunks.every((c) => c.type === "delta"),
        `chunks for ${input} must only be deltas in production turn port`,
      );
      assert.equal(textOf(chunks), `echo[bernd]: ${input}`);
    }
  });

  it("createSessionTurnPort treats marker strings as normal text (runs normal turn)", async () => {
    const backend = openA2aSessionBackend({ provider: () => new FakeChatProvider() });
    try {
      const session = backend.port.ensureSession({ peerId: "peer-1", agentId: "bernd", contextId: "ctx-1" });
      for (const input of markerInputs) {
        const chunks = await collect(backend.port.run(req(input, session.sessionId)));
        assert.ok(chunks.length > 0, `expected chunks for ${input}`);
        assert.ok(
          chunks.every((c) => c.type === "delta"),
          `chunks for ${input} must only be deltas in production turn port`,
        );
        assert.equal(textOf(chunks), `echo[bernd]: ${input}`);
      }
    } finally {
      backend.close();
    }
  });
});
