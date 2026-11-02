/** Parser diagnostics may identify the protocol failure but must never retain V8's response-text snippet. */
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { test } from "node:test";
import { createChatCompletionsAdapter, NO_AUTH, ProviderError } from "../src/index.ts";

for (const variant of ["complete-json", "stream-json", "complete-sse", "stream-sse"]) {
  test(`${variant} parse errors contain no response text in their cause chain`, async () => {
    const sse = variant.endsWith("sse");
    const body = "{\"choices\":[ PRIV8 ]}";
    const adapter = createChatCompletionsAdapter({
      baseUrl: "https://synthetic.invalid/v1", credentials: NO_AUTH,
      fetch: async () => new Response(sse ? `data: ${body}\n\n` : body, {
        headers: { "content-type": sse ? "text/event-stream" : "application/json" },
      }),
    });
    const request = { model: "synthetic", messages: [{ role: "user" as const, content: "synthetic" }] };
    const call = variant.startsWith("complete") ? () => adapter.complete(request) : async () => {
      for await (const event of adapter.stream(request)) assert.notEqual(event.type, "done");
    };
    await assert.rejects(call(), (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.code, "protocol");
      assert.doesNotMatch(inspect(error, { depth: 5 }), /PRIV8/);
      assert.equal(error.cause, undefined);
      return true;
    });
  });
}
