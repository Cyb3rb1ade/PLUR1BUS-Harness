import type { BackfillState, BudgetCallback, MediaIndexPort, MediaIndexRequest, MediaIndexStatus, Scope } from "../../src/media-search/types.ts";
import type { CaptionInput, CaptionProvider } from "../../src/media-search/caption/types.ts";

export const scope: Scope = { agentId: "agent-a", workspace: "ws" } as unknown as Scope;

/** A MediaIndexPort fake: records calls; `indexImpl` lets a test throw or hang. */
export class FakePort implements MediaIndexPort {
  indexed: MediaIndexRequest[] = [];
  removed: string[] = [];
  starts: string[] = [];
  calls: string[] = [];
  fingerprint = "fp-1";
  bf: { state: BackfillState; done: number; total: number; pausedReason?: "budget" | "user" | "error" } = { state: "idle", done: 0, total: 0 };
  indexImpl: (req: MediaIndexRequest) => Promise<{ segments: number; state: "indexed" | "pending" | "unsupported-kind" | "failed" }> = async () => ({ segments: 1, state: "indexed" });
  budget: BudgetCallback | undefined;
  async index(req: MediaIndexRequest) { this.indexed.push(req); return this.indexImpl(req); }
  async search() { return []; }
  async remove(id: string) { this.removed.push(id); }
  async setCaption() {}
  async status(): Promise<MediaIndexStatus> {
    return { enabled: true, provider: "fake", model: "m", dim: 4, fingerprint: this.fingerprint, counts: { indexed: 0, pending: 0, failed: 0, unsupported: 0 }, backfill: { ...this.bf } };
  }
  backfill = {
    start: async (o: { reason: string }) => { this.calls.push("start"); this.starts.push(o.reason); this.bf = { state: "running", done: 0, total: 3 }; },
    pause: async () => { this.calls.push("pause"); this.bf = { ...this.bf, state: "paused", pausedReason: "user" }; },
    resume: async () => { this.calls.push("resume"); const { pausedReason: _p, ...rest } = this.bf; this.bf = { ...rest, state: "running" }; },
    cancel: async () => { this.calls.push("cancel"); this.bf = { state: "cancelled", done: 0, total: 0 }; },
  };
  /** One backfill step as an engine would do it: asks the budget first. */
  async step() {
    if (this.budget && !(await this.budget.canContinue())) { this.bf = { ...this.bf, state: "paused", pausedReason: "budget" }; return; }
    this.bf = { ...this.bf, done: this.bf.done + 1 };
  }
}

export class FakeCaptionProvider implements CaptionProvider {
  calls: CaptionInput[] = [];
  readonly id: string; readonly local: boolean; private text: string;
  constructor(id = "fake", local = true, text = "auto caption") { this.id = id; this.local = local; this.text = text; }
  async caption(input: CaptionInput) { this.calls.push(input); return this.text; }
}

export const recorder = () => {
  const events: { name: string; payload: Record<string, unknown> }[] = [];
  return { events, emit: (name: string, payload: Record<string, unknown>) => { events.push({ name, payload }); } };
};
export const silentLogger = { warn() {}, info() {}, error() {} };
