/** B1's host-eval hook reuses the host registry/dispatcher ports; host subjects own their real provider budget/lifecycle. */
import type { HostEvalHarness, HostEvalModel } from "./host-eval.ts";
import type { CodingArm, CodingMetrics, CodingSubjectInput } from "./coding-bench-subject.ts";

/** A host adapter closes all owned requests/processes and observes the input signal through its factory closure. */
export interface CodingHostSession {
  model: HostEvalModel;
  harness: HostEvalHarness;
  /** Authoritative provider usage, including retries; unavailable counters must remain null. */
  metrics(): CodingMetrics;
}
/** Adapt a bounded host subject without changing its dispatcher or exposing private checker material. */
export function hostCodingArm(id: string, open: (input: CodingSubjectInput) => Promise<CodingHostSession>): CodingArm {
  return {
    id,
    async run(input) {
      const session = await open(input);
      let toolCalls = 0;
      let toolErrors = 0;
      try {
        input.signal.throwIfAborted();
        const calls = await session.model({
          id: `${input.taskId}-${input.seed}`,
          prompt: input.instruction,
          tools: session.harness.registry.describe(),
        });
        if (calls.length > input.budgets.rounds) return { outcome: "budget", metrics: session.metrics() };
        for (const [index, call] of calls.entries()) {
          input.signal.throwIfAborted();
          const result = await session.harness.dispatcher.call(
            { id: `coding-host-${index}`, ...call },
            { ...session.harness.context, signal: input.signal },
          );
          toolCalls++;
          if (result.isError) toolErrors++;
        }
        const metrics = { ...session.metrics(), toolCalls, toolErrors };
        return { outcome: input.signal.aborted ? "aborted" : "completed", metrics };
      } finally {
        await session.harness.close();
      }
    },
  };
}
