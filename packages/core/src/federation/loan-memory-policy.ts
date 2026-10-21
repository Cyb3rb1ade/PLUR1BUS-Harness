/** Content-free G4 memory model. Hashes/references only: no memory text, secret values, import or prompt I/O.
 * The future runtime must authenticate peers, bind hashes to actual content and persist receipts atomically with imports. */
import { createHash } from 'node:crypto';
import type { LoanOffer, LoanState } from './loan-model.ts';

export type LoanMemoryLevel = 'shareable' | 'confidential' | 'private';
export interface LoanMemoryRef {
  id: string;
  personKey: string;
  level: LoanMemoryLevel;
  contentHash: string;
}
interface BatchItem { readonly id: string; readonly contentHash: string }
export interface MemoryBatch {
  readonly loanId: string;
  readonly agentId: string;
  readonly borrowerFingerprint: string;
  readonly relationshipKey: string;
  readonly level: LoanMemoryLevel;
  readonly items: readonly BatchItem[];
  readonly batchId: string;
}
export interface MemoryAck { readonly loanId: string; readonly batchId: string }
export interface MemoryOutboxEntry { readonly batch: MemoryBatch; readonly acknowledged: boolean }
export interface ImportDescriptor extends BatchItem {
  readonly relationshipKey: string;
  readonly level: LoanMemoryLevel;
  readonly context: { readonly kind: 'mission'; readonly missionId: string };
  readonly origin: { readonly system: string };
  readonly sourceRef: string;
  readonly tainted: true;
}
const fail = (reason: string): never => { throw new Error(`loan-memory-model: ${reason}`); };
function closed(value: object, keys: readonly string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) fail('unknown fields');
}
function id(s: string): void {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(s)) fail('invalid memory id');
}
function hash(s: string): void {
  if (typeof s !== 'string' || !/^[a-f0-9]{64}$/.test(s)) fail('invalid memory hash');
}
function level(s: LoanMemoryLevel): void {
  if (!['shareable', 'confidential', 'private'].includes(s)) fail('invalid memory level');
}
function memory(value: LoanMemoryRef): void {
  closed(value, ['id', 'personKey', 'level', 'contentHash']);
  id(value.id); id(value.personKey); level(value.level); hash(value.contentHash);
}
function batchContent(batch: Omit<MemoryBatch, 'batchId'>): string {
  return JSON.stringify([batch.loanId, batch.agentId, batch.borrowerFingerprint, batch.relationshipKey,
    batch.level, batch.items.map(i => [i.id, i.contentHash])]);
}
const digest = (batch: Omit<MemoryBatch, 'batchId'>) => createHash('sha256').update(batchContent(batch)).digest('hex');
function freezeBatch(batch: MemoryBatch): MemoryBatch {
  return Object.freeze({ ...batch, items: Object.freeze(batch.items.map(i => Object.freeze({ ...i }))) });
}
function validateBatch(batch: MemoryBatch): void {
  closed(batch, ['loanId', 'agentId', 'borrowerFingerprint', 'relationshipKey', 'level', 'items', 'batchId']);
  id(batch.loanId); id(batch.agentId); id(batch.borrowerFingerprint); level(batch.level); hash(batch.batchId);
  const prefix = `rel:${batch.agentId}:peer:${batch.borrowerFingerprint}:`;
  if (typeof batch.relationshipKey !== 'string' || !batch.relationshipKey.startsWith(prefix)) fail('invalid batch relationship');
  id(batch.relationshipKey.slice(prefix.length));
  if (!Array.isArray(batch.items) || batch.items.length === 0) fail('invalid batch items');
  let previous = '';
  for (const item of batch.items) {
    closed(item, ['id', 'contentHash']); id(item.id); hash(item.contentHash);
    if (item.id <= previous) fail('invalid batch order or duplicate');
    previous = item.id;
  }
  if (digest(batch) !== batch.batchId) fail('invalid batch hash');
}

/** Explicit selection only. Private home entries never become part of a loan package. */
export function selectedHomeMemories(entries: readonly LoanMemoryRef[] = []): readonly Readonly<LoanMemoryRef>[] {
  return Object.freeze(entries.map(entry => {
    memory(entry);
    if (entry.level === 'private') fail('private home memory');
    return Object.freeze({ ...entry });
  }));
}

/** Produces the next continuous batch set immediately; grouping is by BOTH foreign relationship and level. */
export function makeMemoryBatches(state: LoanState, entries: readonly LoanMemoryRef[]): readonly MemoryBatch[] {
  if (state.side !== 'borrower' || !state.borrowerProjectId) fail('borrower mission required');
  const groups = new Map<string, { relationshipKey: string; level: LoanMemoryLevel; items: BatchItem[] }>();
  const seen = new Set<string>();
  for (const entry of entries) {
    memory(entry);
    if (seen.has(entry.id)) fail('duplicate memory');
    seen.add(entry.id);
    const relationshipKey = `rel:${state.offer.agentId}:peer:${state.offer.borrowerFingerprint}:${entry.personKey}`;
    const key = `${relationshipKey}\0${entry.level}`;
    let group = groups.get(key);
    if (!group) { group = { relationshipKey, level: entry.level, items: [] }; groups.set(key, group); }
    group.items.push({ id: entry.id, contentHash: entry.contentHash });
  }
  return Object.freeze([...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, group]) => {
    const body = { loanId: state.offer.loanId, agentId: state.offer.agentId, borrowerFingerprint: state.offer.borrowerFingerprint,
      ...group, items: group.items.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) };
    return freezeBatch({ ...body, batchId: digest(body) });
  }));
}

/** Returns direct-import descriptors and a replay receipt; performs no import and gives no peer authorization. */
export function receiveMemoryBatch(received: readonly MemoryBatch[], offer: LoanOffer, batch: MemoryBatch): {
  received: readonly MemoryBatch[]; imports: readonly ImportDescriptor[]; ack: MemoryAck;
} {
  const known = new Map<string, { contentHash: string; relationshipKey: string; level: LoanMemoryLevel }>();
  const check = (b: MemoryBatch, remember: boolean) => {
    validateBatch(b);
    if (b.loanId !== offer.loanId || b.agentId !== offer.agentId || b.borrowerFingerprint !== offer.borrowerFingerprint) fail('foreign batch');
    for (const item of b.items) {
      const previous = known.get(item.id);
      if (previous && (previous.contentHash !== item.contentHash || previous.relationshipKey !== b.relationshipKey || previous.level !== b.level)) fail('conflicting memory id');
      if (remember) known.set(item.id, { contentHash: item.contentHash, relationshipKey: b.relationshipKey, level: b.level });
    }
  };
  for (const b of received) check(b, true);
  check(batch, false);
  const replay = received.some(b => b.batchId === batch.batchId);
  const copy = freezeBatch(batch);
  const imports: readonly ImportDescriptor[] = Object.freeze(replay ? [] : copy.items.filter(item => !known.has(item.id)).map(item => Object.freeze({
    ...item, relationshipKey: copy.relationshipKey, level: copy.level,
    context: Object.freeze({ kind: 'mission' as const, missionId: offer.loanId }),
    origin: Object.freeze({ system: `peer:${offer.borrowerFingerprint}` }),
    sourceRef: `mission:${offer.loanId}@${offer.borrowerFingerprint}#${copy.batchId}:${item.id}`,
    tainted: true as const,
  })));
  const previous = received.map(freezeBatch);
  return Object.freeze({ received: Object.freeze(replay ? previous : [...previous, copy]), imports,
    ack: Object.freeze({ loanId: offer.loanId, batchId: batch.batchId }) });
}

export function createMemoryOutbox(batches: readonly MemoryBatch[]): readonly MemoryOutboxEntry[] {
  return Object.freeze(batches.map(batch => {
    validateBatch(batch);
    return Object.freeze({ batch: freezeBatch(batch), acknowledged: false });
  }));
}

/** An ack is meaningful only after peer authentication by the future transport. */
export function acknowledgeMemoryBatch(outbox: readonly MemoryOutboxEntry[], ack: MemoryAck): readonly MemoryOutboxEntry[] {
  closed(ack, ['loanId', 'batchId']);
  if (!outbox.some(e => e.batch.loanId === ack.loanId && e.batch.batchId === ack.batchId)) fail('unknown ack');
  return Object.freeze(outbox.map(e => e.batch.loanId === ack.loanId && e.batch.batchId === ack.batchId ?
    Object.freeze({ ...e, acknowledged: true }) : e));
}

export function borrowerMemoryDisposition(offer: LoanOffer, acknowledged: boolean, missionEnded: boolean):
  'mission-store' | 'outbox' | 'remove' | 'retained-copy' {
  if (!missionEnded) return 'mission-store';
  if (!acknowledged) return 'outbox';
  return offer.keepMissionCopies ? 'retained-copy' : 'remove';
}

/** D116 foreign-context policy. This returns a rule, never prompt content. */
export function foreignMemoryUse(value: LoanMemoryLevel): 'show-with-origin' | 'use-without-disclosure' | 'exclude' {
  level(value);
  const rules = { shareable: 'show-with-origin', confidential: 'use-without-disclosure', private: 'exclude' } as const;
  return rules[value];
}
