// Inbox page: the caller's own entries from inbox.list, filtered by kind and unread, paged by cursor. Mark read, dismiss and
// mark all read. The data comes from inbox.list only; inbox.changed and a reconnect of /events are hints to reload the count
// (pages/inbox/count.ts), never a source for the list.
import { h } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { View } from "../../view.ts";
import { Badge, type BadgeTone } from "../../components/card.ts";
import { ConfirmDialog, type ConfirmResult } from "../../components/confirm-dialog.ts";
import { Page } from "../../components/page.ts";
import { PageLoading, PageState, type PageStateKind } from "../../components/page-state.ts";
import { catalogues, formatDateTime, lang, t, type Key } from "../../i18n.ts";
import { registerArea } from "../../i18n/index.ts";
import * as area from "../../i18n/inbox.ts";
import { failureOf, getApi } from "../common/load.ts";
import { isInboxChanged, refreshInboxCount } from "./count.ts";
import { appendPage, dismissLocal, displayParams, KIND_FILTERS, linkFor, markReadLocal, matches, usableEntries } from "./model.ts";
import { INBOX_KINDS, type InboxEntry, type InboxKind, type InboxListParams, type InboxSeverity } from "./rpc-types.ts";

import "../../styles/inbox.css";

registerArea("inbox", area);

const PAGE_SIZE = 50;
/** The most entries one `inbox.list` call may ask for, and the most ids one `inbox.markRead` call may carry (docs/inbox.md). */
const MAX_LIMIT = 200;
const MAX_IDS = 500;

const KIND_LABEL: Record<InboxKind, Key> = {
  breakglass: "inbox.kind.breakglass",
  approval: "inbox.kind.approval",
  "job-failed": "inbox.kind.jobFailed",
  update: "inbox.kind.update",
  "media-index": "inbox.kind.mediaIndex",
  pairing: "inbox.kind.pairing",
  channel: "inbox.kind.channel",
  system: "inbox.kind.system",
};

const SEVERITY: Record<InboxSeverity, { label: Key; tone: BadgeTone }> = {
  info: { label: "inbox.severity.info", tone: "info" },
  warning: { label: "inbox.severity.warning", tone: "warn" },
  critical: { label: "inbox.severity.critical", tone: "err" },
};

type Filter = { kinds: InboxKind[]; unreadOnly: boolean };
type Load = { kind: "loading" } | { kind: "ready" } | { kind: "fail"; state: PageStateKind };

const filterKey = (f: Filter): string => `${f.kinds.join(",")}|${f.unreadOnly ? "unread" : "all"}`;

function queryOf(f: Filter, cursor?: string, limit: number = PAGE_SIZE): InboxListParams {
  return {
    ...(f.kinds.length > 0 ? { kinds: f.kinds } : {}),
    ...(f.unreadOnly ? { unreadOnly: true } : {}),
    limit,
    ...(cursor !== undefined ? { cursor } : {}),
  };
}

function stateOf(e: unknown): PageStateKind {
  const kind = failureOf(e).kind;
  return kind === "forbidden" ? "forbidden" : kind === "unavailable" ? "unavailable" : "error";
}

// The client's error-code list does not know E_INBOX_CURSOR yet, so the code is read from the raw RPC error data.
const isCursorError = (e: unknown): boolean => (e as { data?: { error?: unknown } }).data?.error === "E_INBOX_CURSOR";

// The core sends `titleKey` as a plain string. A key this catalogue does not know falls back to the kind label, never to the raw key.
function known(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(catalogues[lang.value], key);
}

function titleOf(e: InboxEntry): string {
  if (!known(e.titleKey)) return t(KIND_LABEL[e.kind]);
  return t(e.titleKey as Key, displayParams(e.params, (ms) => formatDateTime(new Date(ms))));
}

export function InboxPage(): View {
  const [filter, setFilter] = useState<Filter>({ kinds: [], unreadOnly: false });
  const [items, setItems] = useState<InboxEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmShown, setConfirmShown] = useState(false);
  // Every reload and filter change starts a new generation; an answer from an older one is dropped.
  const seq = useRef(0);
  const alive = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; seq.current++; };
  }, []);

  const itemsNow = useRef(items);
  itemsNow.current = items;
  // Where the focus goes once the list has changed: a control of that entry (its last one is "Dismiss"), or the heading.
  const focusAfter = useRef<{ id: string; pick: "first" | "last" } | null>(null);
  useLayoutEffect(() => {
    const want = focusAfter.current;
    if (want === null) return;
    focusAfter.current = null;
    const buttons = document.getElementById(`inbox-title-${want.id}`)?.closest("li")?.querySelectorAll<HTMLElement>("a, button:not([disabled])");
    const target = buttons && buttons.length > 0 ? (want.pick === "first" ? buttons[0] : buttons[buttons.length - 1]) : document.querySelector<HTMLElement>("main h1");
    target?.focus();
  }, [items]);

  // `keep`: a refresh the page started itself (a hint, a reconnect). It asks for as many entries as are shown, so paging is not
  // lost, and when it fails the list stays and says so instead of giving way to an error page.
  const reload = (f: Filter, keep = false): void => {
    const mine = ++seq.current;
    const shown = keep ? itemsNow.current.length : 0;
    if (shown === 0) setLoad({ kind: "loading" });
    getApi().rpc("inbox.list", queryOf(f, undefined, Math.min(MAX_LIMIT, Math.max(PAGE_SIZE, shown))), { write: false }).then((r) => {
      if (!alive.current || mine !== seq.current) return;
      setItems(usableEntries(r?.entries));
      setCursor(typeof r?.nextCursor === "string" ? r.nextCursor : null);
      setLoad({ kind: "ready" });
    }, (e: unknown) => {
      if (!alive.current || mine !== seq.current) return;
      if (shown > 0) { setNotice(t("inbox.notice.failed")); setLoad({ kind: "ready" }); return; }
      setLoad({ kind: "fail", state: stateOf(e) });
    });
  };

  // While the page is open, /events tells it when the inbox changed (a hint: the list is asked again) and a reconnect asks again too.
  // The stream is closed when the page goes away.
  const filterNow = useRef(filter);
  filterNow.current = filter;
  useEffect(() => {
    let opened = false;
    const refreshAll = (): void => { reload(filterNow.current, true); void refreshInboxCount(); };
    const stream = getApi().events({ onEvent: (e) => { if (isInboxChanged(e)) refreshAll(); } });
    const stop = stream.status.subscribe((st) => {
      if (st !== "open") return;
      if (opened) refreshAll();
      opened = true;
    });
    return () => { stop(); stream.close(); };
  }, []);

  // The first load and every change of the filter. A change empties the list at once, so no entry of the old filter stays up.
  useEffect(() => { reload(filter); }, [filterKey(filter)]);

  const changeFilter = (next: Filter): void => {
    setItems([]);
    setFilter(next);
  };

  const more = (): void => {
    if (cursor === null || busy) return;
    const mine = seq.current;
    setBusy(true);
    getApi().rpc("inbox.list", queryOf(filter, cursor), { write: false }).then((r) => {
      if (!alive.current || mine !== seq.current) return;
      const fresh = usableEntries(r?.entries);
      const have = new Set(itemsNow.current.map((x) => x.id));
      const first = fresh.find((x) => !have.has(x.id));
      if (first) focusAfter.current = { id: first.id, pick: "first" };
      setItems((cur) => appendPage(cur, fresh));
      setCursor(typeof r?.nextCursor === "string" ? r.nextCursor : null);
    }, (e: unknown) => {
      if (!alive.current || mine !== seq.current) return;
      // The cursor is no longer valid (E_INBOX_CURSOR): start again from the top, and say so.
      if (isCursorError(e)) { setNotice(t("inbox.notice.cursor")); reload(filter); return; }
      setNotice(t("inbox.notice.failed"));
    }).finally(() => { if (alive.current) setBusy(false); });
  };

  // One write, then the local list follows it (no reload of the paged list), then the badge count is asked again.
  const write = (call: () => Promise<unknown>, after: () => void): void => {
    setNotice(null);
    call().then(() => {
      if (!alive.current) return;
      after();
      void refreshInboxCount();
    }, () => { if (alive.current) setNotice(t("inbox.notice.failed")); });
  };

  const markOne = (e: InboxEntry): void => {
    write(() => getApi().rpc("inbox.markRead", { ids: [e.id] }), () => {
      focusAfter.current = { id: e.id, pick: "last" };
      setItems((cur) => markReadLocal(cur, [e.id], Date.now()).filter((x) => matches(x, filter)));
    });
  };

  const dismiss = (e: InboxEntry): void => {
    write(() => getApi().rpc("inbox.dismiss", { ids: [e.id] }), () => {
      setItems((cur) => dismissLocal(cur, [e.id]));
      // The button that had the focus is gone: the heading takes it, as the shell does on navigation.
      document.querySelector<HTMLElement>("main h1")?.focus();
    });
  };

  // Under a kind filter "all" would reach entries the person cannot see, so only the unread entries shown are marked, after a
  // confirmation that says how many. Without a kind filter the button keeps its plain meaning: every entry.
  const filtered = filter.kinds.length > 0;
  const unreadShown = items.filter((e) => e.readAt === null).map((e) => e.id);

  const markAll = (): void => {
    if (filtered) { setConfirmShown(true); return; }
    write(() => getApi().rpc("inbox.markRead", { all: true }), () => {
      // With "only unread" every entry has left the view: ask for the (now empty) first page instead of guessing.
      if (filter.unreadOnly) reload(filter);
      else setItems((cur) => markReadLocal(cur, "all", Date.now()));
    });
  };

  const markShown = async (): Promise<ConfirmResult> => {
    const ids = unreadShown;
    try {
      for (let i = 0; i < ids.length; i += MAX_IDS) await getApi().rpc("inbox.markRead", { ids: ids.slice(i, i + MAX_IDS) });
    } catch {
      return { ok: false, message: t("inbox.notice.failed") };
    }
    if (alive.current) {
      setItems((cur) => markReadLocal(cur, ids, Date.now()).filter((x) => matches(x, filter)));
      void refreshInboxCount();
    }
    return { ok: true };
  };

  const toggleKind = (k: InboxKind): void => {
    const set = new Set(filter.kinds);
    if (set.has(k)) set.delete(k); else set.add(k);
    changeFilter({ ...filter, kinds: INBOX_KINDS.filter((x) => set.has(x)) });
  };

  const filterBar = h("div", { class: "inbox-filter" },
    h("div", { class: "inbox-chips", role: "group", "aria-label": t("inbox.filter.kinds") },
      h("button", {
        type: "button", class: "inbox-chip", "aria-pressed": String(filter.kinds.length === 0),
        onClick: () => { if (filter.kinds.length > 0) changeFilter({ ...filter, kinds: [] }); },
      }, t("inbox.filter.all")),
      KIND_FILTERS.map((k) => h("button", {
        key: k, type: "button", class: "inbox-chip", "aria-pressed": String(filter.kinds.includes(k)),
        onClick: () => { toggleKind(k); },
      }, t(KIND_LABEL[k])))),
    h("label", { class: "checkbox-label" },
      h("input", {
        type: "checkbox", checked: filter.unreadOnly,
        onChange: (e: Event) => { changeFilter({ ...filter, unreadOnly: (e.target as HTMLInputElement).checked }); },
      }),
      " ", t("inbox.filter.unreadOnly")));

  const row = (e: InboxEntry): View => {
    const read = e.readAt !== null;
    const link = linkFor(e);
    const titleId = `inbox-title-${e.id}`;
    const sev = SEVERITY[e.severity];
    return h("li", { key: e.id, class: "inbox-item", "data-read": String(read), "data-severity": e.severity },
      h("div", { class: "inbox-head" },
        h(Badge, { tone: sev.tone }, t(sev.label)),
        h("span", { class: "inbox-kind" }, t(KIND_LABEL[e.kind])),
        h("span", { class: "inbox-status" }, read ? t("inbox.status.read") : t("inbox.status.unread")),
        h("time", { class: "inbox-time", datetime: new Date(e.createdAt).toISOString() },
          t("inbox.received", { when: formatDateTime(new Date(e.createdAt)) }))),
      h("p", { class: "inbox-title", id: titleId }, titleOf(e)),
      h("div", { class: "inbox-actions" },
        link ? h("a", { class: "btn", href: link.href, "aria-describedby": titleId }, t("inbox.open")) : null,
        read ? null : h("button", {
          type: "button", class: "btn", disabled: busy, "aria-describedby": titleId,
          onClick: () => { markOne(e); },
        }, t("inbox.markRead")),
        h("button", {
          type: "button", class: "btn", disabled: busy, "aria-describedby": titleId,
          onClick: () => { dismiss(e); },
        }, t("inbox.dismiss"))));
  };

  let body: View;
  if (load.kind === "fail") {
    body = h(PageState, load.state === "error"
      ? { state: "error", detail: t("inbox.error.detail"), onRetry: () => { reload(filter); } }
      : { state: load.state, onRetry: () => { reload(filter); } });
  }
  else if (load.kind === "loading" && items.length === 0) body = h(PageLoading, { label: t("state.loading") });
  else if (items.length === 0) body = h(PageState, { state: "empty", title: t("inbox.empty.title"), detail: t("inbox.empty.detail") });
  else body = h("ul", { class: "inbox-list" }, items.map(row));

  const moreButton = cursor !== null && load.kind === "ready"
    ? h("div", { class: "inbox-more" }, h("button", { type: "button", class: "btn", disabled: busy, onClick: more }, busy ? t("inbox.loadingMore") : t("inbox.loadMore")))
    : null;

  return h(Page, {
    title: t("nav.inbox"),
    lead: t("inbox.lead"),
    actions: h("button", { type: "button", class: "btn", disabled: busy || load.kind !== "ready" || (filtered && unreadShown.length === 0), onClick: markAll }, t("inbox.markAllRead")),
  },
  filterBar,
  notice ? h("div", { class: "form-notice", role: "status", "aria-live": "polite" }, notice) : null,
  body,
  moreButton,
  confirmShown ? h(ConfirmDialog, {
    title: t("inbox.markShown.title"), confirmLabel: t("inbox.markShown.confirm"),
    onConfirm: markShown, onClose: () => { setConfirmShown(false); },
  }, h("p", {}, t("inbox.markShown.body", { count: unreadShown.length }))) : null);
}
