// Pure helpers of the Help page (no CSS import, so tests can load them without a bundler).

/** `#/help/operations#directories` reaches the page as sub "operations#directories": slug and anchor are separate. */
export function splitSub(sub: string | undefined): { slug: string; anchor: string } {
  const raw = sub ?? "";
  const at = raw.indexOf("#");
  const part = (s: string): string => { try { return decodeURIComponent(s); } catch { return s; } };
  return at < 0 ? { slug: part(raw), anchor: "" } : { slug: part(raw.slice(0, at)), anchor: part(raw.slice(at + 1)) };
}

type Entry = { slug: string; title: string };

export type DocLang = "de" | "en";

/** `#/help/de/wiederkehrende-aufgaben` pins a page to one language's handbook, whatever the UI language is. This is how the
 *  "German/English version of this page" links work: the two versions often have different slugs, and some have the same one
 *  (`breakglass`), so a bare slug cannot name the other language. No prefix: the UI language decides (see `pickDoc`). */
export function splitDocLang(slug: string): { lang: DocLang | null; slug: string } {
  const m = /^(de|en)\/(.+)$/.exec(slug);
  return m?.[1] && m[2] ? { lang: m[1] as DocLang, slug: m[2] } : { lang: null, slug };
}

/** Which handbook page to show: the requested slug in the UI language; when that language has no such page, the English one
 *  (German pages carry German file names, so `#/help/approvals` in a German UI is the English page); otherwise the first page. */
export function pickDoc(slug: string, index: readonly Entry[], fallback: readonly Entry[]): { slug: string; useFallback: boolean } | null {
  if (slug === "") return index[0] ? { slug: index[0].slug, useFallback: false } : null;
  if (index.some((e) => e.slug === slug)) return { slug, useFallback: false };
  if (fallback.some((e) => e.slug === slug)) return { slug, useFallback: true };
  return null;
}

/** Table-of-contents filter: case-insensitive substring over title and slug; plain text, so regex characters and
 *  oversized input are harmless. */
export function filterIndex<T extends Entry>(index: readonly T[], query: string): readonly T[] {
  const q = query.trim().toLowerCase();
  if (q === "") return index;
  return index.filter((e) => e.title.toLowerCase().includes(q) || e.slug.toLowerCase().includes(q));
}
