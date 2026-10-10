// Shared session shell for the duplex realtime providers. A codec turns vendor frames into the unified events and the
// unified calls into vendor frames; this class owns queueing, readiness, abort, usage reporting and close.
import { VoiceProviderError, abortedError } from "../errors.ts";
import type { RealtimeEvent, RealtimeSession, UsageReport } from "../types.ts";
import { AsyncQueue } from "../util.ts";
import { closeError, parseJsonFrame, upstreamProtocolError, type WsLike } from "../ws.ts";

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
  // True once the session itself ended the socket (caller close, abort, protocol failure): the close event that follows
  // is then not an error of the service.
  let closing = false;
  let failed = false;
  let pending: string[] = [];
  const send = (frames: string[]) => {
    if (closed || failed) throw new VoiceProviderError("closed", `${i.provider}: session is closed`, { provider: i.provider });
    for (const f of frames) {
      if (ready) i.ws.send(f);
      else pending.push(f);
    }
  };
  // Anything a frame makes us throw (a codec on an unexpected shape, a send on a socket that is shutting down) ends the
  // session with one error event instead of escaping into the socket's data handler and the process.
  const protocolFailure = () => {
    if (failed || closed) return;
    failed = true;
    closing = true;
    q.push({ type: "error", error: upstreamProtocolError(i.provider) });
    try { i.ws.close(1002, "protocol error"); } catch { /* closed */ }
  };
  i.ws.addEventListener("message", (ev) => {
    if (failed) return;
    try {
      const frame = parseJsonFrame(ev.data, i.provider);
      if (!ready && i.codec.isReady(frame)) {
        ready = true;
        for (const f of pending) i.ws.send(f);
        pending = [];
        q.push({ type: "ready" });
      }
      for (const e of i.codec.decode(frame)) {
        if (e.type === "usage") { try { i.report(e.report); } catch { /* a throwing usage sink must not end the session */ } }
        q.push(e);
      }
    } catch {
      protocolFailure();
    }
  });
  i.ws.addEventListener("close", (ev) => {
    if (closed) return;
    closed = true;
    if (!closing && !failed && ev.code !== 1000 && ev.code !== 1005 && ev.code !== 1001) q.push({ type: "error", error: closeError(i.provider, ev.code) });
    q.push({ type: "closed", reason: ev.code === 1000 ? "normal" : String(ev.code) });
    q.end();
  });
  i.ws.addEventListener("error", () => { if (!failed) q.push({ type: "error", error: new VoiceProviderError("network", `${i.provider}: socket error`, { provider: i.provider }) }); });
  i.signal?.addEventListener("abort", () => { closing = true; q.push({ type: "error", error: abortedError(i.provider) }); try { i.ws.close(1000, "aborted"); } catch { /* closed */ } }, { once: true });
  // A peer that closes immediately is reported by the close handler (events replay to late listeners).
  try { for (const f of i.codec.init()) i.ws.send(f); } catch { /* socket already closed */ }
  return {
    events: q,
    sendAudio: (pcm) => send([i.codec.audio(pcm)]),
    sendText: (t) => send(i.codec.text(t)),
    interrupt: () => send(i.codec.interrupt()),
    submitToolResult: (callId, result) => send(i.codec.toolResult(callId, result)),
    close: async () => { if (closed) return; closing = true; try { i.ws.close(1000, "done"); } catch { /* closed */ } },
  };
}

export function discoveryModels(list: unknown, pick: (m: Record<string, any>) => boolean): Array<Record<string, any>> {
  return Array.isArray(list) ? list.filter((m): m is Record<string, any> => !!m && typeof m === "object" && pick(m)) : [];
}
