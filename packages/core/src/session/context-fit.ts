/** Conservative context policy; counts the complete serialized message/tool input and reserves output before I/O. */
import { ProviderError } from "../../../providers/src/errors.ts";
import type { ChatRequest } from "../../../providers/src/types.ts";
import { RpcError } from "../rpc/errors.ts";

import { MIN_CONTEXT_AGENT_ROLE } from "@plur1bus/config-schema";
export { MIN_CONTEXT_AGENT_ROLE };
export const APPLE_FM_CONTEXT_WINDOW = 4096;
const AGENT_ROLES = new Set(["chat", "reasoning", "dream", "capture", "engine"]);
type FitRequest = Pick<ChatRequest, "messages" | "tools" | "maxTokens">;

/** Known small models cannot serve agent roles; decision and short summarization have a per-call guard instead. */
export function assertRoleContext(role: string, window: number | undefined): void {
  if (!AGENT_ROLES.has(role) || window === undefined || window >= MIN_CONTEXT_AGENT_ROLE) return;
  throw new RpcError("E_CONFIG_INVALID", `model context window ${window} is below the ${MIN_CONTEXT_AGENT_ROLE} floor for ${role}`, {
    reason: "context-too-small",
  });
}

/** UTF-16 /3 is conservative policy from AF0's de/en samples, not an exact Apple tokenizer or hardware window. */
export function contextCost(request: FitRequest): { prompt: number; reserve: number } {
  let serialized: string;
  try {
    serialized = JSON.stringify({ messages: request.messages, tools: request.tools ?? [] });
  } catch {
    throw new ProviderError("invalid_request", "request context cannot be measured", { retryable: false });
  }
  const reserve = request.maxTokens ?? 512;
  if (!Number.isSafeInteger(reserve) || reserve < 1) {
    throw new ProviderError("invalid_request", "invalid output context reserve", { retryable: false });
  }
  return { prompt: Math.ceil(serialized.length / 3), reserve };
}

/** Refuse oversize work before creating a socket request; caller role fallbacks retain their existing policy. */
export function assertContextFit(request: FitRequest, window = APPLE_FM_CONTEXT_WINDOW): void {
  const cost = contextCost(request);
  if (!Number.isSafeInteger(window) || window < 1 || cost.prompt + cost.reserve > window) {
    throw new ProviderError("invalid_request", "request exceeds the model context policy", {
      code: "context_overflow", retryable: false,
    });
  }
}
