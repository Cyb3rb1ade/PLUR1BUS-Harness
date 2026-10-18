import { authorize } from "./rbac-bridge.ts";
import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { ApiPrincipal, AudienceTarget } from "@plur1bus/module-api";
import type { CoreRpc } from "./core-rpc.ts";
import type { Session, SessionStore } from "./session.ts";
import { ApiError, errors } from "./errors.ts";

export const AGENT_WEB_EVENTS = new Set(["recall.completed", "recall.degraded", "recall.block-clipped", "recall.block-dropped", "job.run", "dream.completed", "acl.denied", "agent.activity"]);
export const WEB_EVENT_NAMES = new Set([...AGENT_WEB_EVENTS, "devices.trust.next", "core.state", "inbox.changed", "approval.requested", "approval.resolved", "grant.changed", "session.event", "project.card.changed", "project.column.changed", "voice.realtime.state", "voice.realtime.transcript", "voice.download.progress"]);
export const GLOBAL_WEB_EVENTS = new Set(["core.state"]);
export function webEventAllowed(method: string, principal: ApiPrincipal, delivery: { audience: readonly AudienceTarget[] | null; connectionId: string }): boolean {
  if (!WEB_EVENT_NAMES.has(method)) return false;
  if (delivery.audience === null) return GLOBAL_WEB_EVENTS.has(method);
  if (!Array.isArray(delivery.audience)) return false;
  return delivery.audience.some(a => {
    if (typeof a === "string") return !AGENT_WEB_EVENTS.has(method) && a === delivery.connectionId;
    if (!a || typeof a !== "object" || Array.isArray(a) || Object.keys(a).length !== 1) return false;
    if ("agentId" in a) return AGENT_WEB_EVENTS.has(method) && typeof a.agentId === "string" && authorize(principal, "agent.read", { kind: "agent", agentId: a.agentId }).effect === "allow";
    if (AGENT_WEB_EVENTS.has(method)) return false;
    return "connectionId" in a ? a.connectionId === delivery.connectionId : "personId" in a && a.personId === principal.userId;
  });
}
interface Event { id: string; wire: string }
interface Stream { feedKey: string; person: string; session: Session; end(): void }
interface Feed { person: string; session: Session; events: Event[]; bytes: number; listeners: Set<(event: Event) => void>; off?: () => void; ready: Promise<void>; epoch: string; seq: number; expiry?: NodeJS.Timeout }

/** Buffers only already filtered events, per person and cookie session. No cookie or delegation credential enters an event/cursor. */
export function createEventsRoute(o: { core: CoreRpc; sessions: SessionStore; maxPerPerson?: number; bufferSize?: number; heartbeatMs?: number; initTimeoutMs?: number; now: () => number }) {
  const streams = new Set<Stream>(), feeds = new Map<string, Feed>();
  const endSession = o.sessions.onEnd(s => {
    for (const stream of streams) if (stream.session === s) stream.end();
    for (const [key, feed] of feeds) if (feed.session === s) drop(key);
  });
  function drop(key: string): void { const f = feeds.get(key); if (!f) return; clearTimeout(f.expiry); f.off?.(); feeds.delete(key); }
  function revoke(person: string): void { for (const s of streams) if (s.person === person) s.end(); for (const [key, feed] of feeds) if (feed.person === person) drop(key); }
  return {
    revoke,
    close() { endSession(); for (const s of streams) s.end(); for (const person of feeds.keys()) drop(person); },
    async open(res: ServerResponse, principal: ApiPrincipal, session: Session, sessionId: string, connectionKey: string, lastId: string | undefined, headers: Record<string, string>, current: () => Promise<boolean>): Promise<void> {
      if ([...streams].filter(s => s.person === principal.userId).length >= (o.maxPerPerson ?? 8)) throw errors.rateLimited(25);
      // Reserve before awaiting the core, so concurrent opens cannot exceed the cap.
      let detach: (() => void) | undefined; let heartbeat: NodeJS.Timeout | undefined; let expiry: NodeJS.Timeout | undefined; let stopped = false;
      const stream: Stream = { feedKey: connectionKey, person: principal.userId, session, end() {
        if (stopped) return; stopped = true; streams.delete(stream); clearInterval(heartbeat); clearTimeout(expiry); detach?.(); res.end();
        const feed = feeds.get(connectionKey);
        if (feed && !feed.listeners.size && ![...streams].some(s => s.feedKey === connectionKey)) {
          clearTimeout(feed.expiry); feed.expiry = setTimeout(() => drop(connectionKey), 120_000); feed.expiry.unref();
        }
      } };
      streams.add(stream); res.once("close", stream.end);
      try {
        let feed = feeds.get(connectionKey);
        if (!feed) {
          if (!o.core.subscribeAs) throw new ApiError(503, "E_NOT_AVAILABLE", "event feed unavailable");
          if (feeds.size >= 64) throw errors.rateLimited(25);
          feed = { person: principal.userId, session, events: [], bytes: 0, listeners: new Set(), epoch: randomUUID(), seq: 0, ready: Promise.resolve() };
          const f = feed; feeds.set(connectionKey, f);
          f.ready = o.core.subscribeAs(principal, (method, params, delivery) => {
            if (!webEventAllowed(method, principal, delivery)) return;
            const id = `${f.epoch}:${++f.seq}`;
            const wire = `id: ${id}\nevent: ${method}\ndata: ${JSON.stringify(params)}\n\n`;
            if (Buffer.byteLength(wire) > 256 * 1024) { for (const s of streams) if (s.feedKey === connectionKey) s.end(); drop(connectionKey); return; }
            f.events.push({ id, wire }); f.bytes += Buffer.byteLength(wire);
            while (f.events.length > (o.bufferSize ?? 256) || f.bytes > 1024 * 1024) f.bytes -= Buffer.byteLength(f.events.shift()!.wire);
            for (const listener of f.listeners) listener({ id, wire });
          }, () => { for (const s of streams) if (s.feedKey === connectionKey) s.end(); drop(connectionKey); }, connectionKey).then(off => { f.off = off; if (feeds.get(connectionKey) !== f) off(); }).catch(e => { drop(connectionKey); throw e; });
        }
        clearTimeout(feed.expiry);
        let initTimer: NodeJS.Timeout | undefined;
        await Promise.race([feed.ready, new Promise<never>((_resolve, reject) => { initTimer = setTimeout(() => reject(errors.timeout()), o.initTimeoutMs ?? 10_000); })]).finally(() => clearTimeout(initTimer));
        if (stopped || o.sessions.peek(sessionId) !== session || !await current()) { stream.end(); return; }
        res.writeHead(200, { ...headers, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        res.flushHeaders(); res.write(": connected\n\n");
        const send = (event: Event) => { if (!stopped) { res.write(event.wire); if (res.writableLength > 1024 * 1024) stream.end(); } };
        if (lastId) {
          const at = feed.events.findIndex(e => e.id === lastId);
          if (at < 0) res.write(`id: ${feed.epoch}:${feed.seq}\nevent: restart\ndata: {"reason":"cursor-expired"}\n\n`);
          else for (const e of feed.events.slice(at + 1)) send(e);
        }
        const f = feed; f.listeners.add(send);
        detach = () => { f.listeners.delete(send); if (!f.listeners.size) { f.expiry = setTimeout(() => { drop(connectionKey); }, 120_000); f.expiry.unref(); } };
        const check = () => {
          clearTimeout(expiry);
          if (o.sessions.peek(sessionId) !== session) { stream.end(); return; }
          expiry = setTimeout(check, Math.max(1, Math.min(session.idleExpiresAt, session.absoluteExpiresAt) - o.now())); expiry.unref();
        };
        check();
        heartbeat = setInterval(() => { void current().then(ok => { if (!ok) stream.end(); else if (!stopped) res.write(": heartbeat\n\n"); }).catch(() => stream.end()); }, o.heartbeatMs ?? 25_000); heartbeat.unref();
      } catch (e) { streams.delete(stream); res.off("close", stream.end); if (![...streams].some(s => s.feedKey === connectionKey)) drop(connectionKey); throw e instanceof ApiError ? e : new ApiError(503, "E_NOT_AVAILABLE", "event feed unavailable"); }
    },
  };
}
