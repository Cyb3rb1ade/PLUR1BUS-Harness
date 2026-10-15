// Pure matching, ranking and highlighting for the palette. No DOM, no i18n, no signals: unit-tested in test/palette-match.test.ts.
import type { RolePreset } from "../pages/common/load.ts";

export type Group = "nav" | "action" | "log" | "agent" | "session" | "setting";

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
  /** Roles that may see the entry (docs/rbac.md); absent: every role. Applied by `buildIndex`, never by `search`. */
  roles?: readonly RolePreset[];
};

export type Hit = { entry: Entry; rank: number };
export type Segment = { text: string; hit: boolean };

/** Lower-cases, strips diacritics and maps ß (and ẞ) to ss, keeping for every folded unit the index of its source character. */
export function fold(s: string): { text: string; map: number[] } {
  let text = "";
  const map: number[] = [];
  let at = 0;
  for (const ch of s) {
    const f = ch.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/ß/g, "ss");
    for (let i = 0; i < f.length; i++) map.push(at);
    text += f;
    at += ch.length;
  }
  return { text, map };
}

const words = (q: string): string[] => fold(q).text.split(/\s+/).filter((w) => w !== "");

/** Keys whose value must never be indexed or shown: a name that says key, token, secret, password (or passwd/pwd/passphrase), credential,
 * authorization, bearer, cookie, private material, a signature, jwt or hmac, or a leaf called `auth`. The same list as the Settings page
 * (pages/settings/config/model.ts `isSecretKey`), kept here because Settings imports this module and a back-import would be a cycle.
 * `auth.*` tuning keys (timeouts, capacity) are not secrets, hence the leaf-only `auth` rule. */
const SENSITIVE = /key|token|secret|passw|pwd|passphrase|credential|authori[sz]ation|bearer|cookie|private|signature|jwt|hmac|(^|[._-])auth$/i;
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE.test(key);
}

const MASK = "••••";
/** A value that is a URL may carry its secret in the text: `scheme://user:password@host` loses the user part, and a query parameter with a
 * sensitive name (`?api_key=…`) loses its value. Anything else is returned as it is. */
export function maskUrlSecrets(value: string): string {
  if (!value.includes("://") && !value.includes("?")) return value;
  return value
    .replace(/([a-z][a-z0-9+.-]{0,31}:\/\/)[^/?#\s@]*@/gi, `$1${MASK}@`)
    .replace(/([?&;])([^=&#\s]+)=([^&#\s]*)/g, (m, sep: string, name: string) => (isSensitiveKey(name) ? `${sep}${name}=${MASK}` : m));
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
 * A blank query lists navigation and actions, in index order. */
export function search(entries: readonly Entry[], query: string): Hit[] {
  const ws = words(query);
  if (ws.length === 0) return entries.filter((e) => e.group === "nav" || e.group === "action").map((entry) => ({ entry, rank: 0 }));
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
