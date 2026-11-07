import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Phase 4 transcript recorder (P4-02, parity mode T). One NDJSON line per frame the RPC server reads or writes:
 *  `{"seq":n,"conn":k,"dir":"in"|"out","msg":{...}}`; `conn` numbers the connections in the order they first appear. */
export interface ParityRecorder { record(connectionId: string, dir: "in" | "out", msg: unknown): void }

/** The token placeholder written in place of every `token` value under an `*.auth` request. */
export const PARITY_TOKEN_PLACEHOLDER = "<token>";

function redactTokens(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redactTokens);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "token" && typeof x === "string" ? PARITY_TOKEN_PLACEHOLDER : redactTokens(x)]));
  return v;
}

/** Test seam. Returns a recorder only with `PLUR1BUS_ALLOW_TEST_INTERNALS=1` and an explicit non-empty
 *  `PLUR1BUS_PARITY_RECORD=<file>`; otherwise null and the server does nothing. The file is truncated when the
 *  server is created. Credentials of the handshake are replaced by {@link PARITY_TOKEN_PLACEHOLDER}. */
export function parityRecorder(env: NodeJS.ProcessEnv = process.env): ParityRecorder | null {
  const file = env.PLUR1BUS_PARITY_RECORD;
  if (env.PLUR1BUS_ALLOW_TEST_INTERNALS !== "1" || !file) return null;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "");
  const conns = new Map<string, number>();
  let seq = 0;
  return {
    record(connectionId, dir, msg) {
      let conn = conns.get(connectionId);
      if (conn === undefined) { conn = conns.size; conns.set(connectionId, conn); }
      const method = (msg as { method?: unknown } | null)?.method;
      const safe = dir === "in" && typeof method === "string" && method.endsWith(".auth") ? redactTokens(msg) : msg;
      appendFileSync(file, `${JSON.stringify({ seq: ++seq, conn, dir, msg: safe })}\n`);
    },
  };
}
