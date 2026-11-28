import { PushDispatcher, type PushPostResult } from "../../packages/core/src/a2a/push.ts";
import { DEFAULT_LIMITS, type A2aTask } from "../../packages/core/src/a2a/types.ts";

export async function recordPush() {
  const url = "https://callbacks.example.invalid/report";
  const other = "https://receipts.example.invalid/receipt";
  const task: A2aTask = {
    kind: "task", id: "fixture-task", contextId: "fixture-context",
    status: { state: "completed", timestamp: "2026-01-01T00:00:00.000Z" },
  };
  const scenarios = [
    { name: "same-origin", results: [{ status: 307, location: "/receipt" }, { status: 204 }], denied: [] },
    { name: "changed-origin", results: [{ status: 307, location: other }, { status: 204 }], denied: [] },
    { name: "denied-hop", results: Array.from({ length: 3 }, () => ({ status: 307, location: other })), denied: [other] },
    { name: "retry-then-deliver", results: [{ status: 503 }, { status: 429 }, { status: 204 }], denied: [] },
    { name: "final-client-status", results: [{ status: 403 }], denied: [] },
  ];
  const cases = [];
  for (const scenario of scenarios) {
    const admissions: string[] = [];
    const posts: unknown[] = [];
    const waits: number[] = [];
    const deadlines: number[] = [];
    let next = 0;
    const push = new PushDispatcher({
      transport: {
        async decide(target) {
          admissions.push(target);
          const { hostname: host } = new URL(target);
          return scenario.denied.includes(target)
            ? { allowed: false, reason: "host-not-allowed", message: "fixture scope" } as const
            : { allowed: true, address: "127.0.0.1", family: 4, host, port: 443 } as const;
        },
        async post(request): Promise<PushPostResult> {
          posts.push({
            url: request.url, task: JSON.parse(request.body), authorization: request.headers.authorization !== undefined,
            token: request.headers["x-a2a-notification-token"] !== undefined,
          });
          return scenario.results[next++] ?? { status: 500 };
        },
      },
      clock: { now: () => 0 },
      scheduler: { set(run, ms) { waits.push(ms); queueMicrotask(run); return null; }, clear() {} },
      timeoutScheduler: { set(_run, ms) { deadlines.push(ms); return null; }, clear() {} },
      maxAttempts: DEFAULT_LIMITS.pushMaxAttempts,
      backoffMs: DEFAULT_LIMITS.pushBackoffMs,
    });
    push.deliver({ url, token: "fixture-only", authentication: { schemes: ["bearer"], credentials: "fixture-only" } }, task);
    await push.idle();
    if (next !== scenario.results.length) throw new Error(`Unexpected POST count for ${scenario.name}`);
    cases.push({ ...scenario, admissions, posts, waits, deadlines });
  }
  return { source: "packages/core/src/a2a/push.ts", url, task, cases };
}
