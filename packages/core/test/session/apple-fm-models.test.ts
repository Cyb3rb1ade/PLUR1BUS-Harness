/** Model identity and known context policy apply to every candidate before a chat profile can be chosen. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { chatModelOptions } from "../../src/session/chat-models.ts";
import type { ChatModelSources } from "../../src/session/chat-models.ts";
import { NO_REASONING } from "../../../providers/src/reasoning.ts";

const sources: ChatModelSources = {
  profiles: () => ({
    small: [{ provider: "apple-fm", model: "system" }],
    mixed: [{ provider: "synthetic", model: "large" }, { provider: "apple-fm", model: "system" }],
    forbidden: [{ provider: "apple-fm", model: "pcc" }],
    large: [{ provider: "synthetic", model: "large" }],
  }),
  defaultProfile: () => "large", reasoning: () => NO_REASONING,
  endpoint: provider => provider === "apple-fm" ? "http://apple-fm.invalid/v1" : "http://127.0.0.1:1234",
  catalog: (provider, model) => model === "pcc" ? undefined : ({
    status: "available", contextWindow: provider === "apple-fm" ? 4096 : 32768,
  }),
  config: () => ({ privacy: { localOnly: true } }),
};

test("managed system is local but small and mixed profiles cannot be selected for chat", () => {
  const options = chatModelOptions(sources, "synthetic");
  for (const name of ["small", "mixed"]) {
    const option = options.find(option => option.name === name)!;
    assert.equal(option.local, true);
    assert.equal(option.selectable, false);
    assert.equal(option.disabledReason, "context-too-small");
    assert.equal(option.contextWindow, 4096);
  }
  assert.equal(options.find(option => option.name === "large")?.selectable, true);
  assert.equal(options.some(option => option.name === "forbidden"), false);
});
