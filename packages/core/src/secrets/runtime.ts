import { createHash } from "node:crypto";
import type { SecurePath } from "@plur1bus/module-api";
import type { Layout } from "../paths.ts";
import { createFileAuditSink } from "./audit.ts";
import { createKeyringBackend, type KeyringEntry, type KeyringLoader, type KeyringModule } from "./keyring-backend.ts";
import { createSecretStore, type SecretStore, type SecretStoreLogger } from "./store.ts";
import { createSecretRedaction, type SecretRedaction } from "./redaction.ts";
import { createIsolatedBackend, SECRET_IO_BUDGET_MS, type IsolatedBackendOptions } from "./isolated-backend.ts";
import type { SecretBackend } from "./types.ts";

/** An in-process stand-in for the OS keyring, selected only by the test seam below. */
function memoryKeyringModule(): KeyringModule {
  const items = new Map<string, string>();
  class Entry implements KeyringEntry {
    key: string;
    constructor(service: string, user: string) { this.key = `${service}\u0000${user}`; }
    getPassword() { return items.get(this.key) ?? null; }
    setPassword(p: string) { items.set(this.key, p); }
    deletePassword() { return items.delete(this.key); }
  }
  return { Entry };
}

/**
 * Test seam (ruling R5): `PLUR1BUS_SECRETS_KEYRING=off` makes the keyring unavailable, `=memory` replaces it with an
 * in-process one. Honoured only with `PLUR1BUS_ALLOW_TEST_INTERNALS=1`, so no test run can reach a real keychain and
 * production cannot be switched by an environment variable alone. Absent, the real `@napi-rs/keyring` loads on first
 * use, including Core's startup redaction preload. Constructing the store alone does not touch the keychain.
 */
export function keyringLoaderFor(env: NodeJS.ProcessEnv): KeyringLoader | undefined {
  const mode = env.PLUR1BUS_SECRETS_KEYRING;
  if (mode === undefined) return undefined;
  if (env.PLUR1BUS_ALLOW_TEST_INTERNALS !== "1") throw new Error("PLUR1BUS_SECRETS_KEYRING requires PLUR1BUS_ALLOW_TEST_INTERNALS=1");
  if (mode === "off") return async () => { throw new Error("keyring switched off for the test"); };
  if (mode === "memory") { const m = memoryKeyringModule(); return async () => m; }
  throw new Error(`unknown PLUR1BUS_SECRETS_KEYRING ${mode}`);
}

export function createCoreSecretStore(o: {
  layout: Layout; securePath: SecurePath; fileFallback: () => boolean; clock?: () => number; logger?: SecretStoreLogger; env?: NodeJS.ProcessEnv;
  redaction?: SecretRedaction;
  /** Trusted process/clock test ports; never selected through RPC, configuration or an environment module path. */
  isolation?: Pick<IsolatedBackendOptions, "budgetMs" | "spawn"> & { retryAfterMs?: number };
  /** Injected backends keep arbitrary loader/securePath closures inside test code. Production always isolates persistent I/O. */
  backends?: { keyring?: SecretBackend; file?: SecretBackend };
}): SecretStore {
  const load = keyringLoaderFor(o.env ?? process.env);
  // One keyring service per home, so two homes of one OS user never see each other's secrets.
  const service = `plur1bus:${createHash("sha256").update(o.layout.home).digest("hex").slice(0, 16)}`;
  const redaction = o.redaction ?? createSecretRedaction();
  const audit = createFileAuditSink({ file: o.layout.logFile("audit"), secure: o.securePath,
    redactor: redaction.redactor(), ...(o.clock ? { clock: o.clock } : {}) });
  let store: SecretStore | undefined;
  const io = { ...o.isolation, onUnavailable: () => store?.backendUnavailable() };
  const keyring = !o.backends?.keyring && !load ? createIsolatedBackend({ kind: "keyring", service }, io) : undefined;
  const file = !o.backends?.file ? createIsolatedBackend({ kind: "file", dir: o.layout.secrets }, io) : undefined;
  store = createSecretStore({
    keyring: o.backends?.keyring ?? keyring?.backend ?? createKeyringBackend({ service, load: load! }),
    file: o.backends?.file ?? file!.backend,
    fileFallback: o.fileFallback,
    audit,
    redaction,
    startup: { budgetMs: o.isolation?.budgetMs ?? SECRET_IO_BUDGET_MS,
      ...(o.isolation?.retryAfterMs !== undefined ? { retryAfterMs: o.isolation.retryAfterMs } : {}),
      cancel() { keyring?.cancel(); file?.cancel(); },
      async close() { await Promise.all([keyring?.close(), file?.close()]); } },
    ...(o.clock ? { clock: o.clock } : {}),
    ...(o.logger ? { logger: o.logger } : {}),
  });
  return store;
}
