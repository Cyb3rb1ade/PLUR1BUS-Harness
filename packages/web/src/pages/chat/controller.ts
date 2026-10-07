// One open chat: loads it (session.resume), follows its stream (SSE `session.event`, seq-based), catches up after a gap or
// a reconnect (session.events afterSeq), polls when /events does not exist, submits and cancels. UI-free: signals only.
import { computed, effect, signal } from "@preact/signals";
import type { Api, EventsHandle, EventsStatus, SseEvent } from "../../api/index.ts";
import type { Key } from "../../i18n.ts";
import { applyEvent, addUser, EMPTY_TRANSCRIPT, fromResume, type Transcript } from "./model.ts";
import type { SessionEvent, SessionRecord } from "./rpc-types.ts";
import { getApi } from "../../api/shared.ts";
import { isAborted, refreshList, submitErrorKey } from "./store.ts";

export type LoadState = { status: "loading" } | { status: "ready"; session: SessionRecord } | { status: "error"; error: unknown };

const CATCH_UP_PAGE = 500;
const POLL_MS = 1000;

/** The shape of a `session.event` notification (docs/rpc.md); anything else on the stream is ignored. */
export function parseSessionEvent(e: SseEvent): SessionEvent | null {
  if (e.event !== "session.event") return null;
  let body: unknown;
  try { body = JSON.parse(e.data); } catch { return null; }
  const ev = typeof body === "object" && body !== null ? (body as { event?: unknown }).event : undefined;
  if (typeof ev !== "object" || ev === null) return null;
  const o = ev as Record<string, unknown>;
  if (typeof o.sessionId !== "string" || typeof o.seq !== "number" || typeof o.type !== "string") return null;
  if (typeof o.data !== "object" || o.data === null) return null;
  if (!(o.turnId === null || typeof o.turnId === "string")) return null;
  return o as unknown as SessionEvent;
}

export class ChatController {
  readonly sessionId: string;
  readonly tr = signal<Transcript>(EMPTY_TRANSCRIPT);
  readonly load = signal<LoadState>({ status: "loading" });
  readonly live = signal<EventsStatus>("connecting");
  readonly notice = signal<Key | null>(null);
  readonly sending = signal(false);
  readonly #api: Api;
  readonly #ctl = new AbortController();
  readonly #disposers: (() => void)[] = [];
  #handle: EventsHandle | null = null;
  #catching = false;
  #again = false;

  constructor(sessionId: string, api: Api = getApi()) { this.sessionId = sessionId; this.#api = api; }

  /** Loads the chat, then follows its stream. Calling it again (Try again) reloads. */
  async start(quiet = false): Promise<void> {
    if (!quiet) this.load.value = { status: "loading" };
    try {
      const r = await this.#api.rpc("session.resume", { sessionId: this.sessionId, limit: 200 }, { write: false, signal: this.#ctl.signal });
      this.tr.value = fromResume(r);
      this.load.value = { status: "ready", session: r.session };
    } catch (error) {
      if (!isAborted(error) && !quiet) this.load.value = { status: "error", error };
      return;
    }
    if (this.tr.value.runningTurnId !== null) void this.catchUp();
    if (this.#handle === null) this.#follow();
  }

  stop(): void {
    this.#ctl.abort();
    this.#handle?.close();
    for (const d of this.#disposers.splice(0)) d();
  }

  #follow(): void {
    const handle = this.#api.events({ signal: this.#ctl.signal, onEvent: (e) => { this.#onEvent(e); } });
    this.#handle = handle;
    // Every (re)connect: whatever was missed while the stream was down is fetched; duplicates fall out by seq.
    this.#disposers.push(effect(() => {
      const s = handle.status.value;
      this.live.value = s;
      if (s === "open") void this.catchUp();
    }));
    // No /events on this harness: poll session.events, but only while a reply is being written.
    const polling = computed(() => this.live.value === "unavailable" && this.tr.value.runningTurnId !== null);
    this.#disposers.push(effect(() => {
      if (!polling.value) return undefined;
      const id = setInterval(() => { void this.catchUp(); }, POLL_MS);
      return () => { clearInterval(id); };
    }));
  }

  #onEvent(e: SseEvent): void {
    const ev = parseSessionEvent(e);
    if (ev === null || ev.sessionId !== this.sessionId) return;
    const before = this.tr.value;
    const r = applyEvent(before, ev);
    this.tr.value = r.tr;
    this.#afterChange(before, r.tr);
    if (r.gap) void this.catchUp();
  }

  #afterChange(before: Transcript, after: Transcript): void {
    if (before.runningTurnId !== null && after.runningTurnId === null) void refreshList(true);
  }

  /** Fetches the persisted events after the last one applied (paged), applying them in order. One at a time. */
  async catchUp(): Promise<void> {
    if (this.#catching) { this.#again = true; return; }
    this.#catching = true;
    const first = this.tr.value;
    try {
      do {
        this.#again = false;
        for (;;) {
          const after = this.tr.value.lastSeq;
          const r = await this.#api.rpc("session.events", { sessionId: this.sessionId, afterSeq: after, limit: CATCH_UP_PAGE }, { write: false, signal: this.#ctl.signal });
          for (const ev of r.events) this.tr.value = applyEvent(this.tr.value, ev).tr;
          if (r.events.length < CATCH_UP_PAGE || this.tr.value.lastSeq === after) break;
        }
      } while (this.#again);
    } catch { /* aborted or transient: the next (re)connect, gap or poll tick tries again */ }
    this.#catching = false;
    this.#afterChange(first, this.tr.value);
  }

  /** Submits one message. false: nothing was sent (a hint is in `notice`, the caller keeps the text). */
  async send(text: string): Promise<boolean> {
    if (this.sending.value || this.tr.value.runningTurnId !== null) return false;
    this.sending.value = true;
    this.notice.value = null;
    try {
      const r = await this.#api.rpc("session.submit", { sessionId: this.sessionId, text }, { signal: this.#ctl.signal });
      this.tr.value = addUser(this.tr.value, { id: r.messageId, text, turnId: r.turnId, state: r.state });
      void refreshList(true);
      return true;
    } catch (e) {
      if (isAborted(e)) return false;
      const key = submitErrorKey(e);
      this.notice.value = key;
      if (key === "chat.err.busy") void this.start(true);
      return false;
    } finally {
      this.sending.value = false;
    }
  }

  async cancel(): Promise<void> {
    this.notice.value = null;
    try {
      await this.#api.rpc("session.cancel", { sessionId: this.sessionId }, { signal: this.#ctl.signal });
      await this.catchUp();
    } catch (e) {
      if (!isAborted(e)) this.notice.value = "chat.err.cancel";
    }
  }
}
