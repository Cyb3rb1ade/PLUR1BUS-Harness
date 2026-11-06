import { SecretError, type SecretBackend } from "./types.ts";
import type { BackendDescription, BackendReply, BackendRequest } from "./isolated-protocol.ts";

/** The process owns synchronous native/filesystem work and the backend's existing serialized mutation implementation. */
export function serveIsolatedBackend(create: (description: BackendDescription) => SecretBackend | Promise<SecretBackend>): void {
  let backend: Promise<SecretBackend> | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  process.on("disconnect", () => process.exit(0));
  process.on("message", (message: BackendRequest) => {
    if (!message || !Number.isSafeInteger(message.id) || !Array.isArray(message.args)) return;
    const run = async () => {
      const registrations: string[] = [];
      const reply: BackendReply = { id: message.id, registrations };
      try {
        backend ??= Promise.resolve().then(() => create(message.backend));
        const b = await backend, a = message.args;
        const register = (value: string) => registrations.push(value);
        switch (message.operation) {
          case "probe": reply.value = await b.probe(); break;
          case "get": reply.value = await b.get(a[0] as string); break;
          case "list": reply.value = await b.list(); break;
          case "put": reply.value = await b.put(a[0] as string, a[1] as string, new Date(a[2] as number), a[3] as string | undefined, a[4] as string | undefined, register); break;
          case "describe": reply.value = await b.describe(a[0] as string, a[1] as string, new Date(a[2] as number), a[3] as string | undefined, register); break;
          case "delete": reply.value = await b.delete(a[0] as string, a[1] === undefined ? undefined : new Date(a[1] as number)); break;
          case "tombstones": reply.value = await b.tombstones?.() ?? {}; break;
          case "clearTombstone": await b.clearTombstone?.(a[0] as string); break;
          default: throw new SecretError("storage", "unknown secret backend operation");
        }
      } catch (error) {
        const safe = error instanceof SecretError ? error : new SecretError("storage", "secret backend operation failed");
        reply.error = { code: safe.code, message: safe.message, detail: { ...safe.detail } };
      }
      if (process.connected) process.send?.(reply, () => { /* Parent cancellation closes the inherited channel. */ });
    };
    tail = tail.then(run, run);
  });
}
