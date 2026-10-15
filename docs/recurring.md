# User recurring tasks

`jobs.create`, `jobs.update` and `jobs.delete { id, confirm: true }` manage user tasks. A task has a name, target agent, prompt (at most 4000 characters), enabled flag and five-field cron schedule with an explicit IANA timezone. Engine and system jobs remain immutable.

## Schedule rules

- The schedule is exactly `{ cron, timezone }` (other keys are refused); the cron text is at most 128 characters and the timezone must be a valid IANA name. The task name is 1 to 128 characters without control characters and is stored trimmed.
- **A cron that can never fire is refused** with `E_INVALID_PARAMS`. An expression that parses but matches no real date, such as `0 0 30 2 *` (30 February), would otherwise leave an enabled task with no next run. The check looks for a firing within the next eight years, so `0 0 29 2 *` (leap day) is accepted.
- **Daylight saving time** follows the evaluator in `packages/core/src/dreams/cron.ts`, shared with the dream scheduler (see [dreams.md](dreams.md)), and is evaluated in the task's own timezone, never the host's. A wall time that does not exist (spring forward) is skipped for that day: `30 2 * * *` in `Europe/Berlin` does not fire on 2026-03-29 and next fires on 2026-03-30. A wall time that occurs twice (fall back) fires once, at its first occurrence. A task that runs every hour therefore sees a two-hour gap in real time across the repeated hour. Day-of-month and day-of-week are OR-ed when both are restricted, as in Vixie cron.

The core stores definitions and execution records in `state/user-jobs.sqlite`, a private SQLite database included by the existing state-database snapshot discovery. There is no host cron. Each due slot and its next scheduled time are committed together before a turn starts. An interrupted run becomes `abandoned`; its claimed slot is never replayed. Downtime produces at most one catch-up per task. Concurrent scheduler scans re-check the live slot before admission, so a stale scan cannot repeat another scan's completed slot.

## Identity, rights and approvals

`createdBy` is the creator's person ID. `runAs` is the current execution identity; roles, rights and tokens are never stored in the definition. Each run resolves that person again and uses current roles and agent rights. A trusted `rbac.resolvePerson` directory callback can resolve current authentication status, returning null for a deleted or inactive person. Without that callback the existing identity registry supplies presence and AdminStore supplies current roles/rights; it has no separate deactivation flag today. The transport/auth integration must provide the active-person lookup. Missing/inactive identity yields `skipped_owner_inactive`; lost use rights yield `skipped_no_rights`; a deleted agent yields `skipped_agent_missing`. These cases disable the task and publish an inbox notice for owner/admin, and for the active person after rights loss. Re-enabling uses `jobs.update` and checks rights again. A paused or archived agent yields `skipped_agent_inactive` without deleting the schedule; a hard budget yields `skipped_budget`.

Every run creates a separate private session under `runAs`, uses the regular turn/budget/memory pipeline, and marks prompt metadata as recurring. It has the creator/editor's own person-scoped memory identity and the existing linked-identity scope. It never supplies break-glass grants. Its origin has surface trust 0; OS confirmation comes from a person making the existing approval decision. Valid grants retain their normal person, agent, scope, expiry and revocation checks. A missing/expired grant produces an ordinary request for `runAs`, labelled with the recurring task's name. The existing foreground approval timeout ends the turn with `approval_timeout`; the task never approves itself.

Editing as another permitted person changes `runAs` to that editor, is audited, and displays a warning before saving. `runAs` cannot be set to an arbitrary third person. Run records keep `jobId`, `runAs`, display name, `trigger: recurring` and outcome; a manual trigger additionally records `requestedBy`.

Existing stricter permissions remain: writing requires the existing `agent.manage` policy (owner/admin, or member with manage rights). Operator is excluded by that policy even with a manage entry. Manual `jobs.run` retains its owner/admin/operator guard and additionally checks use rights. Approval decisions retain their existing owner/admin restriction. A member's task may use allowed tools and applicable grants, but cannot widen that approval rule.

## UI, RPC and CLI

`jobs.list { kind: user }` and `jobs.list { kind: all }` include user definitions and optional `manageableAgents`, computed from the authenticated person's current rights. The create/edit selector uses only those IDs. `jobs.history { kind: user, job?, agentId?, since?, limit? }` returns visible user run records with the execution person's display name. Existing agent/system defaults and records remain supported.

Recurring Tasks has create/edit/delete dialogs, three upcoming runs in the selected timezone, and a task-history dialog. The typed web client is verified against the existing mock; authenticated `/rpc` and `/events` delivery remains a separate transport package.

The CLI adds `plur1bus jobs list` (defaults to user tasks) and `plur1bus jobs create --name NAME --agent ID --prompt TEXT --cron '0 9 * * *' --timezone Europe/Berlin [--disabled]`. Their JSON schemas are `jobs.list/1` and `jobs.create/1`.
