/** D109 remains the decision maker: ACP translates offered choices and never creates or widens a grant itself. */
import type { ApprovalRecord, GrantOption, GrantScopeName } from "@plur1bus/rpc-schema";
import type { RpcCaller } from "./backend.ts";
import type { AcpPermissionAsk, AcpPermissionHandler } from "./permissions.ts";
import { acpText, type AcpLanguage } from "./text.ts";

const PAGE_SIZE = 100;
const MAX_APPROVALS_PER_TURN = 1024;
interface RelayOptions {
  client: RpcCaller;
  agentId: string;
  sessionId: string;
  turnId: string;
  requestPermission: AcpPermissionHandler;
  refused?: () => void;
  language?: AcpLanguage;
}
interface Active { abort: AbortController }

/** One turn's bounded UI relay. Core records, scopes and OS confirmation remain authoritative at every decision. */
export class AcpApprovalRelay {
  readonly #o: RelayOptions;
  readonly #seen = new Set<string>();
  readonly #cycle = new Set<string>();
  readonly #active = new Map<string, Active>();
  #cursor: string | undefined;
  #closed = false;
  constructor(options: RelayOptions) {
    this.#o = options;
  }

  /** One bounded page per event poll; completing a scan also withdraws editor choices already resolved elsewhere. */
  async poll(): Promise<void> {
    if (this.#closed) return;
    const page = await this.#o.client.call<{ approvals: ApprovalRecord[]; nextCursor?: string }>("approval.list", {
      status: "pending", agent: this.#o.agentId, limit: PAGE_SIZE, ...(this.#cursor ? { cursor: this.#cursor } : {}),
    });
    if (this.#closed) return;
    for (const record of page.approvals) {
      if (!this.#belongs(record) || record.status !== "pending") continue;
      this.#cycle.add(record.id);
      if (this.#seen.has(record.id)) continue;
      if (this.#seen.size >= MAX_APPROVALS_PER_TURN) throw new Error("ACP permission budget exceeded");
      this.#seen.add(record.id);
      const abort = new AbortController();
      this.#active.set(record.id, { abort });
      void this.#choose(record, abort.signal).catch(async () => {
        if (!this.#closed && !abort.signal.aborted) {
          await this.#cancel(record.id);
          this.#o.refused?.();
        }
      }).finally(() => this.#active.delete(record.id));
    }
    this.#cursor = page.nextCursor;
    if (!page.nextCursor) {
      for (const [id, active] of this.#active) {
        if (this.#cycle.has(id)) continue;
        // A changing paginated list is not proof of withdrawal. Check the individual record before clearing its UI.
        const current = await this.#o.client.call<ApprovalRecord>("approval.get", { id });
        if (current.status !== "pending" || !this.#belongs(current)) active.abort.abort();
      }
      this.#cycle.clear();
    }
  }

  /** Withdraw every outstanding editor choice; a late reply can no longer reach approval.decide. */
  close(): void {
    this.#closed = true;
    for (const active of this.#active.values()) active.abort.abort();
    this.#active.clear();
    this.#seen.clear();
    this.#cycle.clear();
    this.#cursor = undefined;
  }

  #belongs(record: ApprovalRecord): boolean {
    return record.sessionId === this.#o.sessionId && record.turnId === this.#o.turnId &&
      record.subject.kind === "agent" && record.subject.id === this.#o.agentId;
  }

  async #choose(record: ApprovalRecord, signal: AbortSignal): Promise<void> {
    const choices = offered(record);
    const outcome = await this.#o.requestPermission(question(record, choices, this.#o.language), signal);
    if (this.#closed || signal.aborted) return;
    if (outcome.outcome !== "selected") {
      await this.#cancel(record.id);
      return;
    }
    const fresh = await this.#o.client.call<ApprovalRecord>("approval.get", { id: record.id });
    if (this.#closed || signal.aborted || fresh.status !== "pending") return;
    if (!this.#belongs(fresh) || fresh.id !== record.id || fresh.actionHash !== record.actionHash ||
      fresh.capability !== record.capability) {
      await this.#cancel(record.id);
      return;
    }
    if (outcome.optionId === "deny") {
      await this.#o.client.call("approval.decide", { id: record.id, decision: "deny" });
      return;
    }
    const selected = choices.get(outcome.optionId);
    const current = offered(fresh).get(outcome.optionId);
    if (!selected || !current || current.scope !== selected.scope) {
      await this.#cancel(record.id);
      return;
    }
    try {
      await this.#o.client.call("approval.decide", { id: record.id, decision: "approve", scope: current.scope,
        ...(Math.max(fresh.requiredSurface ?? 0, current.requiredSurface) > 1 ? { attest: true } : {}) });
    } catch {
      // A missing helper, failed OS confirmation or a changed policy is a refusal; never fall back to grant.create.
      await this.#cancel(record.id);
      if (!this.#closed && !signal.aborted) this.#o.refused?.();
    }
  }

  async #cancel(id: string): Promise<void> {
    await this.#o.client.call("approval.cancel", { id }).catch(() => {});
  }
}

function offered(record: ApprovalRecord): Map<string, GrantOption> {
  const choices = new Map<string, GrantOption>();
  for (const option of record.grantOptions ?? []) {
    if (Math.max(record.requiredSurface ?? 0, option.requiredSurface) > 2 || option.scope === "always") continue;
    if (option.scope === "task" && !record.taskId) continue;
    if (option.scope === "session" && !record.sessionId) continue;
    choices.set(`allow-${option.scope}`, option);
  }
  return choices;
}
function question(
  record: ApprovalRecord,
  choices: Map<string, GrantOption>,
  language: AcpLanguage = "en",
): AcpPermissionAsk {
  const text = acpText(language);
  const scopeName: Record<GrantScopeName, string> = {
    once: text.allowOnce, task: text.allowTask, session: text.allowSession, always: text.always,
  };
  const details = [record.summary, ...(record.targets ?? []), ...(record.risk ? [`${text.risk}: ${record.risk}`] : []),
    ...(record.agentReason ? [`${text.agentReason}: ${record.agentReason}`] : []),
    ...(record.diff ? [`${text.patchPreview}:\n${record.diff}`] : [])].filter((s): s is string => !!s).join("\n");
  const kinds: Readonly<Record<string, string>> = { "fs.read": "read", "fs.write": "edit" };
  return {
    toolCall: { toolCallId: `approval:${record.id}`, title: record.tool ?? record.capability, status: "pending",
      kind: kinds[record.capability] ?? "other",
      ...(details ? { content: [{ type: "content", content: { type: "text", text: details } }] } : {}) },
    options: [...[...choices].map(([optionId, option]) => ({ optionId, name: scopeName[option.scope],
      kind: option.scope === "once" ? "allow_once" as const : "allow_always" as const })),
      { optionId: "deny", name: text.deny, kind: "reject_once" }],
  };
}
