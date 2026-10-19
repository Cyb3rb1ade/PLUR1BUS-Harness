export type RetryClass = 'rate_limit' | 'overloaded' | 'network' | 'timeout' | 'tool_call_invalid';
/** Per failure class and turn: at most `maxAttempts` retries reserving at most `maxTokens` (input + output) together. */
export interface RetryRule { maxAttempts: number; maxTokens: number }
export type RetryPolicy = Record<RetryClass, RetryRule>;
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  rate_limit: { maxAttempts: 3, maxTokens: 200_000 }, overloaded: { maxAttempts: 2, maxTokens: 200_000 },
  network: { maxAttempts: 2, maxTokens: 100_000 }, timeout: { maxAttempts: 1, maxTokens: 200_000 },
  tool_call_invalid: { maxAttempts: 1, maxTokens: 100_000 },
};
/** Tokens all retries of one turn may reserve together, across classes. */
export const DEFAULT_RETRY_TURN_TOKENS = 400_000;
export class RetryBudgetExceededError extends Error {
  readonly code = 'retry_budget_exceeded';
  readonly failureClass: RetryClass;
  readonly reason: 'attempts' | 'tokens';
  constructor(failureClass: RetryClass, reason: 'attempts' | 'tokens') {
    super(`retry ${failureClass} ${reason} budget exceeded`); this.name = 'RetryBudgetExceededError'; this.failureClass = failureClass; this.reason = reason;
  }
}
/** Counts retry attempts (initial call excluded) and their tokens. Tokens remain reserved until authoritative settlement. */
export class RetryBudget {
  private readonly turns = new Map<string, { total: number; classes: Partial<Record<RetryClass, { attempts: number; tokens: number }>> }>();
  private readonly tickets = new Map<number, { turnId: string; failureClass: RetryClass; reserved: number; settled: boolean }>();
  private nextTicket = 0;
  private readonly policy: RetryPolicy;
  private readonly maxTurnTokens: number;
  constructor(policy: RetryPolicy = DEFAULT_RETRY_POLICY, maxTurnTokens = DEFAULT_RETRY_TURN_TOKENS) {
    this.policy = structuredClone(policy); this.maxTurnTokens = maxTurnTokens;
    for (const key of Object.keys(DEFAULT_RETRY_POLICY) as RetryClass[]) {
      const rule = this.policy[key];
      if (!rule || !Number.isSafeInteger(rule.maxAttempts) || rule.maxAttempts < 0 || !Number.isSafeInteger(rule.maxTokens) || rule.maxTokens < 0) throw new RangeError('invalid retry policy');
    }
    if (!Number.isSafeInteger(maxTurnTokens) || maxTurnTokens < 0) throw new RangeError('invalid turn tokens');
  }
  consume(turnId: string, failureClass: RetryClass, estimatedTokens: number): number {
    if (!turnId || !Number.isSafeInteger(estimatedTokens) || estimatedTokens < 0) throw new RangeError('invalid retry reservation');
    if (!Object.hasOwn(this.policy, failureClass)) throw new RangeError('unknown failure class');
    const rule = this.policy[failureClass];
    const turn = this.turns.get(turnId) ?? { total: 0, classes: {} };
    const prev = turn.classes[failureClass] ?? { attempts: 0, tokens: 0 };
    if (prev.attempts >= rule.maxAttempts) throw new RetryBudgetExceededError(failureClass, 'attempts');
    if (estimatedTokens > rule.maxTokens - prev.tokens || estimatedTokens > this.maxTurnTokens - turn.total) throw new RetryBudgetExceededError(failureClass, 'tokens');
    turn.classes[failureClass] = { attempts: prev.attempts + 1, tokens: prev.tokens + estimatedTokens };
    turn.total += estimatedTokens; this.turns.set(turnId, turn);
    const ticket = ++this.nextTicket;
    this.tickets.set(ticket, { turnId, failureClass, reserved: estimatedTokens, settled: false });
    return ticket;
  }
  /** Reconcile a retry's actual tokens once. Actual overages remain counted even when this throws. */
  settle(ticket: number, actualTokens: number): boolean {
    if (!Number.isSafeInteger(actualTokens) || actualTokens < 0) throw new RangeError('invalid actual retry tokens');
    const entry = this.tickets.get(ticket);
    if (!entry) throw new RangeError('unknown retry ticket');
    if (entry.settled) return false;
    const turn = this.turns.get(entry.turnId)!;
    const usage = turn.classes[entry.failureClass]!;
    const delta = actualTokens - entry.reserved;
    if (!Number.isSafeInteger(turn.total + delta) || !Number.isSafeInteger(usage.tokens + delta)) throw new RangeError('retry token overflow');
    turn.total += delta; usage.tokens += delta; entry.settled = true;
    if (turn.total > this.maxTurnTokens || usage.tokens > this.policy[entry.failureClass].maxTokens) throw new RetryBudgetExceededError(entry.failureClass, 'tokens');
    return true;
  }
  /** Host calls only when the turn ends; do not reset between retries. */
  endTurn(turnId: string): void {
    this.turns.delete(turnId);
    for (const [ticket, entry] of this.tickets) if (entry.turnId === turnId) this.tickets.delete(ticket);
  }
}
