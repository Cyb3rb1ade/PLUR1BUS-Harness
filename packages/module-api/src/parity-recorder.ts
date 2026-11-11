import { mkdirSync, openSync, writeSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

/** Phase 4 transcript recorder (P4-02, parity mode T). One NDJSON line per frame the RPC server reads or writes:
 *  `{"seq":n,"conn":k,"dir":"in"|"out","msg":{...}}`; `conn` numbers the connections in the order they first appear.
 *  A test seam, never a product feature. `file` is the path this instance writes to. */
export interface ParityRecorder { readonly file: string; record(connectionId: string, dir: "in" | "out", msg: unknown): void }

/** The token placeholder written in place of the `token` value of an `*.auth` request (the replayer puts the live one back). */
export const PARITY_TOKEN_PLACEHOLDER = "<token>";
/** The placeholder for every other value under a secret-looking key, in any frame and direction. */
export const PARITY_SECRET_PLACEHOLDER = "[REDACTED:secret]";

/** Keys whose values never reach a transcript (transcripts are committed). Matched on the key name at any depth. */
export const PARITY_SECRET_KEY = /token|secret|password|passphrase|api[-_]?key|authorization|cookie|ticket|credential|private[-_]?key|pin$/i;

const isSecretName = (v: unknown): boolean => typeof v === "string" && PARITY_SECRET_KEY.test(v);

/** Recursively replaces every value under a secret-looking key. `null` and `undefined` stay (they carry no secret).
 *  A `{key|name: "<secret-looking name>", value}` pair (a `config.set` change such as `providers.x.apiKey`) loses its `value` too. */
export function redactSecrets(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redactSecrets);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const named = isSecretName(o.key) || isSecretName(o.name);
    // A dotted key whose value is an object is a method-name map entry (`"secret.set": {stability, since}` in the
    // capabilities), not a credential: recurse, so any secret inside is still caught by its own key.
    const hide = (k: string, x: unknown): boolean => x !== null && x !== undefined && (PARITY_SECRET_KEY.test(k) || (named && k === "value")) && !(k.includes(".") && typeof x === "object");
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, hide(k, x) ? PARITY_SECRET_PLACEHOLDER : redactSecrets(x)]));
  }
  return v;
}

function redactFrame(dir: "in" | "out", msg: unknown): unknown {
  const safe = redactSecrets(msg) as { params?: Record<string, unknown> };
  const orig = msg as { method?: unknown; params?: { token?: unknown } } | null;
  // `secret.*` calls carry the secret under the neutral key `value`.
  if (dir === "in" && typeof orig?.method === "string" && orig.method.startsWith("secret.") && safe.params && "value" in safe.params) safe.params.value = PARITY_SECRET_PLACEHOLDER;
  if (dir === "in" && typeof orig?.method === "string" && orig.method.endsWith(".auth") && typeof orig.params?.token === "string" && safe.params) {
    safe.params.token = PARITY_TOKEN_PLACEHOLDER;
  }
  return safe;
}

/** Picks and creates the file of one recorder. Never truncates: the first instance gets exactly `file` when it
 *  does not exist; any other (a second server, another process, an earlier run) writes a sibling
 *  `<stem>.<server>-<pid>-<n><ext>`, so concurrent recorders cannot clobber each other. Callers that re-record
 *  delete the file first. */
function openExclusive(file: string, server: string): { fd: number; path: string } {
  mkdirSync(dirname(file), { recursive: true });
  const ext = extname(file);
  const stem = join(dirname(file), basename(file, ext));
  for (let n = 0; ; n++) {
    const path = n === 0 ? file : `${stem}.${server}-${process.pid}-${n}${ext}`;
    try { return { fd: openSync(path, "wx"), path }; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  }
}

/** Test seam. Returns a recorder only with `PLUR1BUS_ALLOW_TEST_INTERNALS=1` and an explicit non-empty
 *  `PLUR1BUS_PARITY_RECORD=<file>`; otherwise null and the server does nothing. Secrets are replaced
 *  ({@link redactSecrets}); the handshake token becomes {@link PARITY_TOKEN_PLACEHOLDER}. The descriptor stays open
 *  for the life of the process. */
export function parityRecorder(env: NodeJS.ProcessEnv = process.env, server = "core"): ParityRecorder | null {
  const requested = env.PLUR1BUS_PARITY_RECORD;
  if (env.PLUR1BUS_ALLOW_TEST_INTERNALS !== "1" || !requested) return null;
  const { fd, path } = openExclusive(requested, server);
  const conns = new Map<string, number>();
  let seq = 0;
  return {
    file: path,
    record(connectionId, dir, msg) {
      let conn = conns.get(connectionId);
      if (conn === undefined) { conn = conns.size; conns.set(connectionId, conn); }
      writeSync(fd, `${JSON.stringify({ seq: ++seq, conn, dir, msg: redactFrame(dir, msg) })}\n`);
    },
  };
}
