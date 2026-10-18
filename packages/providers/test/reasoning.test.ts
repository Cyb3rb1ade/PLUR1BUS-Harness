// Reasoning intensity: the shared scale and every adapter's wire mapping (no network: request builders only).
import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderError, buildRequestBody, buildGeminiBody, nearestLevel, budgetFor, reasoningDirective, checkReasoningDirective, REASONING_LEVELS } from "../src/index.ts";
import type { ChatRequest, ReasoningDescriptor } from "../src/index.ts";
import { buildAnthropicBody } from "../src/anthropic/request.ts";
import { buildResponsesBody } from "../src/responses/request.ts";

const hi: ChatRequest["messages"] = [{ role: "user", content: "hi" }];
const invalid = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: unknown) => e instanceof ProviderError && e.kind === "invalid_request" && re.test(e.message), String(re));
const chat = (r: ChatRequest["reasoning"]) => buildRequestBody({ model: "m", messages: hi, ...(r ? { reasoning: r } : {}) }, { stream: false, maxTokensField: "max_tokens", includeUsage: false });

test("scale: six levels cheapest first; nearest supported level, ties go to the cheaper one, adjusted is visible", () => {
  assert.deepEqual([...REASONING_LEVELS], ["off", "minimal", "low", "medium", "high", "xhigh"]);
  assert.deepEqual(nearestLevel("medium", ["low", "medium", "high"]), { level: "medium", adjusted: false });
  assert.deepEqual(nearestLevel("xhigh", ["low", "medium", "high"]), { level: "high", adjusted: true });
  assert.deepEqual(nearestLevel("minimal", ["off", "high"]), { level: "off", adjusted: true });
  assert.deepEqual(nearestLevel("medium", ["low", "high"]), { level: "low", adjusted: true });
  assert.equal(nearestLevel("high", []), null);
});

test("budget levels map onto the model's range and never leave it", () => {
  const b = { min: 1024, max: 32768, default: 8192 };
  assert.deepEqual(["off", "minimal", "low", "medium", "high", "xhigh"].map((l) => budgetFor(l as never, b)), [0, 1024, 4096, 8192, 16384, 32768]);
  assert.equal(budgetFor("low", { min: 2048, max: 4096, default: 2048 }), 2048);
});

test("directive: effort uses the per-level wire value, toggle a boolean, budget tokens; none has no directive", () => {
  const effort: ReasoningDescriptor = { kind: "effort", levels: ["off", "low", "medium", "high"], vendorParam: "reasoning_effort", values: { off: "none" }, source: "table" };
  assert.deepEqual(reasoningDirective("off", effort), { vendorParam: "reasoning_effort", value: "none" });
  assert.deepEqual(reasoningDirective("high", effort), { vendorParam: "reasoning_effort", value: "high" });
  const toggle: ReasoningDescriptor = { kind: "toggle", levels: ["off", "medium"], vendorParam: "chat_template_kwargs.enable_thinking", source: "table" };
  assert.deepEqual(reasoningDirective("off", toggle), { vendorParam: "chat_template_kwargs.enable_thinking", value: false });
  assert.deepEqual(reasoningDirective("medium", toggle), { vendorParam: "chat_template_kwargs.enable_thinking", value: true });
  const budget: ReasoningDescriptor = { kind: "budget", levels: ["off", "low", "high"], vendorParam: "thinking.budget_tokens", budget: { min: 1024, max: 32768, default: 8192 }, source: "table" };
  assert.deepEqual(reasoningDirective("high", budget), { vendorParam: "thinking.budget_tokens", value: 16384 });
  assert.equal(reasoningDirective("high", { kind: "none", levels: [], source: "unknown" }), undefined);
  assert.throws(() => reasoningDirective("xhigh", effort), /not supported/);
  assert.match(checkReasoningDirective({ vendorParam: "reasoning_effort", value: "HIGH; drop" }, ["reasoning_effort"], "x") ?? "", /lowercase word/);
});

test("chat_completions: reasoning_effort, OpenRouter reasoning object and the Qwen/DeepSeek template toggle; nothing sent without a directive", () => {
  assert.equal("reasoning_effort" in chat(undefined), false);
  assert.equal(chat({ vendorParam: "reasoning_effort", value: "high" })["reasoning_effort"], "high");
  assert.deepEqual(chat({ vendorParam: "reasoning.effort", value: "low" })["reasoning"], { effort: "low" });
  assert.deepEqual(chat({ vendorParam: "chat_template_kwargs.enable_thinking", value: false })["chat_template_kwargs"], { enable_thinking: false });
  // Key order stays fixed (cache stability): the reasoning field sits right before `stream`.
  const keys = Object.keys(chat({ vendorParam: "reasoning_effort", value: "low" }));
  assert.deepEqual(keys.slice(-2), ["reasoning_effort", "stream"]);
  invalid(() => chat({ vendorParam: "thinking.budget_tokens", value: 2048 }), /not supported by the chat_completions wire/);
  invalid(() => chat({ vendorParam: "chat_template_kwargs.enable_thinking", value: "yes" }), /boolean/);
});

test("Anthropic: budget becomes thinking, max_tokens is lifted above the budget, 0 sends nothing", () => {
  const b = buildAnthropicBody({ model: "c", messages: hi, maxTokens: 1000, reasoning: { vendorParam: "thinking.budget_tokens", value: 4096 } }, { stream: false, defaultMaxTokens: 4096 });
  assert.deepEqual(b["thinking"], { type: "enabled", budget_tokens: 4096 });
  assert.equal(b["max_tokens"], 5096);
  const roomy = buildAnthropicBody({ model: "c", messages: hi, maxTokens: 20000, reasoning: { vendorParam: "thinking.budget_tokens", value: 4096 } }, { stream: false, defaultMaxTokens: 4096 });
  assert.equal(roomy["max_tokens"], 20000);
  const off = buildAnthropicBody({ model: "c", messages: hi, reasoning: { vendorParam: "thinking.budget_tokens", value: 0 } }, { stream: false, defaultMaxTokens: 4096 });
  assert.equal("thinking" in off, false);
  invalid(() => buildAnthropicBody({ model: "c", messages: hi, reasoning: { vendorParam: "thinking.budget_tokens", value: 512 } }, { stream: false, defaultMaxTokens: 4096 }), /at least 1024/);
  invalid(() => buildAnthropicBody({ model: "c", messages: hi, temperature: 0.2, reasoning: { vendorParam: "thinking.budget_tokens", value: 2048 } }, { stream: false, defaultMaxTokens: 4096 }), /temperature/);
  invalid(() => buildAnthropicBody({ model: "c", messages: hi, reasoning: { vendorParam: "reasoning_effort", value: "high" } }, { stream: false, defaultMaxTokens: 4096 }), /not supported by the Anthropic Messages wire/);
});

test("Anthropic: an unsigned thinking tool continuation is refused rather than silently dropping thinking", () => {
  const loop: ChatRequest["messages"] = [
    {role:"user",content:"weather?"},
    {role:"assistant",content:null,toolCalls:[{id:"t1",name:"w",arguments:"{}"}]},
    {role:"tool",toolCallId:"t1",content:"sunny"},
  ];
  invalid(()=>buildAnthropicBody({model:"c",messages:loop,reasoning:{vendorParam:"thinking.budget_tokens",value:2048}},{stream:false,defaultMaxTokens:4096}),/original signed thinking blocks/);
});

test("Anthropic stable effort uses output_config without a beta header or budget",()=>{
 const body=buildAnthropicBody({model:"claude-opus-4-5",messages:hi,reasoning:{vendorParam:"output_config.effort",value:"high"}},{stream:false,defaultMaxTokens:4096});
 assert.deepEqual(body.output_config,{effort:"high"});assert.equal("thinking" in body,false);
 invalid(()=>buildAnthropicBody({model:"c",messages:hi,reasoning:{vendorParam:"output_config.effort",value:"banana"}},{stream:false,defaultMaxTokens:4096}),/effort must be/);
 invalid(()=>buildAnthropicBody({model:"c",messages:hi,maxTokens:Number.MAX_SAFE_INTEGER,reasoning:{vendorParam:"thinking.budget_tokens",value:Number.MAX_SAFE_INTEGER}},{stream:false,defaultMaxTokens:4096}),/safe integer/);
});

test("Gemini: thinkingBudget (2.5) and thinkingLevel (3) inside generationConfig.thinkingConfig", () => {
  assert.deepEqual(buildGeminiBody({ model: "g", messages: hi, reasoning: { vendorParam: "thinkingConfig.thinkingBudget", value: 0 } })["generationConfig"], { thinkingConfig: { thinkingBudget: 0 } });
  assert.deepEqual(buildGeminiBody({ model: "g", messages: hi, reasoning: { vendorParam: "thinkingConfig.thinkingLevel", value: "high" } })["generationConfig"], { thinkingConfig: { thinkingLevel: "high" } });
  invalid(() => buildGeminiBody({ model: "g", messages: hi, reasoning: { vendorParam: "reasoning_effort", value: "high" } }), /not supported by the Gemini wire/);
});

test("Responses: the directive wins over the adapter default, an explicit provider option still wins, xhigh/none accepted", () => {
  const opts = { stream: false, profile: "openai" as const, store: false, reasoningEffort: "low" as const };
  assert.deepEqual(buildResponsesBody({ model: "o", messages: hi, reasoning: { vendorParam: "reasoning.effort", value: "xhigh" } }, opts)["reasoning"], { effort: "xhigh" });
  assert.deepEqual(buildResponsesBody({ model: "o", messages: hi, reasoning: { vendorParam: "reasoning.effort", value: "none" } }, opts)["reasoning"], { effort: "none" });
  assert.deepEqual(buildResponsesBody({ model: "o", messages: hi, providerOptions: { responses: { reasoningEffort: "medium" } }, reasoning: { vendorParam: "reasoning.effort", value: "high" } }, opts)["reasoning"], { effort: "medium" });
  assert.deepEqual(buildResponsesBody({ model: "o", messages: hi }, opts)["reasoning"], { effort: "low" });
  invalid(() => buildResponsesBody({ model: "o", messages: hi, reasoning: { vendorParam: "reasoning.effort", value: "turbo" } }, opts), /none, minimal, low, medium, high or xhigh/);
  invalid(() => buildResponsesBody({ model: "o", messages: hi, reasoning: { vendorParam: "thinking.budget_tokens", value: 2048 } }, opts), /not supported by the Responses wire/);
});

test("adaptive effort explicitly enables thinking and keeps a single bounded output maximum",()=>{
 const directive=reasoningDirective("high",{kind:"effort",levels:["high"],vendorParam:"output_config.effort",adaptiveThinking:true,source:"table"});
 assert.deepEqual(directive,{vendorParam:"output_config.effort",value:"high",adaptiveThinking:true});
 const body=buildAnthropicBody({model:"claude-opus-4-6",messages:hi,maxTokens:2048,reasoning:directive},{stream:false,defaultMaxTokens:4096});
 assert.deepEqual(body.thinking,{type:"adaptive"});assert.deepEqual(body.output_config,{effort:"high"});assert.equal(body.max_tokens,2048);
 invalid(()=>buildAnthropicBody({model:"c",messages:hi,temperature:0.7,reasoning:directive},{stream:false,defaultMaxTokens:4096}),/sampling controls/);
});
