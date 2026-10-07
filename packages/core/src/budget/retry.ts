export type RetryClass = 'rate_limit' | 'overloaded' | 'network' | 'timeout' | 'tool_call_invalid';
export interface RetryRule { maxAttempts: number; maxCostMicros: number }
export type RetryPolicy = Record<RetryClass, RetryRule>;
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  rate_limit: { maxAttempts: 3, maxCostMicros: 100000 }, overloaded: { maxAttempts: 2, maxCostMicros: 100000 },
  network: { maxAttempts: 2, maxCostMicros: 50000 }, timeout: { maxAttempts: 1, maxCostMicros: 100000 },
  tool_call_invalid: { maxAttempts: 1, maxCostMicros: 50000 },
};
export class RetryBudgetExceededError extends Error {
  readonly code = 'retry_budget_exceeded';
  readonly failureClass: RetryClass;
  readonly reason: 'attempts' | 'cost';
  constructor(failureClass: RetryClass, reason: 'attempts' | 'cost') {
    super(`retry ${failureClass} ${reason} budget exceeded`); this.name = 'RetryBudgetExceededError'; this.failureClass = failureClass; this.reason = reason;
  }
}
/** Counts retry attempts (initial call excluded). Costs remain reserved until authoritative settlement. */
export class RetryBudget {
  private readonly turns = new Map<string, { total: number; classes: Partial<Record<RetryClass, { attempts: number; cost: number }>> }>();
  private readonly tickets = new Map<number, { turnId: string; failureClass: RetryClass; reserved: number; settled: boolean }>();
  private nextTicket = 0;
  private readonly policy: RetryPolicy;
  private readonly maxTurnCostMicros: number;
  constructor(policy: RetryPolicy = DEFAULT_RETRY_POLICY, maxTurnCostMicros = 200000) {
    this.policy = structuredClone(policy); this.maxTurnCostMicros = maxTurnCostMicros;
    for (const key of Object.keys(DEFAULT_RETRY_POLICY) as RetryClass[]) {
      const rule = this.policy[key];
      if (!rule || !Number.isSafeInteger(rule.maxAttempts) || rule.maxAttempts < 0 || !Number.isSafeInteger(rule.maxCostMicros) || rule.maxCostMicros < 0) throw new RangeError('invalid retry policy');
    }
    if (!Number.isSafeInteger(maxTurnCostMicros) || maxTurnCostMicros < 0) throw new RangeError('invalid turn cost');
  }
  consume(turnId: string, failureClass: RetryClass, estimatedCostMicros: number): number {
    if (!turnId || !Number.isSafeInteger(estimatedCostMicros) || estimatedCostMicros < 0) throw new RangeError('invalid retry reservation');
    const rule = this.policy[failureClass];
    if (!rule) throw new RangeError('unknown failure class');
    const turn = this.turns.get(turnId) ?? { total: 0, classes: {} };
    const prev = turn.classes[failureClass] ?? { attempts: 0, cost: 0 };
    if (prev.attempts >= rule.maxAttempts) throw new RetryBudgetExceededError(failureClass, 'attempts');
    if (estimatedCostMicros > rule.maxCostMicros - prev.cost || estimatedCostMicros > this.maxTurnCostMicros - turn.total) throw new RetryBudgetExceededError(failureClass, 'cost');
    turn.classes[failureClass] = { attempts: prev.attempts + 1, cost: prev.cost + estimatedCostMicros };
    turn.total += estimatedCostMicros; this.turns.set(turnId, turn);
    const ticket = ++this.nextTicket;
    this.tickets.set(ticket, { turnId, failureClass, reserved: estimatedCostMicros, settled: false });
    return ticket;
  }
  /** Reconcile a retry's actual cost once. Actual overages remain counted even when this throws. */
  settle(ticket: number, actualCostMicros: number): boolean {
    if (!Number.isSafeInteger(actualCostMicros) || actualCostMicros < 0) throw new RangeError('invalid actual retry cost');
    const entry = this.tickets.get(ticket);
    if (!entry) throw new RangeError('unknown retry ticket');
    if (entry.settled) return false;
    const turn = this.turns.get(entry.turnId)!;
    const usage = turn.classes[entry.failureClass]!;
    const delta = actualCostMicros - entry.reserved;
    if (!Number.isSafeInteger(turn.total + delta) || !Number.isSafeInteger(usage.cost + delta)) throw new RangeError('retry cost overflow');
    turn.total += delta; usage.cost += delta; entry.settled = true;
    if (turn.total > this.maxTurnCostMicros || usage.cost > this.policy[entry.failureClass].maxCostMicros) throw new RetryBudgetExceededError(entry.failureClass, 'cost');
    return true;
  }
  /** Host calls only when the turn ends; do not reset between retries. */
  endTurn(turnId: string): void {
    this.turns.delete(turnId);
    for (const [ticket, entry] of this.tickets) if (entry.turnId === turnId) this.tickets.delete(ticket);
  }
}
