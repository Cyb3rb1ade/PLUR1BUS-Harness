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

You can trigger a scheduled job on demand from the web interface without waiting for its next scheduled time.
Clicking **Run now** prompts for confirmation before invoking the job execution (`jobs.run`).

## Task configuration and limitations

In the current version of Plur1bus, the RPC backend provides interfaces for listing jobs, querying history, and
triggering runs (`jobs.run`). Creating new recurring tasks or modifying their schedules via RPC is not yet supported
by the backend schema (see [../../web-ui.md](../../web-ui.md)). The web interface indicates this limitation with an
informational notice.
