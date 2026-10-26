// RE-14/T1: reference inputs and generated TypeScript results consumed by the Rust parity test.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CACHE_PROFILE_TABLE, cacheRouteForUrl, findCacheProfile } from "./cache-profiles.ts";
import type { CachePlatform, CacheProvider, CacheRoute, NormalizedModelRef } from "./cache-profiles.ts";

interface ProfileVector {
  name: string;
  model: string;
  route: CacheRoute;
  expected: { ref: NormalizedModelRef; platform: CachePlatform; gateway: string; rowId: string | null };
}

// These are inputs, not hand-maintained expected results. Coverage fails when a new row needs a witness.
const ROW_MODELS: Record<string, string[]> = {
  "anthropic.bedrock.opus-4-7": ["claude-opus-4-7"],
  "anthropic.mythos-preview": ["claude-mythos-preview"],
  "anthropic.fable-mythos-5-1": ["claude-fable-5-1", "claude-mythos-5-1"],
  "anthropic.fable-mythos-5": ["claude-fable-5", "claude-mythos-5-2"],
  "anthropic.opus-5-5": ["claude-opus-5-5"],
  "anthropic.opus-5": ["claude-opus-5", "claude-opus-5-2"],
  "anthropic.sonnet-5-5": ["claude-sonnet-5-5"],
  "anthropic.sonnet-5": ["claude-sonnet-5"],
  "anthropic.haiku-5": ["claude-haiku-5", "claude-haiku-5-5"],
  "anthropic.opus-4-8": ["claude-opus-4-8"],
  "anthropic.opus-4-7": ["claude-opus-4-7"],
  "anthropic.sonnet-4-5-4-6": ["claude-sonnet-4-5", "claude-sonnet-4-6"],
  "anthropic.opus-4-5-4-6": ["claude-opus-4-5", "claude-opus-4-6"],
  "anthropic.opus-4-4-1": ["claude-opus-4", "claude-opus-4-1", "claude-opus-4-20250514"],
  "anthropic.sonnet-4": ["claude-sonnet-4", "claude-sonnet-4-20250514"],
  "anthropic.haiku-4-5": ["claude-haiku-4-5"],
  "anthropic.haiku-3-5": ["claude-haiku-3-5", "claude-3-5-haiku-latest"],
  "openai.chatgpt-plan": ["gpt-6", "codex-mini", "o4-mini"],
  "openai.gpt-6": ["gpt-6.1-sol"],
  "openai.gpt-5-6-plus": ["gpt-5.6", "gpt-5.9-mini", "gpt-5.10"],
  "openai.implicit": ["gpt-4.1", "gpt-5.5", "o4-mini"],
  "google.vertex.gemini-6144": ["gemini-3.8-flash", "gemini-3.0-flash-preview"],
  "google.vertex.gemini-3-4": ["gemini-4-pro", "gemini-3.1-flash-lite"],
  "google.vertex.gemini-2": ["gemini-2.5-pro"],
  "google.gemini-2-5": ["gemini-2.5-flash"],
  "google.gemini-3-gemma4": ["gemini-3.1-flash-lite", "gemini-3.1-pro-preview"],
  "google.gemini-3": ["gemini-3.8-flash"],
  "google.gemini-4": ["gemini-4-pro"],
  "google.gemini-other": ["gemini-unknown"],
  "xai.grok": ["grok-4.7"],
  "moonshot.kimi-k3": ["kimi-k3.1-pro-highspeed"],
  "moonshot.kimi-k2": ["kimi-k2-instruct"],
  "deepseek.all": ["deepseek-v4.1-flash"],
  "alibaba.qwen": ["qwen3.8-max"],
  "zai.glm": ["glm-5.3"],
  "mistral.all": ["mistral-large-4", "magistral-small", "devstral-2", "codestral-latest", "ministral-3", "pixtral-12b"],
  "local.kv-prefix": ["qwen3:8b", "claude-opus-5", "unknown-local-model"],
};

const VENDOR_MODELS: Record<CacheProvider, string> = {
  anthropic: "claude-opus-5", openai: "gpt-6", google: "gemini-3.8-flash", xai: "grok-4.7",
  moonshot: "kimi-k3", deepseek: "deepseek-chat", alibaba: "qwen3", zai: "glm-5.3",
  mistral: "mistral-large-4", local: "unknown-local-model",
};

const HOST_INPUTS = [
  "openrouter.ai", "api.openrouter.ai", "api.openai.com", "chatgpt.com", "api.chatgpt.com",
  "api.anthropic.com", "bedrock-runtime.us-east-1.amazonaws.com", "bedrock.eu-west-1.amazonaws.com",
  "aiplatform.googleapis.com", "us-east5-aiplatform.googleapis.com", "generativelanguage.googleapis.com",
  "api.x.ai", "api.moonshot.ai", "api.moonshot.cn", "api.kimi.ai", "api.kimi.com", "api.deepseek.com",
  "dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com", "dashscope-us.aliyuncs.com",
  "api.z.ai", "open.bigmodel.cn", "api.mistral.ai",
];

function profileVector(name: string, model: string, route: CacheRoute = {}): ProfileVector {
  const match = findCacheProfile(model, route);
  return {
    name, model, route,
    expected: { ref: match.ref, platform: match.platform, gateway: match.gateway, rowId: match.row?.id ?? null },
  };
}

function rowVectors(): ProfileVector[] {
  return CACHE_PROFILE_TABLE.rows.flatMap((row) => {
    const models = ROW_MODELS[row.id];
    if (!models) throw new Error(`cache-profile vectors: add model inputs for ${row.id}`);
    return models.flatMap((model) => [
      profileVector(`row:${row.id}:${model}:default`, model),
      ...row.platforms.map((platform) => profileVector(`row:${row.id}:${model}:${platform}`, model, { platform })),
    ]);
  });
}

function decoratedVectors(): ProfileVector[] {
  const aliases = CACHE_PROFILE_TABLE.aliases.flatMap(({ from }) => [
    profileVector(`alias:${from}`, from),
    profileVector(`alias:${from}:decorated`, `  GOOGLE/${from.replaceAll("-", ".")}:free  `),
  ]);
  const prefixes = Object.entries(CACHE_PROFILE_TABLE.gateways.openrouter.slugPrefixes).flatMap(([prefix, vendor]) => [
    profileVector(`gateway:${prefix}`, `${prefix}/${VENDOR_MODELS[vendor]}`),
    profileVector(`gateway:${prefix}:suffix`, `${prefix}/${VENDOR_MODELS[vendor]}:free`),
  ]);
  const bedrock = ["us", "eu", "apac", "jp", "au", "global"].map((region) =>
    profileVector(`bedrock:${region}`, `${region}.anthropic.claude-opus-4-7-v1:0`));
  return [...aliases, ...prefixes, ...bedrock,
    profileVector("bedrock:unregional", "anthropic.claude-opus-4-7-v2"),
    profileVector("bedrock:no-version", "anthropic.claude-opus-4-7"),
    profileVector("google:dated", "claude-opus-4-1@20250805"),
    profileVector("google:invalid-date-shape", "claude-opus-4-1@2025080"),
    profileVector("route:override-platform", "us.anthropic.claude-opus-4-7-v1:0", { platform: "first-party" }),
    profileVector("route:override-gateway", "anthropic/claude-opus-5", { gateway: "direct" }),
    profileVector("route:local", "anthropic/claude-opus-5", { local: true, platform: "bedrock" }),
    profileVector("route:local-false", "claude-opus-5", { local: false }),
    profileVector("route:unsupported-platform", "gpt-6", { platform: "vertex" }),
    profileVector("route:gateway", "claude-opus-5", { gateway: "openrouter", vendor: "anthropic" }),
    profileVector("unknown:model", "mystery-model"),
    profileVector("unknown:prefix", "unknown/gpt-6:free"),
    profileVector("unknown:empty", ""),
    profileVector("normalization:case", "\u00a0Anthropic/Claude-Opus-4.5:free\u00a0"),
    profileVector("normalization:bom", "\ufeffOpenAI/GPT-6:free\ufeff"),
    profileVector("normalization:next-line-is-not-trimmed", "\u0085gpt-6\u0085"),
    profileVector("normalization:unicode-digits", "gpt-5-\u0666"),
    profileVector("normalization:unicode-case", "\u039f\u03a3"),
    profileVector("normalization:internal-line", "unknown\r\nmodel", { local: true }),
  ];
}

function urlVectors(): Array<{ url: string; expected: CacheRoute }> {
  const urls = HOST_INPUTS.flatMap((host) => [
    `https://${host}/v1`,
    `HTTPS://${host.toUpperCase()}:443/v1?model=gpt-6`,
    `https://${host}.evil.example/v1`,
  ]);
  urls.push("https://api.openai.com.evil.example/v1", "https://notopenrouter.ai/v1",
    "https://api.openai.com@evil.example/v1", "https://user:pass@api.openai.com:8443/v1",
    "https://api%2eopenai%2ecom/v1", "https://api.openai.com./v1", "https://llm.example.com/v1",
    "http://localhost:11434/v1", "http://127.0.0.1:1234/v1", "http://[::1]:8080/v1",
    "file:///tmp/cache-profiles.json", "mailto:api.openai.com", "not a url", "", "https://[invalid/v1");
  urls.push("file://api.openai.com/cache", "custom://API.OPENAI.COM/v1", "https://api.\topenai.com/v1");
  return [...new Set(urls)].map((url) => ({ url, expected: cacheRouteForUrl(url) }));
}

/** Build the committed contract by evaluating all inputs through the TypeScript reference loader. */
export function buildCacheProfileVectors() {
  const profiles = [...rowVectors(), ...decoratedVectors()];
  const urls = urlVectors();
  for (const row of CACHE_PROFILE_TABLE.rows) {
    if (!profiles.some((v) => v.expected.rowId === row.id)) {
      throw new Error(`cache-profile vectors: no witness for ${row.id}`);
    }
  }
  for (const host of CACHE_PROFILE_TABLE.hosts) {
    if (!HOST_INPUTS.some((input) => new RegExp(host.pattern, "u").test(input))) {
      throw new Error(`cache-profile vectors: add host inputs for ${host.pattern}`);
    }
  }
  return { version: 1, profiles, urls };
}

function main(): void {
  const output = new URL("../fixtures/cache-profile-vectors.json", import.meta.url);
  const expected = JSON.stringify(buildCacheProfileVectors(), null, 2) + "\n";
  if (process.argv.includes("--check")) {
    let actual = "";
    try {
      actual = readFileSync(output, "utf8").replaceAll("\r\n", "\n");
    } catch { /* A missing fixture is stale. */ }
    if (actual !== expected) {
      console.error("stale: packages/providers/fixtures/cache-profile-vectors.json (run pnpm gen)");
      process.exitCode = 1;
    }
    return;
  }
  mkdirSync(dirname(fileURLToPath(output)), { recursive: true });
  writeFileSync(output, expected);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
