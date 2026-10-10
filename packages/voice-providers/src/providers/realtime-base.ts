// Shared session shell for the duplex realtime providers. A codec turns vendor frames into the unified events and the
// unified calls into vendor frames; this class owns queueing, readiness, abort, usage reporting and close.
import { VoiceProviderError, abortedError } from "../errors.ts";
import type { RealtimeEvent, RealtimeSession, UsageReport } from "../types.ts";
import { AsyncQueue } from "../util.ts";
import { parseJsonFrame, type WsLike } from "../ws.ts";

export interface RealtimeCodec {
  /** Frames to send right after the socket opens (session setup). */
  init(): string[];
  /** True for the frame that means the session is configured and may take audio. */
  isReady(frame: Record<string, unknown>): boolean;
  decode(frame: Record<string, unknown>): RealtimeEvent[];
  audio(pcm: Uint8Array): string;
  text(text: string): string[];
  interrupt(): string[];
  toolResult(callId: string, result: unknown): string[];
}

export interface SessionInit {
  provider: string;
  ws: WsLike;
  codec: RealtimeCodec;
  report: (r: UsageReport) => void;
  signal?: AbortSignal | undefined;
}

export function startRealtimeSession(i: SessionInit): RealtimeSession {
  const q = new AsyncQueue<RealtimeEvent>();
  let ready = false;
  let closed = false;
  let pending: string[] = [];
  const send = (frames: string[]) => {
    if (closed) throw new VoiceProviderError("closed", `${i.provider}: session is closed`, { provider: i.provider });
    for (const f of frames) {
      if (ready) i.ws.send(f);
      else pending.push(f);
    }
  };
  i.ws.addEventListener("message", (ev) => {
    let frame: Record<string, unknown>;
    try { frame = parseJsonFrame(ev.data, i.provider); } catch (e) {
      q.push({ type: "error", error: new VoiceProviderError("upstream_protocol", `${i.provider}: malformed frame: ${(e as Error).message}`, { provider: i.provider }) });
      try { i.ws.close(1002, "protocol error"); } catch { /* ignore */ }
      return;
    }
    try {
      if (!ready && i.codec.isReady(frame)) {
        ready = true;
        for (const f of pending) i.ws.send(f);
        pending = [];
        q.push({ type: "ready" });
      }
      for (const e of i.codec.decode(frame)) {
        if (e.type === "usage") i.report(e.report);
        q.push(e);
      }
    } catch (e) {
      q.push({ type: "error", error: new VoiceProviderError("upstream_protocol", `${i.provider}: frame decoding failed: ${(e as Error).message}`, { provider: i.provider }) });
      try { i.ws.close(1002, "protocol error"); } catch { /* ignore */ }
    }
  });

  i.ws.addEventListener("close", (ev) => {
    if (closed) return;
    closed = true;
    if (ev.code !== 1000 && ev.code !== 1005 && ev.code !== 1001) {
      const code = ev.code === 1008 ? "auth" : "network";
      q.push({ type: "error", error: new VoiceProviderError(code, `${i.provider}: connection closed (${ev.code})`, { provider: i.provider }) });
    }
    q.push({ type: "closed", reason: ev.code === 1000 ? "normal" : String(ev.code) });
    q.end();
  });
  i.ws.addEventListener("error", () => q.push({ type: "error", error: new VoiceProviderError("network", `${i.provider}: socket error`, { provider: i.provider }) }));
  i.signal?.addEventListener("abort", () => { q.push({ type: "error", error: abortedError(i.provider) }); try { i.ws.close(1000, "aborted"); } catch { /* closed */ } }, { once: true });
  // A peer that closes immediately is reported by the close handler (events replay to late listeners).
  try { for (const f of i.codec.init()) i.ws.send(f); } catch { /* socket already closed */ }
  return {
    events: q,
    sendAudio: (pcm) => send([i.codec.audio(pcm)]),
    sendText: (t) => send(i.codec.text(t)),
    interrupt: () => send(i.codec.interrupt()),
    submitToolResult: (callId, result) => send(i.codec.toolResult(callId, result)),
    close: async () => { if (closed) return; try { i.ws.close(1000, "done"); } catch { /* closed */ } },
  };
}

export function discoveryModels(list: unknown, pick: (m: Record<string, any>) => boolean): Array<Record<string, any>> {
  return Array.isArray(list) ? list.filter((m): m is Record<string, any> => !!m && typeof m === "object" && pick(m)) : [];
}
