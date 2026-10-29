/**
 * N-G2: real-provider construction and measured quality gates for the turn-path nightly.
 *
 * Credentials reach a live evaluation the way they reach the harness: through its secret store. A setup step writes the
 * key into the store of a short-lived eval home (`storeTurnEvalCredentials`), and the evaluation composes its providers
 * from the same provider definitions, credentials provider and store the core uses (`composeAuth`). Nothing here reads a
 * key from the process environment except that one setup step, and no OpenAI profile is ever accepted (D110).
 */
import { mkdirSync } from "node:fs";
import { defaults } from "@plur1bus/config-schema";
import { type StreamingAdapter } from "../../../providers/src/index.ts";
import { composeAuth, type ProviderDefinition } from "../composition/auth.ts";
import { createEgress } from "../egress/service.ts";
import type { Egress } from "../egress/service.ts";
import { layout } from "../paths.ts";
import { createPlatformCapabilities } from "../platform.ts";
import { createCoreSecretStore } from "../secrets/runtime.ts";
import type { SecretStore } from "../secrets/store.ts";
import type { TurnEvalReport } from "./turn-eval.ts";
import type { ProviderFamily } from "./quirks.ts";

type WireFormat = "chat_completions" | "anthropic_messages" | "gemini";

/** Endpoint and wire, never a credential or the name of one. Keyless endpoints require an explicit local=true. */
export interface TurnEvalModel {
  provider: string;
  model: string;
  baseUrl: string;
  wireFormat: WireFormat;
  local?: boolean;
}

const MAX_MODELS = 32;
const MAX_CONFIG_BYTES = 32 * 1024;
const WIRES = new Set(["chat_completions", "codex_responses", "anthropic_messages", "gemini"]);
const CONFIG_ERROR = "PLUR1BUS_TURN_EVAL_MODELS must contain 1-32 provider/model/baseUrl/wireFormat entries (and optionally local)";
const KEY_ERROR = "PLUR1BUS_TURN_EVAL_MODELS no longer names a key variable: the key comes from the harness secret store (scripts/eval/turn-eval-secrets.ts)";
const OPENAI_ERROR = "live turn eval refuses OpenAI profiles: direct OpenAI credentials are only for the owner-gated live job (D110)";
/** Direct OpenAI endpoints and the ChatGPT backend, including their subdomains. */
const OPENAI_HOST = /(?:^|\.)(?:openai|chatgpt)\.com$/;
/** `openai/api-key` is the name `plur1bus login openai --api-key` uses; the label alone must not reach it. */
const OPENAI_LABEL = /^(?:openai|chatgpt|codex)(?![a-z0-9])/i;

/** D110: the scheduled evaluation never carries OpenAI credentials, whichever way a profile is spelled. */
function refuseOpenAi(row: { provider: string; baseUrl: string; wireFormat: string }, url: URL): void {
  if (row.wireFormat === "codex_responses" || OPENAI_LABEL.test(row.provider)
    || OPENAI_HOST.test(url.hostname.toLowerCase().replace(/\.$/, ""))) throw new Error(OPENAI_ERROR);
}

function parseModel(value: unknown): TurnEvalModel {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(CONFIG_ERROR);
  const row = value as Record<string, unknown>;
  if ("keyEnv" in row) throw new Error(KEY_ERROR);
  if (Object.keys(row).some(k => !["provider", "model", "baseUrl", "wireFormat", "local"].includes(k))
    || typeof row.provider !== "string" || !/^[a-zA-Z0-9_.-]{1,64}$/.test(row.provider)
    || typeof row.model !== "string" || !row.model.trim() || row.model.length > 256
    || typeof row.baseUrl !== "string" || row.baseUrl.length > 2048
    || typeof row.wireFormat !== "string" || !WIRES.has(row.wireFormat)
    || (row.local !== undefined && typeof row.local !== "boolean")) throw new Error(CONFIG_ERROR);
  let url: URL;
  try { url = new URL(row.baseUrl); } catch { throw new Error(CONFIG_ERROR); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error(CONFIG_ERROR);
  refuseOpenAi({ provider: row.provider, baseUrl: row.baseUrl, wireFormat: row.wireFormat }, url);
  return {
    provider: row.provider, model: row.model, baseUrl: row.baseUrl,
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

/** The secret name `plur1bus login <provider> --api-key` stores a key under. */
export const turnEvalSecretName = (provider: string): string => `${provider}/api-key`;

/**
 * The credential source of the scheduled job for each provider label it may use: the GitHub secret's variable name,
 * visible to the setup step only. Any other provider can only be a local endpoint.
 */
export const TURN_EVAL_KEY_ENV: Readonly<Record<string, string>> = {
  anthropic: "ANTHROPIC_API_KEY", google: "GOOGLE_API_KEY", gemini: "GOOGLE_API_KEY",
};
/** Local OpenAI-compatible servers need no key, but the harness' credentials path always presents one. */
const LOCAL_PLACEHOLDER_KEY = "local";

/** The short-lived eval home both steps share; it is never the owner's home. */
export function turnEvalHome(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const home = env.PLUR1BUS_TURN_EVAL_HOME;
  if (!home || !/^(?:\/|[A-Za-z]:[\\/])/.test(home)) throw new Error("PLUR1BUS_TURN_EVAL_HOME must name an absolute path for the short-lived eval home");
  return home;
}

/**
 * The harness secret store of an eval home. Keys live in its encrypted file backend, which carries across processes: the
 * setup step writes, the evaluation reads. The OS keyring is switched off so a developer's real keychain is never touched.
 */
export function openTurnEvalSecrets(home: string): SecretStore {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return createCoreSecretStore({
    layout: layout(home), securePath: createPlatformCapabilities().securePath, fileFallback: () => true,
    env: { PLUR1BUS_ALLOW_TEST_INTERNALS: "1", PLUR1BUS_SECRETS_KEYRING: "off" },
  });
}

/**
 * The setup step: store each provider's key under the name `plur1bus login` uses. This is the only place that reads a key
 * variable. Returns the secret names written (never a value).
 */
export async function storeTurnEvalCredentials(
  models: readonly TurnEvalModel[], env: Readonly<Record<string, string | undefined>>, secrets: SecretStore,
): Promise<string[]> {
  const written: string[] = [];
  for (const provider of new Set(models.map(model => model.provider))) {
    const keyEnv = TURN_EVAL_KEY_ENV[provider];
    const key = keyEnv ? env[keyEnv] : undefined;
    const local = models.filter(model => model.provider === provider).every(model => model.local === true);
    if (!key && !local) {
      throw new Error(keyEnv
        ? `live turn eval credential ${keyEnv} for provider ${provider} is unavailable`
        : `live turn eval has no credential source for provider ${provider}; only local endpoints may use another provider name`);
    }
    const name = turnEvalSecretName(provider);
    await secrets.set({ kind: "owner" }, name, key || LOCAL_PLACEHOLDER_KEY);
    written.push(name);
  }
  return written;
}

function definitionOf(model: TurnEvalModel): ProviderDefinition {
  const scheme = model.wireFormat === "chat_completions" ? "Authorization: Bearer {token}" : "x-api-key: {token}";
  return {
    wireFormat: model.wireFormat, defaultModel: model.model,
    entries: [{ id: "default", secretRef: turnEvalSecretName(model.provider) }],
    profile: {
      id: model.provider, display_name: model.provider, kind: "api_key", capabilities: ["chat"], base_url: model.baseUrl,
      auth_header_scheme: scheme, policy_status: "allowed", policy_source: "turn-eval", policy_checked: "2026-10-29",
    },
  };
}

export interface TurnEvalProviders {
  /** One adapter per configured model, in order; each leases its key from the store on every request. */
  adapters: StreamingAdapter[];
  close(): void;
}

/**
 * The providers of a live run, composed exactly as the core composes them: provider definitions, the credentials provider
 * over the secret store, the egress gate on every request. A missing key surfaces as the harness' `no_credential` error.
 */
export function composeTurnEvalProviders(
  models: readonly TurnEvalModel[],
  o: { secrets: SecretStore; egress?: Egress; fetch?: typeof fetch },
): TurnEvalProviders {
  const definitions: Record<string, ProviderDefinition> = {};
  for (const model of models) {
    const definition = definitionOf(model);
    const known = definitions[model.provider];
    if (known && (known.profile.base_url !== model.baseUrl || known.wireFormat !== model.wireFormat)) {
      throw new Error(`live turn eval provider ${model.provider} is configured with two endpoints`);
    }
    definitions[model.provider] ??= definition;
  }
  const urls = models.map(model => new URL(model.baseUrl));
  const egress = o.egress ?? createEgress({ config: () => ({
    allowHosts: [...new Set(urls.map(url => url.hostname))],
    allowPorts: [...new Set(urls.map(url => Number(url.port) || (url.protocol === "https:" ? 443 : 80)))],
    allowLoopback: models.some(model => model.local === true),
  }) });
  const config = defaults();
  config.modelProfiles = Object.fromEntries(models.map((model, index) => [`eval-${index}`, {
    strategy: "fallback", candidates: [{ model: `${model.provider}/${model.model}`, weight: 1 }], params: {}, cache: { hint: "auto" },
  }]));
  const auth = composeAuth({ config, definitions, secrets: o.secrets, egress, ...(o.fetch ? { fetch: o.fetch } : {}) });
  if (auth.refused.length) throw new Error(`live turn eval provider ${auth.refused[0]!.provider} was refused: ${auth.refused[0]!.reason}`);
  return {
    adapters: models.map((_, index) => auth.profiles[`eval-${index}`]![0]!.adapter),
    close: () => auth.close(),
  };
}

/** Provider-family mapping is fixed by the configured wire, not inferred from model names. */
export function turnEvalFamily(config: TurnEvalModel): ProviderFamily {
  return { chat_completions: "openai-chat", anthropic_messages: "anthropic", gemini: "gemini" }[config.wireFormat] as ProviderFamily;
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
