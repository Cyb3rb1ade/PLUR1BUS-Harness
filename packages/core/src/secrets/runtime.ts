import { createHash } from "node:crypto";
import type { SecurePath } from "@plur1bus/module-api";
import type { Layout } from "../paths.ts";
import { createFileAuditSink } from "./audit.ts";
import { createFileBackend } from "./file-backend.ts";
import { createKeyringBackend, type KeyringEntry, type KeyringLoader, type KeyringModule } from "./keyring-backend.ts";
import { createSecretStore, type SecretStore, type SecretStoreLogger } from "./store.ts";

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
 * production cannot be switched by an environment variable alone. Absent, the real `@napi-rs/keyring` loads lazily on
 * first use: starting the core never touches the keychain.
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
}): SecretStore {
  const load = keyringLoaderFor(o.env ?? process.env);
  // One keyring service per home, so two homes of one OS user never see each other's secrets.
  const service = `plur1bus:${createHash("sha256").update(o.layout.home).digest("hex").slice(0, 16)}`;
  return createSecretStore({
    keyring: createKeyringBackend({ service, ...(load ? { load } : {}) }),
    file: createFileBackend({ dir: o.layout.secrets, secure: o.securePath }),
    fileFallback: o.fileFallback,
    audit: createFileAuditSink({ file: o.layout.logFile("audit"), secure: o.securePath, ...(o.clock ? { clock: o.clock } : {}) }),
    ...(o.clock ? { clock: o.clock } : {}),
    ...(o.logger ? { logger: o.logger } : {}),
  });
}
