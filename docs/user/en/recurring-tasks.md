# Recurring tasks

Recurring tasks run scheduled operations in the background, such as periodic maintenance, synchronization, and
automated workflows. This page describes how scheduled jobs are inspected, monitored, and run. The German version of
this page is [../de/wiederkehrende-aufgaben.md](../de/wiederkehrende-aufgaben.md).

In the web interface, scheduled jobs and their execution logs are located under **Recurring Tasks** (`#/recurring`).

## Viewing scheduled tasks

The web interface lists all scheduled jobs retrieved from the jobs service (`jobs.list`). Each entry displays:

- **Name and identifier**: the task label and purpose.
- **Schedule**: the cron expression or interval cadence.
- **Run timestamps**: the previous run time and the planned next run time.
- **Status**: current operational state (active, paused, or disabled).

Selecting a task displays its execution history (`jobs.history`), including run durations, exit codes, and status logs.

## Running a task immediately

For system and agent background jobs, you can use the existing manual trigger without waiting for the next scheduled time. The user-job panel currently offers create/edit/delete and history; its manual run RPC is separate.
Clicking **Run now** prompts for confirmation before invoking the job execution (`jobs.run`).

## Create and edit a task

Use **Create recurring task** to choose a manageable agent, enter a prompt, a five-field cron expression and an IANA timezone. The dialog previews the next three runs. A schedule that can never fire, such as `0 0 30 2 *` (30 February), is refused. Times are evaluated in the task's own timezone: a time that does not exist on the day the clocks go forward (for example 02:30 in Berlin on the last Sunday in March) is skipped for that day, and a time that occurs twice when the clocks go back runs once, at its first occurrence. You can enable or disable the task and delete it after confirmation. System and engine jobs stay read only.

A task runs under its creator's identity, with current rights checked each time. Editing someone else's task switches it to your identity; the dialog warns before saving. Task history shows the execution person's display name. Lost rights or an inactive person disable the task and create an inbox notice. Hard budgets skip the run. Tool approvals and OS confirmations follow the normal approval flow; the task never confirms them automatically.

See [the recurring task backend guide](../../recurring.md) for RPC, CLI and scheduler behavior. The web controls are tested against the typed mock while the authenticated RPC/event transport is supplied separately.
