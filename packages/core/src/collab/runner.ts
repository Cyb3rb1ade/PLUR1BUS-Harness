import type { ChatProvider } from "../session/provider.ts";
import { FakeChatProvider } from "../session/provider.ts";
import { CollabError } from "./errors.ts";
import type { AgentScopePort } from "./ports.ts";
import { requireAgentScope, type AgentScopeValue } from "./scope.ts";

export interface AgentRunInput {
  agentId: string;
  question: string;
  context: string;
  signal: AbortSignal;
}

export interface AgentRunResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface AgentRunner {
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

/** Runs the target agent through the session ChatProvider seam. The callee sees only question+context. */
export function providerRunner(provider: ChatProvider, scope: AgentScopePort): AgentRunner {
  return {
    async run(input) {
      const held = scope.current();
      if (!held || held.agentId !== input.agentId) {
        throw new CollabError("no-scope", "target agent must run inside its own AgentScope");
      }
      input.signal.throwIfAborted();
      const messages: { role: "system" | "user" | "assistant" | "tool"; text: string }[] = [
        { role: "user", text: input.context.length > 0 ? `${input.question}\n\n${input.context}` : input.question },
      ];
      let text = "";
      let inputTokens = 0;
      let outputTokens = 0;
      for await (const chunk of provider.stream({
        sessionId: `collab:${held.projectId}`,
        agentId: input.agentId,
        summaries: [],
        memory: "",
        messages,
        signal: input.signal,
      })) {
        input.signal.throwIfAborted();
        if (chunk.type === "delta") text += chunk.text;
        else if (chunk.type === "usage") { inputTokens = chunk.inputTokens; outputTokens = chunk.outputTokens; }
      }
      return { text, inputTokens, outputTokens };
    },
  };
}

export function fakeProviderRunner(scope: AgentScopePort, provider: ChatProvider = new FakeChatProvider()): AgentRunner {
  return providerRunner(provider, scope);
}

export function assertScoped(expected: AgentScopeValue): void {
  const s = requireAgentScope();
  if (s.agentId !== expected.agentId) throw new CollabError("no-scope", "AgentScope agentId does not match the target");
}
