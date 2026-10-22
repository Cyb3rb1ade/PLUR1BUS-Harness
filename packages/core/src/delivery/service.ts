import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { createSecurePath } from '../../../module-api/src/secure-path.ts';
import type { IdentityService, ChannelIdentity } from '../identity/service.ts';
import type { Principal } from '../rbac/types.ts';
import type { AuditSink } from '../rbac/audit.ts';
import type { InboundMessage } from '../channels/types.ts';
import { authorize } from '../rbac/authorize.ts';
import { RpcError } from '../rpc/errors.ts';
export interface DeliveryTarget {
    id: string;
    person: string;
    identity: ChannelIdentity;
    chatId: string;
    validated: boolean;
    createdAt: number;
}
interface Stored extends DeliveryTarget {
    codeHash?: string;
    expires?: number;
    attempts?: number;
    subscriptions?: {
        source: 'system' | 'dreams';
        job: string;
        agentId: string;
    }[];
}
export interface DeliveryOptions {
    path: string;
    clock: () => number;
    identity: () => IdentityService | null;
    resolve: (id: string) => Principal | null;
    audit: AuditSink;
    allowed: (identity: ChannelIdentity) => boolean;
    target: (identity: ChannelIdentity) => Promise<string>;
    send: (channel: string, chatId: string, text: string) => Promise<boolean>;
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const denied = () => new RpcError('E_DENIED', 'delivery destination denied');
export class DeliveryTargets {
    readonly #db: DatabaseSync;
    readonly #o: DeliveryOptions;
    constructor(o: DeliveryOptions) { this.#o = o; mkdirSync(dirname(o.path), { recursive: true, mode: 0o700 }); closeSync(openSync(o.path, 'a', 0o600)); if (!createSecurePath()(o.path, { mode: 0o600 }).applied)
        throw new Error('delivery permissions unavailable'); this.#db = new DatabaseSync(o.path); this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS delivery_targets(id TEXT PRIMARY KEY, value TEXT NOT NULL)'); }
    close() { this.#db.close(); }
    #all(): Stored[] { return (this.#db.prepare('SELECT value FROM delivery_targets').all() as {
        value: string;
    }[]).map(r => JSON.parse(r.value)); }
    #get(id: string): Stored { const t = this.#all().find(t => t.id === id); if (!t)
        throw denied(); return t; }
    #save(t: Stored) { this.#db.prepare('INSERT INTO delivery_targets VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(t.id, JSON.stringify(t)); }
    #audit(person: string, action: string, id: string) { this.#o.audit.append({ at: this.#o.clock(), actor: { user: person, host: 'core' }, action, target: id, detail: {} }); }
    #person(p: Principal) { if (p.kind !== 'person' || !this.#o.resolve(p.userId))
        throw denied(); }
    #live(t: Stored, person: string) { return t.person === person && !!this.#o.resolve(person) && this.#o.identity()?.resolve(t.identity)?.humanId === person && this.#o.allowed(t.identity); }
    #public(t: Stored): DeliveryTarget { return { id: t.id, person: t.person, identity: t.identity, chatId: t.chatId, validated: t.validated, createdAt: t.createdAt }; }
    eligible(p: Principal) { this.#person(p); return this.#o.identity()?.list({}).humans.flatMap(h => h.identities).filter(l => l.humanId === p.userId && l.revokedAt === null && this.#o.allowed(l)).map(l => ({ channel: l.channel, accountId: l.accountId, userId: l.userId })) ?? []; }
    list(p: Principal) { this.#person(p); return this.#all().filter(t => t.person === p.userId).map(t => this.#public({ ...t, validated: t.validated && this.#live(t, p.userId) })); }
    async add(identity: ChannelIdentity, p: Principal) {
        this.#person(p);
        if (this.#all().filter(t => t.person === p.userId).length >= 32)
            throw denied();
        const t: Stored = { id: randomUUID(), person: p.userId, identity: { channel: identity.channel, accountId: identity.accountId, userId: identity.userId }, chatId: '', validated: false, createdAt: this.#o.clock() };
        if (!this.#live(t, p.userId))
            throw denied();
        t.chatId = await this.#o.target(t.identity);
        if (!t.chatId || !this.#live(t, p.userId))
            throw denied();
        if (this.#all().filter(row => row.person === p.userId).length >= 32)
            throw denied();
        this.#audit(p.userId, 'delivery.target.add', t.id);
        this.#save(t);
        await this.challenge(t.id, p);
        return this.#public(t);
    }
    async challenge(id: string, p: Principal) {
        this.#person(p);
        const t = this.#get(id);
        if (!this.#live(t, p.userId))
            throw denied();
        const code = randomBytes(16).toString('hex');
        t.codeHash = hash(code);
        t.expires = this.#o.clock() + 600000;
        t.attempts = 0;
        t.validated = false;
        this.#audit(p.userId, 'delivery.target.challenge', id);
        this.#save(t);
        // Never return or log the code. Confirmation must come back through the exact linked target DM.
        if (!await this.#o.send(t.identity.channel, t.chatId, `Confirm delivery in this DM: /delivery ${code}`).catch(() => false))
            throw new RpcError('E_NOT_AVAILABLE', 'confirmation could not be sent');
        return { awaitingChannel: true };
    }
    confirmMessage(msg: InboundMessage, person: string) {
        if (!/^\/delivery(?:\s|$)/i.test(msg.text.trim()))
            return false;
        const code = /^\/delivery\s+([a-f0-9]{32})$/i.exec(msg.text.trim())?.[1]?.toLowerCase();
        const candidates = this.#all().filter(t => t.person === person && t.identity.channel === msg.channel && t.identity.accountId === msg.accountId && t.identity.userId === msg.senderId && t.chatId === msg.chatId);
        for (const t of candidates) {
            if (!t.codeHash || !this.#live(t, person) || msg.chatKind !== 'direct')
                continue;
            t.attempts = (t.attempts ?? 0) + 1;
            if (code && t.attempts <= 5 && this.#o.clock() < (t.expires ?? 0) && hash(code) === t.codeHash) {
                this.#audit(person, 'delivery.target.confirmed', t.id);
                t.validated = true;
                delete t.codeHash;
                delete t.expires;
            }
            this.#save(t);
        }
        return true;
    }
    remove(id: string, p: Principal) { this.#person(p); const t = this.#get(id); if (t.person !== p.userId)
        throw denied(); this.#audit(p.userId, 'delivery.target.removed', id); this.#db.prepare('DELETE FROM delivery_targets WHERE id=?').run(id); return { removed: true }; }
    validate(id: string, person: string, agentId: string) { const t = this.#get(id); const p = this.#o.resolve(person); if (!t.validated || !this.#live(t, person) || !p || authorize(p, 'agent.use', { kind: 'agent', agentId }, { now: this.#o.clock() }).effect !== 'allow') {
        this.#audit(person, 'delivery.denied', id);
        throw denied();
    } return t; }
    async deliver(id: string, person: string, agentId: string, text: string) {
        const t = this.validate(id, person, agentId);
        const destination = await this.#o.target(t.identity);
        const current = this.validate(id, person, agentId);
        if (current.chatId !== destination || current.identity.accountId !== t.identity.accountId)
            throw denied();
        this.#audit(person, 'delivery.attempt', id);
        const sent = await this.#o.send(t.identity.channel, t.chatId, text).catch(() => false);
        if (!sent)
            throw new RpcError('E_NOT_AVAILABLE', 'delivery unavailable');
        return { sent: true };
    }
    subscribe(id: string, source: 'system' | 'dreams', job: string, agentId: string, p: Principal) {
        const t = this.validate(id, p.userId, agentId);
        if (!['system', 'dreams'].includes(source) || typeof job !== 'string' || !/^[a-zA-Z0-9._-]{1,64}$/.test(job) || !agentId)
            throw denied();
        if (source === 'system' && !['owner', 'admin'].includes(p.role))
            throw denied();
        t.subscriptions = [...(t.subscriptions ?? []).filter(s => !(s.source === source && s.job === job && s.agentId === agentId)), { source, job, agentId }].slice(-32);
        this.#audit(p.userId, 'delivery.subscription', id);
        this.#save(t);
        return { subscribed: true };
    }
    async notify(source: 'system' | 'dreams', job: string, agentId: string | undefined, outcome: string) { for (const t of this.#all())
        for (const s of t.subscriptions ?? []) {
            if (s.source !== source || s.job !== job || agentId !== undefined && s.agentId !== agentId)
                continue;
            const p = this.#o.resolve(t.person);
            if (source === 'system' && !['owner', 'admin'].includes(p?.role ?? ''))
                continue;
            try {
                await this.deliver(t.id, t.person, s.agentId, `${source}: ${job} — ${outcome}`);
            }
            catch { /* denied deliveries are audited; no result or error content goes to another target */ }
        } }
}
