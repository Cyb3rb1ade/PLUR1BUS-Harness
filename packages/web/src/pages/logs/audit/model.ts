// Read only the documented metadata. Unknown fields (especially pending detail/target) never enter the view model.
export type Actor = { user: string; host: string };
export type Note = { at: number | null; actor: Actor | null };
export type Pending = Note & { action: string; reason: string | null };
export type Health = {
  state: "ok" | "refusing"; reason: string | null; lastSeq: number | null; observedAt: number; lastVerifiedAt: number | null;
  pendingLines: number; pendingDropped: number; pending: Pending[]; lastAnchorAdvanced: Note | null; lastReanchor: Note | null;
};
export type Finding = { code: string; file: string; line: number | null; seq: number | null };
export type Boundary = { seq: number; file: string; line: number; at: number | null; suffix: string | null };
export type Era = { suffix: string; announced: boolean; files: number; records: number; lastSeq: number; intact: boolean; firstBreak: Finding | null; anchor: Anchor };
type Anchor = { status: string; seq: number | null };
export type Verification = { ok: boolean; records: number; files: number; lastSeq: number; anchor: Anchor; findingsTotal: number; findings: Finding[]; reanchors: Boundary[] | null; previousChains: Era[] | null };
const object = (x: unknown): Record<string, unknown> => { if (typeof x !== "object" || x === null || Array.isArray(x)) throw new Error("Invalid audit metadata"); return x as Record<string, unknown>; };
const count = (x: unknown): number => { if (typeof x !== "number" || !Number.isSafeInteger(x) || x < 0) throw new Error("Invalid audit count"); return x; };
const time = (x: unknown): number => { const n = count(x); if (n > 8.64e15) throw new Error("Invalid audit timestamp"); return n; };
const text = (x: unknown, max = 512): string => { if (typeof x !== "string" || [...x].length > max) throw new Error("Invalid audit text"); return x; };
const bool = (x: unknown): boolean => { if (typeof x !== "boolean") throw new Error("Invalid audit boolean"); return x; };
const nullable = <T>(x: unknown, parse: (x: unknown) => T): T | null => x === null ? null : parse(x);
const list = <T>(x: unknown, parse: (x: unknown) => T): T[] => { if (!Array.isArray(x)) throw new Error("Invalid audit list"); return x.map(parse); };
function note(x: unknown): Note { const o = object(x); return { at: nullable(o.at, time), actor: nullable(o.actor, (a) => { const v = object(a); return { user: text(v.user, 128), host: text(v.host, 128) }; }) }; }
function anchor(x: unknown): Anchor {
  const o = object(x); const status = text(o.status);
  if (!["match", "behind", "absent", "invalid", "ahead", "mismatch"].includes(status)) throw new Error("Invalid audit anchor");
  return { status, seq: nullable(o.seq, count) };
}
function finding(x: unknown): Finding { const o = object(x); return { code: text(o.code, 128), file: text(o.file), line: nullable(o.line, count), seq: nullable(o.seq, count) }; }
function suffix(x: unknown): string { const s = text(x); if (!/^pre-reanchor-[0-9]{1,16}$/.test(s)) throw new Error("Invalid audit era"); return s; }
/** Missing/older health contracts cannot be interpreted as accepting writes. */
export function parseHealth(status: unknown): Health | null {
  try {
    const o = object(object(status).audit);
    if (o.state !== "ok" && o.state !== "refusing") return null;
    return { state: o.state, reason: nullable(o.reason, (x) => text(x, 128)), lastSeq: nullable(o.lastSeq, count), observedAt: time(o.observedAt), lastVerifiedAt: nullable(o.lastVerifiedAt, time),
      pendingLines: count(o.pendingLines), pendingDropped: count(o.pendingDropped), pending: list(o.pending, (x) => { const p = object(x); return { ...note(p), action: text(p.action, 128), reason: nullable(p.reason, (r) => text(r, 128)) }; }),
      lastAnchorAdvanced: nullable(o.lastAnchorAdvanced, note), lastReanchor: nullable(o.lastReanchor, note) };
  } catch { return null; }
}
/** Reject malformed results before rendering a positive integrity label. Older cores may omit era metadata. */
export function parseVerification(value: unknown): Verification {
  const o = object(value);
  return { ok: bool(o.ok), records: count(o.records), files: count(o.files), lastSeq: count(o.lastSeq), anchor: anchor(o.anchor), findingsTotal: count(o.findingsTotal), findings: list(o.findings, finding),
    reanchors: o.reanchors === undefined ? null : list(o.reanchors, (x) => { const b = object(x); return { seq: count(b.seq), file: text(b.file), line: count(b.line), at: nullable(b.at, time), suffix: nullable(b.suffix, suffix) }; }),
    previousChains: o.previousChains === undefined ? null : list(o.previousChains, (x) => { const e = object(x); return { suffix: suffix(e.suffix), announced: bool(e.announced), files: count(e.files), records: count(e.records), lastSeq: count(e.lastSeq), intact: bool(e.intact), firstBreak: nullable(e.firstBreak, finding), anchor: anchor(e.anchor) }; }) };
}
