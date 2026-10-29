/** One bounded observation sink joins provider-direct and persisted session completion paths without double counting. */
import type { TurnTelemetry } from "../session/turn-telemetry.ts";

export interface TurnObservationContext { sessionId: string; turnId: string; agentId: string }
const MAX_OBSERVED_TURNS = 4096;

/** A direct provider result and its later session completion share an identity; commands only use the latter path. */
export function createTurnObserver(sink: (telemetry: TurnTelemetry) => void):
  (telemetry: TurnTelemetry, context: TurnObservationContext) => void {
  const seen = new Set<string>();
  return (telemetry, context) => {
    const key = JSON.stringify([context.agentId, context.sessionId, context.turnId]);
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > MAX_OBSERVED_TURNS) seen.delete(seen.values().next().value!);
    sink(telemetry);
  };
}
