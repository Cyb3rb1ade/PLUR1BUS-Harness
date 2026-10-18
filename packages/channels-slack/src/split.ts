/** Safe text size. Slack truncates `text` above 4000 characters and section blocks at 3000; we split earlier. */
export const SLACK_MAX_TEXT = 3500;
/** Section-block text limit is 3000 characters; used for approval prompt bodies. */
export const SLACK_SECTION_MAX = 2900;

const FENCE_LINE = /^```/;

function insideFence(chunk: string, startInside: boolean): boolean {
  let inside = startInside;
  for (const line of chunk.split("\n")) if (FENCE_LINE.test(line)) inside = !inside;
  return inside;
}

function breakPoint(s: string, max: number, extend: number): number {
  const floor = Math.floor(max / 2);
  for (const sep of ["\n\n", "\n", " "]) {
    const i = s.lastIndexOf(sep, max - sep.length);
    if (i >= floor) return graphemeCut(s, i + sep.length, extend);
  }
  return graphemeCut(s, max, extend);
}

const GRAPHEMES = new Intl.Segmenter("en", { granularity: "grapheme" });
const LOOKAHEAD = 64;

/** Moves `cut` back to the nearest extended grapheme cluster boundary at or before it (ZWJ sequences, flags, keycaps,
 *  combining marks, CRLF stay whole). When one cluster spans the whole window, the cut moves forward to the end of that
 *  cluster if it ends at or before `extend`; otherwise the cut stays (it still never tears a surrogate pair). */
function graphemeCut(s: string, cut: number, extend: number): number {
  if (cut >= s.length) return cut;
  let best = 0;
  let end = -1;
  for (const seg of GRAPHEMES.segment(s.slice(0, Math.max(cut, extend) + LOOKAHEAD))) {
    if (seg.index > cut) {
      end = seg.index;
      break;
    }
    best = seg.index;
  }
  if (best > 0 || end < 0) return best > 0 ? best : cut;
  return end <= extend ? end : cut;
}

/** Splits mrkdwn `text` into chunks of at most `max` UTF-16 code units. Prefers paragraph, line, then word breaks;
 *  never tears a grapheme cluster, surrogate pair or angle-bracket token; a fenced code block that spans chunks is closed at the end
 *  of one chunk and reopened at the start of the next. Whitespace-only chunks are dropped. */
export function splitMessage(text: string, max: number = SLACK_MAX_TEXT): string[] {
  if (!Number.isInteger(max) || max < 16) throw new RangeError("max must be an integer >= 16");
  const out: string[] = [];
  let rest = text;
  let reopen = false;
  for (;;) {
    const prefix = reopen ? "```\n" : "";
    if (prefix.length + rest.length <= max) {
      out.push(prefix + rest);
      break;
    }
    const room = max - prefix.length - 4; // 4 = room for the closing "\n```"
    // A cluster wider than the room may use the closer's room, but only when no fence is open at the cut (no closer needed).
    const choose = (extend: number): { cut: number; body: string; inside: boolean } => {
      let cut = breakPoint(rest, room, extend);
      const prev = rest.charCodeAt(cut - 1);
      const next = rest.charCodeAt(cut);
      if (prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) cut -= 1;
      // Never tear a <...> token: move the cut before it, or past it when it starts the chunk and fits.
      const lt = rest.lastIndexOf("<", cut - 1);
      const gt = lt >= 0 ? rest.indexOf(">", lt) : -1;
      if (lt >= 0 && gt >= cut && gt - lt < room) cut = lt > 0 ? lt : gt + 1;
      const body = rest.slice(0, cut);
      return { cut, body, inside: insideFence(body, reopen) };
    };
    let pick = choose(max - prefix.length);
    if (pick.inside && pick.cut > room) pick = choose(room);
    const { cut, inside } = pick;
    let body = pick.body;
    rest = rest.slice(cut);
    if (inside) body = body.replace(/\n?$/, "") + "\n```";
    out.push(prefix + body);
    reopen = inside;
  }
  return out.filter((c) => c.trim().length > 0);
}
