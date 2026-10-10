// Default adapters for model discovery ports (spec P1; plan Task 6).
import type { Clock, CredentialResolver, DiscoveryEvents, ProfileSource, Rng, TimerHandle } from "./ports.ts";
import { createLoggerEvents, type LoggerLike } from "./events-logger.ts";
import { createRealDiscoveryAdapters, type RealAdapterDeps } from "./real-adapters.ts";
import type { SCANNERS } from "./scanners/index.ts";

export const systemClock: Clock = {
  now(): number {
    return Date.now();
  },
  setTimer(fn: () => void | Promise<void>, ms: number): TimerHandle {
    const handle = setTimeout(() => {
      void fn();
    }, ms);
    handle.unref?.();
    return {
      cancel() {
        clearTimeout(handle);
      },
    };
  },
};

export const defaultRng: Rng = () => Math.random();

export interface DefaultAdaptersDeps {
  runtime: RealAdapterDeps;
  logger: LoggerLike;
}

export interface DiscoveryAdapters {
  profiles: ProfileSource;
  credentials: CredentialResolver;
  events: DiscoveryEvents;
  clock: Clock;
  rng: Rng;
  scanners?: Partial<typeof SCANNERS>;
}

export function defaultDiscoveryAdapters(deps: DefaultAdaptersDeps): DiscoveryAdapters {
  return {
    ...createRealDiscoveryAdapters(deps.runtime),
    events: createLoggerEvents(deps.logger),
    clock: systemClock,
    rng: defaultRng,
  };
}
