/** D120 H4: audited conversation rewind, bounded summarize-role lessons and transcript-command parsing. */
import type { CallerIdentity } from "@plur1bus/rpc-schema";
import type { AuditSink } from "../rbac/audit.ts";
import type { TurnApprover } from "./provider.ts";
import type { SessionStore, RewindAudit } from "./store.ts";
import type { Summarizer, SummaryMessage } from "./summarizer.ts";
import { SessionError, type EventRecord, type MessageRecord, type RewindRecord } from "./types.ts";
import { failedEditCycles, rewindResult } from "./rewind-cycles.ts";

const MAX_LESSON_TOKENS = 400;
const LESSON_PREFIX = "Lesson from a discarded attempt: ";
const BODY_CHARS = MAX_LESSON_TOKENS * 4 - LESSON_PREFIX.length;
const line = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 256);
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** File restore is available only through the trusted D115 checkpoint and approval integration. */
export interface RewindFilesPort {
  capture?(input: { sessionId: string; turnId: string; personId: string; signal: AbortSignal }): Promise<void>;
  restore(input: { sessionId: string; parentSeq: number; hiddenFromSeq: number; hiddenToSeq: number;
    checkpointTurnId: string; approver: TurnApprover; signal: AbortSignal; validate(): void }): Promise<void>;
}

/** All model work uses the existing summarize router/budget. The audit sink must be available before a write. */
export interface RewindServiceDeps {
  store: SessionStore;
  audit: AuditSink;
  now: () => number;
  summarize?: Summarizer;
  files?: RewindFilesPort;
  signal?: AbortSignal;
  notify?: (event: EventRecord) => void;
  onError?: (error: unknown) => void;
  /** Trusted D115 card link and canonical bound worktree; agents cannot supply these through rewind params. */
  project?: (sessionId: string, personId: string) => { projectId: string; cardId: string; root: string } | null;
  /** Live per-project opt-in. Empty/absent is automatic rewind off. */
  autoProjects?: () => readonly string[];
}

/** Trusted caller metadata is supplied by the human RPC or turn boundary, never copied from an agent tool argument. */
export interface RewindRequest {
  sessionId: string;
  toSeq: number | "last";
  actor: string;
  lesson?: string;
  trigger?: "user" | "agent";
  caller?: CallerIdentity;
  commandTurnId?: string;
  files?: boolean;
  approver?: TurnApprover;
  signal?: AbortSignal;
  /** Internal revalidation after summary/approval waits; never accepted from a transport. */
  validate?: () => void;
}

function failingLine(value: Record<string, unknown>): string {
  if (typeof value.essence === "string") return line(value.essence);
  if (typeof value.summary === "string") return line(value.summary);
  const output = [value.stderr, value.stdout].filter(v => typeof v === "string").join("\n");
  return line(output.split("\n").find(text => /\bFAIL\b|^not ok\b|\berror\b|AssertionError/i.test(text)) ?? "Check failed.");
}

function lessonFacts(messages: readonly MessageRecord[], events: readonly EventRecord[]): {
  files: string[]; failure: string; envelopes: SummaryMessage[];
} {
  const turns = new Set(messages.flatMap(message => message.turnId ? [message.turnId] : []));
  const calls = new Map<string, EventRecord>();
  const files = new Set<string>();
  const envelopes: SummaryMessage[] = [];
  let failure = "No failing check recorded.";
  for (const event of events) {
    if (!event.turnId || !turns.has(event.turnId)) continue;
    const key = `${event.turnId}:${String(event.data.id)}`;
    if (event.type === "tool.call") {
      calls.set(key, event);
      continue;
    }
    const call = calls.get(key);
    if (!call) continue;
    const name = String(call.data.name), args = object(call.data.args), value = rewindResult(event);
    if (["file.edit", "file.write"].includes(name) && value.isError !== true && event.data.isError !== true
      && typeof args.path === "string" && files.size < 64) files.add(line(args.path));
    const failed = event.data.isError === true || value.isError === true || value.ok === false
      || (typeof value.exitCode === "number" && value.exitCode !== 0);
    if (["code.check", "exec.run", "coding_complete"].includes(name) && failed) failure = failingLine(value);
    // Whitelist the H1 envelope fields. Artifact bodies and complete stdout/stderr are never summary input.
    const artifactId = object(value.artifact).id;
    envelopes.push({ role: "tool", seq: event.seq, text: JSON.stringify({ tool: name,
      ...(typeof args.path === "string" ? { path: line(args.path) } : {}), failed,
      ...(typeof artifactId === "string" && artifactId.length > 0 && artifactId.length <= 256
        ? { artifact: { id: artifactId } } : {}),
      ...(failed ? { essence: failingLine(value) } : {}) }) });
  }
  return { files: [...files], failure, envelopes };
}

/** One shared service for chat.rewind, session.rewind and /rewind; it never performs memory correction or capture. */
export class RewindService {
  readonly #d: RewindServiceDeps;
  constructor(deps: RewindServiceDeps) { this.#d = deps; }

  #audit(actor: string): RewindAudit {
    return event => this.#d.audit.append({ at: this.#d.now(), actor: { user: actor, host: "core" },
      action: event.action, target: String(event.detail.sessionId), detail: event.detail });
  }

  async #lesson(input: RewindRequest, plan: ReturnType<SessionStore["planRewind"]>): Promise<string> {
    // The raw plan is the immutable audit range. Summary input also excludes failed/recovered harness commands.
    const messages = this.#d.store.contextMessages(input.sessionId)
      .filter(message => message.seq >= plan.hiddenFromSeq && message.seq <= plan.hiddenToSeq);
    const facts = lessonFacts(messages, this.#d.store.contextToolEvents(input.sessionId));
    const fileNote = facts.files.length ? `Files changed: ${facts.files.join(", ")}.` : "Files changed: none recorded.";
    let body = input.lesson?.trim() ?? `${fileNote} ${facts.failure}`;
    if (input.lesson === undefined && this.#d.summarize) {
      try {
        const distilled = await this.#d.summarize([
          ...messages.map(({ role, text, seq }) => ({ role, text, seq })),
          ...facts.envelopes,
          { role: "system", seq: plan.hiddenToSeq, text: `Rewind facts: ${fileNote} ${facts.failure}` },
        ], Math.floor(BODY_CHARS / 4), input.sessionId, input.caller);
        if (distilled.trim()) body = distilled.trim();
      } catch (error) { this.#d.onError?.(error); }
    }
    // The note names changed files because conversation rewind deliberately leaves them changed (Q14).
    if (facts.files.length && !facts.files.every(path => body.includes(path))) body = `${fileNote} ${body}`;
    return LESSON_PREFIX + body.slice(0, BODY_CHARS);
  }

  #notify(event: EventRecord): void {
    try { this.#d.notify?.(event); }
    catch (error) { this.#d.onError?.(error); } // Delivery cannot roll back a committed operation; session.events replays it.
  }

  /** Distill, revalidate, then atomically append the overlay and lesson. Concurrent changes refuse the stale plan. */
  async rewind(input: RewindRequest): Promise<RewindRecord> {
    const { store } = this.#d;
    const plan = store.planRewind(input.sessionId, input.toSeq, input.commandTurnId);
    const lesson = await this.#lesson(input, plan);
    const signal = input.signal && this.#d.signal ? AbortSignal.any([input.signal, this.#d.signal])
      : input.signal ?? this.#d.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    input.validate?.();
    let reservation: ReturnType<SessionStore["reserveRewind"]> | undefined;
    try {
      if (input.files) {
        if (!this.#d.files || !input.approver?.person) {
          throw new SessionError("conflict", "approved D115 file checkpoint restore is unavailable", "rewind-checkpoint-unavailable");
        }
        const checkpointTurnId = plan.messages.find(message => message.turnId !== null)?.turnId;
        if (!checkpointTurnId) throw new SessionError("conflict", "rewind checkpoint is unavailable", "rewind-checkpoint-unavailable");
        reservation = store.reserveRewind(input.sessionId, input.commandTurnId);
        await this.#d.files.restore({ sessionId: input.sessionId, parentSeq: plan.parentSeq,
          hiddenFromSeq: plan.hiddenFromSeq, hiddenToSeq: plan.hiddenToSeq, checkpointTurnId, approver: input.approver, signal,
          validate: () => {
            input.validate?.();
            signal.throwIfAborted();
            const current = store.planRewind(input.sessionId, plan.parentSeq, input.commandTurnId, reservation?.token);
            if (current.eventSeq !== plan.eventSeq) {
              throw new SessionError("conflict", "session changed before approved file restore", "rewind-stale");
            }
          } });
      }
      const rewind = store.rewindPath(input.sessionId, { toSeq: plan.parentSeq, lesson,
        actor: input.actor, trigger: input.trigger ?? "user", expectedEventSeq: plan.eventSeq, audit: this.#audit(input.actor),
        ...(input.commandTurnId ? { commandTurnId: input.commandTurnId } : {}),
        ...(reservation ? { reservation: reservation.token } : {}) });
      this.#notify(store.listEvents(input.sessionId, plan.eventSeq, 1)[0]!);
      return rewind;
    } finally { reservation?.release(); }
  }

  /** Turn-boundary sensor: interactive/direct sessions only propose; automatic application needs every Q13 gate. */
  async afterTurn(input: { sessionId: string; personId: string; unattended: boolean }): Promise<void> {
    const session = this.#d.store.getSession(input.sessionId);
    if (!session || session.archivedAt !== null || this.#d.store.runningTurn(session.id) || this.#d.store.rewindReserved(session.id)) return;
    const cycles = failedEditCycles(this.#d.store.contextToolEvents(session.id));
    if (cycles.failedCycles < 3 || !cycles.fromTurnId || cycles.pendingEdit) return;
    const messages = this.#d.store.contextMessages(session.id);
    const first = messages.find(message => message.turnId === cycles.fromTurnId);
    if (!first) return;
    const parentSeq = messages.findLast(message => message.seq < first.seq)?.seq ?? 0;
    const project = session.kind === "card" ? this.#d.project?.(session.id, input.personId) : null;
    if (project && input.unattended && this.#d.autoProjects?.().includes(project.projectId)) {
      await this.rewind({ sessionId: session.id, toSeq: parentSeq, actor: `agent:${session.agentId}`, trigger: "agent",
        validate: () => {
          const current = this.#d.project?.(session.id, input.personId);
          if (!this.#d.autoProjects?.().includes(project.projectId) || current?.root !== project.root
            || current.cardId !== project.cardId || current.projectId !== project.projectId) {
            throw new SessionError("conflict", "automatic rewind project binding changed", "rewind-project-changed");
          }
        } });
    } else {
      const event = this.#d.store.proposeRewind(session.id, { parentSeq, failedCycles: cycles.failedCycles,
        lastCheckSeq: cycles.lastCheckSeq, agentId: session.agentId });
      if (event) this.#notify(event);
    }
  }

  /** Idempotent undo lifts the overlay; the obsolete lesson remains stored but leaves the context view. */
  undo(sessionId: string, rewindId: string, actor: string, commandTurnId?: string): RewindRecord {
    const before = this.#d.store.lastEventSeq(sessionId) ?? 0;
    const rewind = this.#d.store.undoRewind(sessionId, rewindId, actor, this.#audit(actor), commandTurnId);
    const event = this.#d.store.listEvents(sessionId, before, 1)[0];
    if (event) this.#notify(event);
    return rewind;
  }
}

/** A transcript command contains data only. It is never interpreted as a shell command or model instruction. */
export type RewindCommand = { toSeq: number | "last"; lesson?: string; files?: true } | { undo: string };

function words(text: string): string[] {
  const result: string[] = [];
  let token = "", quote = "", started = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === "\\" && quote !== "'") {
      if (++index === text.length) throw new SessionError("invalid", "incomplete rewind escape", "rewind-command");
      token += text[index];
      started = true;
    } else if (quote) {
      if (char === quote) quote = "";
      else token += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) result.push(token);
      token = "";
      started = false;
    } else {
      token += char;
      started = true;
    }
  }
  if (quote) throw new SessionError("invalid", "unclosed rewind quote", "rewind-command");
  if (started) result.push(token);
  return result;
}

/** Return null for ordinary text; malformed /rewind commands are refused before a turn starts. */
export function isRewindCommand(text: string): boolean { return /^\/rewind(?:\s|$)/.test(text.trim()); }

export function parseRewindCommand(text: string): RewindCommand | null {
  if (!isRewindCommand(text)) return null;
  const args = words(text.trim()).slice(1);
  const bad = (): never => { throw new SessionError("invalid", "invalid rewind command", "rewind-command"); };
  if (args[0] === "--undo") {
    if (args.length !== 2 || !/^[A-Za-z0-9_-]{1,128}$/.test(args[1]!)) return bad();
    return { undo: args[1]! };
  }
  const command: Exclude<RewindCommand, { undo: string }> = { toSeq: "last" };
  if (args[0] === "last" || /^\d+$/.test(args[0] ?? "")) {
    const target = args.shift()!;
    command.toSeq = target === "last" ? "last" : Number(target);
    if (typeof command.toSeq === "number" && !Number.isSafeInteger(command.toSeq)) return bad();
  }
  while (args.length) {
    const flag = args.shift();
    if (flag === "--files" && command.files === undefined) command.files = true;
    else if (flag === "--lesson" && command.lesson === undefined && args[0] !== undefined) {
      command.lesson = args.shift()!;
      if (!command.lesson.trim() || command.lesson.length > BODY_CHARS) return bad();
    } else return bad();
  }
  return command;
}
