// Every secret value this process holds is registered here the moment it exists (set, rotated, revealed, leased), and
// each log/audit/report redactor that subscribed learns it before the value can reach a line. Values are only ever held
// in memory. Nothing is removed on delete or rotation: a retired value that still appears somewhere must stay masked.
import { createRedactor, type Redactor } from "../logs/redact.ts";

/** Same bound as the log writer's own set: the newest values win. */
export const MAX_REGISTERED_SECRETS = 256;
const MIN_LENGTH = 8;

export interface SecretRedaction {
  /** Registers a value (and, for an authorization header value, its bare credential). Short or non-string input is ignored. */
  register(value: string): void;
  /** `sink` receives every value registered so far and every later one. Returns the unsubscribe function. */
  subscribe(sink: (value: string) => void): () => void;
  /** A redactor that always masks the values registered at the time of each call. */
  redactor(options?: { pii?: boolean }): Redactor;
}

export function createSecretRedaction(): SecretRedaction {
  const values = new Set<string>(); const sinks = new Set<(value: string) => void>(); let version = 0;
  const add = (value: string): void => {
    if (typeof value !== "string" || value.length < MIN_LENGTH || values.has(value)) return;
    values.add(value); version++;
    if (values.size > MAX_REGISTERED_SECRETS) values.delete(values.values().next().value!);
    for (const sink of sinks) { try { sink(value); } catch { /* one failing sink must not stop the others or the caller */ } }
  };
  return {
    register(value) {
      add(value);
      const bare = typeof value === "string" ? value.replace(/^(?:Bearer|Basic)\s+/i, "") : value;
      if (bare !== value) add(bare);
    },
    subscribe(sink) {
      sinks.add(sink);
      for (const value of values) { try { sink(value); } catch { /* see above */ } }
      return () => { sinks.delete(sink); };
    },
    redactor(options = {}) {
      let seen = -1; let inner: Redactor | undefined;
      const current = (): Redactor => { if (!inner || seen !== version) { inner = createRedactor({ ...options, secrets: values }); seen = version; } return inner; };
      return { text: s => current().text(s), value: v => current().value(v) };
    },
  };
}
