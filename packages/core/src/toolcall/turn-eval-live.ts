/** N-G2: explicit real-provider construction and measured quality gates for the turn-path nightly. */
import {
  createAnthropicAdapter, createChatCompletionsAdapter, createGeminiAdapter, createResponsesAdapter,
  type StreamingAdapter,
} from "../../../providers/src/index.ts";
import type { TurnEvalReport } from "./turn-eval.ts";
import type { ProviderFamily } from "./quirks.ts";

type WireFormat = "chat_completions" | "codex_responses" | "anthropic_messages" | "gemini";

/** Endpoint and credential reference, never a credential value. Keyless requests require explicit local=true. */
export interface TurnEvalModel {
  provider: string;
  model: string;
  baseUrl: string;
  keyEnv: string;
  wireFormat: WireFormat;
  local?: boolean;
}

const MAX_MODELS = 32;
const MAX_CONFIG_BYTES = 32 * 1024;
const WIRES = new Set(["chat_completions", "codex_responses", "anthropic_messages", "gemini"]);
const CONFIG_ERROR = "PLUR1BUS_TURN_EVAL_MODELS must contain 1-32 provider/model/baseUrl/keyEnv/wireFormat entries";

function parseModel(value: unknown): TurnEvalModel {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(CONFIG_ERROR);
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(k => !["provider", "model", "baseUrl", "keyEnv", "wireFormat", "local"].includes(k))
    || typeof row.provider !== "string" || !/^[a-zA-Z0-9_.-]{1,64}$/.test(row.provider)
    || typeof row.model !== "string" || !row.model.trim() || row.model.length > 256
    || typeof row.baseUrl !== "string" || row.baseUrl.length > 2048
    || typeof row.keyEnv !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/.test(row.keyEnv)
    || typeof row.wireFormat !== "string" || !WIRES.has(row.wireFormat)
    || (row.local !== undefined && typeof row.local !== "boolean")) throw new Error(CONFIG_ERROR);
  let url: URL;
  try { url = new URL(row.baseUrl); } catch { throw new Error(CONFIG_ERROR); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error(CONFIG_ERROR);
  return {
    provider: row.provider, model: row.model, baseUrl: row.baseUrl, keyEnv: row.keyEnv,
    wireFormat: row.wireFormat as WireFormat, ...(typeof row.local === "boolean" ? { local: row.local } : {}),
  };
}

/** Refuse empty and malformed configuration; an explicitly requested live run never silently skips. */
export function parseTurnEvalModels(raw: string | undefined): TurnEvalModel[] {
  if (!raw || Buffer.byteLength(raw) > MAX_CONFIG_BYTES) throw new Error(CONFIG_ERROR);
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error(CONFIG_ERROR); }
  if (!Array.isArray(value) || !value.length || value.length > MAX_MODELS) throw new Error(CONFIG_ERROR);
  return value.map(parseModel);
}

/** Build a real adapter without issuing a request. Missing credentials fail before running any scenario. */
export function createTurnEvalAdapter(
  config: TurnEvalModel, env: Readonly<Record<string, string | undefined>> = process.env,
): StreamingAdapter {
  const key = env[config.keyEnv];
  if (!key && !config.local) throw new Error(`live turn eval credential ${config.keyEnv} is unavailable`);
  const common = { baseUrl: config.baseUrl, timeouts: { totalMs: 60_000 } };
  switch (config.wireFormat) {
    case "anthropic_messages": return createAnthropicAdapter({ ...common, credentials: { apiKey: () => key } });
    case "gemini": return createGeminiAdapter({ ...common, credentials: { apiKey: () => key } });
    case "codex_responses": return createResponsesAdapter({
      ...common, credentials: { authorization: () => key ? `Bearer ${key}` : undefined },
    });
    case "chat_completions": return createChatCompletionsAdapter({
      ...common, credentials: { authorization: () => key ? `Bearer ${key}` : undefined },
    });
  }
}

/** Provider-family mapping is fixed by the configured wire, not inferred from model names. */
export function turnEvalFamily(config: TurnEvalModel): ProviderFamily {
  return { chat_completions: "openai-chat", codex_responses: "openai-responses",
    anthropic_messages: "anthropic", gemini: "gemini" }[config.wireFormat] as ProviderFamily;
}

/** N-G2 gates use real observed calls/loads. Prefix changes and unnecessary calls remain reported diagnostics. */
export function turnEvalLiveGate(report: TurnEvalReport): { passed: boolean; failures: string[] } {
  const failures: string[] = [];
  if (report.evidence !== "live") failures.push("real model evidence required");
  if (!report.denominators.tools || !report.denominators.skills || !report.denominators.neededTurns) {
    failures.push("tool and skill evidence is empty");
  }
  if (report.metrics.toolHitRate < .95) failures.push("tool hit rate below 95%");
  if (report.metrics.missingToolRate > .05) failures.push("missing needed tool rate above 5%");
  if (report.metrics.skillHitRate < .9) failures.push("skill load hit rate below 90%");
  if (report.metrics.policyViolations !== 0) failures.push("policy violation observed");
  return { passed: !failures.length, failures };
}
