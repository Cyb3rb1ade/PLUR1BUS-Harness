// Script the TypeScript providerRunner with an in-memory scope and a provider double.
import { pathToFileURL } from "node:url";
import { providerRunner, type AgentRunInput } from "../../packages/core/src/collab/runner.ts";
import { CollabError } from "../../packages/core/src/collab/errors.ts";
import type { ChatRequest } from "../../packages/core/src/session/provider.ts";
import { exporterMain } from "./lib.mjs";

async function record(name: string) {
  const view = ["file.list", "file.read", "file.write"];
  const held = name === "missing scope" ? undefined : {
    agentId: name === "wrong scope" ? "other" : "worker", projectId: "project", toolView: view,
    ...(name === "no delegation" ? {} : {
      delegation: { callClass: ["write", "independent review"].includes(name) ? "write" : "read" },
    }),
  };
  const abort = new AbortController();
  if (name === "already aborted") abort.abort(new Error("fixture cancelled"));
  const calls = [];
  const progress = [];
  const transport = {
    id: "fixture",
    async *stream(req: ChatRequest) {
      calls.push({
        agentId: req.agentId, projectId: req.projectId, sessionId: req.sessionId,
        messages: req.messages, toolView: req.toolView, readOnlyWorktree: req.readOnlyWorktree ?? null,
        principal: req.principal ?? null, person: req.authenticatedPerson ?? null, maxRounds: req.maxRounds ?? null,
      });
      req.onProgress?.();
      yield { type: "delta", text: "partial" };
      if (name === "aborts in stream") abort.abort(new Error("fixture cancelled"));
      yield { type: "usage", inputTokens: 2, outputTokens: 3 };
      yield { type: "tool.call", id: "fixture", name: "file.read", args: {} };
      yield { type: "delta", text: " text" };
    },
  };
  const input = {
    agentId: "worker", question: "Check fixture", context: "More context", maxRounds: 2,
    ...(name === "write" ? { sessionId: "bound-session" } : {}),
    signal: abort.signal,
    principal: { userId: "lead", kind: name === "agent principal" ? "agent" : "person", role: "owner" },
    ...(name === "no delegation" || name === "read" ? {} : { handoff: {
      contract: { constraints: { scope: { tools: ["file.read", "file.write"] } } },
      context: name === "independent review" ? { readOnlyWorktree: "trusted-fixture-path" } : {},
    } }),
    onProgress: (out: {text: string; inputTokens: number; outputTokens: number}) => {
      progress.push([out.text, out.inputTokens, out.outputTokens]);
    },
  } as AgentRunInput;
  let result;
  try {
    result = { ok: await providerRunner(transport as never, { current: () => held } as never).run(input) };
  } catch (e) {
    result = { err: e instanceof CollabError ? { code: e.code, message: e.message } : { code: "aborted" } };
  }
  return { name, result, calls, progress };
}

export async function buildCodingRunnerVectors() {
  const runner = [];
  for (const name of ["write", "read", "no delegation", "independent review", "agent principal",
    "missing scope", "wrong scope", "already aborted", "aborts in stream"]) runner.push(await record(name));
  return { runner };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await exporterMain({ area: "coding", build: buildCodingRunnerVectors });
}
