// Transcript format (parity mode T), normalisers and the comparison with a readable diff.
//
// A transcript is NDJSON, one line per frame: `{"seq":n,"conn":k,"dir":"in"|"out","msg":{...}}` (written by the
// recorder in `packages/module-api/src/parity-recorder.ts`). `in` is what a client sent, `out` what the core wrote.
//
// What the comparison treats as equal (the contract allows it, ADR-012 §3, ADR-016):
//  - ids: every uuid is replaced by `<id#n>`, numbered by first appearance in the canonical order, so two runs with
//    different uuids match, while a uuid used twice in one run and twice-but-differently in the other does not;
//  - times and pids: numbers under the keys in TIME_KEYS / PID_KEYS become `<time>` / `<pid>` (null stays null, so a
//    field that is null on one side and a number on the other is a difference); ISO-8601 strings become `<iso>`;
//  - order: per connection the requests are compared in order, the responses in the order of their requests, and the
//    notifications as a multiset (their relative order and their position between responses are free). `strictOrder`
//    compares the full frame sequence of each connection instead.

export interface TranscriptLine { seq: number; conn: number; dir: "in" | "out"; msg: unknown }
export interface CompareOptions { strictOrder?: boolean }
export interface CompareResult { ok: boolean; diffs: string[] }

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
/** Keys whose number is a wall-clock or elapsed time. Listed by name, never by suffix: a configured `...Ms` limit is a contract value. */
export const TIME_KEYS: ReadonlySet<string> = new Set(["since", "at", "ts", "timestamp", "createdAt", "updatedAt", "checkedAt", "observedAt", "startedAt", "finishedAt", "lastVerifiedAt", "lastAnchorAdvanced", "uptimeMs"]);
export const PID_KEYS: ReadonlySet<string> = new Set(["pid"]);

export function parseTranscript(text: string): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  text.split("\n").forEach((raw, i) => {
    if (raw.trim() === "") return;
    let v: any;
    try { v = JSON.parse(raw); } catch (e) { throw new Error(`transcript line ${i + 1}: not JSON (${(e as Error).message})`); }
    if (!v || typeof v !== "object" || !Number.isInteger(v.seq) || !Number.isInteger(v.conn) || (v.dir !== "in" && v.dir !== "out") || !("msg" in v))
      throw new Error(`transcript line ${i + 1}: expected {seq, conn, dir: "in"|"out", msg} (bad dir or fields)`);
    out.push({ seq: v.seq, conn: v.conn, dir: v.dir, msg: v.msg });
  });
  return out;
}

export function serialiseTranscript(lines: readonly TranscriptLine[]): string {
  return lines.map((l) => `${JSON.stringify({ seq: l.seq, conn: l.conn, dir: l.dir, msg: l.msg })}\n`).join("");
}

function normaliseValue(v: unknown, key: string | undefined, id: (s: string) => string): unknown {
  if (Array.isArray(v)) return v.map((x) => normaliseValue(x, undefined, id));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normaliseValue(x, k, id)]));
  if (typeof v === "number" && key !== undefined) {
    if (PID_KEYS.has(key)) return "<pid>";
    if (TIME_KEYS.has(key)) return "<time>";
  }
  if (typeof v === "string") return ISO.test(v) ? "<iso>" : v.replace(UUID, (m) => id(m.toLowerCase()));
  return v;
}

/** Normalises the values of the lines in the order given (uuids numbered by first appearance in that order). */
export function normaliseTranscript(lines: readonly TranscriptLine[]): TranscriptLine[] {
  const ids = new Map<string, string>();
  const id = (s: string) => { let n = ids.get(s); if (!n) { n = `<id#${ids.size + 1}>`; ids.set(s, n); } return n; };
  return lines.map((l) => ({ ...l, msg: normaliseValue(l.msg, undefined, id) }));
}

const anonymous = (v: unknown) => JSON.stringify(normaliseValue(v, undefined, () => "<id>"));
const msgOf = (l: TranscriptLine) => l.msg as any;
const isResponse = (l: TranscriptLine) => l.dir === "out" && msgOf(l)?.id !== undefined && msgOf(l)?.method === undefined;
const isNotification = (l: TranscriptLine) => l.dir === "out" && msgOf(l)?.method !== undefined;

/** The canonical order of one transcript: per connection, requests, then responses in request order, then notifications sorted. */
function canonical(lines: readonly TranscriptLine[], strict: boolean): TranscriptLine[] {
  const conns = [...new Set(lines.map((l) => l.conn))].sort((a, b) => a - b);
  const out: TranscriptLine[] = [];
  for (const conn of conns) {
    const mine = lines.filter((l) => l.conn === conn);
    if (strict) { out.push(...mine); continue; }
    const ins = mine.filter((l) => l.dir === "in");
    const order = new Map<unknown, number>();
    ins.forEach((l, i) => { if (!order.has(msgOf(l)?.id)) order.set(msgOf(l)?.id, i); });
    const rank = (l: TranscriptLine) => order.get(msgOf(l)?.id) ?? Number.MAX_SAFE_INTEGER;
    out.push(...ins,
      ...mine.filter(isResponse).sort((a, b) => rank(a) - rank(b) || a.seq - b.seq),
      ...mine.filter(isNotification).sort((a, b) => { const x = anonymous(a.msg), y = anonymous(b.msg); return x < y ? -1 : x > y ? 1 : 0; }),
      ...mine.filter((l) => l.dir === "out" && !isResponse(l) && !isNotification(l)));
  }
  return out;
}

const show = (v: unknown) => { const s = JSON.stringify(v); return s === undefined ? "undefined" : s.length > 160 ? `${s.slice(0, 157)}...` : s; };

function diffValues(path: string, want: unknown, got: unknown, out: string[]): void {
  if (JSON.stringify(want) === JSON.stringify(got) && typeof want !== "object") return;
  const wantObj = want && typeof want === "object", gotObj = got && typeof got === "object";
  if (wantObj && gotObj && Array.isArray(want) === Array.isArray(got)) {
    if (Array.isArray(want)) {
      const g = got as unknown[];
      for (let i = 0; i < Math.max(want.length, g.length); i++) {
        if (i >= g.length) out.push(`${path}[${i}]: missing, expected ${show(want[i])}`);
        else if (i >= want.length) out.push(`${path}[${i}]: unexpected, got ${show(g[i])}`);
        else diffValues(`${path}[${i}]`, want[i], g[i], out);
      }
      return;
    }
    const w = want as Record<string, unknown>, g = got as Record<string, unknown>;
    for (const k of Object.keys(w)) { if (!(k in g)) out.push(`${path}.${k}: missing, expected ${show(w[k])}`); else diffValues(`${path}.${k}`, w[k], g[k], out); }
    for (const k of Object.keys(g)) if (!(k in w)) out.push(`${path}.${k}: unexpected, got ${show(g[k])}`);
    return;
  }
  if (JSON.stringify(want) !== JSON.stringify(got)) out.push(`${path}: expected ${show(want)}, got ${show(got)}`);
}

export function compareTranscripts(expected: readonly TranscriptLine[], actual: readonly TranscriptLine[], opts: CompareOptions = {}): CompareResult {
  const strict = opts.strictOrder === true;
  const want = normaliseTranscript(canonical(expected, strict)), got = normaliseTranscript(canonical(actual, strict));
  const requestMethods = new Map<string, string>(); // `${conn}:${id}` -> method, from the expected side then the actual side
  for (const l of [...expected, ...actual]) if (l.dir === "in") requestMethods.set(`${l.conn}:${msgOf(l)?.id}`, String(msgOf(l)?.method));
  const label = (l: TranscriptLine): string => {
    const m = msgOf(l);
    if (l.dir === "in") return `request #${m?.id} ${m?.method}`;
    if (isNotification(l)) return `notification ${m.method}`;
    return `response to #${m?.id} ${requestMethods.get(`${l.conn}:${m?.id}`) ?? "?"}`;
  };
  const diffs: string[] = [];
  const conns = [...new Set([...want, ...got].map((l) => l.conn))].sort((a, b) => a - b);
  for (const conn of conns) {
    const w = want.filter((l) => l.conn === conn), g = got.filter((l) => l.conn === conn);
    if (strict) {
      for (let i = 0; i < Math.max(w.length, g.length); i++) {
        if (!g[i]) diffs.push(`conn ${conn}, frame ${i + 1}: expected ${label(w[i]!)}, none received`);
        else if (!w[i]) diffs.push(`conn ${conn}, frame ${i + 1}: unexpected ${label(g[i]!)}`);
        else if (w[i]!.dir !== g[i]!.dir || label(w[i]!) !== label(g[i]!)) diffs.push(`conn ${conn}, frame ${i + 1}: expected ${label(w[i]!)}, got ${label(g[i]!)}`);
        else { const d: string[] = []; diffValues("$", w[i]!.msg, g[i]!.msg, d); for (const x of d) diffs.push(`conn ${conn}, ${label(w[i]!)}: ${x}`); }
      }
      continue;
    }
    const part = (xs: TranscriptLine[], f: (l: TranscriptLine) => boolean) => xs.filter(f);
    // requests, then responses, matched by id; both sides are already in canonical order
    for (const [kind, pick] of [["request", (l: TranscriptLine) => l.dir === "in"], ["response", isResponse]] as const) {
      const ws = part(w, pick), gs = part(g, pick);
      const byId = new Map(gs.map((l) => [String(msgOf(l)?.id), l]));
      const used = new Set<TranscriptLine>();
      for (const wl of ws) {
        const gl = byId.get(String(msgOf(wl)?.id));
        if (!gl) { diffs.push(kind === "request" ? `conn ${conn}, ${label(wl)}: expected a request, none sent` : `conn ${conn}, ${label(wl)}: expected a response, none received`); continue; }
        used.add(gl);
        const d: string[] = []; diffValues("$", msgOf(wl) && (kind === "request" ? { method: msgOf(wl).method, params: msgOf(wl).params } : { result: msgOf(wl).result, error: msgOf(wl).error }),
          kind === "request" ? { method: msgOf(gl).method, params: msgOf(gl).params } : { result: msgOf(gl).result, error: msgOf(gl).error }, d);
        for (const x of d) diffs.push(`conn ${conn}, ${label(wl)}: ${x}`);
      }
      for (const gl of gs) if (!used.has(gl)) diffs.push(`conn ${conn}: unexpected ${label(gl)}`);
    }
    // notifications as a multiset
    const left = part(g, isNotification).map((l) => ({ l, key: JSON.stringify(l.msg) }));
    for (const wl of part(w, isNotification)) {
      const key = JSON.stringify(wl.msg), at = left.findIndex((x) => x.key === key);
      if (at >= 0) { left.splice(at, 1); continue; }
      const near = left.findIndex((x) => msgOf(x.l).method === msgOf(wl).method);
      if (near >= 0) {
        const d: string[] = []; diffValues("$", msgOf(wl).params, msgOf(left[near]!.l).params, d); left.splice(near, 1);
        for (const x of d) diffs.push(`conn ${conn}, notification ${msgOf(wl).method}: ${x.replace(/^\$/, "$.params")}`);
      } else diffs.push(`conn ${conn}: expected notification ${msgOf(wl).method} ${show(msgOf(wl).params)}, none received`);
    }
    for (const x of left) diffs.push(`conn ${conn}: unexpected notification ${msgOf(x.l).method} ${show(msgOf(x.l).params)}`);
  }
  return { ok: diffs.length === 0, diffs };
}
