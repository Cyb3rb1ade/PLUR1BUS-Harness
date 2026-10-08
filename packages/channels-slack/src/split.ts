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

function breakPoint(s: string, max: number): number {
  const floor = Math.floor(max / 2);
  for (const sep of ["\n\n", "\n", " "]) {
    const i = s.lastIndexOf(sep, max - sep.length);
    if (i >= floor) return i + sep.length;
  }
  return max;
}

/** Splits mrkdwn `text` into chunks of at most `max` UTF-16 code units. Prefers paragraph, line, then word breaks;
 *  never tears a surrogate pair or an angle-bracket token; a fenced code block that spans chunks is closed at the end
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
    let cut = breakPoint(rest, room);
    const prev = rest.charCodeAt(cut - 1);
    const next = rest.charCodeAt(cut);
    if (prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) cut -= 1;
    // Never tear a <...> token: move the cut before it, or past it when it starts the chunk and fits.
    const lt = rest.lastIndexOf("<", cut - 1);
    const gt = lt >= 0 ? rest.indexOf(">", lt) : -1;
    if (lt >= 0 && gt >= cut && gt - lt < room) cut = lt > 0 ? lt : gt + 1;
    let body = rest.slice(0, cut);
    rest = rest.slice(cut);
    const inside = insideFence(body, reopen);
    if (inside) body = body.replace(/\n?$/, "") + "\n```";
    out.push(prefix + body);
    reopen = inside;
  }
  return out.filter((c) => c.trim().length > 0);
}
