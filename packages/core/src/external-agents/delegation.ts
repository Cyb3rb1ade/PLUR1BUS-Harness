// External DelegationTarget. One ACP run is stateless (ADR-003 Q4): session/new every time, no stored ACP session.
// A side effect runs only after a D109 approval for subject acp-agent and only through B3 containment.
import { createHash, randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import type { ApprovalService } from "../approvals/service.ts";
import { CollabError } from "../collab/errors.ts";
import type { HandoffAck } from "../collab/handoff.ts";
import { requireAgentScope } from "../collab/scope.ts";
import type { DelegationTarget } from "../collab/target.ts";
import type { AgentRunInput, AgentRunResult } from "../collab/runner.ts";
import type { Principal } from "../rbac/types.ts";
import type { SessionStore } from "../session/store.ts";
import { AcpClient, AcpClientError, type AcpClientHandlers } from "./acp-client.ts";
import { containedRead, containedTerminal, containedWrite, ContainmentError, findHardlink } from "./containment.ts";
import { acpMemoryExposure, connectorArgv, type ResolvedEngine } from "./engine.ts";
import { launchExternalAgent, type LaunchHandle } from "./launcher.ts";

export interface ExternalRunLink {
  input: Readable;
  output: Writable;
  stop: () => void;
}

export interface ExternalTargetDeps {
  engineOf(agentId: string): ResolvedEngine | { kind: "external"; connector: null } | null;
  /** Provisioned project worktree, or null when the project is bound and nothing is forked. */
  worktreeOf(agentId: string, projectId: string): string | null;
  home: string;
  sessions(): SessionStore;
  approvals(): Promise<ApprovalService | null>;
  /** Test seam. Production launches the connector command. */
  connect?(o: { agentId: string; cwd: string; signal: AbortSignal; timeoutMs: number }): ExternalRunLink;
  forbiddenPayload?: readonly string[];
  log?(event: string, fields?: Record<string, number | string>): void;
}

export class ExternalDelegationTarget implements DelegationTarget {
  readonly kind = "external" as const;
  readonly #d: ExternalTargetDeps;
  constructor(deps: ExternalTargetDeps) { this.#d = deps; }

  accepts(agentId: string): boolean {
    return this.#d.engineOf(agentId)?.kind === "external";
  }

  async ack(input: AgentRunInput): Promise<HandoffAck> {
    const contract = input.handoff?.contract;
    return {
      schema: "plur1bus.ack/1",
      inReplyTo: contract?.id ?? "",
      objective: contract?.objective ?? input.question,
      status: "ok",
      blockingQuestions: [],
    };
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const scope = requireAgentScope();
    if (scope.agentId !== input.agentId) throw new CollabError("no-scope", "AgentScope agent does not match the target");
    const engine = this.#d.engineOf(input.agentId);
    if (!engine) throw new CollabError("invalid", "agent is not external", { reason: "engine" });
    if (engine.connector === null) throw new CollabError("invalid", "external connector is not usable", { reason: "connector-unavailable" });
    const worktree = this.#d.worktreeOf(input.agentId, scope.projectId);
    if (!worktree) throw new CollabError("conflict", "no provisioned worktree", { reason: "worktree" });
    let linked: ReturnType<typeof findHardlink>;
    try { linked = findHardlink(worktree); }
    catch (e) {
      if (e instanceof ContainmentError) throw new CollabError("conflict", e.message, { reason: e.reason });
      throw e;
    }
    if (linked) {
      this.#d.log?.("hardlink-in-worktree", { count: linked.count, path: linked.path });
      throw new CollabError("conflict", "hardlink-in-worktree", { reason: "hardlink-in-worktree" });
    }
    const store = this.#d.sessions();
    const person = personId(input.principal);
    const transcript = store.createSession({
      kind: "acp", agentId: input.agentId, owner: person ?? `external:${input.agentId}`, scope: scope.projectId, title: "ACP", origin: "acp-agent",
    });
    const started = store.beginTurn(transcript.id, input.question, Math.ceil(input.question.length / 4));
    const turnId = started.turn.id;
    let text = "";
    let stop: (() => void) | undefined;
    try {
      if (engine.maxTurns < 1) throw new CollabError("invalid", "turn budget exhausted", { reason: "turn-budget" });
      const link = this.#open(input, engine, worktree);
      stop = link.stop;
      const granted = { ok: false };
      const terminals = new Map<string, { abort: AbortController; done: ReturnType<typeof containedTerminal> }>();
      let termN = 0;
      const handlers: AcpClientHandlers = {
        readText: (path) => containedRead({ worktree, home: this.#d.home }, path),
        writeText: async (path, content) => {
          if (!granted.ok) throw new Error("not-approved");
          await containedWrite({ worktree, home: this.#d.home }, path, content);
        },
        permission: async (params) => {
          const answer = await this.#permission(input, person, transcript.id, turnId, worktree, params);
          granted.ok = answer.outcome === "selected";
          return answer;
        },
        terminal: async (method, params) => this.#terminal(method, params, worktree, granted, terminals, () => { termN += 1; return `t${termN}`; }),
        onUpdate: (params) => {
          const update = params.update;
          if (!update || typeof update !== "object") return;
          const chunk = textOf(update as Record<string, unknown>);
          if (chunk) {
            text += chunk;
            store.appendEvent(turnId, "delta", { text: chunk });
            input.onTranscript?.({ kind: "delta", data: { text: chunk } });
            input.onProgress?.({ text, inputTokens: 1, outputTokens: Math.ceil(text.length / 4), targetKind: "external" });
          } else if ((update as { sessionUpdate?: unknown }).sessionUpdate === "tool_call") {
            const call = update as { toolCallId?: unknown; title?: unknown };
            store.appendEvent(turnId, "tool.call", { id: String(call.toolCallId ?? ""), name: String(call.title ?? "") });
          }
        },
      };
      const client = new AcpClient({
        input: link.input, output: link.output, handlers,
        forbiddenPayload: this.#markers(),
        ...(this.#d.log ? { log: this.#d.log } : {}),
      });
      await client.initialize();
      const acpSession = await client.newSession(worktree, []);
      const result = await client.prompt(acpSession, `${input.question}\n\n${input.context}`.trim());
      store.completeTurn(turnId, { text: text || result.stopReason, tokens: Math.ceil((text || result.stopReason).length / 4) });
      return { text: text || result.stopReason, inputTokens: 1, outputTokens: Math.ceil((text || result.stopReason).length / 4), targetKind: "external" };
    } catch (e) {
      const reason = e instanceof AcpClientError ? e.reason : e instanceof ContainmentError ? e.reason : e instanceof CollabError ? (e.reason ?? e.message) : e instanceof Error ? e.message : "failed";
      try { store.failTurn(turnId, reason.slice(0, 200)); } catch { /* the turn may already be closed */ }
      if (e instanceof CollabError) throw e;
      throw new CollabError("invalid", reason, { reason: reason.slice(0, 80) });
    } finally { stop?.(); }
  }

  #markers(): string[] {
    const exposure = JSON.stringify(acpMemoryExposure());
    return ["memoryExposure", exposure, ...(this.#d.forbiddenPayload ?? [])];
  }

  #open(input: AgentRunInput, engine: ResolvedEngine, worktree: string): ExternalRunLink {
    if (this.#d.connect) return this.#d.connect({ agentId: input.agentId, cwd: worktree, signal: input.signal, timeoutMs: engine.timeoutMs });
    const argv = connectorArgv(engine.connector);
    if (!argv) throw new CollabError("invalid", "connector has no command yet", { reason: "connector-unavailable" });
    const handle: LaunchHandle = launchExternalAgent({ argv, cwd: worktree, timeoutMs: engine.timeoutMs, signal: input.signal });
    return { input: handle.stdout, output: handle.stdin, stop: handle.stop };
  }

  async #permission(
    input: AgentRunInput, person: string | null, sessionId: string, turnId: string, worktree: string, params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!person) return { outcome: "cancelled" };
    const service = await this.#d.approvals();
    if (!service) return { outcome: "cancelled" };
    const actionHash = createHash("sha256").update(JSON.stringify(params)).digest("hex");
    const ask = {
      request: {
        capability: "fs.write", tool: "session/request_permission", effect: "local-write" as const,
        flags: { outsideRoots: false, denyListHit: false }, risk: "medium" as const, reversible: true, actionHash,
        grantOptions: [{ scope: "once" as const, requiredSurface: 2 as const }], requiredSurface: 2 as const,
        tainted: false, taintSuspended: false, originSurface: 2 as const,
      },
      callId: randomUUID(), tool: "session/request_permission", args: params, agentId: input.agentId, principal: person,
      sessionId, park: false, signal: input.signal, subjectKind: "acp-agent" as const, turnId, targets: [worktree], access: "write" as const,
    };
    const answer = await service.request(ask);
    if (!answer.approved) return { outcome: "cancelled" };
    if (service.begin(answer, ask) === false) return { outcome: "cancelled" };
    return { outcome: "selected", optionId: "allow" };
  }

  async #terminal(
    method: string, params: Record<string, unknown>, worktree: string, granted: { ok: boolean },
    terminals: Map<string, { abort: AbortController; done: ReturnType<typeof containedTerminal> }>, idOf: () => string,
  ): Promise<Record<string, unknown>> {
    if (method === "terminal/create") {
      if (!granted.ok) throw new Error("not-approved");
      const argv = argvOf(params);
      if (!argv) throw new Error("argv");
      const abort = new AbortController();
      const id = idOf();
      const done = containedTerminal({ argv, worktree, home: this.#d.home, signal: abort.signal, ...(this.#d.log ? { log: this.#d.log } : {}) });
      terminals.set(id, { abort, done });
      return { terminalId: id };
    }
    const id = typeof params.terminalId === "string" ? params.terminalId : "";
    const rec = terminals.get(id);
    if (!rec) throw new Error("terminal");
    if (method === "terminal/kill") { rec.abort.abort(); return {}; }
    if (method === "terminal/release") { terminals.delete(id); return {}; }
    const result = await rec.done;
    if (!result.ok) throw new Error(result.reason);
    if (method === "terminal/output") return { output: result.stdout, exitCode: result.exitCode ?? -1 };
    if (method === "terminal/wait_for_exit") return { exitCode: result.exitCode ?? -1 };
    throw new Error("method");
  }
}

function personId(principal: Principal | undefined): string | null {
  return principal?.kind === "person" && principal.userId ? principal.userId : null;
}

function argvOf(params: Record<string, unknown>): string[] | null {
  if (Array.isArray(params.argv) && params.argv.every((a) => typeof a === "string")) return params.argv as string[];
  if (typeof params.command !== "string") return null;
  const args = Array.isArray(params.args) ? params.args : [];
  if (!args.every((a) => typeof a === "string")) return null;
  return [params.command, ...(args as string[])];
}

function textOf(update: Record<string, unknown>): string {
  if (update.sessionUpdate !== "agent_message_chunk") return "";
  const content = update.content;
  if (!content || typeof content !== "object") return "";
  const text = (content as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}
