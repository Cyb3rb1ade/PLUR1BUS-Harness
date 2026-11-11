// Replays a recorded transcript against a running core through its socket and returns what happened, as a transcript.
import { PARITY_TOKEN_PLACEHOLDER } from "../../packages/module-api/src/parity-recorder.ts";
import { rawConnect, type RawConnection } from "./raw-client.ts";
import type { TranscriptLine } from "./transcript.ts";

export interface ReplayOptions {
  address: string;
  /** Substituted for every `<token>` placeholder (the recorder never writes the real credential). */
  token: string;
  /** Wait for a response, per request (default 10 s). */
  responseTimeoutMs?: number;
  /** How long frames may keep arriving after the last expected one, to catch unexpected extras (default 200 ms). */
  settleMs?: number;
  /** How long to wait for the notifications the transcript expects after the last request (default 3 s). */
  notificationTimeoutMs?: number;
}

const withToken = (v: unknown, token: string): unknown => {
  if (v === PARITY_TOKEN_PLACEHOLDER) return token;
  if (Array.isArray(v)) return v.map((x) => withToken(x, token));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, withToken(x, token)]));
  return v;
};

/** Sends the `in` lines in order, one request at a time on their recorded connections (a request that the transcript
 *  answers waits for its response before the next is sent), and collects every frame the core writes back. */
export async function replayTranscript(expected: readonly TranscriptLine[], o: ReplayOptions): Promise<TranscriptLine[]> {
  const responseTimeoutMs = o.responseTimeoutMs ?? 10_000, settleMs = o.settleMs ?? 200, notificationTimeoutMs = o.notificationTimeoutMs ?? 3000;
  const ins = expected.filter((l) => l.dir === "in").sort((a, b) => a.seq - b.seq);
  const answered = new Set(expected.filter((l) => l.dir === "out" && (l.msg as any)?.method === undefined).map((l) => `${l.conn}:${(l.msg as any)?.id}`));
  const conns = new Map<number, RawConnection>();
  const drained = new Map<number, number>();
  const actual: TranscriptLine[] = [];
  let seq = 0;
  const drain = () => {
    for (const [conn, c] of [...conns].sort((a, b) => a[0] - b[0])) {
      const from = drained.get(conn) ?? 0;
      for (const msg of c.received.slice(from)) actual.push({ seq: ++seq, conn, dir: "out", msg });
      drained.set(conn, c.received.length);
    }
  };
  try {
    for (const line of ins) {
      let c = conns.get(line.conn);
      if (!c) { c = await rawConnect(o.address); conns.set(line.conn, c); }
      const id = (line.msg as any)?.id;
      actual.push({ seq: ++seq, conn: line.conn, dir: "in", msg: line.msg });
      c.send(withToken(line.msg, o.token));
      if (id !== undefined && answered.has(`${line.conn}:${id}`)) {
        try { await c.waitFor((f) => f.id === id && f.method === undefined, `the response to #${id} ${(line.msg as any)?.method}`, responseTimeoutMs); } catch { /* the comparison reports the missing response */ }
      }
      drain();
    }
    const expectedOut = (conn: number) => expected.filter((l) => l.conn === conn && l.dir === "out").length;
    for (const [conn, c] of conns) await c.waitForCount(expectedOut(conn), notificationTimeoutMs);
    await new Promise((r) => setTimeout(r, settleMs));
    drain();
  } finally {
    await Promise.all([...conns.values()].map((c) => c.close().catch(() => {})));
  }
  return actual;
}
