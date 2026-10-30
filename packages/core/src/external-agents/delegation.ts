// External DelegationTarget. One ACP run is stateless (ADR-003 Q4): session/new every time, no stored ACP session.
// A side effect runs only after a D109 approval for subject acp-agent and only through B3 containment.
import { WatchdogFailure } from "./watchdog-detail.ts";
import { lstat } from "node:fs/promises";
import type { Identity } from "../policy/paths.ts";
import { AcpActions, type AcpAction } from "./actions.ts";
import type { AcpWorktreeMount } from "../tools/sandbox/acp-worktree.ts";
import type { Context } from "../policy/decide.ts";
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
import { containedRead, containedTerminal, containedWrite, containedPath, ContainmentError, findHardlink } from "./containment.ts";
import { connectorArgv, type ResolvedEngine } from "./engine.ts";
import { launchExternalAgent, resolveCommand, type LaunchHandle } from "./launcher.ts";

export interface ExternalRunLink {
  input: Readable;
  output: Writable;
  stop: () => void;
  /** Trusted launcher metadata; transport stderr and arbitrary errors are never a diagnostic source. */
  exited?: LaunchHandle["exited"];
  exitStatus?: LaunchHandle["exitStatus"];
}

/** Preserve native supervision metadata across the production connector transport boundary. */
export function externalRunLink(handle: LaunchHandle): ExternalRunLink {
  handle.stderr.resume();
  return { input: handle.stdout, output: handle.stdin, stop: handle.stop, exited: handle.exited, exitStatus: handle.exitStatus };
}

export interface ExternalTargetDeps {
  engineOf(agentId: string): ResolvedEngine | { kind: "external"; connector: null } | null;
  /** Provisioned project worktree, or null when the project is bound and nothing is forked. */
  worktreeOf(agentId: string, projectId: string, cardId?: string): string | null;
  home: string;
  mountOf?(projectId: string, cardId?: string): AcpWorktreeMount;
  limitsHelper?: string;
  maxTasks?: number | (() => number);
  policyContext?(agentId: string): Partial<Context>;
  sessions(): SessionStore;
  approvals(): Promise<ApprovalService | null>;
  /** Test seam. Production launches the connector command. */
  connect?(o: { agentId: string; cwd: string; signal: AbortSignal; timeoutMs: number }): ExternalRunLink | Promise<ExternalRunLink>;
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
    input.signal.throwIfAborted();
    if (input.handoff?.context.readOnlyWorktree)
      throw new CollabError("invalid", "external read-only review is unavailable", { reason: "read-only-external-unavailable" });
    const scope = requireAgentScope();
    if (scope.agentId !== input.agentId) throw new CollabError("no-scope", "AgentScope agent does not match the target");
    const engine = this.#d.engineOf(input.agentId);
    if (!engine) throw new CollabError("invalid", "agent is not external", { reason: "engine" });
    if (engine.connector === null) throw new CollabError("invalid", "external connector is not usable", { reason: "connector-unavailable" });
    const worktree = this.#d.worktreeOf(input.agentId, scope.projectId, input.handoff?.contract.task.card);
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
    let client: AcpClient | undefined;
    const runAbort = new AbortController();
    const signal = AbortSignal.any([input.signal, runAbort.signal, AbortSignal.timeout(engine.timeoutMs)]);
    const terminals = new Map<string, { abort: AbortController; done: ReturnType<typeof containedTerminal>;
      output: string; truncated: boolean; result?: Awaited<ReturnType<typeof containedTerminal>> }>();
    const actions = new AcpActions({ signal, agentId: input.agentId, person, sessionId: transcript.id, turnId,
      approvals: this.#d.approvals, ...(this.#d.policyContext ? { context: () => this.#d.policyContext!(input.agentId) } : {}) });
    const approvedFiles = new WeakMap<AcpAction, Awaited<ReturnType<typeof containedPath>>>();
    const approvedProcesses = new WeakMap<AcpAction, { command: Identity; cwd: Identity }>();
    const actionOf = async (params: Record<string, unknown>, tool: string): Promise<AcpAction> => {
      signal.throwIfAborted();
      const callId = typeof params.toolCallId === "string" ? params.toolCallId : String(params._requestId ?? "");
      if (!callId) throw new Error("tool-call-id");
      if (tool === "fs/write_text_file") {
        if (typeof params.path !== "string" || typeof params.content !== "string") throw new Error("path");
        const path = await containedPath({ worktree, home: this.#d.home, signal }, params.path, "write");
        signal.throwIfAborted();
        const action: AcpAction = { callId, capability: "fs.write", tool, args: { path: path.canonical, content: params.content }, targets: [path.canonical] };
        approvedFiles.set(action, path);
        return action;
      }
      const argv = argvOf(params);
      if (!argv) throw new Error("argv");
      const command = await resolveCommand(argv[0]!, { worktree });
      signal.throwIfAborted();
      const stat = await lstat(command, { bigint: true });
      signal.throwIfAborted();
      const cwd = await containedPath({ worktree, home: this.#d.home, signal }, typeof params.cwd === "string" ? params.cwd : worktree, "read");
      signal.throwIfAborted();
      const action: AcpAction = { callId, capability: "shell.exec", tool: "terminal/create", args: { command, args: argv.slice(1), cwd: cwd.canonical }, targets: [cwd.canonical] };
      approvedProcesses.set(action, { command: { dev: String(stat.dev), ino: String(stat.ino), ...(stat.birthtimeNs > 0n ? { birth: String(stat.birthtimeNs) } : {}) }, cwd: cwd.identity });
      return action;
    };
    try {
      if (engine.maxTurns < 1) throw new CollabError("invalid", "turn budget exhausted", { reason: "turn-budget" });
      const link = await this.#open({ ...input, signal }, engine, worktree);
      stop = link.stop;
      // stdout can close before the helper's dedicated diagnostic pipe. Observe its final trusted status
      // independently, preserving the existing transport/timeout result while retaining the actual cause.
      void link.exited?.then(code => {
        const detail = link.exitStatus?.detail;
        if (code === 125 && detail) this.#d.log?.("sandbox.watchdog.failure", { process: "connector", ...detail });
      }).catch(() => { /* Diagnostic observation must not change process/transport failure handling. */ });
      signal.throwIfAborted();
      let termN = 0;
      const handlers: AcpClientHandlers = {
        readText: path => containedRead({ worktree, home: this.#d.home, signal }, path),
        writeText: async (path, content, params) => {
          const action = await actionOf({ ...params, path, content }, "fs/write_text_file");
          await actions.authorize(action);
          signal.throwIfAborted();
          await containedWrite({ worktree, home: this.#d.home, signal }, String(action.args.path), content, approvedFiles.get(action));
        },
        permission: async params => {
          const toolCall = params.toolCall as Record<string, unknown> | undefined;
          if (!toolCall || typeof toolCall.toolCallId !== "string" || !toolCall.rawInput || typeof toolCall.rawInput !== "object")
            return { outcome: { outcome: "cancelled" } };
          const raw = toolCall.rawInput as Record<string, unknown>;
          const action = await actionOf({ ...raw, toolCallId: toolCall.toolCallId }, typeof raw.path === "string" ? "fs/write_text_file" : "terminal/create");
          signal.throwIfAborted();
          return actions.permission(action, Array.isArray(params.options) ? params.options : []);
        },
        terminal: async (method, params) => {
          signal.throwIfAborted();
          if (method === "terminal/create") {
            if (terminals.size >= 4) throw new Error("terminal-limit");
            const action = await actionOf(params, method);
            await actions.authorize(action);
            signal.throwIfAborted();
            if (terminals.size >= 4) throw new Error("terminal-limit");
            const abort = new AbortController();
            const id = `t${++termN}`;
            const rec: { abort: AbortController; done: ReturnType<typeof containedTerminal>; output: string;
              truncated: boolean; result?: Awaited<ReturnType<typeof containedTerminal>> } = {
              abort, output: "", truncated: false, done: Promise.resolve({ ok: false, reason: "starting" }),
            };
            terminals.set(id, rec);
            rec.done = containedTerminal({ argv: [String(action.args.command), ...(action.args.args as string[])],
              cwd: String(action.args.cwd), approvedCwd: String(action.args.cwd), approvedCommand: String(action.args.command),
              approvedCommandIdentity: approvedProcesses.get(action)!.command, approvedCwdIdentity: approvedProcesses.get(action)!.cwd,
              worktree, home: this.#d.home, signal, killSignal: abort.signal,
              ...(this.#d.mountOf ? { mount: this.#d.mountOf(scope.projectId, input.handoff?.contract.task.card) } : {}),
              ...(this.#d.limitsHelper ? { limitsHelper: this.#d.limitsHelper } : {}),
              ...(this.#d.maxTasks !== undefined ? { maxTasks: typeof this.#d.maxTasks === "function" ? this.#d.maxTasks() : this.#d.maxTasks } : {}),
              ...(typeof params.outputByteLimit === "number" ? { outputByteLimit: params.outputByteLimit } : {}),
              onOutput: (output, truncated) => { rec.output = output; rec.truncated = truncated; },
            }).then(result => { rec.result = result; return result; });
            return { terminalId: id };
          }
          const id = typeof params.terminalId === "string" ? params.terminalId : "";
          const rec = terminals.get(id);
          if (!rec) throw new Error("terminal");
          if (method === "terminal/kill" || method === "terminal/release") {
            rec.abort.abort();
            await rec.done;
            if (method === "terminal/release") terminals.delete(id);
            return {};
          }
          if (method === "terminal/output") return { output: rec.output, truncated: rec.truncated,
            ...(rec.result?.ok ? { exitStatus: { ...(rec.result.exitCode !== null ? { exitCode: rec.result.exitCode } : {}), ...(rec.result.signal ? { signal: rec.result.signal } : {}) } } : {}) };
          const result = await rec.done;
          if (!result.ok) throw result.detail ? new WatchdogFailure(result.detail) : new Error(result.reason);
          return { ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}), ...(result.signal ? { signal: result.signal } : {}) };
        },
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
      client = new AcpClient({
        input: link.input, output: link.output, handlers,
        signal, runTimeoutMs: engine.timeoutMs,
        ...(this.#d.log ? { log: this.#d.log } : {}),
      });
      await client.initialize();
      const acpSession = await client.newSession(worktree, []);
      const result = await client.prompt(acpSession, input.question);
      store.completeTurn(turnId, { text: text || result.stopReason, tokens: Math.ceil((text || result.stopReason).length / 4) });
      return { text: text || result.stopReason, inputTokens: 1, outputTokens: Math.ceil((text || result.stopReason).length / 4), targetKind: "external" };
    } catch (e) {
      const reason = e instanceof AcpClientError ? e.reason : e instanceof ContainmentError ? e.reason : e instanceof CollabError ? (e.reason ?? e.message) : e instanceof Error ? e.message : "failed";
      try { store.failTurn(turnId, reason.slice(0, 200)); } catch { /* the turn may already be closed */ }
      if (e instanceof CollabError) throw e;
      throw new CollabError("invalid", reason, { reason: reason.slice(0, 80) });
    } finally {
      runAbort.abort();
      client?.close();
      for (const terminal of terminals.values()) terminal.abort.abort();
      await Promise.allSettled([...terminals.values()].map(t => t.done));
      stop?.();
    }
  }

  async #open(input: AgentRunInput, engine: ResolvedEngine, worktree: string): Promise<ExternalRunLink> {
    if (this.#d.connect) return this.#d.connect({ agentId: input.agentId, cwd: worktree, signal: input.signal, timeoutMs: engine.timeoutMs });
    const argv = connectorArgv(engine.connector);
    if (!argv) throw new CollabError("invalid", "connector has no command yet", { reason: "connector-unavailable" });
    const handle: LaunchHandle = await launchExternalAgent({ argv, cwd: worktree, worktree, home: this.#d.home,
      timeoutMs: engine.timeoutMs, signal: input.signal, ...(this.#d.maxTasks !== undefined ? { maxTasks: typeof this.#d.maxTasks === "function" ? this.#d.maxTasks() : this.#d.maxTasks } : {}),
      ...(this.#d.mountOf ? { mount: this.#d.mountOf(requireAgentScope().projectId, input.handoff?.contract.task.card) } : {}),
      ...(this.#d.limitsHelper ? { limitsHelper: this.#d.limitsHelper } : {}) });
    return externalRunLink(handle);
  }

}

function personId(principal: Principal | undefined): string | null {
  return principal?.kind === "person" && principal.userId ? principal.userId : null;
}

function argvOf(params: Record<string, unknown>): string[] | null {
  if ("argv" in params) return null;
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
