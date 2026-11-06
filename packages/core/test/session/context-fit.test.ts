/** AF2: conservative UTF-16 accounting protects the entire message/tool prompt and reserved output before I/O. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderError } from "../../../providers/src/index.ts";
import { RpcError } from "../../src/rpc/errors.ts";
import { assertContextFit, assertRoleContext, contextCost, MIN_CONTEXT_AGENT_ROLE } from "../../src/session/context-fit.ts";

test("four agent roles refuse known small windows with the window and floor in the error", () => {
  assert.equal(MIN_CONTEXT_AGENT_ROLE, 16_384);
  for (const role of ["chat", "reasoning", "dream", "capture"]) {
    assert.throws(() => assertRoleContext(role, 4096), (error: unknown) => error instanceof RpcError
      && error.error === "E_CONFIG_INVALID" && error.reason === "context-too-small" && /4096/.test(error.message) && /16384/.test(error.message));
    assert.doesNotThrow(() => assertRoleContext(role, 16_384));
  }
  for (const role of ["decision", "summarize"]) assert.doesNotThrow(() => assertRoleContext(role, 4096));
});

for (const language of ["de", "en"]) {
  test(`${language} input just inside and outside the 4096 policy window uses the whole serialized prompt`, () => {
    const character = language === "de" ? "ü" : "x";
    const request = { messages: [{ role: "user" as const, content: character.repeat(10_700) }], maxTokens: 512 };
    const cost = contextCost(request);
    assert.equal(cost.reserve, 512);
    assert.ok(cost.prompt > 3500 && cost.prompt < 3600);
    assert.doesNotThrow(() => assertContextFit(request, cost.prompt + cost.reserve));
    assert.throws(() => assertContextFit(request, cost.prompt + cost.reserve - 1), (error: unknown) =>
      error instanceof ProviderError && error.kind === "invalid_request" && error.code === "context_overflow"
        && !error.retryable);
    const tools = [{ name: "synthetic", parameters: { type: "object", description: "x".repeat(10_000) } }];
    assert.throws(() => assertContextFit({ ...request, tools }, 4096), (error: unknown) =>
      error instanceof ProviderError && error.code === "context_overflow");
  });
}
