# Inbox

One place for everything the harness wants to tell a person: a Break-Glass window opened on their data, an approval
waiting for them, a failed recurring job, a media index that finished or failed, a pairing waiting for confirmation, a
channel that cannot start. This is the backend (store, RPC, events, CLI). The web page is follow-up work
(docs/web-ui.md F29).

## What an entry is

Metadata only. No secrets, no message content, no free text typed by another person.

| Field | Meaning |
|---|---|
| `id` | Opaque id. |
| `kind` | Closed set: `breakglass`, `approval`, `job-failed`, `update`, `media-index`, `pairing`, `channel`, `system`. |
| `severity` | `info`, `warning`, `critical`. |
| `titleKey`, `params` | i18n key and short scalar parameters (at most 16, strings up to 200 characters). The client translates. |
| `ref` | Where to go: `route` (an app route such as `/approvals`) and `objectId`. May be `null`. |
| `createdAt`, `readAt`, `dismissedAt` | Milliseconds; `null` while unread or not dismissed. |

Entries are stored per person in `state/inbox.sqlite` (mode 0600). Each write is one statement or one
`BEGIN IMMEDIATE` transaction, so a crash leaves the old or the new state, never half of a batch.

## Retention

Per person, the newest 1000 entries and nothing older than 90 days are kept. Both limits are applied whenever that
person gets a new entry. Configure `inbox.retention.days` (default 90, range 1–3650) and
`inbox.retention.maxEntries` (default 1000, range 10–100000). Both are advanced settings and require a core restart.
`CoreOptions.inbox.maxAgeDays` / `maxEntries` remain per-field overrides for tests. A dismissed entry stays in the
table until it ages out, so a repeated event cannot bring it back.

## Who gets what

| Kind | Source | Recipient | Entry per |
|---|---|---|---|
| `breakglass` | A Break-Glass grant (F41) | The affected person | grant |
| `approval` | `approval.requested`; `approval.resolved` closes it | The approving person | approval |
| `pairing` | A claimed pairing waiting for confirmation; confirm, decline or revoke closes it | The human the pairing belongs to | pairing |
| `job-failed` | A system job run recorded as `failed` | Every Owner and Admin | run |
| `media-index` | `media.index.failed`; a finished backfill | Every Owner and Admin | media object / index fingerprint |
| `channel` | The switchboard parks a channel as `misconfigured` | Every Owner and Admin | channel |
| `update` | Reserved. The core has no update offer yet; the CLI updater is not a core module. | | |
| `system` | Reserved for core-level notices. | | |

"Every Owner and Admin" is resolved when the entry is written. A person who becomes Admin later does not get old entries.

Every producer calls an `InboxPort` (`publish`, `settle`). The call is synchronous and never throws: a failing inbox is
logged and the source module carries on unchanged. Each entry has a dedupe key (`kind:objectId`), so a repeated event
for the same person produces no second entry.

### Break-Glass

`admin_notices` stays the fail-closed record: a grant is only made once its durable notice was written, and
`breakglass.notices` keeps reading it. The inbox copy is written next to it, with the grant id, the holder and the
expiry, but not the reason text. On every start, notices that are not in the inbox yet are copied over (keyed by grant
id), so nothing told before the inbox existed is lost. Copied entries are dated with the start that copied them.

## RPC

All four methods are `experimental` since 1.6.0 and work on the caller's own inbox only. No parameter names a person.

| Method | Params | Result |
|---|---|---|
| `inbox.list` | `kinds`, `unreadOnly`, `includeDismissed`, `limit` (1-200, default 50), `cursor` | `{ entries, nextCursor }` |
| `inbox.count` | none | `{ unread: { <kind>: n }, total }`; every kind is present, dismissed entries are not counted |
| `inbox.markRead` | exactly one of `ids` (1-500) or `all: true` | `{ changed }` |
| `inbox.dismiss` | `ids` (1-500) | `{ changed }` |

Entries come newest first. `nextCursor` is opaque; a cursor that is not valid fails with `E_INBOX_CURSOR`. Paging is
stable while entries arrive: new entries never shift an open page.

### Access

`inbox.read` (list, count) and `inbox.write` (markRead, dismiss) are granted to all five roles and are human-only: an
agent principal is always refused, and `inbox.*` is never offered as a WebMCP tool. An Owner or Admin sees their own
inbox like everybody else; there is no way to read another person's. Ids of someone else's entries change nothing.

## Event

`inbox.changed` `{ change: created|read|dismissed|settled, kinds }` tells a client to refresh with `inbox.count`. It
carries no entry data and no person id. It is opt-in (`events.subscribe` with the name) and fail closed: the RPC server
cannot address one connection, so the event is only sent when every connection that subscribed to it belongs to the
person whose inbox changed. If anybody else (or an agent) is subscribed, it is withheld from all. A client therefore
refreshes on connect and on reconnect, and treats the event as a hint.

## Metrics

`plur1bus_inbox_entries_total{kind}` counts created entries. The label is the closed kind set; no person or object id is
ever a label.

## CLI

```
plur1bus inbox list [--kind K]... [--unread] [--all] [--limit N] [--cursor C]
plur1bus inbox count
plur1bus inbox read <id>... | --all
plur1bus inbox dismiss <id>...
```

`--json` prints the RPC result with the schema ids `inbox.list/1`, `inbox.count/1`, `inbox.read/1` and
`inbox.dismiss/1`. Reference: [cli.md](cli.md), [rpc.md](rpc.md).

## Härtung und Testabdeckung

The page (`packages/web/src/pages/inbox`) is covered by `inbox-page.test.ts`, `inbox-model.test.ts` and, from the hardening sweep,
`inbox-hardening.test.ts` (real Chromium against the mock API, axe in light and dark, English and German, 360 and 1440 px).

- **Who sees what is the backend's job.** The page shows every entry `inbox.list` returns and offers every action to every role; it sends
  no role and no person and filters nothing by audience itself (tested for all five roles).
- **Live updates.** `inbox.changed` and a reconnect only make the page ask again. A refresh asks for as many entries as are shown (50 to 200,
  the maximum of `inbox.list`), so paging is not lost, a burst of hints leaves no entry twice, and the order is the backend's. A refresh that
  fails keeps the list and shows "That did not work. Try again."; only a first load that fails shows the error page.
- **Entries are checked.** An entry needs a non-empty string `id` (repeated ids: the first wins), a known `kind` and `severity`, a string
  `titleKey`, a `params` object of strings, numbers and booleans, finite `createdAt` within the range of a date, `readAt` and `dismissedAt`
  `null` or a time, and a `ref` of `null` or an object with optional string fields. Anything else is left out, not shown half. Titles are text,
  an unknown title key shows the kind label, and a link is only built for a known app route.
- **Bulk action.** Without a kind filter "Mark all as read" keeps its meaning (`{ all: true }`, immediately). Under a kind filter it asks first
  and marks only the unread entries shown (`{ ids }`, at most 500 per call), so entries the filter hides stay unread.
- **Keyboard.** After "Mark as read" the focus moves to the entry's "Dismiss" button (or the heading when the entry left the list); after
  "Load more" it moves to the first new entry.
- **Badge.** The sidebar count is the sum of `inbox.count`'s per-kind numbers, shown only when every one is a non-negative whole number.

Limits: an entry of a kind this UI does not know is not shown (the kinds are a closed list in `rpc-types.ts`); "Mark all as read" without a kind
filter also marks entries that are not loaded yet, as the label says.
