/** Email has no small message limit; bodies are capped (see EMAIL_MAX_BODY_CHARS) rather than split. */
export const EMAIL_MAX_BODY_CHARS = 200_000;

/** Generic splitter kept for API symmetry with the other channels. Lossless apart from whitespace-only chunks; prefers
 *  paragraph, line, then space boundaries in the second half of the window; never tears a surrogate pair or a code fence. */
export function splitMessage(text: string, max: number = EMAIL_MAX_BODY_CHARS): string[] {
  if (!Number.isInteger(max) || max < 2) throw new RangeError("max must be an integer >= 2");
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = breakPoint(rest, max);
    const prev = rest.charCodeAt(cut - 1);
    const next = rest.charCodeAt(cut);
    if (prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) cut -= 1;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  out.push(rest);
  return out.filter((c) => c.trim().length > 0);
}

function breakPoint(s: string, max: number): number {
  const floor = Math.floor(max / 2);
  // Prefer a break outside a fenced code block: look for the last closing fence boundary first.
  const fence = s.lastIndexOf("\n```\n", max - 5);
  if (fence >= floor && (s.slice(0, fence).match(/^```/gm)?.length ?? 0) % 2 === 1) return fence + 5;
  for (const sep of ["\n\n", "\n", " "]) {
    const i = s.lastIndexOf(sep, max - sep.length);
    if (i >= floor) return i + sep.length;
  }
  return max;
}

/** Truncates to `max` UTF-16 units without tearing a surrogate pair and appends `notice`. */
export function truncateBody(text: string, notice: string, max: number = EMAIL_MAX_BODY_CHARS): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  let cut = Math.max(0, max - notice.length - 2);
  const c = text.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut -= 1;
  return { text: `${text.slice(0, cut)}\n\n${notice}`, truncated: true };
}
