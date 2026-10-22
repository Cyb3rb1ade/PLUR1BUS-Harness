// Owner/Admin operational metadata. Observation never repairs, appends or fully verifies a chain.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface Actor { user: string; host: string }
interface Note { at: number | null; actor: Actor | null }
interface Pending extends Note { action: string; reason: string | null }
export interface AuditHealth {
  state: 'ok' | 'refusing'; reason: string | null; lastSeq: number | null; observedAt: number;
  lastVerifiedAt: number | null; pendingLines: number; pendingDropped: number; pending: Pending[];
  lastAnchorAdvanced: Note | null; lastReanchor: Note | null;
}
/** `pending` carries at most this many rows (the newest); `pendingLines` stays the total. Keep in step with rpc.schema.json `maxItems`. */
export const AUDIT_PENDING_SAMPLE = 50;
/** What one chain file contributes to the status: its last two complete lines and its newest two notes. */
interface FileSummary { key: string; tails: string[]; anchorAdvanced: Note | null; reanchored: Note | null }
/** Summaries of rotated (immutable) chain files, keyed by file name. Bounded by the files present in the directory. */
export type RotatedSummaries = Map<string, FileSummary>;
const GENESIS = '0'.repeat(64);
const HEX = /^[0-9a-f]{64}$/;
const CODES = new Set(['anchor-missing', 'anchor-invalid', 'chain-shorter-than-anchor', 'tail-anchor-mismatch',
  'tail-malformed', 'sequence-exhausted', 'rotation-target-exists', 'lock-timeout']);
const object = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const number = (v: unknown): number | null => Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : null;
const note = (v: Record<string, unknown>): Note => {
  const a = object(v.actor);
  return { at: number(v.at), actor: a && typeof a.user === 'string' && typeof a.host === 'string'
    ? { user: [...a.user].slice(0, 128).join(''), host: [...a.host].slice(0, 128).join('') } : null };
};
const hash = (line: string) => createHash('sha256').update(line).digest('hex');

function summarize(text: string, key: string): FileSummary {
  const sum: FileSummary = { key, tails: [], anchorAdvanced: null, reanchored: null };
  const complete = text.slice(0, text.lastIndexOf('\n') + 1).split('\n').slice(0, -1);
  for (const raw of complete) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    sum.tails.push(line); if (sum.tails.length > 2) sum.tails.shift();
    try {
      const rec = object(object(JSON.parse(line))?.rec);
      if (rec?.action === 'audit.chain.anchor-advanced') sum.anchorAdvanced = note(rec);
      if (rec?.action === 'audit.chain.reanchored') sum.reanchored = note(rec);
    } catch { /* historical damage is reported by explicit audit.verify, not rewritten by status */ }
  }
  return sum;
}

export function readAuditHealth(dir: string, now: number, cache?: RotatedSummaries): AuditHealth {
  let lastVerifiedAt: number | null = null;
  try { const v = JSON.parse(readFileSync(join(dir, "audit-chain.verified.json"), "utf8")); if (v.v === 1) lastVerifiedAt = number(v.at); } catch { /* unknown until an explicit successful verification */ }
  const s: AuditHealth = { state: 'ok', reason: null, lastSeq: 0, observedAt: now, lastVerifiedAt,
    pendingLines: 0, pendingDropped: 0, pending: [], lastAnchorAdvanced: null, lastReanchor: null };
  const refuse = (reason: string) => { s.state = 'refusing'; s.reason = reason; };
  try {
    let names: string[];
    try { names = readdirSync(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') names = []; else throw error; }
    const files = [...names.filter(n => /^audit-chain\.\d{10}\.jsonl$/.test(n)).sort(),
      ...(names.includes('audit-chain.jsonl') ? ['audit-chain.jsonl'] : [])];
    const tails: string[] = [];
    // Parse metadata only. Hashing is limited to the newest two complete lines; no historical integrity claim.
    // A rotated file never changes, so its summary is reused while name, size, mtime and inode are unchanged; the active file is always read.
    const present = new Set(files);
    if (cache) for (const name of cache.keys()) if (!present.has(name)) cache.delete(name);
    for (const file of files) {
      const path = join(dir, file);
      const st = statSync(path);
      const key = `${st.size}:${st.mtimeMs}:${st.ino}`;
      const rotated = file !== 'audit-chain.jsonl';
      let sum = rotated ? cache?.get(file) : undefined;
      if (!sum || sum.key !== key) {
        sum = summarize(readFileSync(path, 'utf8'), key);
        if (rotated) cache?.set(file, sum); else cache?.delete(file);
      }
      for (const line of sum.tails) { tails.push(line); if (tails.length > 2) tails.shift(); }
      if (sum.anchorAdvanced) s.lastAnchorAdvanced = sum.anchorAdvanced;
      if (sum.reanchored) s.lastReanchor = sum.reanchored;
    }
    const latest = tails.at(-1);
    let seq = 0, tailHash = GENESIS, prev = GENESIS;
    if (latest !== undefined) {
      let tail: Record<string, unknown> | null = null;
      try { tail = object(JSON.parse(latest)); } catch { /* refuse below */ }
      if (!tail || number(tail.seq) === null || (tail.seq as number) < 1 || typeof tail.prev !== 'string' || !HEX.test(tail.prev) || !object(tail.rec)) {
        s.lastSeq = null; refuse('tail-malformed');
      } else { seq = tail.seq as number; s.lastSeq = seq; tailHash = hash(latest); prev = tail.prev; }
    }
    let anchor: Record<string, unknown> | null = null;
    const anchorPath = join(dir, 'audit-chain.anchor');
    if (existsSync(anchorPath)) {
      const text = readFileSync(anchorPath, 'utf8');
      try { anchor = object(JSON.parse(text)); } catch { /* invalid below */ }
      if (!anchor || anchor.v !== 1 || number(anchor.seq) === null || (anchor.seq as number) < 1 || typeof anchor.hash !== 'string' || !HEX.test(anchor.hash)) { if (s.state === 'ok') refuse('anchor-invalid'); }
      else if (s.state === 'ok') {
        if (seq < (anchor.seq as number)) refuse('chain-shorter-than-anchor');
        else if (!(seq === anchor.seq && tailHash === anchor.hash) &&
          !(seq === (anchor.seq as number) + 1 && prev === anchor.hash && tails.length === 2 && hash(tails[0]!) === anchor.hash)) refuse('tail-anchor-mismatch');
      }
    } else if (s.state === 'ok' && seq > 0) refuse('anchor-missing');
    if (s.state === 'ok' && seq === Number.MAX_SAFE_INTEGER) refuse('sequence-exhausted');
    const pending = join(dir, 'audit-chain.pending.jsonl');
    if (existsSync(pending)) {
      // Count every row, but parse and keep only the newest AUDIT_PENDING_SAMPLE; malformed rows still count, no content is exposed.
      const lines = readFileSync(pending, 'utf8').split('\n').filter(Boolean);
      const parse = (line: string): Record<string, unknown> | null => { try { return object(JSON.parse(line)); } catch { return null; } };
      let first = 0;
      if (lines.length > 0) { const head = parse(lines[0]!); if (head && number(head.pendingDropped) !== null) { s.pendingDropped = head.pendingDropped as number; first = 1; } }
      s.pendingLines = lines.length - first;
      for (const line of lines.slice(Math.max(first, lines.length - AUDIT_PENDING_SAMPLE))) {
        const row = parse(line);
        s.pending.push({ ...note(row ?? {}), action: typeof row?.action === 'string' && /^[a-z][a-z0-9_.-]{0,127}$/.test(row.action) ? row.action : 'unknown',
          reason: typeof row?.chainReason === 'string' && CODES.has(row.chainReason) ? row.chainReason : null });
      }
    }
  } catch { s.lastSeq = null; refuse('audit-unreadable'); }
  return s;
}

export function createAuditHealth(o: { dir: string; clock?: () => number; ttlMs?: number; securePath?: (path: string) => void }) {
  const clock = o.clock ?? Date.now, ttl = o.ttlMs ?? 30_000;
  let cached: AuditHealth | null = null;
  const rotated: RotatedSummaries = new Map();
  return {
    status(): AuditHealth {
      const now = clock();
      if (!cached || now < cached.observedAt || now - cached.observedAt >= ttl) cached = readAuditHealth(o.dir, now, rotated);
      return structuredClone(cached);
    },
    verified(ok: boolean): void {
      if (!ok) return;
      mkdirSync(o.dir, { recursive: true, mode: 0o700 });
      const target = join(o.dir, "audit-chain.verified.json"), tmp = `${target}.${randomUUID()}.tmp`;
      try {
        writeFileSync(tmp, JSON.stringify({ v: 1, at: clock() }) + "\n", { mode: 0o600, flag: "wx" });
        o.securePath?.(tmp); renameSync(tmp, target); cached = null;
      } finally { rmSync(tmp, { force: true }); }
    },
  };
}

type Reader = { kind?: string; role?: string; tokenScopes?: readonly string[] };
function canReadAudit(principal: Reader | null | undefined): boolean {
  return principal?.kind === 'person' && (principal.role === 'owner' || principal.role === 'admin') &&
    (principal.tokenScopes === undefined || principal.tokenScopes.some(s => s === 'audit.read' || (s.endsWith('.*') && 'audit.read'.startsWith(s.slice(0, -1)))));
}
export function projectAuditStatus<T extends object>(status: T, principal: Reader | null | undefined, read?: () => AuditHealth): T {
  if (canReadAudit(principal)) return read ? { ...status, audit: read() } : status;
  const { audit: _audit, ...publicStatus } = status as T & { audit?: unknown };
  return publicStatus as T;
}
