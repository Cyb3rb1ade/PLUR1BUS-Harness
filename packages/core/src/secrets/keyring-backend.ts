import { SecretError, backendFailure, isSecretName, type BackendProbe, type SecretBackend, type SecretMeta } from "./types.ts";

/** The slice of `@napi-rs/keyring` used here. */
export interface KeyringEntry { getPassword(): string | null; setPassword(password: string): void; deletePassword?(): boolean; deleteCredential?(): boolean }
export interface KeyringModule { Entry: new (service: string, username: string) => KeyringEntry }
export type KeyringLoader = () => Promise<KeyringModule>;

const PACKAGE = "@napi-rs/keyring";
const INDEX_ACCOUNT = "__plur1bus-index__";
const PROBE_ACCOUNT = "__plur1bus-probe__";
const INDEX_SCHEMA = "plur1bus.secrets-index/1";

/** The real loader. Dynamic and by variable specifier, so a missing optional package (musl without a prebuild, a stripped
 *  install) is a probe failure and not a startup error, and no bundler resolves it. Tests never use it. */
export const defaultKeyringLoader: KeyringLoader = async () => {
  const spec: string = PACKAGE;
  const mod = (await import(spec)) as Partial<KeyringModule>;
  if (typeof mod.Entry !== "function") throw new Error("no Entry");
  return mod as KeyringModule;
};

interface Index { schema: typeof INDEX_SCHEMA; entries: Record<string, { createdAt: string; updatedAt: string }> }

/**
 * OS keychain backend (macOS Keychain, Windows Credential Manager, libsecret). The keyring cannot enumerate, so the
 * names and timestamps (never values) live in one extra entry, the index. `service` is per home, so two homes of one OS
 * user do not see each other's secrets.
 */
export function createKeyringBackend(o: { service: string; load?: KeyringLoader }): SecretBackend {
  const load = o.load ?? defaultKeyringLoader;
  let mod: KeyringModule | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T> | T): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };
  const unavailable = (): SecretError => new SecretError("backend-unavailable", "the OS keyring is not available");

  async function entry(account: string): Promise<KeyringEntry> {
    try {
      mod ??= await load();
      return new mod.Entry(o.service, account);
    } catch { mod = null; throw unavailable(); }
  }
  const guarded = async <T>(what: string, fn: () => T | Promise<T>): Promise<T> => {
    try { return await fn(); } catch (err) {
      if (err instanceof SecretError) throw err;
      throw backendFailure(err, what);
    }
  };

  async function readIndex(): Promise<Index> {
    const raw = await guarded("reading the keyring index", async () => (await entry(INDEX_ACCOUNT)).getPassword());
    if (raw === null) return { schema: INDEX_SCHEMA, entries: {} };
    let d: Partial<Index> | null;
    try { d = JSON.parse(raw) as Partial<Index>; } catch { throw new SecretError("corrupt", "keyring index is corrupt (unreadable-index); refusing to continue"); }
    if (!d || d.schema !== INDEX_SCHEMA || !d.entries || typeof d.entries !== "object") throw new SecretError("corrupt", "keyring index is corrupt (bad-schema); refusing to continue");
    for (const [n, m] of Object.entries(d.entries)) if (!isSecretName(n) || typeof m?.createdAt !== "string" || typeof m.updatedAt !== "string") throw new SecretError("corrupt", "keyring index is corrupt (bad-entry); refusing to continue");
    return d as Index;
  }
  const writeIndex = (i: Index) => guarded("writing the keyring index", async () => (await entry(INDEX_ACCOUNT)).setPassword(JSON.stringify(i)));

  return {
    kind: "keyring",
    async probe(): Promise<BackendProbe> {
      try { (await entry(PROBE_ACCOUNT)).getPassword(); return { available: true }; } catch (err) {
        return { available: false, reason: err instanceof SecretError && err.code === "backend-unavailable" ? "keyring-unavailable" : "keyring-error" };
      }
    },
    get: (name) => serial(() => guarded("reading from the keyring", async () => (await entry(name)).getPassword())),
    put: (name, value, now) => serial(async () => {
      const idx = await readIndex();
      await guarded("writing to the keyring", async () => (await entry(name)).setPassword(value));
      const at = now.toISOString();
      const createdAt = idx.entries[name]?.createdAt ?? at;
      idx.entries[name] = { createdAt, updatedAt: at };
      await writeIndex(idx);
      return { name, backend: "keyring" as const, createdAt, updatedAt: at };
    }),
    delete: (name) => serial(async () => {
      const idx = await readIndex();
      const e = await entry(name);
      const removed = await guarded("deleting from the keyring", () => (typeof e.deletePassword === "function" ? e.deletePassword() : e.deleteCredential?.() ?? false));
      const indexed = name in idx.entries;
      if (indexed) { delete idx.entries[name]; await writeIndex(idx); }
      return removed || indexed;
    }),
    list: () => serial(async (): Promise<SecretMeta[]> =>
      Object.entries((await readIndex()).entries).map(([name, m]) => ({ name, backend: "keyring" as const, ...m })).sort((a, b) => a.name.localeCompare(b.name))),
  };
}
