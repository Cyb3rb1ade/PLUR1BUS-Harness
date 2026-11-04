import { turnContext } from "./context.ts";
/** One Core-owned Apple provider: fixed Layout destination, no credentials, live sidecar admission and fit policy. */
import type { HarnessConfig } from "@plur1bus/config-schema";
import {
  createChatCompletionsAdapter, createLocalChatAdapter, ProviderError,
} from "../../../providers/src/index.ts";
import type { ChatCompletionsAdapter, ChatRequest } from "../../../providers/src/index.ts";
import { APPLE_FM_BASE_URL, createUnixFetch } from "../../../providers/src/local/unix.ts";
import { createAppleFmSocketGuard } from "../apple-fm/socket.ts";
import { layout } from "../paths.ts";
import { assertContextFit } from "../session/context-fit.ts";

export interface AppleFmOptions {
  home: string;
  config(): Pick<HarnessConfig, "appleFm">;
  /** Trusted supervisor snapshot port; absent means no slot. AF3 owns its production source and preconditions. */
  slot?: () => { state: string } | null;
  platform?: NodeJS.Platform;
}

const SLOT_STATES = new Set(["starting", "ready", "degraded", "crashed", "gave-up", "blocked", "skipped"]);
const REFUSALS = ["platform", "socket-untrusted", "socket-path-too-long", "unavailable"] as const;
type Refusal = typeof REFUSALS[number];

function meteredFetch(inner: typeof fetch, admit: () => void, counters: { ok: number; refused: Record<Refusal, number> }): typeof fetch {
  return async (input, init) => {
    try {
      admit();
      const response = await inner(input, init);
      counters.ok++;
      return response;
    } catch (error) {
      const code = error instanceof ProviderError && REFUSALS.includes(error.code as Refusal)
        ? error.code as Refusal : "unavailable";
      counters.refused[code]++;
      throw error;
    }
  };
}

function assertAppleContext(request: ChatRequest): void {
  if (request.model !== "system") throw new ProviderError("invalid_request", "Apple FM only allows system", {
    code: "model_not_allowed", retryable: false,
  });
  if (!["decision", "summarize"].includes(turnContext.getStore()?.role ?? "chat")) {
    throw new ProviderError("invalid_request", "model context window 4096 is below the 16384 agent-role floor", {
      code: "context-too-small", retryable: false,
    });
  }
  assertContextFit(request);
}

export function createAppleFmRuntime(options: AppleFmOptions) {
  const platform = options.platform ?? process.platform;
  const socket = Object.freeze({ id: "apple-fm" as const, path: layout(options.home).appleFmSocket });
  const guard = createAppleFmSocketGuard(options.home, { platform });
  const counters = { ok: 0, refused: Object.fromEntries(REFUSALS.map(key => [key, 0])) as Record<Refusal, number> };
  const slot = () => {
    try {
      const state = options.slot?.()?.state;
      return state && SLOT_STATES.has(state) ? state : null;
    } catch {
      return null;
    }
  };
  const enabled = () => options.config().appleFm?.enabled === true;
  const present = () => enabled() && platform === "darwin" && slot() !== null;
  const available = () => present() && slot() === "ready";
  const admit = () => {
    const code = platform !== "darwin" ? "platform" : !available() ? "unavailable" : null;
    if (code) throw new ProviderError("network", "managed Apple provider is unavailable", { code, retryable: false });
  };
  const fetch = meteredFetch(createUnixFetch(socket, { guard, platform }), admit, counters);
  const inner = createLocalChatAdapter({ state: "ok", baseUrl: APPLE_FM_BASE_URL, socket: "managed:apple-fm" },
    config => createChatCompletionsAdapter({ ...config, fetch }), undefined, { unix: { socket, guard, platform } });
  const adapter: ChatCompletionsAdapter = {
    async complete(request, callOptions) {
      assertAppleContext(request);
      return inner.complete(request, callOptions);
    },
    async *stream(request, callOptions) {
      assertAppleContext(request);
      yield* inner.stream(request, callOptions);
    },
  };
  return {
    socket, guard, fetch, adapter, present, available, enabled,
    profile: () => present() ? { id: "apple-fm", vendor: "apple", discovery: "openai-models" as const,
      baseUrl: APPLE_FM_BASE_URL } : null,
    metrics: () => ({ transport: { unix: { ok: counters.ok, refused: { ...counters.refused } } } }),
  };
}

export type AppleFmRuntime = ReturnType<typeof createAppleFmRuntime>;
