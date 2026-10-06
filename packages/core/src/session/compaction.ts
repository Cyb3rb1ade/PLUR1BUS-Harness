// Compaction scaffolding (D23, ADR-010 L1/L2/L14, ADR-003 "hide, don't delete"). Deterministic and synchronous apart
// from the pre-swap hook; the LLM summariser (`summarize` role, M2) replaces `digest` later.
// TODO(M2): LLM summarisation behind the same `Summarizer` shape; thresholds from measured provider token counts (L14).
import type { SessionStore } from "./store.ts";
import type { MessageRecord, SummaryRecord } from "./types.ts";

export interface CompactionConfig {
  /** The model's context window in tokens (default 8192 until M2's model catalog supplies it per model). */
  windowTokens: number;
  /** D23: prepare a summary above this share of the window (default 0.65). */
  softRatio: number;
  /** D23: swap it in (and never assemble more) above this share (default 0.88). The L14 bound is `hardRatio * window`. */
  hardRatio: number;
  /** The bound on the summary a session carries (default 15 % of the window), tiered merges included. */
  summaryMaxTokens: number;
  /** L1/L2: one message (a tool result above all) is cut to this size in the context view, with a pointer (default 10 %). */
  maxMessageTokens: number;
}

export function defaultCompaction(windowTokens = 8192): CompactionConfig {
  return { windowTokens, softRatio: 0.65, hardRatio: 0.88, summaryMaxTokens: Math.floor(windowTokens * 0.15), maxMessageTokens: Math.floor(windowTokens * 0.1) };
}

/** A crude, monotonic, deterministic estimate (4 chars per token, rounded up). Measured counts replace it (L14, TODO). */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export function truncateWithPointer(text: string, maxTokens: number, pointer: string): { text: string; truncated: boolean } {
  if (estimateTokens(text) <= maxTokens) return { text, truncated: false };
  const note = `\n[truncated ${text.length} chars; ${pointer}]`;
  const room = Math.max(0, maxTokens * 4 - note.length);
  const out = (text.slice(0, room) + note).slice(0, Math.max(maxTokens * 4, 0));
  return { text: out, truncated: true };
}

export interface CompactionHooks {
  /** D23: every swap is preceded by an engine checkpoint `compaction` so the dropped segment's facts reach long-term memory.
   *  The turn loop wires it to the engine and leaves it out for an incognito session (D92 §3.3). */
  beforeSwap?: (info: { sessionId: string; fromSeq: number; toSeq: number }) => Promise<void>;
  onError?: (what: string, err: unknown) => void;
}

export interface ContextView {
  summaries: SummaryRecord[];
  messages: { id: string; role: MessageRecord["role"]; text: string; seq: number; turnId: string | null }[];
  tokens: number;
  /** Messages cut with a pointer, or dropped from the view, to keep the bound. */
  clipped: number;
  compaction: { swapped: boolean; fromSeq?: number; toSeq?: number; tokensBefore?: number; tokensAfter?: number; checkpoint?: "done" | "failed" | "skipped" };
}

const LINE_CHARS = 160;
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** The deterministic summariser: one capped line per message. */
export function digest(messages: Pick<MessageRecord, "role" | "text" | "seq">[]): string {
  return messages.map((m) => `${m.role}#${m.seq}: ${oneLine(m.text).slice(0, LINE_CHARS)}`).join("\n");
}

/** Keeps the newest lines of `text` within `maxTokens`; the elided older ones leave one marker line ("hide, don't delete":
 *  the transcript still has them). Total function: always within the bound. */
export function fitTail(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  const lines = text.split("\n"); let dropped = 0;
  const marker = () => `[… ${dropped} earlier lines elided]`;
  while (lines.length > 0 && estimateTokens([marker(), ...lines].join("\n")) > maxTokens) { lines.shift(); dropped++; }
  const out = [marker(), ...lines].join("\n");
  return estimateTokens(out) <= maxTokens ? out : out.slice(0, Math.max(maxTokens * 4, 0));
}

export class Compactor {
  readonly #store: SessionStore;
  readonly cfg: CompactionConfig;
  readonly #hooks: CompactionHooks;

  constructor(store: SessionStore, cfg: CompactionConfig = defaultCompaction(), hooks: CompactionHooks = {}) {
    if (!(cfg.windowTokens > 0) || !(cfg.softRatio > 0 && cfg.softRatio < cfg.hardRatio && cfg.hardRatio < 1)) throw new Error("invalid compaction config");
    this.#store = store; this.cfg = cfg; this.#hooks = hooks;
  }

  get hardLimit(): number { return Math.floor(this.cfg.windowTokens * this.cfg.hardRatio); }
  get softLimit(): number { return Math.floor(this.cfg.windowTokens * this.cfg.softRatio); }

  #applied(sessionId: string): SummaryRecord[] { return this.#store.listSummaries(sessionId, "applied"); }
  #coveredTo(applied: SummaryRecord[]): number { return applied.reduce((m, s) => Math.max(m, s.toSeq), 0); }

  /** What the next model call sees of the history: applied summaries plus the uncovered messages, each message capped. */
  view(sessionId: string): ContextView {
    const summaries = this.#applied(sessionId);
    const covered = this.#coveredTo(summaries);
    let clipped = 0;
    const messages = this.#store.listMessages(sessionId, { afterSeq: covered }).map((m) => {
      const t = truncateWithPointer(m.text, this.cfg.maxMessageTokens, `full text is message ${m.id} in the session transcript`);
      if (t.truncated) clipped++;
      return { id: m.id, role: m.role, text: t.text, seq: m.seq, turnId: m.turnId };
    });
    const tokens = summaries.reduce((n, s) => n + s.tokens, 0) + messages.reduce((n, m) => n + estimateTokens(m.text), 0);
    return { summaries, messages, tokens, clipped, compaction: { swapped: false } };
  }

  /** Called with the new user message already stored: guarantees the returned view is within the hard limit (L14),
   *  swapping a summary in when it is not. Never cuts inside a turn and never cuts the newest turn. */
  async prepare(sessionId: string): Promise<ContextView> {
    let v = this.view(sessionId);
    if (v.tokens <= this.hardLimit) return v;
    const before = v.tokens;
    const res = await this.#swap(sessionId, v);
    v = this.view(sessionId);
    // The bound is unconditional (L14): if even the newest turn does not fit, its oldest messages leave the *view*
    // (the store keeps them) until it does.
    while (v.tokens > this.hardLimit && v.messages.length > 1) {
      const dropped = v.messages.shift()!; v.tokens -= estimateTokens(dropped.text); v.clipped++;
    }
    v.compaction = { swapped: res.swapped, ...(res.swapped ? { fromSeq: res.fromSeq!, toSeq: res.toSeq! } : {}), tokensBefore: before, tokensAfter: v.tokens, ...(res.checkpoint ? { checkpoint: res.checkpoint } : {}) };
    return v;
  }

  /** After a turn: above the soft threshold, build (but do not swap in) the summary of the oldest segment (D23). */
  async afterTurn(sessionId: string): Promise<{ prepared: boolean }> {
    const v = this.view(sessionId);
    if (v.tokens <= this.softLimit) return { prepared: false };
    if (this.#store.listSummaries(sessionId, "prepared").length > 0) return { prepared: false };
    const seg = this.#segment(v);
    if (!seg) return { prepared: false };
    const text = fitTail(digest(seg.messages), this.cfg.summaryMaxTokens);
    this.#store.addSummary({ sessionId, fromSeq: seg.fromSeq, toSeq: seg.toSeq, text, tokens: estimateTokens(text), tier: 1, state: "prepared" });
    return { prepared: true };
  }

  /** The oldest whole turns of the uncovered tail whose removal brings the view down to the soft threshold; the newest turn stays. */
  #segment(v: ContextView): { messages: ContextView["messages"]; fromSeq: number; toSeq: number } | null {
    const groups: ContextView["messages"][] = [];
    for (const m of v.messages) {
      const last = groups[groups.length - 1];
      if (last && last[0]!.turnId === m.turnId && m.turnId !== null) last.push(m); else groups.push([m]);
    }
    if (groups.length < 2) return null; // only the newest turn is left: nothing may be cut
    const target = Math.floor(this.cfg.windowTokens * this.cfg.softRatio * 0.5);
    let tokens = v.tokens; const cut: ContextView["messages"] = [];
    for (let i = 0; i < groups.length - 1 && tokens > target; i++) {
      for (const m of groups[i]!) { cut.push(m); tokens -= estimateTokens(m.text); }
    }
    if (cut.length === 0) return null;
    return { messages: cut, fromSeq: cut[0]!.seq, toSeq: cut[cut.length - 1]!.seq };
  }

  async #swap(sessionId: string, v: ContextView): Promise<{ swapped: boolean; fromSeq?: number; toSeq?: number; checkpoint?: "done" | "failed" | "skipped" }> {
    const seg = this.#segment(v);
    if (!seg) return { swapped: false };
    let checkpoint: "done" | "failed" | "skipped" = "skipped";
    if (this.#hooks.beforeSwap) {
      // RULING: a failed pre-swap checkpoint does not stop the swap (the L14 bound wins over a missed memory write); it is
      // reported in the turn's compaction data and logged.
      try { await this.#hooks.beforeSwap({ sessionId, fromSeq: seg.fromSeq, toSeq: seg.toSeq }); checkpoint = "done"; }
      catch (e) { checkpoint = "failed"; this.#hooks.onError?.("compaction checkpoint", e); }
    }
    const prepared = this.#store.listSummaries(sessionId, "prepared").find((p) => p.toSeq <= seg.toSeq && p.fromSeq === seg.fromSeq);
    const older = v.summaries;
    const newText = prepared ? prepared.text : digest(seg.messages);
    const merged = fitTail([...older.map((s) => s.text), newText].join("\n"), this.cfg.summaryMaxTokens);
    const tier = Math.max(1, ...older.map((s) => s.tier + 1));
    const supersede = [...older.map((s) => s.id), ...this.#store.listSummaries(sessionId, "prepared").map((s) => s.id)];
    this.#store.replaceSummaries(supersede, { sessionId, fromSeq: older.length ? Math.min(...older.map((s) => s.fromSeq)) : seg.fromSeq, toSeq: seg.toSeq, text: merged, tokens: estimateTokens(merged), tier, state: "applied" });
    return { swapped: true, fromSeq: seg.fromSeq, toSeq: seg.toSeq, checkpoint };
  }
}
