// Sessions overview model (pure): filtering, sorting and paging of the `session.list` metadata. Only metadata is ever handled:
// the record type has no message text, and nothing here reads any.

export type SessionMeta = {
  id: string; kind: string; agentId: string; title: string; pinned: boolean;
  createdAt: number; updatedAt: number; lastTurnAt: number | null; archivedAt: number | null; turnCount: number;
};

export type SortKey = "activity" | "created" | "title" | "turns";
export type SortDir = "asc" | "desc";
export type StatusFilter = "active" | "archived" | "all";
export type Filters = {
  text: string; agent: string; status: StatusFilter;
  /** Local `YYYY-MM-DD` bounds on the last activity, inclusive; "" = open. */
  from: string; to: string;
};
export const NO_FILTERS: Filters = { text: "", agent: "", status: "active", from: "", to: "" };
export const PAGE_SIZE = 20;

/** The moment a session was last used: its last turn, else when it was created. */
export const activityOf = (s: SessionMeta): number => s.lastTurnAt ?? s.createdAt;

function dayStart(ymd: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : null;
}

export function filtersActive(f: Filters): boolean { return f.text.trim() !== "" || f.agent !== "" || f.status !== NO_FILTERS.status || f.from !== "" || f.to !== ""; }

export function applyFilters(all: readonly SessionMeta[], f: Filters): SessionMeta[] {
  const q = f.text.trim().toLowerCase();
  const from = dayStart(f.from);
  const toStart = dayStart(f.to);
  const to = toStart === null ? null : (() => { const d = new Date(toStart); d.setDate(d.getDate() + 1); return d.getTime(); })();
  return all.filter((s) => {
    if (f.status === "active" && s.archivedAt !== null) return false;
    if (f.status === "archived" && s.archivedAt === null) return false;
    if (f.agent !== "" && s.agentId !== f.agent) return false;
    if (q !== "" && !`${s.title}\n${s.id}\n${s.agentId}`.toLowerCase().includes(q)) return false;
    const a = activityOf(s);
    if (from !== null && a < from) return false;
    if (to !== null && a >= to) return false;
    return true;
  });
}

export function sortSessions(list: readonly SessionMeta[], key: SortKey, dir: SortDir): SessionMeta[] {
  const sign = dir === "asc" ? 1 : -1;
  const val = (s: SessionMeta): number | string => (key === "activity" ? activityOf(s) : key === "created" ? s.createdAt : key === "turns" ? s.turnCount : s.title.toLowerCase());
  return [...list].sort((a, b) => {
    const x = val(a), y = val(b);
    const c = typeof x === "string" ? x.localeCompare(y as string) : (x as number) - (y as number);
    return c !== 0 ? c * sign : a.id.localeCompare(b.id);
  });
}

export type Paged<T> = { items: T[]; page: number; pages: number; from: number; to: number; total: number };

/** 1-based page, clamped into range. `from`/`to` are 1-based item numbers (0 when empty). */
export function paginate<T>(list: readonly T[], page: number, size = PAGE_SIZE): Paged<T> {
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(Math.max(1, Math.trunc(page) || 1), pages);
  const start = (p - 1) * size;
  const items = list.slice(start, start + size);
  return { items, page: p, pages, from: total === 0 ? 0 : start + 1, to: start + items.length, total };
}
