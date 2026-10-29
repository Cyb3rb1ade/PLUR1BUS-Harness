/** D97/N-G1: evaluate harness decisions through createTurnProvider, with adapters as the only model boundary. */
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTurnProvider, type TurnProviderOptions } from "../composition/provider.ts";
import { createCallBudget } from "../budget/index.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { LiveCapabilityIndex } from "./live-index.ts";
import type { ProviderFamily } from "./quirks.ts";
import type { ChatChunk, ChatRequest } from "../session/provider.ts";
import type { ChatRequest as WireRequest, JsonObject, StreamingAdapter } from "../../../providers/src/index.ts";

/** A model recording, independent of the expected harness checks. Names use the public dotted tool spelling. */
export interface TurnEvalRound {
  text?: string;
  calls?: { name: string; args: JsonObject }[];
}

/** An installed skill fixture; its body is deliberately distinguishable from its discovery description. */
export interface TurnEvalSkill {
  name: string;
  description: string;
  category: string;
  body: string;
}

/** One input plus independent acceptance criteria; multiple inputs share one real provider and capability store. */
export interface TurnEvalTurn {
  input: string;
  rounds: TurnEvalRound[];
  requiredTools?: string[];
  requiredSkills?: string[];
  choice: "required" | "auto";
  errorReturned?: string;
  checklist?: string[];
  noToolNeeded?: boolean;
}

/** A bilingual fixture scenario. Failure injection affects only the tool boundary, never harness decisions. */
export interface TurnEvalScenario {
  id: string;
  language: "de" | "en";
  tags: string[];
  turns: TurnEvalTurn[];
  skills?: TurnEvalSkill[];
  pinned?: string[];
  failToolOnce?: string;
  deniedTools?: string[];
}

/** Only bounded labels and counts are exported; model responses and tool exception text are not report fields. */
export interface TurnEvalCheck {
  name: string;
  passed: boolean;
}

/** The observed requests, calls and checks of a scenario; no inference from expected calls populates these counters. */
export interface TurnEvalResult {
  id: string;
  passed: boolean;
  checks: TurnEvalCheck[];
  turns: number;
  toolTargets: number;
  toolHits: number;
  skillTargets: number;
  skillHits: number;
  neededTurns: number;
  missedToolTurns: number;
  plainTurns: number;
  unnecessaryToolTurns: number;
  toolPrefixChanges: number;
  policyViolations: number;
  policyAttempts: number;
  providerRequests: number;
  termination: string[];
}

/** Counts accompany every rate so a fixture pass is never confused with live-model qualification. */
export interface TurnEvalReport {
  schema: "plur1bus.turn-eval/1";
  evidence: "fixture" | "live";
  scenarios: TurnEvalResult[];
  metrics: {
    scenarioPassRate: number;
    toolHitRate: number;
    missingToolRate: number;
    unnecessaryToolRate: number;
    skillHitRate: number;
    toolPrefixChangesPerTurn: number;
    policyViolations: number;
  };
  denominators: {
    scenarios: number; turns: number; tools: number; skills: number; neededTurns: number; plainTurns: number;
    policyAttempts: number;
  };
}

/** Live callers supply a real streaming adapter explicitly; the default runner performs no network access. */
export interface TurnEvalOptions {
  adapterForScenario?: (scenario: TurnEvalScenario) => StreamingAdapter;
  evidence?: "fixture" | "live";
  provider?: string;
  model?: string;
  family?: ProviderFamily;
  providerOptions?: Partial<TurnProviderOptions>;
}

const FIXED_NOW = Date.UTC(2026, 9, 28);
const EVAL_PRINCIPAL = `user:v2:${"a".repeat(64)}`;
const META_TOOLS = new Set(["capabilities.search", "skill.load", "skill.read"]);
const TOOL_NAMES = [
  "file.read", "file.list", "file.stat", "web.search", "web.fetch",
  ...Array.from({ length: 16 }, (_, i) => `fixture.operation${i}`),
];
const originalName = (name: string): string =>
  [...TOOL_NAMES, ...META_TOOLS].find(n => n.replaceAll(".", "_") === name) ?? name;
const content = (request: WireRequest): string =>
  request.messages.map(m => typeof m.content === "string" ? m.content : "").join("\n");
const ratio = (hits: number, total: number): number => total ? hits / total : 0;

function installSkills(home: string, skills: readonly TurnEvalSkill[]): void {
  mkdirSync(join(home, "skills"), { recursive: true });
  for (const skill of skills) {
    const folder = join(home, "skills", skill.name);
    mkdirSync(folder, { recursive: true });
    const text = [
      "---", `name: ${skill.name}`, `description: ${JSON.stringify(skill.description)}`,
      `category: ${skill.category}`, `useWhen: ${JSON.stringify(skill.description)}`, "---", skill.body, "",
    ].join("\n");
    writeFileSync(join(folder, "SKILL.md"), text);
  }
  writeFileSync(join(home, "skills", "index.json"), JSON.stringify({
    version: 1,
    skills: skills.map(s => ({ id: s.name, enabled: true, source: "turn-eval" })),
  }));
}

function fixtureRegistry(scenario: TurnEvalScenario): { registry: ToolRegistry; executed: string[] } {
  const registry = new ToolRegistry();
  const executed: string[] = [];
  let failed = false;
  for (const name of TOOL_NAMES) {
    registry.register({
      name,
      description: name.startsWith("file.") ? `${name} reads files and lists file information.`
        : name.startsWith("web.") ? `${name} searches current web sources and fetches websites.`
        : `${name} reports fixture operation status.`,
      capability: "fs.read", effect: "read", risk: "low", trust: "first-party",
      inputSchema: { type: "object", additionalProperties: false, properties: { query: { type: "string" } } },
      classify: () => ({ flags: { outsideRoots: false, denyListHit: false } }),
      async execute() {
        executed.push(name);
        if (!failed && scenario.failToolOnce === name) {
          failed = true;
          throw new Error("fixture tool temporarily unavailable");
        }
        return { fixture: true, tool: name, text: "safe fixture evidence" };
      },
    });
  }
  return { registry, executed };
}

function recordedAdapter(rounds: () => readonly TurnEvalRound[]): StreamingAdapter {
  let current: readonly TurnEvalRound[] | undefined;
  let position = 0;
  let sequence = 0;
  return {
    async *stream() {
      const next = rounds();
      if (next !== current) { current = next; position = 0; }
      const round = next[position++] ?? { text: "fixture complete" };
      sequence++;
      const calls = round.calls ?? [];
      yield { type: "done", result: {
        text: round.text ?? "",
        toolCalls: calls.map((c, i) => ({
          id: `eval-${sequence}-${i}`, name: c.name, arguments: c.args, argumentsRaw: JSON.stringify(c.args),
        })),
        finishReason: calls.length ? "tool_calls" : "stop", rawFinishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 2 }, meta: {},
      } };
    },
  };
}

function emptyResult(id: string): TurnEvalResult {
  return {
    id, passed: false, checks: [], turns: 0, toolTargets: 0, toolHits: 0, skillTargets: 0, skillHits: 0,
    neededTurns: 0, missedToolTurns: 0, plainTurns: 0, unnecessaryToolTurns: 0,
    toolPrefixChanges: 0, policyViolations: 0, policyAttempts: 0, providerRequests: 0, termination: [],
  };
}

function checkTurn(
  result: TurnEvalResult, turn: TurnEvalTurn, requests: readonly WireRequest[], chunks: readonly ChatChunk[],
  executed: readonly string[], turnIndex: number,
): void {
  const check = (name: string, passed: boolean) =>
    result.checks.push({ name: `turn ${turnIndex + 1}: ${name}`, passed });
  const offered = new Set(requests.flatMap(r => (r.tools ?? []).map(t => originalName(t.name))));
  const called = chunks.filter((c): c is Extract<ChatChunk, { type: "tool.call" }> => c.type === "tool.call");
  const text = requests.map(content).join("\n");
  check("provider was reached", requests.length > 0);
  for (const tool of turn.requiredTools ?? []) {
    const hit = offered.has(tool) && executed.includes(tool);
    result.toolTargets++;
    if (hit) result.toolHits++;
    check(`${tool} is offered or discovered and executes`, hit);
  }
  for (const name of turn.requiredSkills ?? []) {
    const visible = requests.some(r => r.messages.some(m => m.role === "system" && String(m.content).includes(name)));
    const loaded = requests.some(r => r.messages.some(m => m.role === "tool" && m.content.includes(`BODY:${name}`)));
    result.skillTargets++;
    if (loaded) result.skillHits++;
    check(`${name} is visible in system or loaded as a tool result`, visible || loaded);
    check(`${name} instructions are loaded`, loaded);
  }
  const firstChoice = requests[0]?.toolChoice ?? "auto";
  check(`round zero tool_choice is ${turn.choice}`, turn.choice === "auto"
    ? firstChoice === "auto" : firstChoice === "required" || typeof firstChoice === "object");
  const normalRounds = requests.slice(1).filter(r => !content(r).includes("Invalid arguments (data):"));
  check("later rounds use auto tool_choice",
    normalRounds.every(r => r.toolChoice === undefined || r.toolChoice === "auto"));
  if (turn.errorReturned) {
    const found = requests.slice(1).some(r => r.messages.some(m => m.role === "tool"
      && m.content.includes('"isError":true') && m.content.includes(turn.errorReturned!)));
    check("typed error reaches a subsequent model round", found);
    check("model recovers after the tool error", chunks.some(c => c.type === "delta" && c.text.includes("recovered")));
  }
  if (turn.checklist) {
    check("multi task checklist reaches the model", requests.some(r => r.messages.some(m =>
      typeof m.content === "string" && /checklist|\[[ x]\]/i.test(m.content)
      && turn.checklist!.every(task => String(m.content).includes(task)))));
  }
  const domainCall = called.some(c => !META_TOOLS.has(c.name));
  if ((turn.requiredTools?.length ?? 0) > 0) {
    result.neededTurns++;
    if (!domainCall) result.missedToolTurns++;
  }
  if (turn.noToolNeeded) {
    result.plainTurns++;
    if (domainCall) result.unnecessaryToolTurns++;
    check("plain chat needs no domain tool call", !domainCall);
  }
}

/** Run a scenario with real routing, skill discovery, validation, dispatch, budgets and prompt construction. */
export async function runTurnScenario(
  scenario: TurnEvalScenario, options: TurnEvalOptions = {},
): Promise<TurnEvalResult> {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "p1b-turn-eval-")));
  mkdirSync(join(home, "state"));
  installSkills(home, scenario.skills ?? []);
  const capabilities = new LiveCapabilityIndex(home, () => FIXED_NOW);
  const budget = createCallBudget({
    path: join(home, "state", "budget.sqlite"), clock: { now: () => FIXED_NOW }, emitter: { emit() {} },
  });
  const { registry, executed } = fixtureRegistry(scenario);
  const result = emptyResult(scenario.id);
  let activeRounds: readonly TurnEvalRound[] = [];
  const model = options.adapterForScenario?.(scenario) ?? recordedAdapter(() => activeRounds);
  const requests: WireRequest[] = [];
  const attempted: string[] = [];
  const adapter: StreamingAdapter = { async *stream(request, callOptions) {
    requests.push(structuredClone(request));
    for await (const event of model.stream(request, callOptions)) {
      if (event.type === "done") attempted.push(...event.result.toolCalls.map(c => originalName(c.name)));
      yield event;
    }
  } };
  const providerId = options.provider ?? "turn-eval-fixture";
  const provider = createTurnProvider({
    registry, budget, capabilities,
    profiles: { default: [{ provider: providerId, model: options.model ?? "gpt-4.1", adapter }] },
    family: { [providerId]: options.family ?? "openai-chat" },
    skillsForAgent: () => ({ pinned: scenario.pinned ?? [] }),
    ...(scenario.deniedTools ? { policyContext: () => ({ toolsDeny: scenario.deniedTools! }) } : {}),
    approval: { request: async () => ({ approved: false }) }, grants: { get: () => undefined, list: () => [] },
    log() {}, resultStore: { async put() { throw new Error("fixture result exceeded the model result cap"); } },
    router: {
      retry: { maxRetries: 0 }, clock: { now: () => FIXED_NOW, async sleep(_ms, signal) { signal?.throwIfAborted(); } },
      random: () => 0,
    },
    maxRounds: 8, maxTokens: 1024, ...options.providerOptions,
  });
  const messages: ChatRequest["messages"] = [];
  const peers: NonNullable<ChatRequest["peerResults"]>[number][] = [];
  let previousTools: string | undefined;
  try {
    for (const [index, turn] of scenario.turns.entries()) {
      activeRounds = turn.rounds;
      messages.push({ role: "user", text: turn.input });
      const offset = requests.length;
      const executionOffset = executed.length;
      const chunks: ChatChunk[] = [];
      let termination = "completed";
      try {
        for await (const chunk of provider.stream({
          sessionId: scenario.id, turnId: `${scenario.id}-${index}`, agentId: "eval", principal: EVAL_PRINCIPAL,
          summaries: [], memory: "", messages: [...messages], peerResults: [...peers],
          signal: new AbortController().signal,
        })) chunks.push(chunk);
      } catch (error) {
        termination = error && typeof error === "object" && "code" in error ? String(error.code) : "turn-failed";
      }
      const turnRequests = requests.slice(offset);
      result.turns++;
      result.termination.push(termination);
      result.checks.push({ name: `turn ${index + 1}: completes`, passed: termination === "completed" });
      checkTurn(result, turn, turnRequests, chunks, executed.slice(executionOffset), index);
      if (turnRequests[0]) {
        const tools = JSON.stringify(turnRequests[0].tools ?? []);
        if (previousTools !== undefined && tools !== previousTools) result.toolPrefixChanges++;
        previousTools = tools;
      }
      messages.push({ role: "assistant", text: chunks.filter(c => c.type === "delta").map(c => c.text).join("") });
      for (const chunk of chunks) if (chunk.type === "tool.result") {
        const call = chunks.find(c => c.type === "tool.call" && c.id === chunk.id);
        if (call?.type === "tool.call") peers.push({ id: chunk.id, name: call.name, text: chunk.output });
      }
    }
    result.providerRequests = requests.length;
    for (const tool of scenario.deniedTools ?? []) {
      result.policyAttempts += attempted.filter(name => name === tool).length;
      const violations = executed.filter(name => name === tool).length;
      result.policyViolations += violations;
      result.checks.push({ name: `policy blocks ${tool} execution`, passed: violations === 0 });
    }
    result.passed = result.checks.every(c => c.passed);
    return result;
  } finally {
    budget.close();
    capabilities.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

/** Execute every case and aggregate raw counts. An external adapter marks the evidence as live explicitly. */
export async function runTurnEval(
  scenarios: readonly TurnEvalScenario[], options: TurnEvalOptions = {},
): Promise<TurnEvalReport> {
  if (options.evidence === "live" && !options.adapterForScenario) {
    throw new Error("live turn eval requires a real adapter");
  }
  const results: TurnEvalResult[] = [];
  for (const scenario of scenarios) results.push(await runTurnScenario(scenario, options));
  const sum = (key: keyof TurnEvalResult) => results.reduce((n, result) => n + Number(result[key]), 0);
  const turns = sum("turns"), tools = sum("toolTargets"), skills = sum("skillTargets");
  const neededTurns = sum("neededTurns"), plainTurns = sum("plainTurns");
  return {
    schema: "plur1bus.turn-eval/1", evidence: options.evidence ?? "fixture", scenarios: results,
    metrics: {
      scenarioPassRate: ratio(results.filter(r => r.passed).length, results.length),
      toolHitRate: ratio(sum("toolHits"), tools), missingToolRate: ratio(sum("missedToolTurns"), neededTurns),
      unnecessaryToolRate: ratio(sum("unnecessaryToolTurns"), plainTurns),
      skillHitRate: ratio(sum("skillHits"), skills),
      toolPrefixChangesPerTurn: ratio(sum("toolPrefixChanges"), turns), policyViolations: sum("policyViolations"),
    },
    denominators: {
      scenarios: results.length, turns, tools, skills, neededTurns, plainTurns, policyAttempts: sum("policyAttempts"),
    },
  };
}
