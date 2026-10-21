# Status, logs and audit trail

Two pages in the **Control** group of the sidebar tell you whether the installation is healthy and what it has been doing: **Doctor** (`#/doctor`) shows the health of the API, the core and the agents, and **Logs** (`#/logs`) holds the log viewer, a plain-language activity feed and the check of the audit trail. The German version of this page is [../de/diagnose.md](../de/diagnose.md).

## The Doctor page

A banner at the top sums it up:

- **All systems normal**: the core is running and the engine is ready.
- **Degraded mode**: some features may be limited. The banner names the cause and the capability that is affected, or says that the engine is not ready yet.
- **The core is not reachable**: the API is up, but the core is down. Start it, then choose **Re-check**. On the command line, `plur1bus daemon start` starts the supervisor and its core.
- **Status unknown**: the health endpoint is not available, so the state of the core cannot be shown.

The page checks again every 30 seconds while the tab is visible. **Re-check** does it at once, and the page tells you when it last checked.

Below the banner are these cards:

- **API and core**: **API version**, **Core RPC version**, **Contract version**, **Uptime** and **Engine ready**.
- **Core details**: the **Process** state (starting, ready, degraded, orphaned, stopping, stopped or crashed), the **Embedder model** and **Reranker model** (loading, ready, failed or disabled), the **Store schema** against the expected one, and whether **Shared memory** is available.
- **Agents**: one row per agent with whether it is open, its **Activity** (idle, recalling, capturing, checkpointing, dreaming, consolidating or maintenance), since when and, for dreaming, the phase.
- **Live provisioning report**: the checks of the first-aid check, each with a status (**OK**, **Warning**, **Failed** or **Skipped**), a short summary and, where there is one, a hint how to fix it. A check that this build cannot perform shows as skipped; it is never claimed as verified. Owner, Admin and Operator can choose **Refresh provisioning** to run the checks again, at most once every 30 seconds. A second request inside that time is refused and the card says so.
- **Provisioning results**: you can load the output of `plur1bus 1staid check --json` as a file to read it as a table with **Check**, **Status**, **Message** and **How to fix**. The file is read in your browser only and is never sent anywhere. It must be a JSON document of at most 1 MB in the `1staid.check/1` format. **Copy as JSON**, **Download JSON** and **Clear** work on the loaded result.

If your role may not see a card, the card says so and the rest still shows.

## The Logs page

The page has three tabs.

### Logs

The log viewer is for Owner and Admin. Other roles see a note that they have no access.

1. Choose the **Stream**: **Diagnostic** for the records of the supervisor, the core and the modules, or **Audit** for the audit trail of privileged actions.
2. Narrow it with **Minimum level** (trace up to fatal, not for the audit stream), **Component** (a file role such as `core`, a source id or a source kind), **Search text** (case-insensitive, matched against the redacted entry), **Trace ID** (searched as text, so not together with a search text) and **Time range** (any time, last 15 minutes, last hour, last 24 hours or a custom range).
3. Choose the **Order**, newest first or oldest first, and **Apply filters**.

Entries show **Time**, **Level**, **Component** and **Message**. Arrow keys move between them, Enter opens the details, where you can copy single fields or the whole record as JSON. The viewer loads a page at a time; **Load older** and **Load newer** fetch more. If the server stopped at its scan limit, or skipped unreadable lines, a note says so.

Values that must not appear, such as secrets, are masked by the server and marked **Redacted**. The original values are not available.

**Live tail** follows new entries while you look. **Pause live tail** holds them back and counts them as new entries. Live tail is off for oldest-first order and for time ranges with an end. **Export NDJSON** and **Export JSON** save the entries that are loaded in this view, exactly as the server returned them.

### Activity

The tab shows recent activity in plain words, grouped as today, yesterday, earlier this week and older: agent runs, dreams, model scans, backups, sign-ins and break-glass access, each with who did it. **Open in log** jumps to the matching entry in the Logs tab. **Time range** offers 24 hours, 7 days, 30 days or all, and **Show more** loads further entries. If one of the two logs cannot be read, the tab says that some entries are missing. The feed and the audit check are for Owner and Admin. **Agent activity** above the feed shows the state history of an agent, filtered by **Agent ID** and by time; other roles see it too, with a note instead of the feed.

The card **Audit trail** checks that the audit trail has not been changed or cut off. **Verified** means that no change was found and shows how many records and files were checked. **Failed** lists the findings. **Verify again** repeats the check.

### Sessions

The tab lists your own direct chats with title, agent and dates, never the message text. You can search, filter by agent, status and last activity, and sort. A transcript can only be read through break-glass access, which is logged and told to the person concerned, see [breakglass.md](breakglass.md). The tab is open to Owner, Admin, Operator and Viewer. Owner, Admin and Operator also see other people's chats, with owner, model and usage.

## On the command line

```sh
plur1bus daemon status
plur1bus 1staid check
plur1bus 1staid repair --dry-run
plur1bus 1staid bundle --out ./diagnostics
plur1bus logs query --level warn --component core --limit 50
plur1bus logs query --stream audit --from 2026-10-19T08:00:00Z
plur1bus logs tail --follow --level error
plur1bus audit verify
```

- `daemon status` shows the state of the supervisor and the core. `1staid check` is the read-only check behind the live provisioning report; `1staid repair --dry-run` prints what a repair would do and changes nothing. More on both in [operations.md](operations.md).
- `1staid bundle` writes a redacted diagnostic zip and prints its path: versions, check results, service status, configuration and the last log lines, never the audit log, secrets or memory stores. `--out` is a new file or an existing directory, `--lines` keeps the last N lines of each log (500 by default).
- `logs query` prints the newest records first, `logs tail` the latest ones and, with `--follow`, keeps polling until you stop it. `--stream` is `diagnostic` or `audit`. `--level` is `trace`, `debug`, `info`, `warn`, `error` or `fatal`. `--from` and `--to` are inclusive bounds; write them like `2026-10-19T08:00:00Z`. `--trace` takes a 32-character trace id.
- `audit verify` checks that every line of the audit trail carries the hash of the line before it, that the sequence numbers have no gap and that the anchor file matches the newest line. It exits with status 1 when anything is wrong. Owner and Admin can run it.

Reading logs and the audit trail needs the role Owner or Admin. The files themselves are listed in [operations.md](operations.md).

## Next

- Directories, log files, services and updates: [operations.md](operations.md)
- Reading private chats in an emergency: [breakglass.md](breakglass.md)
- What an agent is doing: [agents.md](agents.md)
- Memory health: [memories.md](memories.md)
