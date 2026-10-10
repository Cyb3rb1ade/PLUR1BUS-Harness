# Project board backend

Each project has one durable Kanban board in the existing collaboration SQLite
store (`state/collab.sqlite`). The additive v2 migration creates boards for all
existing projects, including archived ones, without rewriting projects, members,
agents, tasks, artifacts or traces. New projects get their board in the same
transaction through a SQLite trigger. The four default columns carry i18n keys:

| Order | Key | Intended German display |
|---|---|---|
| 0 | `project.board.backlog` | Backlog |
| 1 | `project.board.inProgress` | In Arbeit |
| 2 | `project.board.review` | Review |
| 3 | `project.board.done` | Erledigt |

Custom columns accept a literal `title` or a `titleKey`. Clients translate keys;
Core stores no locale-specific default title. A column has an opaque id, a dense
zero-based position and a nullable positive WIP limit. Deletion requires an empty column (archived cards also count)
or `targetColumnId`; all cards and their move history transfer atomically. A
target in another project or the source column itself is refused.

Cards have an opaque id, project id, title, Markdown description, column id,
position, labels, priority (`none`, `low`, `normal`, `high`, `urgent`), nullable
`dueAt` (epoch milliseconds), typed person/agent assignees, links, actor/time
metadata and an archive flag. Links are `{kind, id}`: `session`, `job`, `media`,
`url`. Their values are opaque references: the board never starts a session or
job, loads media, fetches URLs, evaluates HTML or executes link text. Clients
must separately authorize opening a linked resource. Cross-resource existence
is intentionally not required, so historical references survive resource expiry.

Assignment accepts only current project members or assigned project agents.
Removal from the project revokes board access immediately; old assignment and
comment identities remain historical data. Unassignment can remove a historical
assignee who no longer belongs to the project.

## Ordering, WIP and persistence

Positions are dense integers. A move inserts at the requested zero-based index
(clamped to the end), then renumbers siblings in one `BEGIN IMMEDIATE`
transaction. Omitted positions append. This avoids floating-point exhaustion
under repeated moves. Archived cards retain their positions; WIP counts only
active cards. Create, cross-column move, unarchive and column-delete transfer
check the target limit before commit. Reordering within the same column remains
possible even after its limit has been lowered below the current count.
`overrideWip: true` requires project manage and is never available to agents.
Refusal is `E_PROJECT_WIP_LIMIT`; no card, column or activity change commits.

Each project's board is one JSON document in a foreign-keyed SQLite row. This
keeps board mutations and append-only history atomic with the existing store's
write locking. Reads and writes materialize that project's board, so very large
boards/history may eventually warrant normalized card and history tables. No
additional metrics or id-valued labels are introduced; the RPC method metric
uses its existing schema-derived finite registry and bounded result classes.

Every card records `createdBy/At`, `updatedBy/At` and a durable activity log:
created, updated, moved, assigned, unassigned, commented, archived, unarchived.
Comments are Markdown text with a typed author and creation time. History and
comments use monotonic sequence ids independent of clocks. Actor identity comes
from the authenticated invocation, never request fields.

## Rights

The central RPC guard intersects role rights with token scopes:
`project.board.read`, `.write`, `.move`, `.comment`, `.manage` (or
`project.board.*`). The handler then derives object rights from persisted project
membership, discarding caller-supplied project rights.

| Operation | Human project member | Human project lead | Owner/Admin | Assigned project agent |
|---|---|---|---|---|
| Read board/cards/comments/activity | Yes, including Viewer | Yes | Yes | Yes |
| Create/update/assign/archive cards | Member/Operator | Member/Operator | Yes | No |
| Comment | Member/Operator | Member/Operator | Yes | Yes, unless Viewer |
| Move cards | Member/Operator | Member/Operator | Yes | Own assigned cards only, unless Viewer |
| Manage columns / override WIP | No | Member/Operator | Yes | No |

Viewer is always read-only. Nonmember Operator/Member/Viewer cannot read the
board; Owner/Admin retain their existing project administrative rights. Missing,
unknown or unauthenticated principals fail closed. Agents need both a permitted
role and live project assignment; their trusted principal `userId` names their
agent identity. They cannot use human management rights even with an Owner role.

WebMCP blocks the entire `project.column.` prefix, including explicit opt-in.
Column management changes workflow structure and WIP policy and is a human
project-manage operation. Card access still passes through the authenticated
RPC guards; WebMCP exposure cannot widen an agent's board rights.

## RPC, paging and live updates

See [RPC reference](rpc.md) for all 17 `project.column.*` / `project.card.*`
methods. Every request names `projectId`; card operations also name `cardId`.
`project.card.list` filters column, typed assignee, label, literal case-insensitive
text, and `archived` (default false); it returns cards in column/position order.
Pages have `limit` (1–100, default 50) and opaque `nextCursor` (null at the end).
Card cursors bind project, filters and the ordered matching snapshot. A matching
mutation invalidates the cursor with `E_INVALID_PARAMS`; restart from page one.
This prevents duplicates when cards move between pages. Comment/activity pages
are in sequence order and can continue across subsequent appends. Cursors are
never credentials; each page is independently authorized.

Committed writes emit `project.card.changed` or `project.column.changed` through
the existing events subscription stream (`/events` on the web transport). Payloads
contain `projectId`, optional `cardId`/`columnId`, and `change`. A column deletion
with transfer additionally invalidates project cards. Clients refresh the board,
including reordered siblings, instead of applying only the named record.
Recipients are rechecked against current stored membership, role and token scopes;
resolver failures withhold delivery. Failed transactions emit no events. Events
are refresh hints, not a durable delivery queue; reconnecting clients refetch.

## CLI and UI follow-up

`plur1bus project board <project-id>` follows all active-card pages and groups the
result by column. `--json` returns `project.board/1` with nested cards per column.
The commands below support the global `--json` flag at any command depth:

```sh
plur1bus project card list <project-id> --label bug --limit 25 --json
plur1bus project card show <project-id> <card-id> --json
plur1bus project card create <project-id> <column-id> "Task" --description "Markdown" --json
plur1bus project card move <project-id> <card-id> <column-id> 0 --json
plur1bus project card assign <project-id> <card-id> agent <agent-id> --json
plur1bus project card assign <project-id> <card-id> person <user-id> --remove --json
plur1bus project card comment <project-id> <card-id> "Review note" --json
plur1bus project card archive <project-id> <card-id> --undo --json
plur1bus project column list <project-id> --json
plur1bus project column create <project-id> "Custom" --wip-limit 3 --json
plur1bus project column move <project-id> <column-id> 1 --json
plur1bus project column delete <project-id> <column-id> --target <target-column-id> --json
```

[CLI reference](cli.md) is generated from clap. The Projects web page can now be
built against this backend; its board UI, translation dictionaries and drag/drop
interaction are follow-up work. No web or desktop source is changed here.
