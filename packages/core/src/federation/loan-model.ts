/** G4 model only. No authentication, signatures, timers, I/O or dispatcher authorization.
 * A future runtime must verify peer/lease signatures and enforce these decisions before every call. */
export interface LoanOffer {
  readonly loanId: string;
  readonly agentId: string;
  readonly lenderFingerprint: string;
  readonly borrowerFingerprint: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly keepMissionCopies: boolean;
  readonly secretNames: readonly string[];
}
export interface ModelLease {
  readonly loanId: string;
  readonly agentId: string;
  readonly borrowerFingerprint: string;
  readonly issuedAt: number;
  readonly notAfter: number;
}
export type LoanStatus = 'offered' | 'accepted' | 'active' | 'paused' | 'returned' |
  'returned-by-timeout' | 'recalled' | 'revoked' | 'expired' | 'declined';
export interface LoanState {
  readonly offer: LoanOffer;
  readonly side: 'lender' | 'borrower';
  readonly status: LoanStatus;
  readonly observedAt: number;
  /** Borrower-local metadata, absent on the lender. Never include it in a peer payload. */
  readonly borrowerProjectId?: string;
  readonly lastContactAt?: number;
  readonly lease?: ModelLease;
  readonly nextHeartbeatAt?: number;
  readonly removalConfirmed: boolean;
}
export type LoanEvent =
  | { readonly type: 'accept'; readonly borrowerProjectId?: string }
  | { readonly type: 'renew'; readonly lease: ModelLease }
  | { readonly type: 'tick' | 'recall' | 'revoke' | 'return' | 'decline' | 'confirm-removal' };
const TTL = 120_000;
const HEARTBEAT = 30_000;
const MAX_DURATION = 2_592_000_000;
const terminal = (s: LoanStatus) => !['offered', 'accepted', 'active', 'paused'].includes(s);
const fail = (reason: string): never => { throw new Error(`loan-model: ${reason}`); };
function time(n: number): void {
  if (!Number.isSafeInteger(n) || n < 0) fail('invalid time');
}
function id(s: string, label: string): void {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(s)) fail(`invalid ${label}`);
}
function closed(value: object, keys: readonly string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(k => !keys.includes(k))) fail('unknown fields');
}

export function createLoan(offer: LoanOffer, side: 'lender' | 'borrower', now: number): LoanState {
  closed(offer, ['loanId', 'agentId', 'lenderFingerprint', 'borrowerFingerprint', 'createdAt', 'expiresAt', 'keepMissionCopies', 'secretNames']);
  time(now); time(offer.createdAt); time(offer.expiresAt);
  if (now < offer.createdAt) fail('invalid time');
  const duration = offer.expiresAt - offer.createdAt;
  if (duration <= 0 || duration > MAX_DURATION) fail('invalid duration');
  for (const key of ['loanId', 'agentId', 'lenderFingerprint', 'borrowerFingerprint'] as const) id(offer[key], key);
  if (offer.lenderFingerprint === offer.borrowerFingerprint) fail('same peer');
  if (side !== 'lender' && side !== 'borrower') fail('invalid side');
  if (typeof offer.keepMissionCopies !== 'boolean' || !Array.isArray(offer.secretNames)) fail('invalid offer');
  for (const name of offer.secretNames) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9_.:/-]{1,128}$/.test(name)) fail('invalid secret name');
  }
  const copy = Object.freeze({ ...offer, secretNames: Object.freeze([...offer.secretNames]) });
  return Object.freeze({ offer: copy, side, status: now >= offer.expiresAt ? 'expired' : 'offered', observedAt: now, removalConfirmed: false });
}

function observed(state: LoanState, now: number): LoanState {
  time(now);
  if (now < state.observedAt) fail('time rollback');
  if (terminal(state.status)) return Object.freeze({ ...state, observedAt: now });
  let status = state.status;
  if (now >= state.offer.expiresAt) status = 'expired';
  else if (state.lastContactAt !== undefined && now - state.lastContactAt >= (state.side === 'borrower' ? 86_400_000 : 900_000)) status = 'returned-by-timeout';
  else if (state.status === 'active' && state.lease && now >= state.lease.notAfter) status = 'paused';
  return Object.freeze({ ...state, status, observedAt: now });
}

/** Unsigned lease candidate for deterministic simulation, never a credential. */
export function modelLease(state: LoanState, now: number): ModelLease {
  time(now);
  if (now < state.observedAt || now >= state.offer.expiresAt) fail('invalid lease time');
  return Object.freeze({ loanId: state.offer.loanId, agentId: state.offer.agentId,
    borrowerFingerprint: state.offer.borrowerFingerprint, issuedAt: now,
    notAfter: Math.min(now + TTL, state.offer.expiresAt) });
}

/** A pure local observation. Caller supplies a monotonic, trusted clock; no timer is started here. */
export function transitionLoan(state: LoanState, event: LoanEvent, now: number): LoanState {
  const s = observed(state, now);
  closed(event, event.type === 'accept' ? ['type', 'borrowerProjectId'] : event.type === 'renew' ? ['type', 'lease'] : ['type']);
  if (event.type === 'tick') return s;
  if (event.type === 'confirm-removal') {
    if (!terminal(s.status)) fail('invalid transition');
    return Object.freeze({ ...s, removalConfirmed: true });
  }
  if (terminal(s.status)) fail('mission ended');
  if (event.type === 'accept') {
    if (s.status !== 'offered') fail('invalid transition');
    if (s.side === 'borrower') {
      id(event.borrowerProjectId!, 'borrower project');
      return Object.freeze({ ...s, status: 'accepted', borrowerProjectId: event.borrowerProjectId!, lastContactAt: now });
    }
    if (event.borrowerProjectId !== undefined) fail('borrower project is local');
    return Object.freeze({ ...s, status: 'accepted', lastContactAt: now });
  }
  if (event.type === 'renew') {
    if (!['accepted', 'active', 'paused'].includes(s.status)) fail('invalid transition');
    const l = event.lease;
    closed(l, ['loanId', 'agentId', 'borrowerFingerprint', 'issuedAt', 'notAfter']);
    time(l.issuedAt); time(l.notAfter);
    if (l.loanId !== s.offer.loanId || l.agentId !== s.offer.agentId || l.borrowerFingerprint !== s.offer.borrowerFingerprint ||
      l.issuedAt > now || l.issuedAt < s.lastContactAt! || l.notAfter <= now || l.notAfter <= l.issuedAt ||
      l.notAfter - l.issuedAt > TTL || l.notAfter > s.offer.expiresAt ||
      (s.lease && (l.issuedAt <= s.lease.issuedAt || l.notAfter < s.lease.notAfter))) fail('invalid lease');
    return Object.freeze({ ...s, status: 'active', lease: Object.freeze({ ...l }), lastContactAt: now, nextHeartbeatAt: Math.min(l.issuedAt + HEARTBEAT, s.offer.expiresAt) });
  }
  const status = { recall: 'recalled', revoke: 'revoked', return: 'returned', decline: 'declined' } as const;
  if (event.type === 'decline' && s.status !== 'offered') fail('invalid transition');
  if (event.type === 'return' && s.status === 'offered') fail('invalid transition');
  if (!Object.hasOwn(status, event.type)) fail('invalid transition');
  return Object.freeze({ ...s, status: status[event.type] });
}

/** Simulation result only; never used as an authorization grant. Re-evaluates deadlines even without a tick. */
export function modelWorkDecision(state: LoanState, projectId: string | undefined, now: number): { allowed: boolean } {
  if (!Number.isSafeInteger(now) || now < state.observedAt) return { allowed: false };
  const s = observed(state, now);
  return { allowed: s.side === 'borrower' && s.status === 'active' && !!s.lease && now < s.lease.notAfter &&
    s.borrowerProjectId !== undefined && s.borrowerProjectId === projectId };
}

/** Content-free status for the lender. The borrower project id never crosses this projection. */
export function lenderLoanView(state: LoanState): Pick<LoanState, 'offer' | 'status' | 'removalConfirmed'> {
  return Object.freeze({ offer: state.offer, status: state.status, removalConfirmed: state.removalConfirmed });
}
