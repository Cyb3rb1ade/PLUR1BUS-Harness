// Pure matching, ranking and highlighting for the palette. No DOM, no i18n, no signals: unit-tested in test/palette-match.test.ts.

export type Group = "nav" | "setting";

export type Entry = {
  /** Unique and stable. */
  id: string;
  group: Group;
  /** Shown, in the current language. */
  label: string;
  /** Everything the label can be searched as (both languages for navigation); includes `label`. */
  labels: readonly string[];
  /** Config key, or route path for navigation. */
  key: string;
  help?: string;
  /** Current non-sensitive value, as text. Never set for a sensitive key (see `isSensitiveKey`). */
  value?: string;
  /** Second line for navigation entries (the sidebar group). */
  meta?: string;
  /** Route to open, with query for settings (`/settings/<section>?focus=<key>`). */
  to: string;
};

export type Hit = { entry: Entry; rank: number };
export type Segment = { text: string; hit: boolean };

/** Lower-cases, strips diacritics and maps ß to ss, keeping for every folded unit the index of its source character. */
export function fold(s: string): { text: string; map: number[] } {
  let text = "";
  const map: number[] = [];
  let at = 0;
  for (const ch of s) {
    const f = (ch === "ß" ? "ss" : ch.normalize("NFD").replace(/\p{M}/gu, "")).toLowerCase();
    for (let i = 0; i < f.length; i++) map.push(at);
    text += f;
    at += ch.length;
  }
  return { text, map };
}

const words = (q: string): string[] => fold(q).text.split(/\s+/).filter((w) => w !== "");

/** Keys whose value must never be indexed or shown: any segment naming a key, token, secret, password or credential. */
export function isSensitiveKey(key: string): boolean {
  return /key|token|secret|password|credential/i.test(key);
}

// Field classes, best first: label starts with the word, label contains it, key, help, value.
const LABEL_PREFIX = 0, LABEL_PART = 1, KEY = 2, HELP = 3, VALUE = 4;

function classOf(word: string, folded: { labels: string[]; key: string; help: string; value: string }): number {
  if (folded.labels.some((l) => l.startsWith(word))) return LABEL_PREFIX;
  if (folded.labels.some((l) => l.includes(word))) return LABEL_PART;
  if (folded.key.includes(word)) return KEY;
  if (folded.help.includes(word)) return HELP;
  if (folded.value.includes(word)) return VALUE;
  return -1;
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Entries matching every word of the query (AND, any field), best first. Rank: the weakest word's field class, then the sum
 * of the classes, then the folded label and the id, so the order is total and independent of the input order.
 * A blank query lists the navigation only, in index order. */
export function search(entries: readonly Entry[], query: string): Hit[] {
  const ws = words(query);
  if (ws.length === 0) return entries.filter((e) => e.group === "nav").map((entry) => ({ entry, rank: 0 }));
  const scored: { entry: Entry; worst: number; sum: number; label: string }[] = [];
  for (const entry of entries) {
    const folded = {
      labels: entry.labels.map((l) => fold(l).text), key: fold(entry.key).text,
      help: fold(entry.help ?? "").text, value: fold(entry.value ?? "").text,
    };
    let worst = 0, sum = 0, ok = true;
    for (const w of ws) {
      const c = classOf(w, folded);
      if (c < 0) { ok = false; break; }
      worst = Math.max(worst, c); sum += c;
    }
    if (ok) scored.push({ entry, worst, sum, label: fold(entry.label).text });
  }
  scored.sort((a, b) => a.worst - b.worst || a.sum - b.sum || byCodeUnit(a.label, b.label) || byCodeUnit(a.entry.id, b.entry.id));
  return scored.map((s, i) => ({ entry: s.entry, rank: i }));
}

/** Splits `text` into plain and matching parts (every occurrence of every word, overlaps merged) for rendering as text nodes. */
export function highlight(text: string, query: string): Segment[] {
  const ws = words(query);
  if (ws.length === 0 || text === "") return [{ text, hit: false }];
  const { text: f, map } = fold(text);
  const ranges: [number, number][] = [];
  for (const w of ws) for (let i = f.indexOf(w); i >= 0; i = f.indexOf(w, i + 1)) ranges.push([i, i + w.length]);
  if (ranges.length === 0) return [{ text, hit: false }];
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  const out: Segment[] = [];
  let pos = 0;
  for (const [a, b] of merged) {
    const start = map[a] ?? 0;
    const lastAt = map[b - 1] ?? text.length - 1;
    const end = lastAt + ((text.codePointAt(lastAt) ?? 0) > 0xffff ? 2 : 1);
    if (start > pos) out.push({ text: text.slice(pos, start), hit: false });
    if (end > Math.max(start, pos)) out.push({ text: text.slice(Math.max(start, pos), end), hit: true });
    pos = Math.max(pos, end);
  }
  if (pos < text.length) out.push({ text: text.slice(pos), hit: false });
  return out;
}
