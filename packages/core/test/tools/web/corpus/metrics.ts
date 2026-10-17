// The quality gate's measurements (D94 "Quality gate", M2 acceptance 12): how much of a golden's main text survived
// extraction, and whether every heading and every table did. Pure functions, no I/O.
const segmenter = new Intl.Segmenter("en", { granularity: "word" });

/** Markdown syntax that is not text: fences, table rules, heading and list markers, emphasis, link and image targets. */
export function plainText(md: string): string {
  return md
    .split("\n")
    .filter((l) => !/^\s*```/.test(l) && !/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(l))
    .map((l) => l.replace(/^\s*#{1,6}\s+/, "").replace(/^\s*>\s?/g, "").replace(/^\s*(?:[-*+]|\d+\.)\s+/, ""))
    .join("\n")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[|*`~]/g, " ");
}

export function tokens(md: string): string[] {
  const out: string[] = [];
  for (const s of segmenter.segment(plainText(md).normalize("NFC").toLowerCase())) if (s.isWordLike) out.push(s.segment);
  return out;
}

const count = (xs: string[]): Map<string, number> => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
};

/** Share of the golden's tokens (as a multiset) that the output also contains. 1 for an empty golden. */
export function recall(golden: string, output: string): number {
  const g = tokens(golden);
  if (g.length === 0) return 1;
  const o = count(tokens(output));
  let kept = 0;
  for (const [t, n] of count(g)) kept += Math.min(n, o.get(t) ?? 0);
  return kept / g.length;
}

export interface Heading {
  level: number;
  text: string;
}

const inlineText = (s: string): string => plainText(s).replace(/\s+/g, " ").trim();

export function headings(md: string): Heading[] {
  const out: Heading[] = [];
  let fenced = false;
  for (const line of md.split("\n")) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const m = fenced ? null : /^(#{1,6}) +(.+?)\s*#*\s*$/.exec(line);
    if (m) out.push({ level: m[1]!.length, text: inlineText(m[2]!) });
  }
  return out;
}

/** Every golden heading, with its level, appears in the output in the same order. Returns the ones that do not. */
export function missingHeadings(golden: string, output: string): Heading[] {
  const want = headings(golden);
  const have = headings(output);
  const missing: Heading[] = [];
  let at = 0;
  for (const h of want) {
    let k = at;
    while (k < have.length && !(have[k]!.level === h.level && have[k]!.text.normalize("NFC") === h.text.normalize("NFC"))) k++;
    if (k === have.length) missing.push(h);
    else at = k + 1;
  }
  return missing;
}

export type Table = string[][];

const cells = (line: string): string[] => {
  const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "\\" && t[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (t[i] === "|") {
      out.push(cur);
      cur = "";
    } else cur += t[i];
  }
  out.push(cur);
  return out.map((c) => c.replace(/[*`~]/g, "").replace(/\s+/g, " ").trim());
};

/** Tables in a Markdown document as rows of cells; the separator row is dropped. */
export function tables(md: string): Table[] {
  const out: Table[] = [];
  let cur: Table | null = null;
  let fenced = false;
  for (const line of md.split("\n")) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (!fenced && /^\s*\|.*\|\s*$/.test(line)) {
      cur ??= [];
      if (!/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line)) cur.push(cells(line));
    } else if (cur) {
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}

const same = (a: Table, b: Table): boolean => a.length === b.length && a.every((r, i) => r.length === b[i]!.length && r.every((c, j) => c.normalize("NFC") === b[i]![j]!.normalize("NFC")));

/** Golden tables that have no identical table (same rows, same cells) in the output. */
export function missingTables(golden: string, output: string): Table[] {
  const have = tables(output);
  const used = new Set<number>();
  const missing: Table[] = [];
  for (const t of tables(golden)) {
    const k = have.findIndex((h, i) => !used.has(i) && same(t, h));
    if (k < 0) missing.push(t);
    else used.add(k);
  }
  return missing;
}

/** Link targets (the URL part of `[text](url)`) in a document. */
export function linkTargets(md: string): string[] {
  return [...md.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]!);
}
