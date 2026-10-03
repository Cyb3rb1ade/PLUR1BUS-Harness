// Default adapters for model discovery ports (spec P1; plan Task 6).
import type { Clock, CredentialLease, CredentialResolver, DiscoveryEvents, ProfileInfo, ProfileSource, Rng, TimerHandle } from "./ports.ts";
import { createLoggerEvents, type LoggerLike } from "./events-logger.ts";

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

export class EmptyProfileSource implements ProfileSource {
  list(): readonly ProfileInfo[] {
    return [];
  }
}

export class NoCredentialResolver implements CredentialResolver {
  async resolve(_profileId: string, _origin: string): Promise<CredentialLease | null> {
    return null;
  }
}

export const defaultRng: Rng = () => Math.random();

export interface DefaultAdaptersDeps {
  logger: LoggerLike;
}

import type { SCANNERS } from "./scanners/index.ts";

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
    profiles: new EmptyProfileSource(),
    credentials: new NoCredentialResolver(),
    events: createLoggerEvents(deps.logger),
    clock: systemClock,
    rng: defaultRng,
  };
}
