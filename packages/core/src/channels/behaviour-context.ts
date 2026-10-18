import { AsyncLocalStorage } from 'node:async_hooks';
import { permitsName, type EffectiveBehaviour } from './behaviour.ts';

/** Host-only turn policy; neither RPC parameters nor provider output can populate this context. */
export const channelOrigin = new AsyncLocalStorage<{ channel: string; chatId: string }>();
export const channelBehaviour = new AsyncLocalStorage<EffectiveBehaviour>();

export function permitsTool(name: string, capability: string): boolean {
  const p = channelBehaviour.getStore();
  return !p || permitsName(p.tools, name) && permitsName(p.capabilities, capability)
    && permitsName({ allow: null, deny: p.tools.deny }, capability);
}

/** The engine pin has no per-request scope mask. Suppress a call that would otherwise exceed its allowed scopes. */
export function permitsEngineMemory(): boolean {
  const p = channelBehaviour.getStore();
  return !p || ['agent-private', 'workspace', 'user'].every(scope => p.memory.allowedScopes.includes(scope as 'user'));
}

export class BehaviourRateGate {
  readonly #windows = new Map<string, { at: number; count: number }>();
  take(key: string, limit: number, now: number, windowMs = 3_600_000): boolean {
    if (limit <= 0) return false;
    let window = this.#windows.get(key);
    if (!window || now - window.at >= windowMs || now < window.at) {
      if (this.#windows.size >= 5000 && !this.#windows.has(key)) {
        for (const [k, v] of this.#windows) if (now - v.at >= windowMs) this.#windows.delete(k);
        if (this.#windows.size >= 5000) return false; // do not evict a live bucket and reset its allowance
      }
      window = { at: now, count: 0 }; this.#windows.set(key, window);
    }
    if (window.count >= limit) return false;
    window.count++; return true;
  }
}
