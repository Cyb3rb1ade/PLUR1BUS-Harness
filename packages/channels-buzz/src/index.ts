import type { Event } from 'nostr-tools/pure';
import { getPublicKey, getEventHash, verifyEvent, finalizeEvent } from './nostr.ts';
import { decode } from './nostr.ts';
import { unwrapEvent, wrapManyEvents } from './nostr.ts';
import { socketConnect, type SocketConnect, type JsonSocket } from '../../core/src/voice/socket.ts';
import type { Egress } from '../../core/src/egress/service.ts';
import type { Channel, ChannelHost, OutboundMessage } from '../../core/src/channels/types.ts';
import { channelMessageAllowed, channelOutputText } from '../../core/src/channels/behaviour.ts';
import { resolveConfig, publicKey, relayUrl, type BuzzConfig } from './config.ts';
import { MAX_SEEN, type SeenStore } from './seen.ts';
export { FileSeenStore, MemorySeenStore } from './seen.ts';
export { publicKey, relayUrl, resolveConfig } from './config.ts';
export type { BuzzConfig } from './config.ts';
export interface BuzzDeps {
  secrets: { reveal(name: string): Promise<string | null> }; seen: SeenStore;
  egress: Pick<Egress, 'decide'>; connect?: SocketConnect; now?: () => number; random?: () => number;
  pairing?: { claim(input: { code: string; identity: { channel: string; accountId: string; userId: string } }): { pairingId: string } };
  logger?: { log(level: string, event: string, attrs: Record<string, string | number | boolean>): void };
}
/** Text-only, one-to-one NIP-17 / NIP-59. Network metadata never grants a Principal. */
export class BuzzChannel implements Channel {
  readonly name = 'buzz'; readonly #c; readonly #d: BuzzDeps;
  #host: ChannelHost | undefined; #key: Uint8Array | undefined; #pub = ''; #abort: AbortController | undefined;
  #sockets = new Map<string, JsonSocket>(); #loops: Promise<void>[] = []; #seen = new Set<string>(); #work = Promise.resolve(); #pending = 0;
  #relayWaiters = new Map<string, Set<() => void>>();
  #acks = new Map<string, (ok: boolean) => void>();
  #metadata = new Map<string, { at: number; relays: string[] }>(); #timers = new Set<NodeJS.Timeout>();
  constructor(config: BuzzConfig, deps: BuzzDeps) { this.#c = resolveConfig(config); this.#d = deps; }
  #now() { return Math.floor((this.#d.now?.() ?? Date.now()) / 1000); }
  #log(event: string) { this.#d.logger?.log('warn', event, {}); }
  async start(host: ChannelHost): Promise<void> {
    if (this.#abort) throw new Error('Buzz already started');
    let raw: string | null;
    try {
      raw = await this.#d.secrets.reveal(this.#c.secret);
      if (!raw) throw new Error();
      if (/^[0-9a-fA-F]{64}$/.test(raw)) this.#key = Uint8Array.from(Buffer.from(raw, 'hex'));
      else { const v = decode(raw); if (v.type !== 'nsec') throw new Error(); this.#key = v.data; }
      this.#pub = getPublicKey(this.#key);
      this.#seen = new Set(await this.#d.seen.load());
    } catch { this.#key?.fill(0); this.#key = undefined; throw new Error('Buzz key or replay store unavailable'); }
    this.#host = host; this.#abort = new AbortController();
    // Start every relay independently; a denied or failing relay cannot prevent another from connecting.
    this.#loops = this.#c.relays.map(url => this.#loop(url));
  }
  async #pause(ms: number) {
    if (this.#abort?.signal.aborted) return;
    await new Promise<void>(resolve => {
      const signal = this.#abort!.signal;
      const done = () => { clearTimeout(t); this.#timers.delete(t); signal.removeEventListener('abort', done); resolve(); };
      const t = setTimeout(done, ms); this.#timers.add(t); signal.addEventListener('abort', done, { once: true });
    });
  }
  async #loop(url: string) {
    let failures = 0;
    while (!this.#abort!.signal.aborted) {
      try {
        let closed!: () => void; const done = new Promise<void>(r => { closed = r; }); let challenges = 0;
        const connect = this.#d.connect ?? socketConnect(this.#d.egress);
        // Also check injected transports. Production transport pins this same decision to its connection.
        const check = new URL(url); check.protocol = check.protocol === 'wss:' ? 'https:' : 'http:';
        if (!(await this.#d.egress.decide(check.href)).allowed) throw new Error();
        const connectedAt = Date.now();
        const socket = await connect({ url, signal: this.#abort!.signal, onClose: () => { this.#sockets.delete(url); for (const [id, ack] of this.#acks) if (id.startsWith(url + '\0')) ack(false); closed(); }, onMessage: async value => {
          if (Array.isArray(value) && value[0] === 'OK' && typeof value[1] === 'string') { this.#acks.get(url + '\0' + value[1])?.(value[2] === true); return; }
          if (Array.isArray(value) && value[0] === 'AUTH' && typeof value[1] === 'string' && value[1].length <= 1024 && ++challenges <= 3) {
            await this.#sockets.get(url)?.send(['AUTH', finalizeEvent({ kind: 22242, created_at: this.#now(), content: '', tags: [['relay', url], ['challenge', value[1]]] }, this.#key!)]); return;
          }
          if (Array.isArray(value) && value[0] === 'EVENT' && value[1] === 'buzz-relays') { await this.#receive(value); return; }
          if (this.#pending >= 128) throw new Error('Buzz queue full');
          this.#pending++;
          this.#work = this.#work.then(() => this.#receive(value)).catch(() => { this.#log('buzz.event.rejected'); }).finally(() => { this.#pending--; });
        } });
        if (this.#abort!.signal.aborted) { await socket.close(); break; }
        this.#sockets.set(url, socket);
        await socket.send(['REQ', 'buzz-inbox', { kinds: [1059], '#p': [this.#pub], since: this.#now() - 172800 }]);
        if (this.#c.allow.size) await socket.send(['REQ', 'buzz-relays', { kinds: [10050], authors: [...this.#c.allow] }]);
        await socket.send(['EVENT', finalizeEvent({ kind: 10050, created_at: this.#now(), content: '', tags: this.#c.relays.map(r => ['relay', r]) }, this.#key!)]);
        await done;
        if (Date.now() - connectedAt >= 60000) failures = 0;
      } catch { this.#log('buzz.relay.unavailable'); const socket = this.#sockets.get(url); this.#sockets.delete(url); await socket?.close().catch(() => {}); }
      if (!this.#abort!.signal.aborted) await this.#pause(Math.min(60000, 1000 * 2 ** Math.min(failures++, 6)) * (0.75 + (this.#d.random?.() ?? Math.random()) / 2));
    }
  }
  async #receive(value: unknown) {
    if (!Array.isArray(value) || value[0] !== 'EVENT' || !['buzz-inbox', 'buzz-relays'].includes(value[1]) || JSON.stringify(value).length > 131072) return;
    const e = value[2] as Event;
    if (!e || ![1059,10050].includes(e.kind) || !verifyEvent(e)) return;
    if (e.kind === 10050) {
      if (value[1] !== 'buzz-relays' || !this.#c.allow.has(e.pubkey) || e.created_at > this.#now() + 300 || e.created_at <= (this.#metadata.get(e.pubkey)?.at ?? -1)) return;
      const relays = e.tags.filter(t => t[0] === 'relay' && typeof t[1] === 'string').flatMap(t => { try { const r = relayUrl(t[1]!); return this.#c.relays.includes(r) ? [r] : []; } catch { return []; } });
      this.#metadata.set(e.pubkey, { at: e.created_at, relays }); for (const done of this.#relayWaiters.get(e.pubkey) ?? []) done(); return;
    }
    if (value[1] !== 'buzz-inbox' || this.#seen.has(e.id) || e.created_at > this.#now() + 300 || e.created_at < this.#now() - 172800 || e.tags.filter(t => t[0] === 'p').length !== 1 || !e.tags.some(t => t[0] === 'p' && t[1] === this.#pub)) return;
    let rumor; try { rumor = unwrapEvent(e, this.#key!); } catch { return; }
    if (rumor.kind !== 14 || !this.#c.allow.has(rumor.pubkey) || rumor.pubkey === this.#pub || rumor.id !== getEventHash(rumor) || this.#seen.has(rumor.id) || rumor.content.length > 16384 || rumor.created_at > this.#now() + 300 || rumor.created_at < this.#now() - 172800 || rumor.tags.filter(t => t[0] === 'p').length !== 1 || !rumor.tags.some(t => t[0] === 'p' && t[1] === this.#pub)) return;
    const next = new Set(this.#seen); next.add(e.id); next.add(rumor.id);
    while (next.size > MAX_SEEN) next.delete(next.values().next().value!);
    await this.#d.seen.save([...next]); this.#seen = next;
    const message = { channel: this.name, chatId: rumor.pubkey, senderId: rumor.pubkey, accountId: this.#pub, chatKind: 'direct' as const, addressed: true, text: rumor.content, messageId: rumor.id };
    if (!channelMessageAllowed(this.#host, message)) return;
    const link = /^\/link\s+(\S+)\s*$/i.exec(rumor.content);
    if (link) {
      let claimed = false;
      try { claimed = !!this.#d.pairing?.claim({ code: link[1]!, identity: { channel: this.name, accountId: this.#pub, userId: rumor.pubkey } }); } catch {}
      await this.send({ chatId: rumor.pubkey, text: this.#c.locale === 'de' ? claimed ? 'Owner-Bestätigung ausstehend.' : 'Verknüpfung fehlgeschlagen.' : claimed ? 'Awaiting owner confirmation.' : 'Link failed.' }); return;
    }
    await this.#host?.receive(message);
  }
  async #waitMetadata(peer: string) {
    if (this.#metadata.has(peer)) return;
    await new Promise<void>(resolve => {
      const signal = this.#abort!.signal;
      const waiters = this.#relayWaiters.get(peer) ?? new Set<() => void>(); this.#relayWaiters.set(peer, waiters);
      const done = () => { clearTimeout(t); signal.removeEventListener('abort', done); waiters.delete(done); if (!waiters.size) this.#relayWaiters.delete(peer); resolve(); };
      const t = setTimeout(done, 3000); waiters.add(done); signal.addEventListener('abort', done, { once: true });
    });
  }
  async #publish(url: string, event: Event): Promise<boolean> {
    const id = url + '\0' + event.id;
    let finish!: (ok: boolean) => void;
    const ack = new Promise<boolean>(resolve => { finish = resolve; });
    this.#acks.set(id, finish);
    const timeout = setTimeout(() => finish(false), 8000);
    const abort = () => finish(false); this.#abort!.signal.addEventListener('abort', abort, { once: true });
    try { await this.#sockets.get(url)!.send(['EVENT', event]); return await ack; }
    catch { return false; }
    finally { clearTimeout(timeout); this.#acks.delete(id); this.#abort?.signal.removeEventListener('abort', abort); }
  }
  async send(message: OutboundMessage) {
    if (!this.#key || !this.#host) throw new Error('Buzz unavailable');
    const peer = publicKey(message.chatId); if (!this.#c.allow.has(peer)) throw new Error('Buzz destination denied');
    const text = channelOutputText(this.#host, this.name, peer, 'reply', message.text);
    if (text.length > 16384) throw new Error('Buzz message too large');
    await this.#waitMetadata(peer);
    if (!this.#key || !this.#abort || this.#abort.signal.aborted) throw new Error("Buzz unavailable");
    const destinations = this.#metadata.get(peer)?.relays.filter(r => this.#sockets.has(r)) ?? [];
    if (!destinations.length) throw new Error('Buzz recipient has no permitted DM relay');
    const events = wrapManyEvents({ kind: 14, content: text, created_at: this.#now(), tags: [['p', peer]] }, this.#key, [peer]);
    for (const event of events) {
      const target = event.tags.find(t => t[0] === 'p')?.[1]; const relays = target === peer ? destinations : [...this.#sockets.keys()];
      const results = await Promise.all(relays.map(r => this.#publish(r, event)));
      if (!results.some(Boolean)) throw new Error('Buzz publish failed');
    }
  }
  async stop() {
    this.#abort?.abort(); await Promise.allSettled([...this.#sockets.values()].map(s => s.close())); this.#sockets.clear(); await Promise.allSettled(this.#loops); await this.#work;
    this.#key?.fill(0); this.#key = undefined; this.#host = undefined; this.#abort = undefined; this.#metadata.clear();
  }
  async idle() { await this.#work; }
  async health() { return { ok: this.#sockets.size > 0, detail: this.#sockets.size ? 'connected' : 'waiting for permitted relay' }; }
}
export function createBuzzChannel(config: BuzzConfig, deps: BuzzDeps) { return new BuzzChannel(config, deps); }
