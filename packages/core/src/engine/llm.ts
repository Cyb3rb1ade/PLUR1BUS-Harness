import type { LlmParams, LlmResult } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { TurnToolError, type createTurnProvider, type TurnProviderOptions } from "../composition/provider.ts";
import { CallBudgetExceededError } from "../budget/calls.ts";
import type { Candidate, ProfileTable } from "../../../providers/src/router/types.ts";
import { RpcError } from "../rpc/errors.ts";
import { ToolRegistry } from "../tools/registry.ts";

/** Core's registered agent-id syntax; the resulting internal principal also fits the budget identifier limit. */
const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const failure = () => new RpcError("E_NOT_AVAILABLE", "Engine completion failed; check provider, egress and budget", { reason: "engine-completion-failed" });

/** A non-person, tool-free background role through the same router and per-attempt controls as foreground turns.
 * The caller must additionally check registry membership and the authenticated engine's agent scope before invoking it. */
export function createEngineCompletion(create: typeof createTurnProvider, options: TurnProviderOptions): (agentId: string, params: LlmParams) => Promise<LlmResult> {
  const active = new AsyncLocalStorage<{ served?: string }>();
  const providers = new Map<string, ReturnType<typeof createTurnProvider>>();
  const {
    capabilities: _capabilities, skillsForAgent: _skillsForAgent, selectSkills: _selectSkills,
    classifyMessage: _classifyMessage, modelRouting: _modelRouting, onModelRouting: _onModelRouting,
    onDecision: _onDecision, onExecution: _onExecution, onPrompt: _onPrompt, beforeTools: _beforeTools,
    ...routerOptions
  } = options;
  return async (agentId, params) => {
    if (typeof agentId !== "string" || !AGENT_ID.test(agentId))
      throw new RpcError("E_DENIED", "Engine agent attribution is invalid", { reason: "engine-agent-invalid" });
    const signal = params.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const unconfigured = new RpcError("E_NOT_AVAILABLE", "Engine model has no configured profile or chat adapter", { reason: "model-not-configured" });
    const toolsForbidden = new RpcError("E_DENIED", "Engine completion cannot use tools", { reason: "engine-tools-forbidden" });
    try {
      let profile = options.profileForAgent?.(agentId) ?? options.profile ?? "default";
      let candidates: readonly Candidate[] | undefined;
      if (params.model !== undefined) {
        if (Object.hasOwn(options.profiles, params.model)) {
          profile = params.model;
          candidates = options.profiles[profile];
        } else {
          const selected = Object.entries(options.profiles).find(([, values]) => values.some(candidate => `${candidate.provider}/${candidate.model}` === params.model));
          if (selected) {
            profile = selected[0];
            candidates = selected[1].filter(candidate => `${candidate.provider}/${candidate.model}` === params.model);
          }
        }
      } else candidates = Object.hasOwn(options.profiles, profile) ? options.profiles[profile] : undefined;
      if (!candidates?.length) throw unconfigured;
      // Sampling is per request; the configured choice owns one stable router/breaker across agents and calls.
      const key = JSON.stringify([profile, candidates.map(candidate => [candidate.provider, candidate.model])]);
      let provider = providers.get(key);
      if (!provider) {
        // Recording the actual model cannot bypass admission: only createTurnProvider reaches these adapters.
        const profiles: ProfileTable = { [profile]: candidates.map(candidate => ({ ...candidate, adapter: {
          async *stream(request, streamOptions) {
            for await (const event of candidate.adapter.stream(request, streamOptions)) {
              const context = active.getStore();
              if (event.type === "done" && context) context.served = `${candidate.provider}/${candidate.model}`;
              yield event;
            }
          },
        } })) };
        const registry = new ToolRegistry();
        provider = create({
          ...routerOptions, profiles, profile,
          principal: request => request.principal!,
          registry, toolsForTurn: async () => registry, requireTriage: false,
          snapshot: (_request, memory) => memory, maxRounds: 1,
          // Provider codes are free text; only a fixed code may enter the pipeline log for this boundary.
          log: record => options.log(record.phase === "error" ? { ...record, code: "engine-completion-failed" } : record),
          onRouterEvent: (event, turn) => {
            if (event.type === "provider.skipped") {
              const { detail: _detail, ...metadata } = event;
              options.onRouterEvent?.(metadata, turn);
            } else options.onRouterEvent?.(event, turn);
          },
        });
        providers.set(key, provider);
      }
      const context: { served?: string } = {};
      let text = "";
      let usage: LlmResult["usage"];
      const stream = provider.stream({
        role: "engine", agentId, principal: `engine:v1:${agentId}`,
        sessionId: `engine-${randomUUID()}`, turnId: `engine-${randomUUID()}`,
        approver: { person: null, surface: 0 }, originSurface: 0, incognito: true,
        toolView: [], tools: [], summaries: [], memory: "",
        messages: params.messages.map(message => ({ role: message.role, text: message.content })),
        ...(params.maxTokens === undefined ? {} : { maxOutputTokens: params.maxTokens }),
        ...(params.temperature === undefined ? {} : { temperature: params.temperature }), signal,
      })[Symbol.asyncIterator]();
      try { while (true) {
        const next = await active.run(context, () => stream.next());
        if (next.done) break;
        signal.throwIfAborted();
        const chunk = next.value;
        if (chunk.type === "delta") text += chunk.text;
        else if (chunk.type === "usage") usage = { inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens };
        else throw toolsForbidden;
      } } finally { await active.run(context, () => stream.return?.()); }
      signal.throwIfAborted();
      return { text, ...(context.served === undefined ? {} : { model: context.served }), ...(usage === undefined ? {} : { usage }) };
    } catch (e) {
      if (signal.aborted) throw signal.reason;
      if (e instanceof CallBudgetExceededError)
        throw new RpcError("E_NOT_AVAILABLE", "Engine completion budget exhausted", { reason: "budget-exceeded" });
      if (e instanceof TurnToolError && e.code === "local-only")
        throw new RpcError("E_DENIED", "Engine completion requires a local model", { reason: "local-only" });
      if (e instanceof TurnToolError && ["tool-unknown", "engine-tools-forbidden"].includes(e.code))
        throw new RpcError("E_DENIED", "Engine completion cannot use tools", { reason: "engine-tools-forbidden" });
      // Only fixed errors created at this boundary survive; arbitrary provider messages/codes/details never cross RPC.
      if (e === unconfigured || e === toolsForbidden) throw e;
      throw failure();
    }
  };
}
